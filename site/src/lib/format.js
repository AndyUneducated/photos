/**
 * Pure formatting helpers shared by the Astro templates (build time) and the
 * lightbox client script (browser). No Node APIs in here.
 */

/**
 * `takenAt` is camera local time with no timezone suffix, so it is parsed by
 * hand: `new Date('2026-09-19T20:14:03')` is engine/timezone dependent and we
 * want the wall-clock time the camera recorded, verbatim.
 */
export function parseTakenAt(takenAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(takenAt || '');
  if (!m) return null;
  return {
    year: +m[1],
    month: +m[2],
    day: +m[3],
    hour: m[4] === undefined ? null : +m[4],
    minute: m[5] === undefined ? null : +m[5],
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** `2026年9月19日` */
export function formatDateZh(takenAt) {
  const t = parseTakenAt(takenAt);
  if (!t) return '';
  return `${t.year}年${t.month}月${t.day}日`;
}

/** `2026年9月19日 20:14` */
export function formatDateTimeZh(takenAt) {
  const t = parseTakenAt(takenAt);
  if (!t) return '';
  const date = `${t.year}年${t.month}月${t.day}日`;
  if (t.hour === null || t.minute === null) return date;
  return `${date} ${pad(t.hour)}:${pad(t.minute)}`;
}

/**
 * `ILCE-7RM5 · FE 24-70mm F2.8 GM II · f/2.8 · 1/125s · ISO 400 · 55mm`
 * Every field is optional; returns '' when nothing is known.
 */
export function formatExif(exif) {
  if (!exif || typeof exif !== 'object') return '';
  const parts = [];

  const body = exif.model || exif.make;
  if (body) parts.push(String(body));

  if (exif.lens) {
    // Phones pack everything into LensModel ("iPhone 15 Pro back camera 6.765mm f/1.78"):
    // the body name, then the focal length and aperture that get their own fields below.
    // Left alone it reads "iPhone 15 Pro · back camera 6.765mm f/1.78 · f/1.78 · … · 24mm",
    // with the aperture twice and two disagreeing focal lengths (physical vs 35mm-equivalent).
    let lens = String(exif.lens);
    if (body && lens.startsWith(String(body))) {
      lens = lens.slice(String(body).length).trim();
    }
    // Only drop the trailing spec when it really is a repeat: the aperture has to match the one
    // we are about to print, and something has to be left over. That keeps a lens whose actual
    // name ends in "24-70mm f/2.8" from being erased.
    const spec = lens.match(/^(.*?)\s*[\d.]+mm\s+f\/([\d.]+)$/i);
    if (spec && spec[1] && Number(spec[2]) === exif.fNumber) lens = spec[1];
    if (lens) parts.push(lens);
  }

  if (typeof exif.fNumber === 'number' && Number.isFinite(exif.fNumber)) {
    // f/2.8 and f/1.78 both need to survive: trim zeros, never round away a digit.
    parts.push('f/' + String(Math.round(exif.fNumber * 100) / 100));
  }
  if (exif.exposure) {
    const e = String(exif.exposure);
    parts.push(/s$/.test(e) ? e : e + 's');
  }
  if (typeof exif.iso === 'number' && Number.isFinite(exif.iso)) parts.push('ISO ' + exif.iso);
  if (typeof exif.focal === 'number' && Number.isFinite(exif.focal)) parts.push(exif.focal + 'mm');

  return parts.join(' · ');
}

export function osmUrl(location) {
  if (!location) return '';
  const { lat, lon } = location;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
}

export function locationLabel(location) {
  if (!location) return '';
  if (location.label) return location.label;
  return `${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`;
}
