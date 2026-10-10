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
 *
 * Because every publish is a force-push of a parentless commit, git's own ancestry cannot tell
 * "the remote moved on" from "this machine is ahead". Two private refs stand in for it:
 *
 *   refs/studio/synced  the last commit this machine knows GitHub held (set after every successful
 *                       push, or when the remote is seen to match). It is the merge base.
 *   refs/studio/remote  what GitHub holds right now, refreshed on every check.
 *
 * Whether a push is needed is decided by comparing the local tree with the *remote* tree, never
 * with the local HEAD — a commit that was made but never reached GitHub still gets pushed next time.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { GALLERY_DIR, ROOT } from './gallery.mjs';

/**
 * GitHub Actions reads a workflow from the branch that was pushed, so a push to `gallery` triggers
 * nothing unless that branch carries the workflow itself. Copying it in on every publish is what
 * makes uploading a photo rebuild the site, and copying (rather than committing it once) keeps the
 * two copies from drifting apart.
 */
const WORKFLOW_PATH = join('.github', 'workflows', 'deploy.yml');

/** The canonical hash of git's empty tree; used to seed the gallery branch. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const IDENTITY_FALLBACK = ['-c', 'user.name=photos studio', '-c', 'user.email=studio@localhost'];

export const REF_SYNCED = 'refs/studio/synced';
export const REF_REMOTE = 'refs/studio/remote';
const BRANCH_REF = 'refs/heads/gallery';

export class GitError extends Error {
  constructor(message, { args, stderr, exitCode, cwd }) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.cwd = cwd;
  }
}

/**
 * Runs git and resolves with trimmed stdout.
 *
 * Terminal prompts are off unless `interactive` is set: the studio's git runs with no terminal
 * attached, and a credential prompt there would hang the publish forever with nothing on screen.
 * Failing fast lets the error explain how to sign in instead.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, stdin?: string, onStderr?: (chunk: string) => void, interactive?: boolean }} [opts]
 */
