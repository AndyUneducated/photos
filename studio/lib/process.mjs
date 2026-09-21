/**
 * The per-photo pipeline: camera file in, web-ready AVIF derivatives out.
 *
 * Deliberately free of any state or I/O beyond reading the source file, so that it can run
 * unchanged inside a worker thread (see `pool.mjs`).
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

import { decodeHeif, isHeif } from './heif.mjs';
import { convertToSrgb, planColourConversion } from './color.mjs';
import { readExif } from './exif.mjs';

// libvips caches decoded images across calls, which is counterproductive here: every photo is
// touched exactly once and the cache just holds onto hundreds of megabytes.
sharp.cache(false);

/** EXIF orientation -> the operations needed to display the image upright. */
const ORIENTATION_OPS = {
  1: { rotate: 0, flop: false, flip: false },
  2: { rotate: 0, flop: true, flip: false },
  3: { rotate: 180, flop: false, flip: false },
  4: { rotate: 0, flop: false, flip: true },
  5: { rotate: 90, flop: true, flip: false },
  6: { rotate: 90, flop: false, flip: false },
  7: { rotate: 270, flop: true, flip: false },
  8: { rotate: 270, flop: false, flip: false },
};

const SWAPS_AXES = new Set([5, 6, 7, 8]);

/**
 * @param {string} filePath
 * @param {object} opts
 * @param {number} opts.webMaxEdge
 * @param {number} opts.thumbMaxEdge
 * @param {number} opts.webQuality
 * @param {number} opts.thumbQuality
 * @param {number} [opts.manualRotate] extra clockwise rotation in degrees (0/90/180/270)
 */
