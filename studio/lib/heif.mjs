/**
 * HEIF/HEIC/HIF decoding.
 *
 * sharp's prebuilt binaries cannot read HEIC: libvips upstream disables H.265 in its official
 * builds for patent reasons, so `sharp(file.HIF)` fails with an unsupported-format error. We
 * decode with libheif compiled to WebAssembly instead, which needs no native dependency on the
 * user's machine, and hand raw RGBA to sharp for resizing and encoding.
 */

import { createRequire } from 'node:module';

// Not `libheif-js/wasm`: that entry point reads the .wasm with a path relative to the *current
// working directory*, so it only ever works when you happen to be sitting inside the package.
// Requiring the emscripten factory directly sidesteps it — the module resolves `libheif.wasm`
// against its own __dirname, which is correct from anywhere.
const require = createRequire(import.meta.url);
const libheif = require('libheif-js/libheif-wasm/libheif.js')();

/** ISOBMFF brands that indicate a still HEIF image we can decode. */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', // HEVC single image / image sequence
  'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1', 'miaf', // generic MIAF, used by some Sony firmware
  'avif', 'avis', // AV1 in HEIF; sharp can read these natively but we handle them too
]);

/**
 * Reads the `ftyp` box to decide whether this is a HEIF-family file. Extension sniffing is not
 * enough: Sony writes `.HIF`, Apple writes `.HEIC`, and both appear as `.heif` in the wild.
 */
export function isHeif(buf) {
  if (buf.length < 12) return false;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const major = buf.toString('latin1', 8, 12);
  if (HEIF_BRANDS.has(major)) return true;
  // Fall back to scanning the compatible-brands list.
  const boxSize = Math.min(buf.readUInt32BE(0), buf.length);
  for (let off = 16; off + 4 <= boxSize; off += 4) {
    if (HEIF_BRANDS.has(buf.toString('latin1', off, off + 4))) return true;
  }
  return false;
}

/**
 * Walks the ISOBMFF box tree looking for the first `colr` box, which tells us what colour space
 * the pixels are in. libheif-js hands back 8-bit RGBA with no colour information attached, so
 * without this an iPhone's Display-P3 photo would be misread as sRGB and come out oversaturated.
 *
 * Returns `null` when the file carries no colour information (treat as sRGB).
 */
export function readColourInfo(buf) {
  let found = null;

  // `colr` lives deep inside meta > iprp > ipco > (colr), and HEIF box nesting varies between
  // encoders, so walk containers generically rather than hardcoding a path.
  const CONTAINERS = new Set(['meta', 'iprp', 'ipco', 'iinf', 'moov', 'trak', 'mdia', 'minf', 'stbl']);

  const walk = (start, end, depth) => {
    if (found || depth > 8) return;
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      let headerSize = 8;
      if (size === 1) {
        if (off + 16 > end) return;
        // 64-bit sizes are always far smaller than 2^53 for real image files.
        size = Number(buf.readBigUInt64BE(off + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - off; // box extends to the end of its parent
      }
      if (size < headerSize || off + size > end) return;

      if (type === 'colr') {
        const parsed = parseColrBox(buf, off + headerSize, off + size);
        if (parsed) {
          found = parsed;
          return;
        }
      } else if (CONTAINERS.has(type)) {
        // `meta` is a FullBox: skip its version+flags before descending.
        const childStart = off + headerSize + (type === 'meta' ? 4 : 0);
        walk(childStart, off + size, depth + 1);
        if (found) return;
      }
      off += size;
    }
  };

  walk(0, buf.length, 0);
  return found;
}

function parseColrBox(buf, start, end) {
  if (start + 4 > end) return null;
  const kind = buf.toString('latin1', start, start + 4);

  if (kind === 'nclx') {
    if (start + 11 > end) return null;
    return {
      kind: 'nclx',
      primaries: buf.readUInt16BE(start + 4),
      transfer: buf.readUInt16BE(start + 6),
      matrix: buf.readUInt16BE(start + 8),
      fullRange: (buf[start + 10] & 0x80) !== 0,
    };
  }

  if (kind === 'prof' || kind === 'rICC') {
    const icc = buf.subarray(start + 4, end);
    if (icc.length < 132) return null;
    return { kind: 'icc', icc, description: readIccDescription(icc) };
  }

  return null;
}

/**
 * Pulls the human-readable name out of an ICC profile's `desc` tag. We only need it to tell
 * "Display P3" apart from "sRGB" when a file ships a full profile instead of nclx codes.
 */
function readIccDescription(icc) {
  try {
    const tagCount = icc.readUInt32BE(128);
    if (tagCount > 200) return '';
    for (let i = 0; i < tagCount; i++) {
      const entry = 132 + i * 12;
      if (entry + 12 > icc.length) break;
      if (icc.toString('latin1', entry, entry + 4) !== 'desc') continue;
      const offset = icc.readUInt32BE(entry + 4);
      const size = icc.readUInt32BE(entry + 8);
      if (offset + size > icc.length) break;
      const type = icc.toString('latin1', offset, offset + 4);

      // ICC v4 multiLocalizedUnicodeType: record table at +16, strings are UTF-16BE.
      if (type === 'mluc') {
        const strLen = icc.readUInt32BE(offset + 20);
        const strOffset = offset + icc.readUInt32BE(offset + 24);
        if (strOffset + strLen > icc.length) break;
        return decodeUtf16BE(icc.subarray(strOffset, strOffset + strLen));
      }

      // ICC v2 textDescriptionType: ASCII length at +8, string at +12.
      if (type === 'desc') {
        const strLen = icc.readUInt32BE(offset + 8);
        if (offset + 12 + strLen > icc.length) break;
        return icc.toString('latin1', offset + 12, offset + 12 + strLen).replace(/\0/g, '').trim();
      }
    }
  } catch {
    // A malformed profile is not worth failing an upload over.
  }
  return '';
}

function decodeUtf16BE(be) {
  const le = Buffer.allocUnsafe(be.length & ~1);
  for (let i = 0; i + 1 < be.length; i += 2) {
    le[i] = be[i + 1];
    le[i + 1] = be[i];
  }
  return le.toString('utf16le').replace(/\0/g, '').trim();
}

/**
 * Decodes the primary image of a HEIF file to raw RGBA.
 *
 * @returns {Promise<{data: Buffer, width: number, height: number, colour: object|null}>}
 */
export async function decodeHeif(buf) {
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buf);
  if (!images || images.length === 0) {
    throw new Error('HEIF 文件里没有找到图像（文件可能损坏或是不支持的编码）');
  }

  // A HEIC can hold a burst or a Live Photo sequence; the first image is the primary one.
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height) throw new Error('HEIF 图像尺寸无效');

  // libheif-js mirrors the browser ImageData shape, so we hand it a compatible object.
  const data = Buffer.allocUnsafe(width * height * 4);
  const imageData = { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };

  await new Promise((resolve, reject) => {
    image.display(imageData, (result) => {
      if (!result) reject(new Error('libheif 解码失败'));
      else resolve();
    });
  });

  // Free the WASM-side pixel buffers; without this a batch of 60MP files exhausts WASM memory.
  for (const img of images) img.free?.();

  return { data, width, height, colour: readColourInfo(buf) };
}
