/**
 * Build-time loader for gallery/manifest.json (see MANIFEST.md).
 *
 * Resolution order:
 *   1. gallery/manifest.json      real data written by the studio uploader
 *   2. site/fixtures/manifest.json  dev fixture
 *   3. hardcoded empty manifest   so the build never crashes
 *
 * Everything here runs in Node at build time only. The returned object is
 * normalised so that templates never have to null-check the contract.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deliberately not derived from `import.meta.url`: Astro bundles this module into a temporary
 * directory before executing it, so `import.meta.url` points somewhere under that scratch
 * directory and every relative path computed from it silently misses. That failure mode is
 * particularly nasty here, because missing both sources looks exactly like an empty gallery.
 *
 * Both `astro build` and `astro dev` run with the project root as the working directory, so we
 * walk up from there until we find this project's own marker files.
 */
function findRoot() {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'astro.config.mjs')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = findRoot();

const GALLERY_MANIFEST = path.join(ROOT, 'gallery', 'manifest.json');
const FIXTURE_MANIFEST = path.join(ROOT, 'site', 'fixtures', 'manifest.json');

// Real data always wins, so fixtures can never leak onto the live site. Once the gallery exists
// but is empty, `PHOTOS_FIXTURES=1` is the way to get the fixture data back for local design work.
const SOURCES =
  process.env.PHOTOS_FIXTURES === '1'
    ? [FIXTURE_MANIFEST, GALLERY_MANIFEST]
    : [GALLERY_MANIFEST, FIXTURE_MANIFEST];

const EMPTY = {
  version: 1,
  updatedAt: null,
  site: { title: 'Photos', tagline: '', passcodeHash: '' },
  budgetBytes: 0,
  usedBytes: 0,
  albums: [],
  photos: [],
};

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Site-root-relative manifest path -> absolute URL path for an <img src>. */
export function assetUrl(p) {
  return '/' + String(p || '').replace(/^\/+/, '');
}

function normalizePhoto(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  const web = str(raw.web);
  const thumb = str(raw.thumb);
  if (!id || !web || !thumb) return null;

  // Every exif field is individually optional; keep only the ones actually present.
  const exifIn = raw.exif && typeof raw.exif === 'object' ? raw.exif : {};
  const exif = {};
  for (const key of ['make', 'model', 'lens', 'fNumber', 'exposure', 'iso', 'focal']) {
    const v = exifIn[key];
    if (v === null || v === undefined || v === '') continue;
    exif[key] = v;
  }

  // location only exists when the album opted in, and only counts with real coords.
  let location = null;
  const loc = raw.location;
  if (loc && typeof loc === 'object' && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    location = { lat: loc.lat, lon: loc.lon, label: str(loc.label) };
  }

  const w = num(raw.w, 0);
  const h = num(raw.h, 0);

  return {
    id,
    albumId: str(raw.albumId),
    web,
    thumb,
    w,
    h,
    // Fall back to the web dimensions so width/height attributes are never 0
    // (a 0x0 <img> would reintroduce layout shift).
    tw: num(raw.tw, 0) || w || 1,
    th: num(raw.th, 0) || h || 1,
    lqip: str(raw.lqip),
    bytes: num(raw.bytes, 0),
    takenAt: str(raw.takenAt),
    caption: str(raw.caption),
    exif,
    location,
  };
}

function normalize(data, source) {
  const base = data && typeof data === 'object' ? data : {};
  const siteIn = base.site && typeof base.site === 'object' ? base.site : {};

  const photos = Array.isArray(base.photos)
    ? base.photos.map(normalizePhoto).filter(Boolean)
    : [];

  const counts = new Map();
  for (const p of photos) counts.set(p.albumId, (counts.get(p.albumId) || 0) + 1);

  const albums = (Array.isArray(base.albums) ? base.albums : [])
    .filter((a) => a && typeof a === 'object' && str(a.id))
    .map((a) => ({
      id: str(a.id),
      title: str(a.title) || str(a.id),
      date: str(a.date),
      // coverPhotoId is allowed to be missing entirely.
      coverPhotoId: str(a.coverPhotoId) || null,
      showLocation: a.showLocation === true,
      // Trust what we actually render over what the manifest claims.
      photoCount: counts.get(str(a.id)) || 0,
      bytes: num(a.bytes, 0),
    }))
    // An album with nothing to show would render a dead filter chip.
    .filter((a) => a.photoCount > 0);

  return {
    version: num(base.version, 1),
    updatedAt: str(base.updatedAt) || null,
    site: {
      title: str(siteIn.title) || EMPTY.site.title,
      tagline: str(siteIn.tagline),
      passcodeHash: str(siteIn.passcodeHash).trim().toLowerCase(),
    },
    budgetBytes: num(base.budgetBytes, 0),
    usedBytes: num(base.usedBytes, 0),
    albums,
    photos,
    source,
  };
}

let cached = null;

export function loadManifest() {
  if (cached) return cached;

  for (const file of SOURCES) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      cached = normalize(JSON.parse(text), path.relative(ROOT, file).replaceAll('\\', '/'));
      return cached;
    } catch (err) {
      console.warn(`[manifest] ${file} is not valid JSON, skipping: ${err.message}`);
    }
  }

  cached = normalize(EMPTY, 'empty');
  return cached;
}

export default loadManifest;