export async function processPhoto(filePath, opts) {
  const source = await readFile(filePath);
  const id = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const meta = await readExif(source);
  const notes = [];

  const { pipeline, colourPlan, autoRotate } = isHeif(source)
    ? await openHeif(source, meta, notes)
    : await openWithSharp(source, notes);

  if (colourPlan.hdr) {
    notes.push(
      `The source file is HDR (${colourPlan.label}) and has been tone mapped to SDR. If the colours do not look right, export an SDR version from the camera instead.`,
    );
  }

  // sharp's `rotate(angle)` overwrites any previously set angle rather than composing with it, so
  // the automatic correction and the user's manual nudge have to be summed and applied once.
  const totalRotate = normaliseRotation(autoRotate + normaliseRotation(opts.manualRotate));
  if (totalRotate) pipeline.rotate(totalRotate);

  // Resize once to the largest output we need, then derive everything else from that. Colour
  // conversion runs on this reduced buffer rather than the 61MP original, which is the difference
  // between tens of milliseconds and several seconds.
  const web = await pipeline
    .resize({
      width: opts.webMaxEdge,
      height: opts.webMaxEdge,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'lanczos3',
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const converted = convertToSrgb(web.data, colourPlan, web.info.channels);
  if (converted) notes.push(`Converted from ${colourPlan.label} to sRGB`);

  const rgb = () =>
    sharp(web.data, {
      raw: { width: web.info.width, height: web.info.height, channels: web.info.channels },
    });

  const [webAvif, thumb, lqip, dominant] = await Promise.all([
    rgb().avif({ quality: opts.webQuality, effort: 4, chromaSubsampling: '4:2:0' }).toBuffer(),
    rgb()
      .resize({
        width: opts.thumbMaxEdge,
        height: opts.thumbMaxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .avif({ quality: opts.thumbQuality, effort: 4, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true }),
    // 12px is small enough that the data URI stays under ~250 bytes yet still reads as a
    // recognisable blur of the photo behind the real thumbnail.
    rgb().resize({ width: 12, fit: 'inside' }).webp({ quality: 45, effort: 4 }).toBuffer(),
    rgb().stats(),
  ]);

  return {
    id,
    sourceName: filePath,
    sourceBytes: source.length,
    web: { data: webAvif, width: web.info.width, height: web.info.height },
    thumb: { data: thumb.data, width: thumb.info.width, height: thumb.info.height },
    lqip: `data:image/webp;base64,${lqip.toString('base64')}`,
    color: toHex(dominant.dominant),
    exif: meta.exif,
    takenAt: meta.takenAt,
    gps: meta.gps,
    colourSpace: colourPlan.label,
    notes,
  };
}

async function openHeif(source, meta, notes) {
  const { data, width, height, colour } = await decodeHeif(source);
  const pipeline = sharp(data, { raw: { width, height, channels: 4 } });

  const autoRotate = applyHeifOrientation(pipeline, meta, width, height, notes);
  if (autoRotate) notes.push(`Rotated by ${autoRotate}° to follow EXIF Orientation ${meta.orientation}`);

  return { pipeline, colourPlan: planColourConversion(colour), autoRotate };
}

/**
 * libheif applies the container's own `irot`/`imir` transform properties while decoding, but it
 * does not look at the EXIF Orientation tag. Which of the two a given camera or phone writes
 * varies, so blindly applying EXIF here would leave half the portrait photos upside down and the
 * other half sideways.
 *
 * We only intervene in the one case we can confirm from the pixel dimensions: EXIF says the image
 * needs a quarter turn, and the decoded buffer still has the un-turned aspect ratio. Anything
 * ambiguous is left alone and can be fixed with the rotate buttons in the studio.
 *
 * Applies any mirroring itself (those are independent flags on the pipeline) and returns only the
 * rotation, which the caller has to combine with the user's manual rotation.
 */
function applyHeifOrientation(pipeline, meta, width, height, notes) {
  const { orientation, declaredWidth, declaredHeight } = meta;
  if (!orientation || orientation === 1) return 0;

  if (!SWAPS_AXES.has(orientation)) {
    notes.push(
      `EXIF Orientation is ${orientation}, and the dimensions cannot tell us whether the decoder already applied it, so the photo was left as it is (rotate it by hand if you need to)`,
    );
    return 0;
  }

  if (!declaredWidth || !declaredHeight) return 0;

  const decodedIsTurned = width === declaredHeight && height === declaredWidth;
  if (decodedIsTurned) return 0; // libheif already did it

  const matchesDeclared = width === declaredWidth && height === declaredHeight;
  if (!matchesDeclared) return 0; // dimensions disagree with EXIF entirely; don't guess

  const ops = ORIENTATION_OPS[orientation];
  if (ops.flop) pipeline.flop();
  if (ops.flip) pipeline.flip();
  return ops.rotate;
}

async function openWithSharp(source, notes) {
  const pipeline = sharp(source, { failOn: 'error' });
  const metadata = await pipeline.metadata();

  // Not `pipeline.rotate()`: the no-argument form asks sharp to apply the EXIF orientation, but
  // sharp resets all rotation state whenever `rotate` is called again, so a later manual rotation
  // would silently discard it. Deriving the angle here keeps the two composable.
  const ops = ORIENTATION_OPS[metadata.orientation] ?? ORIENTATION_OPS[1];
  if (ops.flop) pipeline.flop();
  if (ops.flip) pipeline.flip();

  // An embedded profile (Lightroom exports are often Display P3 or Adobe RGB) makes libvips do a
  // real ICC transform when we name an output profile, which is more accurate than our matrix.
  if (metadata.icc) {
    pipeline.withIccProfile('srgb');
    notes.push('Converted to sRGB using the embedded ICC profile');
  }

  return {
    pipeline,
    colourPlan: { matrix: null, transfer: 'srgb', hdr: false, label: metadata.space || 'sRGB' },
    autoRotate: ops.rotate,
  };
}

function normaliseRotation(deg) {
  const n = Number(deg) || 0;
  const mod = ((n % 360) + 360) % 360;
  return mod === 90 || mod === 180 || mod === 270 ? mod : 0;
}

function toHex(dominant) {
  if (!dominant) return '#1a1a1c';
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(dominant.r)}${c(dominant.g)}${c(dominant.b)}`;
}
