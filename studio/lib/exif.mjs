/**
 * EXIF extraction.
 *
 * exifr does the tag decoding, but it is not allowed to identify HEIF files: its brand check
 * rejects the 10-bit `.HIF` files the A7R V writes. We locate the Exif item ourselves and give
 * exifr a bare TIFF block, which it reads the same way for every container.
 */

import exifr from 'exifr';

import { isHeif, readExifBlock } from './heif.mjs';

const EXIF_OPTIONS = {
  tiff: true,
  ifd0: true,
  exif: true,
  gps: true,
  xmp: false,
  iptc: false,
  icc: false,
  jfif: false,
  mergeOutput: true,
  translateKeys: true,
  translateValues: true,
  reviveValues: true,
  sanitize: true,
};

/** Same read, but with the timestamps left as the raw `YYYY:MM:DD HH:mm:ss` digits. */
const UNREVIVED_OPTIONS = { ...EXIF_OPTIONS, gps: false, reviveValues: false, translateValues: false };

/**
 * @returns {Promise<{exif: object, takenAt: string|null, orientation: number,
 *                    declaredWidth: number|null, declaredHeight: number|null,
 *                    gps: {lat: number, lon: number}|null}>}
 */
export async function readExif(buf) {
  // A HEIF file is reduced to its TIFF block first; see readExifBlock for why exifr cannot be
  // left to recognise the container itself.
  const source = (isHeif(buf) && readExifBlock(buf)) || buf;

  let raw = null;
  try {
    raw = await exifr.parse(source, EXIF_OPTIONS);
  } catch {
    // Unreadable or absent EXIF is not an error; the photo is still perfectly publishable.
  }
  raw ||= {};

  const lens = firstString(raw.LensModel, raw.LensMake, raw.LensInfo);
  const focal = firstNumber(raw.FocalLength);

  const exif = compact({
    make: normaliseMake(firstString(raw.Make)),
    model: firstString(raw.Model),
    lens: lens && lens !== 'Unknown' ? lens : undefined,
    fNumber: round(firstNumber(raw.FNumber), 1),
    exposure: formatExposure(firstNumber(raw.ExposureTime)),
    iso: firstNumber(raw.ISO, raw.ISOSpeedRatings, raw.PhotographicSensitivity),
    focal: round(focal, 0),
  });

  const lat = firstNumber(raw.latitude);
  const lon = firstNumber(raw.longitude);
  const gps = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;

  return {
    exif,
    takenAt: await readTakenAt(source, raw),
    orientation: firstNumber(raw.Orientation) || 1,
    declaredWidth: firstNumber(raw.ExifImageWidth, raw.ImageWidth) || null,
    declaredHeight: firstNumber(raw.ExifImageHeight, raw.ImageHeight) || null,
    gps,
  };
}

/**
 * Returns the moment the shutter fired, worded the way the camera worded it:
 * `YYYY-MM-DDTHH:mm:ss`, with no timezone.
 *
 * This deliberately reads the undecoded digits instead of exifr's revived Date. When a file
 * carries OffsetTimeOriginal — the A7R V writes one — exifr resolves the timestamp to an absolute
 * instant, and rendering that instant here would relabel the photo in *this machine's* timezone.
 * Photos taken abroad and uploaded after getting home would show, sort and group under the wrong
 * local time, usually the wrong day too. The literal digits are what the photographer saw on the
 * back of the camera, so those are what we keep.
 */
async function readTakenAt(source, revived) {
  try {
    const raw = await exifr.parse(source, UNREVIVED_OPTIONS);
    const literal = firstString(raw?.DateTimeOriginal, raw?.CreateDate, raw?.ModifyDate);
    const parts = literal?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (parts) return `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}`;
  } catch {
    // Fall back to the revived value below.
  }
  return formatNaiveDate(revived.DateTimeOriginal || revived.CreateDate || revived.ModifyDate);
}

/**
 * Last resort for files whose timestamps only survived as a Date: read it back with local getters.
 * Accurate only when the photo's timezone matches this machine's, which is why readTakenAt tries
 * the raw digits first.
 */
function formatNaiveDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `0.008` -> `1/125`, `2` -> `2s`. */
function formatExposure(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds >= 1) return `${round(seconds, 1)}s`;
  return `1/${Math.round(1 / seconds)}`;
}

/** Cameras write `SONY`, `NIKON CORPORATION`, `Apple`; collapse the shoutiest of these. */
function normaliseMake(make) {
  if (!make) return undefined;
  const trimmed = make.trim().replace(/\s+CORPORATION$/i, '');
  return trimmed || undefined;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v[0].trim();
  }
  return undefined;
}

function firstNumber(...values) {
  for (const v of values) {
    const n = Array.isArray(v) ? Number(v[0]) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function round(n, digits) {
  if (!Number.isFinite(n)) return undefined;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Rounds coordinates to a coarse grid so a published photo cannot pinpoint a home address.
 * 0.05 degrees is roughly 5km of latitude, which still lands you in the right neighbourhood.
 */
export function fuzzCoordinates({ lat, lon }, gridDegrees = 0.05) {
  const snap = (v) => Math.round(v / gridDegrees) * gridDegrees;
  return { lat: round(snap(lat), 3), lon: round(snap(lon), 3) };
}
