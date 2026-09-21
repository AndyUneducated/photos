/**
 * Reads and writes the gallery: `gallery/manifest.json` plus the AVIF files beside it.
 *
 * `gallery/` is a git worktree tracking the `gallery` branch (see `scripts/setup-gallery.mjs`),
 * which is what keeps deleted photos from accumulating in `main`'s history forever.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const GALLERY_DIR = join(ROOT, 'gallery');
export const ALBUMS_DIR = join(GALLERY_DIR, 'albums');
export const MANIFEST_PATH = join(GALLERY_DIR, 'manifest.json');

const MANIFEST_VERSION = 1;

export async function loadConfig() {
  const raw = await readFile(join(ROOT, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

export function emptyManifest(config) {
  return {
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    site: {
      title: config.siteTitle,
      tagline: config.siteTagline,
      passcodeHash: config.passcodeHash || '',
    },
    budgetBytes: config.budgetBytes,
    usedBytes: 0,
    albums: [],
    photos: [],
  };
}

export async function loadManifest(config) {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`manifest.json is version ${manifest.version}, but this build of the tool only understands ${MANIFEST_VERSION}`);
    }
    // Site-level settings live in config.json and are re-stamped on every write, so that editing
    // config.json is enough to change the title or passcode.
    manifest.site = emptyManifest(config).site;
    manifest.budgetBytes = config.budgetBytes;
    return manifest;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyManifest(config);
    throw err;
  }
}

export async function saveManifest(manifest) {
  manifest.usedBytes = manifest.photos.reduce((sum, p) => sum + (p.bytes || 0), 0);
  sortManifest(manifest);

  // Compare against what is already on disk with updatedAt held at its old value. Bumping the
  // stamp unconditionally would make every save byte-different, so publishGallery's tree check
  // could never see a no-op and saving unchanged settings would commit, push and rebuild the site.
  const previous = await readFile(MANIFEST_PATH, 'utf8').catch(() => null);
  const oldStamp = previousStamp(previous);
  if (oldStamp) {
    manifest.updatedAt = oldStamp;
    if (`${JSON.stringify(manifest, null, 2)}\n` === previous) return manifest;
  }

  manifest.updatedAt = new Date().toISOString();
  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function previousStamp(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text).updatedAt || null;
  } catch {
    return null;
  }
}

function sortManifest(manifest) {
  // Newest first, with the id as a tiebreaker so the order is stable across runs.
  manifest.photos.sort((a, b) => cmpDesc(a.takenAt, b.takenAt) || a.id.localeCompare(b.id));
  manifest.albums.sort((a, b) => cmpDesc(a.date, b.date) || a.id.localeCompare(b.id));

  for (const album of manifest.albums) {
    const photos = manifest.photos.filter((p) => p.albumId === album.id);
    album.photoCount = photos.length;
    album.bytes = photos.reduce((sum, p) => sum + (p.bytes || 0), 0);
    if (!photos.some((p) => p.id === album.coverPhotoId)) {
      album.coverPhotoId = photos[0]?.id ?? null;
    }
  }
}

function cmpDesc(a, b) {
  const x = a || '';
  const y = b || '';
  return x === y ? 0 : x < y ? 1 : -1;
}

/**
 * Turns an album title into a filesystem- and URL-safe id, prefixed with the shoot date so that
 * the folder listing sorts chronologically.
 *
 * CJK titles are common here and would slugify to nothing, so the date prefix doubles as the
 * fallback identity and a short counter disambiguates same-day albums.
 */
export function albumId(title, date, existingIds = []) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    // Keep ASCII slugs readable but drop non-ASCII, which would percent-encode into noise.
    .replace(/[^\x20-\x7e]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const base = slug ? `${date}-${slug}` : date;
  if (!existingIds.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
}

export function albumDir(id) {
  return join(ALBUMS_DIR, id);
}

/** Site-root-relative paths, which is what the manifest and the website use. */
export function photoPaths(albumIdValue, photoId) {
  return {
    web: `p/${albumIdValue}/w/${photoId}.avif`,
    thumb: `p/${albumIdValue}/t/${photoId}.avif`,
  };
}

export async function writePhotoFiles(albumIdValue, photoId, webBuf, thumbBuf) {
  const dir = albumDir(albumIdValue);
  await mkdir(join(dir, 'w'), { recursive: true });
  await mkdir(join(dir, 't'), { recursive: true });
  await writeFile(join(dir, 'w', `${photoId}.avif`), webBuf);
  await writeFile(join(dir, 't', `${photoId}.avif`), thumbBuf);
  return webBuf.length + thumbBuf.length;
}

export async function removePhotoFiles(albumIdValue, photoId) {
  const dir = albumDir(albumIdValue);
  await rm(join(dir, 'w', `${photoId}.avif`), { force: true });
  await rm(join(dir, 't', `${photoId}.avif`), { force: true });
}

export async function removeAlbumFiles(albumIdValue) {
  await rm(albumDir(albumIdValue), { recursive: true, force: true });
}

export function deletePhotos(manifest, photoIds) {
  const ids = new Set(photoIds);
  const removed = manifest.photos.filter((p) => ids.has(p.id));
  manifest.photos = manifest.photos.filter((p) => !ids.has(p.id));
  return removed;
}

export function deleteAlbum(manifest, id) {
  const removed = manifest.photos.filter((p) => p.albumId === id);
  manifest.photos = manifest.photos.filter((p) => p.albumId !== id);
  manifest.albums = manifest.albums.filter((a) => a.id !== id);
  return removed;
}

/**
 * Reports how much of the storage budget is used, and which albums to drop first if it is
 * exceeded. GitHub Pages refuses to publish a site over 1GB, so the budget exists to keep us
 * comfortably under that rather than as a soft preference.
 */
export function budgetReport(manifest) {
  const usedBytes = manifest.photos.reduce((sum, p) => sum + (p.bytes || 0), 0);
  const budgetBytes = manifest.budgetBytes;
  const overBytes = Math.max(0, usedBytes - budgetBytes);

  // Oldest albums first: the natural eviction order for a rolling family feed.
  const evictionOrder = [...manifest.albums]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map((a) => ({ id: a.id, title: a.title, date: a.date, bytes: a.bytes, photoCount: a.photoCount }));

  const suggestions = [];
  let reclaimed = 0;
  for (const album of evictionOrder) {
    if (reclaimed >= overBytes) break;
    suggestions.push(album);
    reclaimed += album.bytes;
  }

  return {
    usedBytes,
    budgetBytes,
    overBytes,
    freeBytes: Math.max(0, budgetBytes - usedBytes),
    percent: budgetBytes > 0 ? usedBytes / budgetBytes : 0,
    suggestions,
  };
}

/** Total bytes actually on disk under `gallery/`, as a cross-check against the manifest. */
export async function diskUsage(dir = GALLERY_DIR) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await diskUsage(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}
