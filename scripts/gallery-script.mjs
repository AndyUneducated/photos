/**
 * Shared runner for one-off scripts that rewrite already-published photos (backfill-exif,
 * regen-thumbs). It refuses to run alongside the studio, wraps the change in an ordinary gallery
 * transaction so a conflict with GitHub or a failed upload rolls everything back, prints each
 * milestone as it completes, and uploads unless `--local` is given.
 */

import { albumDir, loadConfig, loadManifest, saveManifest } from '../studio/lib/gallery.mjs';
import { galleryTransaction, startOperation, transactionSteps } from '../studio/lib/operations.mjs';

/**
 * @param {object} o
 * @param {string} o.kind
 * @param {string} o.title       shown in crash-recovery reports
 * @param {string} o.stepLabel   the milestone for the per-photo work
 * @param {(changed: number) => string} o.message  commit message
 * @param {(photo: object, ctx: { config: object, dir: string }) => Promise<boolean>} o.eachPhoto
 *        updates one photo's files and manifest entry in place; true when it changed anything
 */
export async function runGalleryScript({ kind, title, stepLabel, message, eachPhoto }) {
  const push = !process.argv.includes('--local');
  const port = Number(process.env.PORT) || 4478;

  if (await fetch(`http://127.0.0.1:${port}/app.css`).then(() => true, () => false)) {
    console.error(`The studio is running (port ${port}). Close it first, then run this again.`);
    process.exit(1);
  }

  let changed = 0;
  const op = startOperation(
    { kind, title, steps: transactionSteps([['work', stepLabel]]) },
    (op) => galleryTransaction(op, {
      message: () => message(changed),
      push,
      apply: async (op) => {
        const config = await loadConfig();
        const manifest = await loadManifest(config);
        await op.step('work', async (step) => {
          for (const [i, photo] of manifest.photos.entries()) {
            step.progress = (i + 1) / manifest.photos.length;
            if (await eachPhoto(photo, { config, dir: albumDir(photo.albumId) })) changed++;
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
      console.log(`${{ done: '✓', failed: '✗', skipped: '–' }[s.state]} ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
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
    else if (git.pushed) console.log('Every photo was already up to date; uploaded the earlier changes GitHub was missing.');
    else console.log('Nothing to do: every photo is already up to date.');
    return;
  }
  console.error(`${op.error.error}\n${op.error.hint || ''}`);
  if (op.state === 'conflict') {
    console.error('GitHub has changes this computer does not. Open the studio and use "Upload them now" or publish once to settle it, then run this again.');
  }
  process.exit(1);
}
