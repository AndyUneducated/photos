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
  console.log('collect: 没有 gallery/albums 目录，跳过（构建出来的是空相册站）。');
} else {
  await mkdir(DEST_DIR, { recursive: true });

  let copied = 0;
  for (const album of albums) {
    if (!album.isDirectory()) continue;
    await cp(join(ALBUMS_DIR, album.name), join(DEST_DIR, album.name), { recursive: true });
    copied++;
  }

  console.log(`collect: 已复制 ${copied} 个相册到 dist/p/`);
}

const total = await dirSize(DIST_DIR);
console.log(`collect: dist/ 共 ${(total / 1024 / 1024).toFixed(1)} MB`);

if (total > PAGES_LIMIT_BYTES) {
  console.error(
    `collect: dist/ 超过了 GitHub Pages 的 1GB 上限（${(total / 1024 / 1024).toFixed(1)} MB）。` +
      ' 部署会被拒绝，请先在相册工作台里删掉一些旧相册。',
  );
  process.exit(1);
}

// A soft warning well before the hard limit, so there is time to act.
if (total > PAGES_LIMIT_BYTES * 0.9) {
  console.warn('collect: 已经用掉 90% 以上的 Pages 配额，建议清理旧相册。');
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
    console.error(`collect: manifest 里有 ${missing.length} 个文件在 dist/ 里不存在：`);
    for (const path of missing.slice(0, 10)) console.error(`  - ${path}`);
    process.exit(1);
  }

  console.log(`collect: manifest 校验通过（${manifest.photos?.length ?? 0} 张照片）`);
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
