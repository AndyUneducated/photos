/** Loading the studio's state from the server, and picking up where the last session left off. */

import { HandledError, api } from './api.js';
import { $, fmtBytes, state } from './core.js';
import { renderAlbums, renderSettings } from './manage.js';
import { followOperation, runOperation } from './operations.js';
import { renderReview } from './review.js';
import { toast } from './toasts.js';
import { renderFileList } from './upload.js';

export async function refresh() {
  const data = await api('/api/state');
  state.config = data.config;
  state.git = data.git;
  state.budget = data.budget;
  state.albums = data.albums;

  renderGauge();
  renderAlbums();
  renderSettings();

  $('site-link').href = state.config.domain ? `https://${state.config.domain}/` : '#';

  if (!state.loadedOnce) {
    state.loadedOnce = true;
    restoreSession(data);
  }

  if (!data.git.worktreeReady) {
    const t = toast('The gallery branch is not set up yet. Setting it up…', 'progress');
    try {
      await api('/api/setup', { method: 'POST' });
      t.update('The gallery branch is ready.', 'ok');
    } catch (err) {
      t.fail('Setting up the gallery branch failed', err);
    }
  } else if (!data.git.remote && !state.warnedNoRemote) {
    // refresh() runs after every operation; this one is a standing condition, not an event.
    state.warnedNoRemote = true;
    toast('No origin remote is configured. Publishing only commits to the local repository, and the site will not update.', 'info');
  } else if (data.git.unpushed && !data.operation && !state.warnedUnpushed) {
    state.warnedUnpushed = true;
    toast('This computer has gallery changes that never reached GitHub (an earlier upload did not finish), so the site does not show them yet.', 'info')
      .action('Upload them now', syncNow);
  }
}

/**
 * Picks up where the last session left off: photos already copied in or processed are still on
 * disk, an operation may still be running, and the server may have rolled back an interrupted one.
 */
function restoreSession(data) {
  if (data.recovery) {
    const r = data.recovery;
    if (r.outcome === 'completed') {
      toast(`“${r.title}” was interrupted when the studio stopped, but it had already reached GitHub, so it has been kept.`, 'ok');
    } else if (r.outcome === 'rolled-back') {
      toast(`“${r.title}” was interrupted when the studio stopped. The gallery has been put back exactly as it was before; any photos it was publishing are still below, so you can publish again.`, 'info');
    } else {
      toast('', 'error').fail('Could not recover an interrupted operation', r.error);
    }
  }

  let restored = 0;
  for (const meta of data.staged || []) {
    if (state.files.has(meta.fileId)) continue;
    const ready = meta.state === 'ready' && meta.photo;
    state.files.set(meta.fileId, {
      fileId: meta.fileId,
      name: meta.name,
      bytes: meta.photo?.sourceBytes,
      state: ready ? 'ready' : 'staged',
      photo: meta.photo,
      progress: 1,
    });
    if (ready) state.selected.add(meta.fileId);
    restored++;
  }
  if (restored) {
    renderFileList();
    if ([...state.files.values()].some((f) => f.state === 'ready')) {
      $('panel-review').hidden = false;
      renderReview();
    }
    toast(`Restored ${restored} photos from your last session. Ones that were not processed yet can be processed again.`, 'info');
  }

  if (data.operation) {
    const t = toast(data.operation.title, 'progress');
    followOperation(data.operation, t)
      .then((op) => {
        if (op.state === 'done') t.update(`${op.title} — finished.`, 'ok');
        else t.fail(`${op.title} — ${op.state === 'conflict' ? 'stopped: GitHub has other changes' : 'failed'}`, { ...op.error, steps: op.steps });
        return refresh();
      })
      .catch((err) => t.fail('Lost track of the running operation', err));
  }
}

async function syncNow() {
  try {
    const { result, toast: t } = await runOperation('/api/sync');
    await refresh();
    t.update(result.git.pushed ? 'GitHub is up to date. The site updates in a minute or two.' : 'GitHub already had everything.', 'ok');
  } catch (err) {
    if (!(err instanceof HandledError)) toast('', 'error').fail('Sync failed', err);
  }
}

function renderGauge() {
  const { usedBytes, budgetBytes, percent } = state.budget;
  const pct = Math.min(1, percent);
  $('gauge-fill').style.width = `${pct * 100}%`;
  $('gauge-label').textContent = `${fmtBytes(usedBytes)} / ${fmtBytes(budgetBytes)}`;
  $('gauge').className = `gauge${percent > 1 ? ' over' : percent > 0.85 ? ' warn' : ''}`;
}
