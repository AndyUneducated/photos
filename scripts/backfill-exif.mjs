/**
 * Adds the download EXIF block (shooting time, camera, lens, exposure; never GPS) to published
 * photos that predate it, then publishes the result. New photos get it while processing; see
 * studio/lib/avif-exif.mjs. Safe to run again: photos that already have it are left alone.
 *
 *   node scripts/backfill-exif.mjs            # change and upload
 *   node scripts/backfill-exif.mjs --local    # change and commit here only
 *
 * Runs as an ordinary gallery transaction, so a conflict with GitHub or a failed upload rolls
 * everything back. Close the studio first: both would be writing the same gallery.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { addExif, buildExif, hasExif } from '../studio/lib/avif-exif.mjs';
import { albumDir, loadConfig, loadManifest, saveManifest } from '../studio/lib/gallery.mjs';
import { galleryTransaction, startOperation, transactionSteps } from '../studio/lib/operations.mjs';

const push = !process.argv.includes('--local');
const port = Number(process.env.PORT) || 4478;

if (await fetch(`http://127.0.0.1:${port}/app.css`).then(() => true, () => false)) {
  console.error(`The studio is running (port ${port}). Close it first, then run this again.`);
  process.exit(1);
}

let changed = 0;
const op = startOperation(
  {
    kind: 'backfill-exif',
    title: 'Adding shooting details to published photos',
    steps: transactionSteps([['exif', 'Writing shooting time and camera details into each photo']]),
  },
  (op) => galleryTransaction(op, {
    message: () => `gallery: add shooting details to ${changed} photos`,
    push,
    apply: async (op) => {
      const manifest = await loadManifest(await loadConfig());
      await op.step('exif', async (step) => {
        for (const [i, photo] of manifest.photos.entries()) {
          const file = join(albumDir(photo.albumId), 'w', `${photo.id}.avif`);
          const before = await readFile(file);
          step.progress = (i + 1) / manifest.photos.length;
          if (hasExif(before)) continue;
          const tiff = buildExif({ takenAt: photo.takenAt, exif: photo.exif, width: photo.w, height: photo.h });
          if (!tiff) continue;
          const after = addExif(before, tiff);
          await writeFile(file, after);
          photo.bytes += after.length - before.length;
          changed++;
        }
        await saveManifest(manifest);
        step.detail = `${changed} of ${manifest.photos.length} photos updated`;
      });
      return { changed };
    },
  }),
);

const reported = new Set();
const report = () => {
  for (const s of op.steps) {
    if (!['done', 'failed', 'skipped'].includes(s.state) || reported.has(s.id)) continue;
    reported.add(s.id);
    console.log(`${mark(s.state)} ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
  }
};
while (op.state === 'running') {
  report();
  await new Promise((r) => setTimeout(r, 200));
}
report();

if (op.state === 'done') {
  const { changed: count, git } = op.result;
  if (count) console.log(`Done: ${count} photos updated${git.pushed ? ' and uploaded' : ''}.`);
  else if (git.pushed) console.log('Every photo already had its details; uploaded the earlier changes GitHub was missing.');
  else console.log('Nothing to do: every photo already has its details.');
} else {
  console.error(`${op.error.error}\n${op.error.hint || ''}`);
  if (op.state === 'conflict') console.error('GitHub has changes this computer does not. Open the studio and use "Upload them now" or publish once to settle it, then run this again.');
  process.exit(1);
}

function mark(state) {
  return { done: '✓', failed: '✗', skipped: '–' }[state];
}
