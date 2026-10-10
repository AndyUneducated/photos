/**
 * Long-running studio operations (publish, delete, save settings, sync) as a list of named
 * milestones the UI can poll — "Checking GitHub", "Copying photos", "Uploading to GitHub" — rather
 * than one spinner. Two reasons: a person can see that it is moving, and when something fails the
 * last green step says exactly how far it got.
 *
 * Every operation that changes the gallery runs as a transaction:
 *
 *   1. check GitHub          compare with the remote before touching anything
 *   2. journal               write .state/journal.json with the commit to return to
 *   3. apply                 the operation's own steps (copy photos, edit the manifest, ...)
 *   4. commit                one parentless commit
 *   5. push                  leased force-push, so a concurrent publish elsewhere is refused
 *   6. finish                clear the journal, run the operation's cleanup
 *
 * Any failure between 2 and 5 puts the branch and the worktree back at the journalled commit, so
 * there is never a half-applied gallery and never a local "success" GitHub did not receive. If the
 * studio itself dies mid-way, the journal is found on the next start and the same rollback runs.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { GALLERY_DIR, ROOT, saveManifest } from './gallery.mjs';
import { StudioError, describeError } from './errors.mjs';
import {
  checkoutGallery,
  commitGallery,
  compareWithRemote,
  describeDivergence,
  fetchRemoteGallery,
  galleryHead,
  isDirty,
  markSynced,
  mergedManifest,
  pushGallery,
  restoreFiles,
} from './git.mjs';

const STATE_DIR = join(ROOT, 'studio', '.state');
const JOURNAL_PATH = join(STATE_DIR, 'journal.json');

/** Finished operations are kept briefly so a page that polls late still sees the outcome. */
const KEEP_MS = 30 * 60 * 1000;
const operations = new Map();
let active = null;

/**
 * Starts an operation in the background and returns it immediately.
 *
 * @param {{ kind: string, title: string, steps: [string, string][] }} spec  step ids and labels, in order
 * @param {(op: Operation) => Promise<object>} run
 */
export function startOperation(spec, run) {
  if (active) {
    throw new StudioError(`Another operation is still running: ${active.title}.`, {
      status: 409,
      code: 'busy',
      hint: 'Wait for it to finish (its progress is shown in the corner), then try again.',
    });
  }

  const op = new Operation(spec);
  operations.set(op.id, op);
  active = op;

  run(op)
    .then((result) => op.finish('done', { result }))
    .catch((err) => {
      const described = describeError(err, { operation: op.title, step: op.currentLabel() });
      op.finish(err.code === 'conflict' ? 'conflict' : 'failed', { error: described });
      if (described.code !== 'conflict' && (err.status || 500) >= 500) console.error(err);
    })
    .finally(() => {
      active = null;
      setTimeout(() => operations.delete(op.id), KEEP_MS).unref();
    });

  return op;
}

export function getOperation(id) {
  return operations.get(id) || null;
}

export function activeOperation() {
  return active;
}

class Operation {
  constructor({ kind, title, steps }) {
    this.id = randomUUID();
    this.kind = kind;
    this.title = title;
    this.state = 'running';
    this.startedAt = Date.now();
    this.steps = steps.map(([id, label]) => ({ id, label, state: 'pending' }));
  }

  /** Runs `fn` as the named step, marking it running, then done (or failed). */
  async step(id, fn) {
    const step = this.#find(id);
    step.state = 'running';
    step.startedAt = Date.now();
    try {
      const value = await fn(step);
      if (step.state === 'running') step.state = 'done';
      step.finishedAt = Date.now();
      return value;
    } catch (err) {
      step.state = 'failed';
      step.finishedAt = Date.now();
      throw err;
    }
  }

  skip(id, detail) {
    const step = this.#find(id);
    step.state = 'skipped';
    if (detail) step.detail = detail;
  }

  /** Inserts a step (e.g. "Bringing in changes from GitHub" when a merge turns out to be needed). */
  addStepAfter(afterId, id, label) {
    if (this.steps.some((s) => s.id === id)) return;
    const index = this.steps.findIndex((s) => s.id === afterId);
    this.steps.splice(index + 1, 0, { id, label, state: 'pending' });
  }

  currentLabel() {
    return (this.steps.find((s) => s.state === 'running' || s.state === 'failed') || {}).label;
  }

  finish(state, { result, error } = {}) {
    this.state = state;
    this.finishedAt = Date.now();
    this.result = result;
    this.error = error;
    for (const step of this.steps) if (step.state === 'pending' || step.state === 'running') step.state = state === 'done' ? 'skipped' : 'cancelled';
  }

