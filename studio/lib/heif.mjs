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
    for (const box of eachBox(buf, start, end)) {
      if (box.type === 'colr') {
        const parsed = parseColrBox(buf, box.start, box.end);
        if (parsed) {
          found = parsed;
          return;
        }
      } else if (CONTAINERS.has(box.type)) {
        // `meta` is a FullBox: skip its version+flags before descending.
        walk(box.start + (box.type === 'meta' ? 4 : 0), box.end, depth + 1);
        if (found) return;
      }
    }
  };

  walk(0, buf.length, 0);
  return found;
}

/**
 * Iterates the ISOBMFF boxes in `[start, end)`, yielding the bounds of each box's payload. Stops
 * at the first malformed header instead of throwing, so a truncated file degrades to "found
 * nothing" rather than failing an upload.
 */
function* eachBox(buf, start, end) {
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
    yield { type, start: off + headerSize, end: off + size };
    off += size;
  }
}

/**
 * Locates the Exif payload inside a HEIF container and returns it as a bare TIFF block.
 *
 * exifr reads HEIF, but only recognises a file when the literal string `heic` appears among the
 * compatible brands listed from byte 16 of `ftyp` — its check is effectively
 * `brands.includes('heic')`, and the major brand is never consulted. A 10-bit Sony .HIF
 * advertises `mif1 heix miaf MiHA jpeg SHIF`, and Canon's equivalent `mif1 heix`; neither says
 * `heic`, so exifr rejects the file outright with "Unknown file format" and every frame loses its
 * camera, lens, exposure and date. The same check also caps `ftyp` at 50 bytes, which recent
 * iPhones exceed once they add adaptive-HDR brands. Finding the Exif item ourselves and handing
 * exifr a plain TIFF block sidesteps the brand sniffing altogether.
 *
 * @returns {Buffer|null} the TIFF block, or null when the file carries no Exif item.
 */
export function readExifBlock(buf) {
  let meta = null;
  for (const box of eachBox(buf, 0, buf.length)) {
    if (box.type === 'meta') {
      meta = box;
      break;
    }
  }
  if (!meta) return null;

  // `meta` is a FullBox, so its children start after version+flags.
  let iinf = null;
  let iloc = null;
  for (const box of eachBox(buf, meta.start + 4, meta.end)) {
    if (box.type === 'iinf') iinf = box;
    else if (box.type === 'iloc') iloc = box;
  }
  if (!iinf || !iloc) return null;

  const itemId = findExifItemId(buf, iinf);
  if (itemId === null) return null;

  const extents = findItemExtents(buf, iloc, itemId);
  if (!extents || extents.length === 0) return null;

  const parts = [];
  for (const { offset, length } of extents) {
    if (offset < 0 || length <= 0 || offset + length > buf.length) return null;
    parts.push(buf.subarray(offset, offset + length));
  }
  const payload = parts.length === 1 ? parts[0] : Buffer.concat(parts);

  // An Exif item payload begins with a 32-bit offset to the TIFF header (almost always 0).
  if (payload.length < 8) return null;
  const tiff = payload.subarray(4 + payload.readUInt32BE(0));
  return tiff.length > 8 ? tiff : null;
}

/** Scans the item-info box for the entry whose type is `Exif` and returns its item ID. */
function findExifItemId(buf, iinf) {
  if (iinf.start + 4 > iinf.end) return null;
  const version = buf.readUInt8(iinf.start);
  // FullBox header, then an entry count that we can skip: the `infe` boxes are self-delimiting.
  const listStart = iinf.start + 4 + (version === 0 ? 2 : 4);

  for (const entry of eachBox(buf, listStart, iinf.end)) {
    if (entry.type !== 'infe' || entry.start + 4 > entry.end) continue;
    // item_type only exists from version 2 onwards; earlier versions predate typed items.
    const version = buf.readUInt8(entry.start);
    if (version < 2) continue;

    const idSize = version === 2 ? 2 : 4;
    const idAt = entry.start + 4;
    const typeAt = idAt + idSize + 2; // + item_protection_index
    if (typeAt + 4 > entry.end) continue;

    if (buf.toString('latin1', typeAt, typeAt + 4) === 'Exif') {
      return idSize === 2 ? buf.readUInt16BE(idAt) : buf.readUInt32BE(idAt);
    }
  }
  return null;
}

/**
 * Reads the item-location box to find where an item's bytes actually live. Items may be split
 * across several extents, and the width of every offset field is declared in the box header
 * rather than being fixed, so this has to be parsed rather than indexed.
 */
function findItemExtents(buf, iloc, wantId) {
  let off = iloc.start;
  if (off + 8 > iloc.end) return null;
  const version = buf.readUInt8(off);
  off += 4;

  const offsetSize = buf[off] >> 4;
  const lengthSize = buf[off] & 0x0f;
  const baseOffsetSize = buf[off + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? buf[off + 1] & 0x0f : 0;
  off += 2;

  let itemCount;
  if (version < 2) {
    itemCount = buf.readUInt16BE(off);
    off += 2;
  } else {
    itemCount = buf.readUInt32BE(off);
    off += 4;
  }

  const readInt = (size) => {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buf[off + i];
    off += size;
    return value;
  };

  for (let i = 0; i < itemCount; i++) {
    if (off + 8 > iloc.end) return null;
    const id = version < 2 ? buf.readUInt16BE(off) : buf.readUInt32BE(off);
    off += version < 2 ? 2 : 4;

    // Construction method 1 keeps the bytes inside an `idat` box rather than at a file offset;
    // we only resolve plain file offsets, so such an item is reported as not found.
    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = buf.readUInt16BE(off) & 0x0f;
      off += 2;
    }
    off += 2; // data_reference_index

    const baseOffset = readInt(baseOffsetSize);
    if (off + 2 > iloc.end) return null;
    const extentCount = buf.readUInt16BE(off);
    off += 2;

    const extents = [];
    for (let j = 0; j < extentCount; j++) {
      if (off + indexSize + offsetSize + lengthSize > iloc.end) return null;
      if (indexSize) readInt(indexSize);
      const extentOffset = readInt(offsetSize);
      extents.push({ offset: baseOffset + extentOffset, length: readInt(lengthSize) });
    }

    if (id === wantId) return constructionMethod === 0 ? extents : null;
  }
  return null;
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
