/**
 * Post-build step: copy the gallery's AVIF files into the built site.
 *
 * The photos deliberately do not live in `site/public/`, because they are on a separate git branch
 * checked out at `gallery/`. Astro therefore never sees them, and we splice them into `dist/` here
 * under the same `p/...` paths the manifest records.
 */

import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ALBUMS_DIR = join(ROOT, 'gallery', 'albums');
const DIST_DIR = join(ROOT, 'dist');
const DEST_DIR = join(DIST_DIR, 'p');

/** GitHub Pages refuses to publish a site larger than 1GB. */
const PAGES_LIMIT_BYTES = 1024 * 1024 * 1024;

const albums = await readdir(ALBUMS_DIR, { withFileTypes: true }).catch(() => null);

if (!albums) {
  console.log('collect: no gallery/albums directory, skipping (the build will be an empty gallery site).');
} else {
  await mkdir(DEST_DIR, { recursive: true });

  let copied = 0;
  for (const album of albums) {
    if (!album.isDirectory()) continue;
    await cp(join(ALBUMS_DIR, album.name), join(DEST_DIR, album.name), { recursive: true });
    copied++;
  }

  console.log(`collect: copied ${copied} album(s) into dist/p/`);
}

const total = await dirSize(DIST_DIR);
console.log(`collect: dist/ is ${(total / 1024 / 1024).toFixed(1)} MB in total`);

if (total > PAGES_LIMIT_BYTES) {
  console.error(
    `collect: dist/ is over the 1GB GitHub Pages limit (${(total / 1024 / 1024).toFixed(1)} MB).` +
      ' The deploy will be rejected; delete some old albums in the photo studio first.',
  );
  process.exit(1);
}

// A soft warning well before the hard limit, so there is time to act.
if (total > PAGES_LIMIT_BYTES * 0.9) {
  console.warn('collect: more than 90% of the Pages quota is used; consider clearing out old albums.');
}

await verifyManifest();

/**
 * Cross-checks that every path the manifest promises actually exists in `dist/`. A missing file
 * here means broken images on the live site, which is much cheaper to catch now than later.
 */
async function verifyManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
  } catch {
    return;
  }

  const missing = [];
  for (const photo of manifest.photos ?? []) {
    for (const key of ['web', 'thumb']) {
      const path = join(DIST_DIR, photo[key]);
      try {
        await stat(path);
      } catch {
        missing.push(photo[key]);
      }
    }
  }

  if (missing.length) {
    console.error(`collect: ${missing.length} file(s) listed in the manifest are missing from dist/:`);
    for (const path of missing.slice(0, 10)) console.error(`  - ${path}`);
    process.exit(1);
  }

  console.log(`collect: manifest verified (${manifest.photos?.length ?? 0} photos)`);
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}
