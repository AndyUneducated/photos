/**
 * Colour-space normalisation to sRGB.
 *
 * iPhones tag their HEICs as Display P3 and Sony tags HLG/BT.2020 when shooting HDR. libheif
 * hands us the raw 8-bit RGBA without any profile attached, so if we encoded it straight to AVIF
 * the browser would interpret those wide-gamut values as sRGB and everything would look
 * oversaturated (P3) or washed out and flat (HLG). We convert the pixels ourselves.
 *
 * Everything here runs on already-downscaled images (a few megapixels, not 61), and uses lookup
 * tables instead of Math.pow per channel, which keeps a full conversion in the low tens of
 * milliseconds rather than seconds.
 */

// ITU-T H.273 colour_primaries codes.
const PRIMARIES_BT709 = 1;
const PRIMARIES_BT2020 = 9;
const PRIMARIES_DCI_P3 = 11;
const PRIMARIES_DISPLAY_P3 = 12;

// ITU-T H.273 transfer_characteristics codes.
const TRANSFER_BT709 = 1;
const TRANSFER_SRGB = 13;
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

// Linear-light 3x3 matrices, both source and destination at a D65 white point.
const P3_TO_SRGB = [
  1.2249401762805699, -0.2249401762805700, 0.0,
  -0.0420569547676105, 1.0420569547676108, 0.0,
  -0.0196375587185150, -0.0786360496255420, 1.0982736083440570,
];

const BT2020_TO_SRGB = [
  1.6605043219179011, -0.5876411387885848, -0.0728631831293164,
  -0.1245862375371361, 1.1328949974354256, -0.0083087598982895,
  -0.0181868205825232, -0.1005789975390839, 1.1187658181216071,
];

/**
 * Decides what to do with an image given the `colr` box we parsed out of the HEIF container.
 *
 * @returns {{matrix: number[]|null, transfer: 'srgb'|'hlg'|'pq', hdr: boolean, label: string}}
 */
export function planColourConversion(colour) {
  if (!colour) return { matrix: null, transfer: 'srgb', hdr: false, label: 'sRGB (assumed)' };

  if (colour.kind === 'icc') {
    const desc = (colour.description || '').toLowerCase();
    if (desc.includes('p3')) {
      return { matrix: P3_TO_SRGB, transfer: 'srgb', hdr: false, label: colour.description || 'Display P3' };
    }
    if (desc.includes('2020') || desc.includes('rec2020')) {
      return { matrix: BT2020_TO_SRGB, transfer: 'srgb', hdr: false, label: colour.description || 'BT.2020' };
    }
    // sRGB, Adobe RGB and anything else unrecognised: leave the pixels alone. Adobe RGB is close
    // enough to sRGB in the midtones that guessing wrong here is worse than doing nothing.
    return { matrix: null, transfer: 'srgb', hdr: false, label: colour.description || 'ICC (unrecognised)' };
  }

  const matrix =
    colour.primaries === PRIMARIES_DISPLAY_P3 || colour.primaries === PRIMARIES_DCI_P3 ? P3_TO_SRGB
    : colour.primaries === PRIMARIES_BT2020 ? BT2020_TO_SRGB
    : null;

  const transfer =
    colour.transfer === TRANSFER_HLG ? 'hlg'
    : colour.transfer === TRANSFER_PQ ? 'pq'
    : 'srgb';

  const primariesLabel =
    colour.primaries === PRIMARIES_DISPLAY_P3 ? 'Display P3'
    : colour.primaries === PRIMARIES_DCI_P3 ? 'DCI-P3'
    : colour.primaries === PRIMARIES_BT2020 ? 'BT.2020'
    : colour.primaries === PRIMARIES_BT709 ? 'BT.709'
    : `primaries=${colour.primaries}`;

  const transferLabel = transfer === 'hlg' ? ' HLG' : transfer === 'pq' ? ' PQ' : '';

  return {
    matrix,
    transfer,
    hdr: transfer === 'hlg' || transfer === 'pq',
    label: primariesLabel + transferLabel,
  };
}

/** Number of entries in the linear -> sRGB encoding table. 4096 is well past 8-bit visible banding. */
const ENCODE_STEPS = 4096;