  #find(id) {
    const step = this.steps.find((s) => s.id === id);
    if (!step) throw new Error(`Unknown step ${id}`);
    return step;
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      steps: this.steps,
      result: this.result,
      error: this.error,
    };
  }
}

// ---------------------------------------------------------------------------- transaction

/** The steps every gallery transaction shares; operations put their own between `remote` and `commit`. */
export function transactionSteps(applySteps) {
  return [
    ['remote', 'Checking GitHub for changes made on other computers'],
    ...applySteps,
    ['commit', 'Saving a snapshot of the gallery on this computer'],
    ['push', 'Uploading to GitHub'],
    ['finish', 'Finishing up'],
  ];
}

/**
 * Runs `apply` inside a rollback-protected gallery change. See the module comment.
 *
 * @param {Operation} op
 * @param {object} o
 * @param {string | (() => string)} o.message  commit message, or a function read at commit time
 * @param {boolean} [o.push]      false keeps everything local (tests, offline use)
 * @param {{ action: 'force' | 'merge', remoteCommit: string } | null} [o.resolution]
 *        the user's answer to a previous conflict, bound to the remote commit they were shown
 * @param {(op: Operation) => Promise<object>} o.apply
 * @param {() => Promise<void>} [o.onRollback]  restores anything outside the gallery (config.json)
 * @param {object} [o.journal]    extra fields for the journal, used by crash recovery
 * @param {() => Promise<void>} [o.finish]     cleanup that must only happen once GitHub has it
 */
export async function galleryTransaction(op, { message, push = true, resolution = null, apply, onRollback, journal = {}, finish }) {
  let leftovers = false;
  if (await isDirty()) {
    // Only a publish that died before this journal existed leaves these behind. Its staged photos
    // are still in staging, so discarding the half-written copy loses nothing.
    leftovers = true;
    await checkoutGallery('HEAD');
  }

  const snapshot = await galleryHead();
  let expectedRemote = null;
  let remoteState = null;

  if (push) {
    remoteState = await op.step('remote', async (step) => {
      const remote = await fetchRemoteGallery();
      const cmp = await compareWithRemote(remote);
      step.detail = describeRemoteState(cmp.state, leftovers);
      return { remote, ...cmp };
    });
    expectedRemote = remoteState.remoteCommit || null;
  } else {
    op.skip('remote', 'Publishing locally only');
  }

  const state = remoteState?.state;
  if (state === 'diverged') {
    const bound = resolution && resolution.remoteCommit === remoteState.remoteCommit;
    if (!bound) throw await conflictError(remoteState, resolution);
  }

  await writeJournal({ opId: op.id, kind: op.kind, title: op.title, startedAt: op.startedAt, head: snapshot, ...journal });

  try {
    if (state === 'behind' || (state === 'diverged' && resolution.action === 'merge')) {
      op.addStepAfter('remote', 'pull', 'Bringing in the changes from GitHub');
      await op.step('pull', async (step) => {
        if (state === 'behind') {
          await checkoutGallery(remoteState.remoteCommit);
          step.detail = 'This computer had no changes of its own, so it now matches GitHub.';
        } else {
          const merged = await mergedManifest(remoteState);
          await checkoutGallery(remoteState.remoteCommit);
          await restoreFiles(snapshot, merged.addFiles);
          for (const file of merged.removeFiles) await rm(join(GALLERY_DIR, file), { force: true });
          await saveManifest(merged.manifest);
          step.detail = `Kept ${merged.manifest.albums.length} albums from both computers.`;
        }
      });
    }

    const applied = await apply(op);

    const committed = await op.step('commit', async (step) => {
      const c = await commitGallery(typeof message === 'function' ? message() : message);
      step.detail = c.changed ? `Snapshot ${c.commit.slice(0, 7)}` : 'Nothing changed in the gallery';
      return c;
    });
    await updateJournal({ newCommit: committed.commit });

    let pushed = false;
    if (!push) {
      op.skip('push', 'Publishing locally only');
    } else if (!remoteState.remote.remote) {
      op.skip('push', 'No GitHub remote is configured, so this stays on this computer');
    } else if (remoteState.remote.exists && remoteState.remote.tree === committed.tree) {
      await markSynced(committed.commit);
      op.skip('push', 'GitHub already has exactly this');
    } else {
      await op.step('push', async (step) => {
        try {
          await pushGallery(committed.commit, expectedRemote, ({ fraction, text }) => {
            step.detail = text;
            if (fraction !== null) step.progress = fraction;
          });
        } catch (err) {
          if (/stale info|\[rejected\]/i.test(err.stderr || '')) {
            const fresh = await fetchRemoteGallery().catch(() => null);
            if (fresh?.exists) {
              throw await conflictError({ ...(await compareWithRemote(fresh)), localHead: snapshot }, null, err);
            }
          }
          throw err;
        }
        step.detail = 'GitHub Actions is rebuilding the site; it updates in a minute or two.';
      });
      pushed = true;
    }

    await op.step('finish', async () => {
      await clearJournal();
      await finish?.();
    });

    return { ...applied, git: { changed: committed.changed, commit: committed.commit, pushed, remote: state || 'local' } };
  } catch (err) {
    await rollback(snapshot, onRollback);
    const rolledBack =
      "Nothing was published: this computer's gallery has been put back exactly as it was, and any photos you were publishing are still waiting in the studio.";
    if (err instanceof StudioError) {
      err.extra = { ...(err.extra || {}), rolledBack: true };
      // A deliberate refusal (4xx) already says what happened; only unexpected failures need the reassurance.
      if ((err.status || 500) >= 500) err.hint = err.hint ? `${err.hint} ${rolledBack}` : rolledBack;
      throw err;
    }
    const described = describeError(err);
    throw new StudioError(described.error, {
      status: err.status || 500,
      code: described.code,
      hint: described.hint ? `${described.hint} ${rolledBack}` : rolledBack,
      extra: { rolledBack: true },
      cause: err,
    });
  }
}

