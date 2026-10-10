/**
 * Puts a small EXIF block into the web AVIF so a downloaded photo keeps its shooting time and
 * camera settings: Photos on iOS and macOS sorts by DateTimeOriginal, and without it a whole
 * downloaded album lands on the day it was downloaded.
 *
 * The block is built from the manifest's summary fields (`takenAt`, `exif`), never copied from the
 * camera file. That is deliberate: the camera's block carries GPS and serial numbers, and the
 * summary is also all that exists for photos published before this was added, so new and
 * backfilled photos come out identical.
 *
 * The AVIF is edited at the container level rather than re-encoded (sharp's withExif would
 * re-encode, and the backfill has no originals to encode from). HEIF stores EXIF the way iPhones
 * do in HEIC: an `Exif` item whose payload is a 4-byte offset plus a TIFF block, linked to the
 * image with a `cdsc` ("content describes") reference. Adding it means a new `infe` in `iinf`, a
 * new `iloc` entry, an `iref` entry, and the payload in its own trailing `mdat`. The meta box
 * grows, so every existing file offset in `iloc` that points past it is shifted by the same amount.
 */

// ---------------------------------------------------------------------------- TIFF

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const UNDEFINED = 7;
const TYPE_SIZE = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [RATIONAL]: 8, [UNDEFINED]: 1 };

/**
 * @param {{ takenAt?: string|null, exif?: object, width?: number, height?: number }} photo
 *        the manifest's fields for one photo
 * @returns {Buffer|null} a little-endian TIFF block, or null when there is nothing to record
 */
export function buildExif({ takenAt, exif = {}, width, height }) {
  const date = exifDate(takenAt);
  const ifd0 = [];
  const sub = [];

  if (exif.make) ifd0.push(ascii(0x010f, exif.make));
  if (exif.model) ifd0.push(ascii(0x0110, exif.model));
  // The pixels are already upright: rotation is applied before encoding.
  ifd0.push(short(0x0112, 1));
  if (date) ifd0.push(ascii(0x0132, date));

  const exposure = exposureRational(exif.exposure);
  if (exposure) sub.push(rational(0x829a, exposure));
  if (Number.isFinite(exif.fNumber)) sub.push(rational(0x829d, decimalRational(exif.fNumber)));
  if (Number.isFinite(exif.iso)) sub.push(short(0x8827, Math.min(65535, Math.round(exif.iso))));
  sub.push({ tag: 0x9000, type: UNDEFINED, count: 4, data: Buffer.from('0232', 'latin1') });
  if (date) sub.push(ascii(0x9003, date), ascii(0x9004, date));
  if (Number.isFinite(exif.focal)) sub.push(rational(0x920a, decimalRational(exif.focal)));
  sub.push(short(0xa001, 1)); // sRGB
  if (width && height) sub.push(long(0xa002, width), long(0xa003, height));
  if (exif.lens) sub.push(ascii(0xa434, exif.lens));

  if (!date && !exif.make && !exif.model) return null;

  // IFD0 points at the Exif sub-IFD, which is laid out straight after IFD0 and its data.
  const pointer = long(0x8769, 0);
  ifd0.push(pointer);
  const ifd0Size = ifdSize(ifd0);
  pointer.data.writeUInt32LE(8 + ifd0Size);

  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  return Buffer.concat([header, writeIfd(ifd0, 8), writeIfd(sub, 8 + ifd0Size)]);
}

function ascii(tag, text) {
  const data = Buffer.from(`${String(text).replace(/[^\x20-\x7e]/g, '?')}\0`, 'latin1');
  return { tag, type: ASCII, count: data.length, data };
}

function short(tag, value) {
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value);
  return { tag, type: SHORT, count: 1, data };
}

function long(tag, value) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return { tag, type: LONG, count: 1, data };
}

function rational(tag, [num, den]) {
  const data = Buffer.alloc(8);
  data.writeUInt32LE(num);
  data.writeUInt32LE(den, 4);
  return { tag, type: RATIONAL, count: 1, data };
}

