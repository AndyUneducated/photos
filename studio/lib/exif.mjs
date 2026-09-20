/**
 * EXIF extraction. exifr reads HEIC, JPEG and TIFF containers, so one code path covers both the
 * A7R V's .HIF files and anything exported from Lightroom.
 */

import exifr from 'exifr';

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

/**
 * @returns {Promise<{exif: object, takenAt: string|null, orientation: number,
 *                    declaredWidth: number|null, declaredHeight: number|null,
 *                    gps: {lat: number, lon: number}|null}>}
 */
export async function readExif(buf) {
  let raw = null;
  try {
    raw = await exifr.parse(buf, EXIF_OPTIONS);
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
    takenAt: formatNaiveDate(raw.DateTimeOriginal || raw.CreateDate || raw.ModifyDate),
    orientation: firstNumber(raw.Orientation) || 1,
    declaredWidth: firstNumber(raw.ExifImageWidth, raw.ImageWidth) || null,
    declaredHeight: firstNumber(raw.ExifImageHeight, raw.ImageHeight) || null,
    gps,
  };
}

/**
 * Formats a Date as a timezone-less `YYYY-MM-DDTHH:mm:ss` string.
 *
 * exifr builds Dates from the literal EXIF digits interpreted in the host timezone, so reading
 * them back with local getters returns exactly the wall-clock time the camera recorded — which is
 * what we want to show, regardless of where the photo was taken or where this script runs.
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