function describeRemoteState(state, leftovers) {
  const extra = leftovers ? ' (Discarded half-written files left by an earlier publish that did not finish.)' : '';
  return {
    'remote-missing': 'GitHub has no gallery yet; this will create it.',
    'in-sync': 'GitHub matches this computer.',
    ahead: 'GitHub matches the last sync; only this computer has changes.',
    behind: 'GitHub has newer photos from another computer; they will be brought in first.',
    diverged: 'GitHub and this computer have both changed.',
  }[state] + extra;
}

async function conflictError(cmp, resolution, cause) {
  const diff = await describeDivergence(cmp);
  const stale = resolution && resolution.remoteCommit !== cmp.remoteCommit;
  return new StudioError(
    stale
      ? 'The gallery on GitHub changed again since you looked at the differences.'
      : 'The gallery on GitHub has changes this computer does not have.',
    {
      status: 409,
      code: 'conflict',
      hint: 'Nothing has been changed yet. Review the differences and choose how to continue.',
      extra: { conflict: { remoteCommit: cmp.remoteCommit, ...diff } },
      cause,
    },
  );
}

async function rollback(snapshot, onRollback) {
  try {
    if (snapshot) await checkoutGallery(snapshot);
    await onRollback?.();
    await clearJournal();
  } catch (err) {
    // Leave the journal in place so the next start retries the rollback.
    console.error('Rollback failed; it will be retried on the next start:', err);
  }
}

// ---------------------------------------------------------------------------- journal

async function writeJournal(entry) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(JOURNAL_PATH, JSON.stringify(entry, null, 2), 'utf8');
}

async function updateJournal(fields) {
  const current = await readJournal();
  if (current) await writeJournal({ ...current, ...fields });
}

async function readJournal() {
  try {
    return JSON.parse(await readFile(JOURNAL_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function clearJournal() {
  await rm(JOURNAL_PATH, { force: true });
}

/**
 * Called once at startup. If the previous run died inside a transaction, either confirms that its
 * push actually reached GitHub (and keeps it) or rolls the gallery back to where it started.
 *
 * @param {(journal: object) => Promise<void>} finishCompleted  cleanup for an operation that did land
 * @returns {Promise<null | { title: string, outcome: 'completed' | 'rolled-back', startedAt: number }>}
 */
export async function recoverInterrupted(finishCompleted) {
  const journal = await readJournal();
  if (!journal) return null;

  if (journal.newCommit) {
    const remote = await fetchRemoteGallery().catch(() => null);
    if (remote?.exists && remote.commit === journal.newCommit) {
      await markSynced(journal.newCommit);
      await finishCompleted?.(journal).catch(() => {});
      await clearJournal();
      return { title: journal.title, outcome: 'completed', startedAt: journal.startedAt };
    }
  }

  const restoreConfig = journal.configBefore !== undefined
    ? () => writeFile(join(ROOT, 'config.json'), journal.configBefore, 'utf8')
    : null;
  await rollback(journal.head, restoreConfig);
  return { title: journal.title, outcome: 'rolled-back', startedAt: journal.startedAt };
}
