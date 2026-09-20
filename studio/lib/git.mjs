/**
 * Git plumbing for publishing.
 *
 * The photos do not live on `main`. They live on an orphan branch called `gallery`, checked out as
 * a worktree at `gallery/`, and every publish replaces that branch with a single parentless commit.
 *
 * The reason: git keeps every version of every file it has ever committed, so deleting a photo from
 * a normal branch frees no space at all — the blob stays in history forever and the repository only
 * ever grows. With a single-commit branch, the repository is always exactly as large as the current
 * gallery. Pushes stay cheap because git deduplicates blobs by content hash, so re-committing 600MB
 * of unchanged photos uploads nothing.
 */

import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';

import { GALLERY_DIR, ROOT } from './gallery.mjs';

/** The canonical hash of git's empty tree; used to seed the gallery branch. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const IDENTITY_FALLBACK = ['-c', 'user.name=photos studio', '-c', 'user.email=studio@localhost'];

export class GitError extends Error {
  constructor(message, { args, stderr }) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

export function git(args, { cwd = ROOT, stdin } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new GitError(stderr.trim() || `git ${args[0]} 退出码 ${code}`, { args, stderr }));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function gitOrNull(args, opts) {
  try {
    return await git(args, opts);
  } catch {
    return null;
  }
}

/**
 * git refuses to create a commit without a committer identity. Rather than fail a publish over it,
 * fall back to a local-only identity when the user has no global git config.
 */
async function identityArgs() {
  const name = await gitOrNull(['config', '--get', 'user.name']);
  const email = await gitOrNull(['config', '--get', 'user.email']);
  return name && email ? [] : IDENTITY_FALLBACK;
}

export async function status() {
  const branch = await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = await gitOrNull(['remote', 'get-url', 'origin']);
  const galleryBranchExists = (await gitOrNull(['rev-parse', '--verify', '--quiet', 'refs/heads/gallery'])) !== null;
  const worktreeReady = await isGalleryWorktree();
  const name = await gitOrNull(['config', '--get', 'user.name']);
  const email = await gitOrNull(['config', '--get', 'user.email']);

  return {
    branch,
    remote,
    galleryBranchExists,
    worktreeReady,
    hasIdentity: Boolean(name && email),
    ready: Boolean(remote) && worktreeReady,
  };
}

async function isGalleryWorktree() {
  const listing = await gitOrNull(['worktree', 'list', '--porcelain']);
  if (!listing) return false;
  const normalised = GALLERY_DIR.replace(/\\/g, '/').toLowerCase();
  return listing
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => line.slice('worktree '.length).replace(/\\/g, '/').toLowerCase() === normalised);
}

/**
 * Creates the `gallery` branch and its worktree if they are not already there. Safe to call on
 * every startup.
 */
export async function ensureGalleryWorktree() {
  if (await isGalleryWorktree()) return { created: false };

  const occupied = await directoryHasContent(GALLERY_DIR);
  if (occupied) {
    throw new Error(
      `gallery/ 目录已经存在且非空，但它不是 git worktree。请先把里面的东西移走或删掉，再重新运行初始化。`,
    );
  }

  const ident = await identityArgs();
  const exists = await gitOrNull(['rev-parse', '--verify', '--quiet', 'refs/heads/gallery']);
  if (!exists) {
    const commit = await git([...ident, 'commit-tree', EMPTY_TREE, '-m', 'gallery: 初始化（空）']);
    await git(['branch', 'gallery', commit]);
  }

  // A bare branch name here (rather than `refs/heads/gallery`) is deliberate: it makes git check
  // the branch out in the new worktree instead of leaving it on a detached HEAD.
  await git(['worktree', 'add', GALLERY_DIR, 'gallery']);
  return { created: true };
}

async function directoryHasContent(dir) {
  try {
    await access(dir);
  } catch {
    return false;
  }
  const entries = await readdir(dir);
  return entries.length > 0;
}

/**
 * Commits the current contents of `gallery/` as a fresh single-commit `gallery` branch and, when a
 * remote exists, force-pushes it.
 *
 * Uses plumbing rather than `git checkout --orphan` + `git commit` so that the branch ref moves
 * atomically and the worktree is never left on a temporary branch if something fails midway.
 */
export async function publishGallery(message, { push = true } = {}) {
  const ident = await identityArgs();

  await git(['add', '-A'], { cwd: GALLERY_DIR });
  const tree = await git(['write-tree'], { cwd: GALLERY_DIR });

  const head = await gitOrNull(['rev-parse', 'HEAD'], { cwd: GALLERY_DIR });
  if (head) {
    const headTree = await gitOrNull(['rev-parse', 'HEAD^{tree}'], { cwd: GALLERY_DIR });
    if (headTree === tree) return { changed: false, commit: head, pushed: false };
  }

  // No `-p`: the commit is deliberately parentless, which is what keeps the branch a single commit.
  const commit = await git([...ident, 'commit-tree', tree, '-m', message], { cwd: GALLERY_DIR });
  await git(['update-ref', 'refs/heads/gallery', commit], { cwd: GALLERY_DIR });

  let pushed = false;
  if (push) {
    const remote = await gitOrNull(['remote', 'get-url', 'origin']);
    if (remote) {
      await git(['push', '--force', 'origin', 'gallery:gallery']);
      pushed = true;
    }
  }

  return { changed: true, commit, pushed };
}

/** Commits and pushes changes on `main`. Never forced — `main` keeps a normal history. */
export async function publishCode(message) {
  const ident = await identityArgs();
  const dirty = await git(['status', '--porcelain']);
  if (!dirty) return { changed: false, pushed: false };

  await git(['add', '-A']);
  await git([...ident, 'commit', '-m', message]);

  const remote = await gitOrNull(['remote', 'get-url', 'origin']);
  if (!remote) return { changed: true, pushed: false };

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  await git(['push', '-u', 'origin', `${branch}:${branch}`]);
  return { changed: true, pushed: true };
}

/**
 * Drops the objects left behind by previous gallery commits. Force-pushing an orphan branch makes
 * the old commits unreachable, but git keeps unreachable objects for 90 days by default, so local
 * disk use keeps climbing until they are expired explicitly.
 */
export async function reclaimSpace() {
  const before = await repoSizeBytes();
  await git(['reflog', 'expire', '--expire-unreachable=now', '--all']);
  await git(['gc', '--prune=now', '--quiet']);
  const after = await repoSizeBytes();
  return { before, after, freed: Math.max(0, before - after) };
}

async function repoSizeBytes() {
  const out = await gitOrNull(['count-objects', '-v']);
  if (!out) return 0;
  const sizes = Object.fromEntries(
    out.split('\n').map((line) => {
      const [key, value] = line.split(':');
      return [key?.trim(), Number(value)];
    }),
  );
  // `size` and `size-pack` are reported in KiB.
  return ((sizes.size || 0) + (sizes['size-pack'] || 0)) * 1024;
}
