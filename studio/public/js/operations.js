/** Long server operations (publish, delete, settings, sync): following them and resolving conflicts. */

import { HandledError, api } from './api.js';
import { $ } from './core.js';
import { detailsBlock, toast } from './toasts.js';

/**
 * Runs a server operation (publish, delete, save settings, sync) with a live milestone list.
 *
 * Resolves with `{ result, toast }` once it is done — the caller words the success message.
 * Everything else is handled here and surfaces as a HandledError: failures are shown with their
 * detail, and a conflict with GitHub opens the conflict dialog and retries with the user's choice.
 */
export async function runOperation(path, body = {}) {
  let resolution = null;
  for (;;) {
    const t = toast('Starting…', 'progress');
    let started;
    try {
      started = await api(path, {
        method: 'POST',
        body: JSON.stringify(resolution ? { ...body, resolution } : body),
      });
    } catch (err) {
      t.fail('Could not start', err);
      throw new HandledError(err.message);
    }

    let op;
    try {
      op = await followOperation(started.operation, t);
    } catch (err) {
      t.fail(`${started.operation.title} — lost track of progress`, err);
      throw new HandledError(err.message);
    }

    if (op.state === 'done') return { result: op.result, toast: t };

    if (op.state === 'conflict') {
      t.close();
      const choice = await askConflict(op.error.conflict, op.title);
      if (choice === 'abort') {
        toast('Cancelled. Nothing was changed, here or on GitHub. Your photos are still in the studio for later.', 'info');
        throw new HandledError('cancelled');
      }
      resolution = { action: choice, remoteCommit: op.error.conflict.remoteCommit };
      continue;
    }

    t.fail(`${op.title} — failed`, { ...op.error, steps: op.steps });
    throw new HandledError(op.error?.error);
  }
}

/** Polls an operation until it leaves `running`, keeping the toast's milestones current. */
export async function followOperation(op, t) {
  let failures = 0;
  for (;;) {
    t.update(op.title, op.state === 'running' ? 'progress' : kindFor(op.state)).steps(op.steps);
    if (op.state !== 'running') return op;
    await new Promise((r) => setTimeout(r, 500));
    try {
      op = await api(`/api/ops/${op.id}`);
      failures = 0;
    } catch (err) {
      // One missed poll is noise; several in a row means the studio itself went away.
      if (++failures >= 6) throw err;
    }
  }
}

function kindFor(state) {
  return state === 'done' ? 'ok' : state === 'running' ? 'progress' : 'error';
}

/**
 * Shows how GitHub and this computer differ and asks what to do. Resolves 'merge', 'force' or
 * 'abort'. Closing the dialog any other way (Esc) counts as abort.
 */
function askConflict(conflict, title) {
  const dialog = $('conflict-dialog');
  $('conflict-title').textContent = `${title}: GitHub has changes this computer does not have`;

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'unknown time');
  $('conflict-summary').textContent =
    `GitHub was last published ${when(conflict.remote.date)} (“${conflict.remote.subject || 'no message'}”) and holds ` +
    `${conflict.remote.albums} albums / ${conflict.remote.photos} photos. This computer holds ` +
    `${conflict.local.albums} albums / ${conflict.local.photos} photos. Usually this means someone published from another computer.`;

  const list = (id, items, format) => {
    const box = $(id);
    box.hidden = items.length === 0;
    const ul = box.querySelector('ul');
    ul.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      li.textContent = format(item);
      return li;
    }));
  };
  const album = (a) => `${a.title} · ${a.date} · ${a.photoCount} photos${a.why ? ` — ${a.why}` : ''}`;
  list('conflict-only-remote', conflict.onlyRemote, album);
  list('conflict-only-local', conflict.onlyLocal, album);
  list('conflict-changed', conflict.changed, (c) =>
    `${c.title}: ${c.remotePhotos} photos on GitHub, ${c.localPhotos} here${c.remoteTitle !== c.title ? ` (called “${c.remoteTitle}” on GitHub)` : ''}`);
  $('conflict-none').hidden = conflict.onlyRemote.length + conflict.onlyLocal.length + conflict.changed.length > 0;
  $('conflict-nobase').hidden = conflict.hasBase;

  const lost = conflict.onlyRemote.filter((a) => a.why !== 'deleted on this computer');
  $('conflict-force-note').textContent = lost.length
    ? `Removes from the site: ${lost.map((a) => `“${a.title}”`).join(', ')}.`
    : 'GitHub becomes an exact copy of this computer.';

  $('conflict-debug').replaceChildren(detailsBlock({ remoteCommit: conflict.remoteCommit, remote: conflict.remote, local: conflict.local, hasBase: conflict.hasBase }));

  return new Promise((resolve) => {
    const done = (choice) => {
      dialog.removeEventListener('close', onClose);
      dialog.close();
      resolve(choice);
    };
    const onClose = () => resolve('abort');
    dialog.addEventListener('close', onClose);
    $('conflict-merge').onclick = () => done('merge');
    $('conflict-force').onclick = () => {
      if (!lost.length || confirm(`Overwrite GitHub? ${$('conflict-force-note').textContent} This cannot be undone.`)) done('force');
    };
    $('conflict-abort').onclick = () => done('abort');
    dialog.showModal();
  });
}