const srgbEncodeTable = buildEncodeTable();
const srgbDecodeTable = buildDecodeTable((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
const hlgDecodeTable = buildDecodeTable(hlgInverseOetf);
const pqDecodeTable = buildDecodeTable(pqInverseEotf);

function buildDecodeTable(fn) {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = fn(i / 255);
  return t;
}

function buildEncodeTable() {
  const t = new Uint8Array(ENCODE_STEPS + 1);
  for (let i = 0; i <= ENCODE_STEPS; i++) {
    const l = i / ENCODE_STEPS;
    const v = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
    t[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return t;
}

/** ITU-R BT.2100 HLG inverse OETF: signal -> scene linear, normalised so 1.0 is peak white. */
function hlgInverseOetf(x) {
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  return x <= 0.5 ? (x * x) / 3 : (Math.exp((x - c) / a) + b) / 12;
}

/** ITU-R BT.2100 PQ inverse EOTF, normalised so 1.0 is 10000 nits. */
function pqInverseEotf(x) {
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const p = x ** (1 / m2);
  const ratio = Math.max(0, p - c1) / (c2 - c3 * p);
  return ratio > 0 ? ratio ** (1 / m1) : 0;
}

/**
 * HLG's nominal diffuse white sits at roughly 26% of peak luminance, and PQ's at 203/10000 nits.
 * Scaling by the reciprocal puts a normally-exposed subject at 1.0 so it lands where an SDR
 * viewer expects it, and the highlights above 1.0 get rolled off by the tone mapper.
 */
const HLG_DIFFUSE_WHITE = 0.26;
const PQ_DIFFUSE_WHITE = 0.0203;

/**
 * Extended Reinhard: identity-ish in the shadows and midtones, smooth rolloff that maps `white`
 * exactly to 1.0. Good enough to make an HDR capture look like a decent SDR photo without
 * pretending to be a real tone-mapping pipeline.
 */
function toneMap(l, white) {
  if (l <= 0) return 0;
  return (l * (1 + l / (white * white))) / (1 + l);
}

/**
 * Converts a raw interleaved RGB(A) buffer to 8-bit sRGB **in place**.
 *
 * @param {Buffer} data interleaved samples, `channels` bytes per pixel
 * @param {ReturnType<typeof planColourConversion>} plan
 * @param {number} channels 3 for RGB, 4 for RGBA (alpha is left untouched)
 * @returns {boolean} whether any pixels were actually touched
 */
export function convertToSrgb(data, plan, channels = 4) {
  const { matrix, transfer } = plan;
  if (!matrix && transfer === 'srgb') return false;

  const decode =
    transfer === 'hlg' ? hlgDecodeTable : transfer === 'pq' ? pqDecodeTable : srgbDecodeTable;

  const hdr = transfer !== 'srgb';
  const gain = transfer === 'hlg' ? 1 / HLG_DIFFUSE_WHITE : transfer === 'pq' ? 1 / PQ_DIFFUSE_WHITE : 1;
  // The brightest value the source can represent, after the same diffuse-white scaling.
  const white = hdr ? gain : 1;

  const m = matrix;
  const enc = srgbEncodeTable;

  for (let i = 0; i + channels <= data.length; i += channels) {
    let r = decode[data[i]];
    let g = decode[data[i + 1]];
    let b = decode[data[i + 2]];

    if (hdr) {
      r *= gain;
      g *= gain;
      b *= gain;
    }

    if (m) {
      const nr = m[0] * r + m[1] * g + m[2] * b;
      const ng = m[3] * r + m[4] * g + m[5] * b;
      const nb = m[6] * r + m[7] * g + m[8] * b;
      r = nr;
      g = ng;
      b = nb;
    }

    if (hdr) {
      r = toneMap(r, white);
      g = toneMap(g, white);
      b = toneMap(b, white);
    }

    // Out-of-gamut values after the matrix are clipped; a proper gamut compression would be
    // nicer but clipping is what every browser does anyway when handed out-of-range sRGB.
    data[i] = enc[clampIndex(r)];
    data[i + 1] = enc[clampIndex(g)];
    data[i + 2] = enc[clampIndex(b)];
  }

  return true;
}

function clampIndex(l) {
  const i = (l * ENCODE_STEPS + 0.5) | 0;
  return i < 0 ? 0 : i > ENCODE_STEPS ? ENCODE_STEPS : i;
}
