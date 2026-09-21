/**
 * One-time (idempotent) setup of the `gallery` orphan branch and its worktree at `gallery/`.
 * The studio calls the same code on startup; this exists so it can also be done from a terminal.
 */

import { ensureGalleryWorktree, status } from '../studio/lib/git.mjs';

const before = await status();
console.log(`Current branch : ${before.branch ?? '(unknown)'}`);
console.log(`Remote         : ${before.remote ?? '(not configured)'}`);
console.log(`git identity   : ${before.hasIdentity ? 'configured' : 'not configured (a local fallback identity will be used)'}`);

const { created } = await ensureGalleryWorktree();
console.log(created ? 'Created the gallery branch and the gallery/ worktree.' : 'The gallery/ worktree is already in place, nothing to do.');

const after = await status();
if (!after.remote) {
  console.log('\nThere is no origin remote yet. Once the GitHub repository exists, run:');
  console.log('  git remote add origin https://github.com/<username>/photos.git');
  console.log('  git push -u origin main');
}