export function git(args, { cwd = ROOT, stdin, onStderr, interactive = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const env = interactive ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const child = spawn('git', args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      stderr += d;
      onStderr?.(String(d));
    });
    child.on('error', (err) => {
      reject(err.code === 'ENOENT'
        ? new GitError('git is not installed, or not on the PATH.', { args, stderr: '', exitCode: null, cwd })
        : err);
    });
    child.on('close', (code) => {
      if (code === 0) return resolvePromise(stdout.trim());
      const text = settledLines(stderr);
      reject(new GitError(text || `git ${args[0]} exited with code ${code}`, { args, stderr: text, exitCode: code, cwd }));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Git redraws progress lines with \r; keep only what a terminal would finally show. */
function settledLines(text) {
  return text
    .split('\n')
    .map((line) => line.split('\r').map((part) => part.trimEnd()).filter(Boolean).pop() || '')
    .join('\n')
    .trim();
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

export async function remoteUrl() {
  return gitOrNull(['remote', 'get-url', 'origin']);
}

/** Cheap, offline status for the UI. Never touches the network. */
export async function status() {
  const branch = await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = await remoteUrl();
  const galleryBranchExists = (await treeOf(BRANCH_REF)) !== null;
  const worktreeReady = await isGalleryWorktree();
  const name = await gitOrNull(['config', '--get', 'user.name']);
  const email = await gitOrNull(['config', '--get', 'user.email']);

  let unpushed = null;
  if (worktreeReady && remote) {
    const synced = await treeOf(REF_SYNCED);
    const local = await treeOf(BRANCH_REF);
    // Unknown (null) until the first successful check or push records what GitHub holds.
    if (synced && local) unpushed = synced !== local;
  }

  return {
    branch,
    remote,
    galleryBranchExists,
    worktreeReady,
    hasIdentity: Boolean(name && email),
    ready: Boolean(remote) && worktreeReady,
    unpushed,
  };
}

async function treeOf(rev, cwd = ROOT) {
  return gitOrNull(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], { cwd });
}

async function commitOf(rev, cwd = ROOT) {
  return gitOrNull(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd });
}

/** Compares paths as the filesystem would: through symlinks (macOS /var → /private/var) and case-folded where the filesystem usually is. */
async function samePath(a, b) {
  const canon = async (p) => {
    const real = await realpath(p).catch(() => p);
    const slashed = real.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'linux' ? slashed : slashed.toLowerCase();
  };
  return (await canon(a)) === (await canon(b));
}

async function isGalleryWorktree() {
  const listing = await gitOrNull(['worktree', 'list', '--porcelain']);
  if (!listing) return false;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ') && await samePath(line.slice('worktree '.length), GALLERY_DIR)) return true;
  }
  return false;
}

/**
 * Creates the `gallery` branch and its worktree if they are not already there. Safe to call on
 * every startup.
 *
 * On a fresh clone the gallery already exists on GitHub, and seeding an empty local branch instead
 * would make the very first publish look like a conflict (or, before conflict checks existed, wipe
 * the live site). So the remote branch is adopted when it can be reached.
 */
export async function ensureGalleryWorktree({ interactive = false } = {}) {
  if (await isGalleryWorktree()) {
    const adopted = await adoptRemoteIfLocalEmpty({ interactive });
    return { created: false, adopted };
  }

  const occupied = await directoryHasContent(GALLERY_DIR);
  if (occupied) {
    throw new Error(
      `The gallery/ directory already exists and is not empty, but it is not a git worktree. Move or delete what is inside it, then run the setup again.`,
    );
  }

  // A worktree that was deleted by hand leaves a stale registration that blocks `worktree add`.
  await gitOrNull(['worktree', 'prune']);

  let adopted = false;
  const exists = await commitOf(BRANCH_REF);
  if (!exists) {
    const remote = await fetchRemoteGallery({ interactive }).catch(() => null);
    if (remote?.exists) {
      await git(['branch', 'gallery', remote.commit]);
      await git(['update-ref', REF_SYNCED, remote.commit]);
      adopted = true;
    } else {
      const ident = await identityArgs();
      const commit = await git([...ident, 'commit-tree', EMPTY_TREE, '-m', 'gallery: initialise (empty)']);
      await git(['branch', 'gallery', commit]);
    }
  }

  // A bare branch name here (rather than `refs/heads/gallery`) is deliberate: it makes git check
  // the branch out in the new worktree instead of leaving it on a detached HEAD.
  await git(['worktree', 'add', GALLERY_DIR, 'gallery']);
  if (!adopted) adopted = await adoptRemoteIfLocalEmpty({ interactive });
  return { created: true, adopted };
}

/** A local gallery that holds no photos and was never synced has nothing to lose by taking GitHub's. */
async function adoptRemoteIfLocalEmpty({ interactive }) {
  if (await commitOf(REF_SYNCED)) return false;
  if (!(await isEmptyGallery(BRANCH_REF))) return false;
  if (await isDirty()) return false;

  const remote = await fetchRemoteGallery({ interactive }).catch(() => null);
  if (!remote?.exists) return false;
  await checkoutGallery(remote.commit);
  await git(['update-ref', REF_SYNCED, remote.commit]);
  return true;
}

async function isEmptyGallery(rev) {
  const tree = await treeOf(rev);
  if (!tree || tree === EMPTY_TREE) return true;
  const manifest = await readManifestAt(rev);
  return !manifest || (manifest.photos || []).length === 0;
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

// ---------------------------------------------------------------------------- remote state

/**
 * Asks GitHub what the gallery branch points at, and fetches it into REF_REMOTE.
 *
 * Throws (with git's stderr preserved) when the remote cannot be reached at all. A missing branch
 * is not an error: it is a brand-new repository.
 *
 * @returns {Promise<{ remote: boolean, exists?: boolean, commit?: string, tree?: string }>}
 */
export async function fetchRemoteGallery({ interactive = false } = {}) {
  if (!(await remoteUrl())) return { remote: false };

  const listing = await git(['ls-remote', 'origin', BRANCH_REF], { interactive });
  const commit = listing.split(/\s+/)[0] || null;
  if (!commit) {
    await gitOrNull(['update-ref', '-d', REF_REMOTE]);
    return { remote: true, exists: false };
  }

  if (!(await commitOf(commit))) {
    await git(['fetch', '--no-tags', '--quiet', 'origin', `+${BRANCH_REF}:${REF_REMOTE}`], { interactive });
  } else {
    await git(['update-ref', REF_REMOTE, commit]);
  }
  return { remote: true, exists: true, commit, tree: await treeOf(commit) };
}

/**
 * Classifies the local gallery against what GitHub holds.
 *
 *   no-remote        nothing to compare with; publishing only commits locally
 *   remote-missing   GitHub has no gallery yet; pushing creates it
 *   in-sync          same contents
 *   ahead            GitHub still holds what we last synced; only this machine changed
 *   behind           only GitHub changed (or this machine has nothing yet); safe to take theirs
 *   diverged         both changed; publishing needs the user to choose
 */
export async function compareWithRemote(remote) {
  const localHead = await commitOf(BRANCH_REF);
  const localTree = await treeOf(BRANCH_REF);
  if (!remote.remote) return { state: 'no-remote', localHead };
  if (!remote.exists) return { state: 'remote-missing', localHead };

  const base = await commitOf(REF_SYNCED);
  const baseTree = base ? await treeOf(base) : null;

  if (remote.tree === localTree) {
    await git(['update-ref', REF_SYNCED, localHead]);
    return { state: 'in-sync', localHead, remoteCommit: remote.commit };
  }
  if (baseTree && remote.tree === baseTree) return { state: 'ahead', localHead, remoteCommit: remote.commit };
  if ((baseTree && localTree === baseTree) || (!base && (await isEmptyGallery(BRANCH_REF)))) {
    return { state: 'behind', localHead, remoteCommit: remote.commit };
  }
  return { state: 'diverged', localHead, remoteCommit: remote.commit, base };
}

async function readManifestAt(rev) {
  const text = await gitOrNull(['show', `${rev}:manifest.json`]);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Describes, album by album, how the remote and local galleries differ — what a forced push would
 * delete from the site and what merging would bring in. Album titles rather than ids, because this
 * is shown to a person deciding whether to overwrite someone else's upload.
 */
export async function describeDivergence({ localHead, remoteCommit, base }) {
  const local = (await readManifestAt(localHead)) || { albums: [], photos: [] };
  const remote = (await readManifestAt(remoteCommit)) || { albums: [], photos: [] };
  const baseManifest = base ? await readManifestAt(base) : null;
  const baseIds = baseManifest ? new Set(baseManifest.albums.map((a) => a.id)) : null;

  const summary = (a) => ({ id: a.id, title: a.title, date: a.date, photoCount: a.photoCount, bytes: a.bytes });
  const localById = new Map(local.albums.map((a) => [a.id, a]));
  const remoteById = new Map(remote.albums.map((a) => [a.id, a]));

  // Without a recorded sync there is no telling an addition on one side from a deletion on the
  // other, so no reason is claimed.
  const why = (id, ifInBase, otherwise) => (baseIds ? (baseIds.has(id) ? ifInBase : otherwise) : undefined);
  const onlyRemote = remote.albums
    .filter((a) => !localById.has(a.id))
    .map((a) => ({ ...summary(a), why: why(a.id, 'deleted on this computer', 'added on another computer') }));
  const onlyLocal = local.albums
    .filter((a) => !remoteById.has(a.id))
    .map((a) => ({ ...summary(a), why: why(a.id, 'deleted on another computer', 'added on this computer') }));
  const changed = local.albums
    .filter((a) => remoteById.has(a.id))
    .map((a) => ({ local: a, remote: remoteById.get(a.id) }))
    .filter(({ local: l, remote: r }) => l.photoCount !== r.photoCount || l.title !== r.title || l.bytes !== r.bytes)
    .map(({ local: l, remote: r }) => ({
      id: l.id,
      title: l.title,
      remoteTitle: r.title,
      localPhotos: l.photoCount,
      remotePhotos: r.photoCount,
    }));

  const commitInfo = async (rev) => {
    const line = await gitOrNull(['log', '-1', '--format=%cI%x09%s', rev]);
    const [date, subject] = (line || '').split('\t');
    return { commit: rev, date: date || null, subject: subject || null };
  };

  return {
    remote: { ...(await commitInfo(remoteCommit)), albums: remote.albums.length, photos: remote.photos.length },
    local: { ...(await commitInfo(localHead)), albums: local.albums.length, photos: local.photos.length },
    onlyRemote,
    onlyLocal,
    changed,
    hasBase: Boolean(baseManifest),
  };
}

/**
 * Three-way merge of two gallery manifests at album and photo level, keyed by id.
 *
 * Starts from the remote and re-applies what this machine did since the last sync: things it added
 * are brought in, things it deleted are removed. Without a recorded base (a machine that predates
 * sync tracking) nothing can be called a deletion, so it degrades to a union — the safe direction.
 *
 * @returns {{ manifest: object, addFiles: string[], removeFiles: string[] }}
 */
export async function mergedManifest({ localHead, remoteCommit, base }) {
  const local = (await readManifestAt(localHead)) || { albums: [], photos: [] };
  const remote = (await readManifestAt(remoteCommit)) || { albums: [], photos: [] };
  const baseManifest = base ? await readManifestAt(base) : null;

  const merge = (key) => {
    const baseIds = baseManifest ? new Set(baseManifest[key].map((x) => x.id)) : new Set();
    const localIds = new Set(local[key].map((x) => x.id));
    const remoteIds = new Set(remote[key].map((x) => x.id));
    const kept = remote[key].filter((x) => localIds.has(x.id) || !baseIds.has(x.id));
    const added = local[key].filter((x) => !remoteIds.has(x.id) && !baseIds.has(x.id));
    const removed = remote[key].filter((x) => !localIds.has(x.id) && baseIds.has(x.id));
    return { items: [...kept, ...added], added, removed };
  };

  const albums = merge('albums');
  const photos = merge('photos');
  const albumIds = new Set(albums.items.map((a) => a.id));
  const keptPhotos = photos.items.filter((p) => albumIds.has(p.albumId));
  const populated = new Set(keptPhotos.map((p) => p.albumId));

  const files = (p) => [p.web, p.thumb].map((path) => path.replace(/^p\//, 'albums/'));
  return {
    manifest: { ...remote, albums: albums.items.filter((a) => populated.has(a.id)), photos: keptPhotos },
    addFiles: photos.added.filter((p) => albumIds.has(p.albumId)).flatMap(files),
    removeFiles: photos.removed.flatMap(files),
  };
}

// ---------------------------------------------------------------------------- local changes

export async function galleryHead() {
  return commitOf(BRANCH_REF);
}

export async function isDirty() {
  const out = await gitOrNull(['status', '--porcelain', '--untracked-files=all'], { cwd: GALLERY_DIR });
  return Boolean(out);
}

/** Puts the gallery branch and worktree at exactly `commit`, discarding anything uncommitted. */
export async function checkoutGallery(commit) {
  await git(['reset', '--hard', '--quiet', commit], { cwd: GALLERY_DIR });
  await git(['clean', '-fd', '--quiet'], { cwd: GALLERY_DIR });
}

/** Restores individual files from a commit into the worktree (used by the merge). */
export async function restoreFiles(commit, paths) {
  // Batched: Windows caps a command line at ~32k characters and a big album has hundreds of files.
  for (let i = 0; i < paths.length; i += 200) {
    await git(['checkout', commit, '--', ...paths.slice(i, i + 200)], { cwd: GALLERY_DIR });
  }
}

/**
 * Commits the current contents of `gallery/` as a fresh single-commit `gallery` branch.
 *
 * Uses plumbing rather than `git checkout --orphan` + `git commit` so that the branch ref moves
 * atomically and the worktree is never left on a temporary branch if something fails midway.
 *
 * @returns {Promise<{ commit: string, tree: string, changed: boolean }>}
 */
export async function commitGallery(message) {
  await syncWorkflow();
  await git(['add', '-A'], { cwd: GALLERY_DIR });
  const tree = await git(['write-tree'], { cwd: GALLERY_DIR });

  const head = await commitOf(BRANCH_REF);
  if (head && (await treeOf(head)) === tree) return { commit: head, tree, changed: false };

  // No `-p`: the commit is deliberately parentless, which is what keeps the branch a single commit.
  const ident = await identityArgs();
  const commit = await git([...ident, 'commit-tree', tree, '-m', message], { cwd: GALLERY_DIR });
  await git(['update-ref', BRANCH_REF, commit], { cwd: GALLERY_DIR });
  return { commit, tree, changed: true };
}

/**
 * Force-pushes the gallery, but only over the exact remote commit that was inspected.
 *
 * `--force-with-lease` makes "check, then push" atomic: if another machine publishes between the
 * check and the push, GitHub rejects it instead of silently deleting their photos.
 *
 * @param {string | null} expectedRemote  the commit seen on GitHub, or null for "must not exist yet"
 * @param {(p: { fraction: number | null, text: string }) => void} [onProgress]
 */
export async function pushGallery(commit, expectedRemote, onProgress) {
  let buffer = '';
  await git(
    ['push', '--progress', `--force-with-lease=${BRANCH_REF}:${expectedRemote || ''}`, 'origin', `${BRANCH_REF}:${BRANCH_REF}`],
    {
      onStderr: (chunk) => {
        buffer += chunk;
        // git redraws progress with \r; the last complete segment is the current state.
        const parts = buffer.split(/[\r\n]/);
        buffer = parts.pop();
        const line = parts.reverse().find((p) => /Writing objects|Compressing objects|Counting objects/.test(p));
        if (!line || !onProgress) return;
        const pct = line.match(/(\d+)%/);
        const writing = line.startsWith('Writing objects');
        onProgress({ fraction: writing && pct ? Number(pct[1]) / 100 : null, text: line.replace(/^remote:\s*/, '').trim() });
      },
    },
  );
  await git(['update-ref', REF_SYNCED, commit]);
  await git(['update-ref', REF_REMOTE, commit]);
}

/** Records that GitHub is known to hold `commit` (after verifying it, e.g. on crash recovery). */
export async function markSynced(commit) {
  await git(['update-ref', REF_SYNCED, commit]);
}

/** Mirrors main's deploy workflow into the gallery worktree. See WORKFLOW_PATH. */
async function syncWorkflow() {
  let source;
  try {
    source = await readFile(join(ROOT, WORKFLOW_PATH), 'utf8');
  } catch {
    return; // No workflow to mirror; publishing still has to work.
  }

  const target = join(GALLERY_DIR, WORKFLOW_PATH);
  if (await readFile(target, 'utf8').catch(() => null) === source) return;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
}

/** Commits and pushes changes on `main`. Never forced — `main` keeps a normal history. */
export async function publishCode(message) {
  const ident = await identityArgs();
  const dirty = await git(['status', '--porcelain']);
  if (!dirty) return { changed: false, pushed: false };

  await git(['add', '-A']);
  await git([...ident, 'commit', '-m', message]);

  const remote = await remoteUrl();
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