/** `2026-10-02T10:37:29` -> `2026:10:02 10:37:29`, the only form EXIF accepts. */
function exifDate(takenAt) {
  const m = typeof takenAt === 'string' && takenAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}` : null;
}

/** The manifest words exposure as `1/160` or `2s` / `1.3s` (see formatExposure in exif.mjs). */
function exposureRational(text) {
  if (typeof text !== 'string') return null;
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) return [Number(fraction[1]), Number(fraction[2])];
  const seconds = Number.parseFloat(text);
  return Number.isFinite(seconds) && seconds > 0 ? decimalRational(seconds) : null;
}

function decimalRational(n) {
  return [Math.round(n * 10), 10];
}

function outOfLine(entry) {
  const size = entry.count * TYPE_SIZE[entry.type];
  return size > 4 ? size + (size % 2) : 0;
}

function ifdSize(entries) {
  return 2 + entries.length * 12 + 4 + entries.reduce((sum, e) => sum + outOfLine(e), 0);
}

function writeIfd(entries, start) {
  entries.sort((a, b) => a.tag - b.tag);
  const out = Buffer.alloc(ifdSize(entries));
  out.writeUInt16LE(entries.length, 0);
  let dataAt = 2 + entries.length * 12 + 4; // next-IFD offset stays 0
  entries.forEach((e, i) => {
    const at = 2 + i * 12;
    out.writeUInt16LE(e.tag, at);
    out.writeUInt16LE(e.type, at + 2);
    out.writeUInt32LE(e.count, at + 4);
    if (outOfLine(e)) {
      out.writeUInt32LE(start + dataAt, at + 8);
      e.data.copy(out, dataAt);
      dataAt += outOfLine(e);
    } else {
      e.data.copy(out, at + 8);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------- HEIF container

/** True when the file already carries an `Exif` item. */
export function hasExif(avif) {
  const meta = readMeta(avif);
  return readIinf(meta.children.find((c) => c.type === 'iinf')).some((i) => i.type === 'Exif');
}

/**
 * Returns a copy of `avif` with `tiff` attached as its EXIF item. Throws on files that already
 * have one or whose layout it does not understand, rather than guessing.
 */
export function addExif(avif, tiff) {
  const meta = readMeta(avif);
  const child = (type) => meta.children.find((c) => c.type === type);
  const iinf = child('iinf');
  const iloc = child('iloc');
  const pitm = child('pitm');
  if (!iinf || !iloc || !pitm) throw new Error('AVIF has no iinf/iloc/pitm box');

  const infos = readIinf(iinf);
  if (infos.some((i) => i.type === 'Exif')) throw new Error('AVIF already has an Exif item');
  const primary = pitm.version === 0 ? pitm.body.readUInt16BE(0) : pitm.body.readUInt32BE(0);
  const locs = readIloc(iloc);
  const exifId = Math.max(primary, ...infos.map((i) => i.id), ...locs.items.map((i) => i.id)) + 1;
  if (exifId > 0xffff) throw new Error('AVIF item ids are exhausted');

  const payload = Buffer.concat([Buffer.alloc(4), tiff]); // 4-byte offset to the TIFF header: 0

  const build = (exifOffset, delta) => {
    const items = locs.items.map((item) => ({
      ...item,
      extents: item.extents.map((x) => ({
        ...x,
        // Only data in this file (construction method 0, data reference 0) moves with the meta box.
        offset: item.method === 0 && item.dataRef === 0 && item.base + x.offset >= meta.end ? x.offset + delta : x.offset,
      })),
    }));
    items.push({ id: exifId, method: 0, dataRef: 0, base: 0, extents: [{ index: 0, offset: exifOffset, length: payload.length }] });

    const hasIref = meta.children.some((c) => c.type === 'iref');
    const children = [];
    for (const c of meta.children) {
      if (c.type === 'iloc') children.push(writeIloc(locs, items));
      else if (c.type === 'iinf') children.push(writeIinf(iinf, exifId));
      else if (c.type === 'iref') children.push(appendCdsc(c, exifId, primary));
      else children.push(c.raw);
      if (c.type === 'iinf' && !hasIref) children.push(appendCdsc(null, exifId, primary));
    }
    return fullBox('meta', meta.version, meta.flags, Buffer.concat(children));
  };

  // Offsets are fixed-width, so the meta box's size does not depend on their values.
  const probe = build(0, 0);
  const delta = probe.length - (meta.end - meta.start);
  const exifOffset = avif.length + delta + 8;
  const newMeta = build(exifOffset, delta);
  const trailer = box('mdat', payload);
  return Buffer.concat([avif.subarray(0, meta.start), newMeta, avif.subarray(meta.end), trailer]);
}

/** Reads the Exif item back out (for tests and checks); null when there is none. */
export function readExif(avif) {
  const meta = readMeta(avif);
  const info = readIinf(meta.children.find((c) => c.type === 'iinf')).find((i) => i.type === 'Exif');
  if (!info) return null;
  const item = readIloc(meta.children.find((c) => c.type === 'iloc')).items.find((i) => i.id === info.id);
  const x = item.extents[0];
  const payload = avif.subarray(item.base + x.offset, item.base + x.offset + x.length);
  return payload.subarray(4 + payload.readUInt32BE(0));
}

function readBoxes(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error('AVIF box sizes are inconsistent');
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, end: p + size, header, raw: buf.subarray(p, p + size) });
    p += size;
  }
  return out;
}

function readMeta(avif) {
  const meta = readBoxes(avif, 0, avif.length).find((b) => b.type === 'meta');
  if (!meta) throw new Error('not an AVIF: no meta box');
  const bodyStart = meta.start + meta.header + 4;
  const children = readBoxes(avif, bodyStart, meta.end).map((c) => ({
    ...c,
    version: avif[c.start + c.header],
    flags: avif.readUIntBE(c.start + c.header + 1, 3),
    body: avif.subarray(c.start + c.header + 4, c.end),
  }));
  return { ...meta, version: avif[meta.start + meta.header], flags: avif.readUIntBE(meta.start + meta.header + 1, 3), children };
}

function readIinf(iinf) {
  if (!iinf) return [];
  const countSize = iinf.version === 0 ? 2 : 4;
  const entries = readBoxes(iinf.body, countSize, iinf.body.length);
  return entries
    .filter((e) => e.type === 'infe')
    .map((e) => {
      const b = iinf.body;
      const version = b[e.start + 8];
      if (version < 2) return { id: b.readUInt16BE(e.start + 12), type: null };
      const id = version === 2 ? b.readUInt16BE(e.start + 12) : b.readUInt32BE(e.start + 12);
      const typeAt = e.start + 12 + (version === 2 ? 2 : 4) + 2;
      return { id, type: b.toString('latin1', typeAt, typeAt + 4) };
    });
}

function writeIinf(iinf, exifId) {
  const countSize = iinf.version === 0 ? 2 : 4;
  const count = countSize === 2 ? iinf.body.readUInt16BE(0) : iinf.body.readUInt32BE(0);
  const head = Buffer.alloc(countSize);
  if (countSize === 2) head.writeUInt16BE(count + 1);
  else head.writeUInt32BE(count + 1);
  const infe = Buffer.alloc(9);
  infe.writeUInt16BE(exifId, 0); // item_ID
  infe.writeUInt16BE(0, 2); // item_protection_index
  infe.write('Exif', 4, 'latin1');
  infe[8] = 0; // empty item_name
  return fullBox('iinf', iinf.version, iinf.flags, Buffer.concat([head, iinf.body.subarray(countSize), fullBox('infe', 2, 0, infe)]));
}

function appendCdsc(iref, exifId, primary) {
  const version = iref ? iref.version : 0;
  const idSize = version === 0 ? 2 : 4;
  const ref = Buffer.alloc(idSize * 2 + 2);
  const put = (v, at) => (idSize === 2 ? ref.writeUInt16BE(v, at) : ref.writeUInt32BE(v, at));
  put(exifId, 0);
  ref.writeUInt16BE(1, idSize);
  put(primary, idSize + 2);
  return fullBox('iref', version, iref ? iref.flags : 0, Buffer.concat([iref ? iref.body : Buffer.alloc(0), box('cdsc', ref)]));
}

function readIloc(iloc) {
  const b = iloc.body;
  const v = iloc.version;
  if (v > 2) throw new Error(`iloc version ${v} is not supported`);
  const offsetSize = b[0] >> 4;
  const lengthSize = b[0] & 15;
  const baseSize = b[1] >> 4;
  const indexSize = v >= 1 ? b[1] & 15 : 0;
  let p = 2;
  const uint = (size) => {
    const value = size === 0 ? 0 : size === 8 ? Number(b.readBigUInt64BE(p)) : b.readUIntBE(p, size);
    p += size;
    return value;
  };
  const count = v < 2 ? uint(2) : uint(4);
  const items = [];
  for (let i = 0; i < count; i++) {
    const id = v < 2 ? uint(2) : uint(4);
    const method = v >= 1 ? uint(2) & 15 : 0;
    const dataRef = uint(2);
    const base = uint(baseSize);
    const extentCount = uint(2);
    const extents = [];
    for (let j = 0; j < extentCount; j++) {
      const index = uint(indexSize);
      extents.push({ index, offset: uint(offsetSize), length: uint(lengthSize) });
    }
    items.push({ id, method, dataRef, base, extents });
  }
  return { version: v, flags: iloc.flags, indexSize, items };
}

function writeIloc({ version, flags, indexSize }, items) {
  // Widths are at least 4 so a shifted offset always fits; 8 only if a value needs it.
  const width = (values) => (values.some((x) => x > 0xffffffff) ? 8 : 4);
  const offsetSize = width(items.flatMap((i) => i.extents.map((x) => x.offset)));
  const lengthSize = width(items.flatMap((i) => i.extents.map((x) => x.length)));
  const baseSize = width(items.map((i) => i.base));
  const parts = [Buffer.from([(offsetSize << 4) | lengthSize, (baseSize << 4) | indexSize])];
  const uint = (value, size) => {
    if (size === 0) return;
    const out = Buffer.alloc(size);
    if (size === 8) out.writeBigUInt64BE(BigInt(value));
    else out.writeUIntBE(value, 0, size);
    parts.push(out);
  };
  uint(items.length, version < 2 ? 2 : 4);
  for (const item of items) {
    uint(item.id, version < 2 ? 2 : 4);
    if (version >= 1) uint(item.method, 2);
    uint(item.dataRef, 2);
    uint(item.base, baseSize);
    uint(item.extents.length, 2);
    for (const x of item.extents) {
      uint(x.index, indexSize);
      uint(x.offset, offsetSize);
      uint(x.length, lengthSize);
    }
  }
  return fullBox('iloc', version, flags, Buffer.concat(parts));
}

function box(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(type, version, flags, body) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, Buffer.concat([vf, body]));
}
