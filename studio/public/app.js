/**
 * Studio UI. Vanilla ES module, no build step — this only ever runs in the local browser against
 * the local server, so there is nothing to bundle and nothing to ship.
 */

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  git: null,
  budget: null,
  albums: [],
  /** Staged files keyed by fileId: { fileId, name, bytes, state, photo, error } */
  files: new Map(),
  jobId: null,
  polling: null,
  /** Handle for the toast that tracks the running process job, so it mutates instead of stacking. */
  processToast: null,
  warnedNoRemote: false,
  selected: new Set(),
  coverFileId: null,
  captions: new Map(),
  rotations: new Map(),
};

// ------------------------------------------------------------------ plumbing

/**
 * A failure as the server describes it: `error` (the headline), `hint` (what to do), `code`, and
 * `detail` (command, stderr, stack — for whoever debugs it). See studio/lib/errors.mjs.
 */
class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.error || `Request failed (${status})`);
    this.payload = { ...payload, error: this.message };
    this.status = status;
  }
}

/** Thrown once a failure has already been shown to the user, so callers only need to clean up. */
class HandledError extends Error {}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: options.body && !(options.body instanceof Blob)
        ? { 'Content-Type': 'application/json', ...options.headers }
        : options.headers,
    });
  } catch (err) {
    throw new ApiError({
      error: 'The studio is not responding.',
      code: 'studio-unreachable',
      hint: 'Check that the studio window (the terminal running it) is still open. If it closed, start it again; nothing that already finished is lost.',
      detail: { request: `${options.method || 'GET'} ${path}`, error: String(err) },
    }, 0);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError({
      error: 'The studio sent back a response it could not read.',
      code: 'bad-response',
      detail: { request: `${options.method || 'GET'} ${path}`, status: res.status, body: text.slice(0, 2000) },
    }, res.status);
  }
  if (!res.ok) throw new ApiError(data, res.status);
  return data;
}

/** Normalises anything thrown into the server's error shape. */
function errorPayload(err) {
  if (err instanceof ApiError) return err.payload;
  if (err && typeof err === 'object' && 'error' in err && !(err instanceof Error)) return err;
  return { error: err?.message || String(err), code: 'client-error', detail: { stack: err?.stack } };
}

// ------------------------------------------------------------------ toasts

/**
 * A stack of dismissible messages rather than one shared line.
 *
 * Long jobs need a message that stays put and mutates in place (uploading -> processing ->
 * published), while a failure needs to survive whatever status update comes next. Both fall out
 * of returning a handle: keep it to update or close that toast, drop it to fire and forget.
 *
 * Successes clear themselves. Errors never do — a failed photo is something to act on.
 */
const DISMISS_MS = { ok: 4500, info: 3500, progress: 0, error: 0 };

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;

  const icon = document.createElement('span');
  icon.className = 'toast__icon';
  icon.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'toast__body';

  const text = document.createElement('p');
  text.className = 'toast__text';
  text.textContent = message;

  // Everything below the headline is rebuilt on each update; the headline node stays put so
  // screen readers announce changes to it rather than a whole new toast.
  const extra = document.createElement('div');
  extra.className = 'toast__extra';
  body.append(text, extra);

  const close = document.createElement('button');
  close.className = 'toast__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u00d7';

  el.append(icon, body, close);
  $('toasts').append(el);
  // Next frame, so the entry transition has a start state to animate from.
  requestAnimationFrame(() => el.classList.add('is-in'));

  let timer = null;
  const handle = {
    update(nextMessage, nextKind = kind) {
      text.textContent = nextMessage;
      el.className = `toast toast--${nextKind} is-in`;
      kind = nextKind;
      extra.replaceChildren();
      handle.arm();
      return handle;
    },
    /** Shows the milestones of a server operation; see renderSteps. */
    steps(steps) {
      extra.replaceChildren(renderSteps(steps));
      return handle;
    },
    /** Turns this toast into an error: headline, what went wrong, what to do, and the raw detail. */
    fail(headline, err) {
      const payload = errorPayload(err);
      handle.update(headline, 'error');
      extra.append(errorBlock(payload));
      return handle;
    },
    /** Adds a button, e.g. "Upload now". */
    action(label, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = label;
      btn.onclick = () => { handle.close(); onClick(); };
      extra.append(btn);
      return handle;
    },
    arm() {
      clearTimeout(timer);
      const ms = DISMISS_MS[kind] ?? 0;
      if (ms) timer = setTimeout(handle.close, ms);
      return handle;
    },
    close() {
      clearTimeout(timer);
      el.classList.remove('is-in');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      // transitionend never fires if the element is already hidden or motion is reduced.
      setTimeout(() => el.remove(), 400);
    },
  };

  close.addEventListener('click', handle.close);
  return handle.arm();
}

const STEP_MARK = { pending: '○', running: '◌', done: '✓', skipped: '–', failed: '✕', cancelled: '–' };

function renderSteps(steps) {
  const ol = document.createElement('ol');
  ol.className = 'steps';
  for (const step of steps) {
    const li = document.createElement('li');
    li.className = `step step--${step.state}`;

    const mark = document.createElement('span');
    mark.className = 'step__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = STEP_MARK[step.state] || '○';

    const label = document.createElement('span');
    label.className = 'step__label';
    label.textContent = step.label;
    if (step.state === 'running' && step.startedAt) {
      const secs = Math.round((Date.now() - step.startedAt) / 1000);
      if (secs >= 3) label.textContent += ` (${secs}s)`;
    }

    li.append(mark, label);
    if (step.detail && step.state !== 'pending') {
      const detail = document.createElement('span');
      detail.className = 'step__detail';
      detail.textContent = step.detail;
      li.append(detail);
    }
    if (step.state === 'running' && typeof step.progress === 'number') {
      const bar = document.createElement('span');
      bar.className = 'step__bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(step.progress * 100)}%`;
      bar.append(fill);
      li.append(bar);
    }
    ol.append(li);
  }
  return ol;
}

/** The readable part of an error, plus a collapsed, copyable block for debugging. */
function errorBlock(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'errblock';

  const what = document.createElement('p');
  what.className = 'errblock__what';
  what.textContent = payload.error;
  wrap.append(what);

  if (payload.hint) {
    const hint = document.createElement('p');
    hint.className = 'errblock__hint';
    hint.textContent = payload.hint;
    wrap.append(hint);
  }

  if (payload.steps) wrap.append(renderSteps(payload.steps));

  const debug = { code: payload.code, ...(payload.rolledBack ? { rolledBack: true } : {}), ...(payload.detail || {}) };
  wrap.append(detailsBlock(debug));
  return wrap;
}

function detailsBlock(debug) {
  const details = document.createElement('details');
  details.className = 'errblock__details';
  const summary = document.createElement('summary');
  summary.textContent = 'Technical details';
  const pre = document.createElement('pre');
  const text = JSON.stringify(debug, null, 2);
  pre.textContent = text;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'errblock__copy';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select the text and copy it';
    }
  };
  details.append(summary, copy, pre);
  return details;
}

// ------------------------------------------------------------------ operations

/**
 * Runs a server operation (publish, delete, save settings, sync) with a live milestone list.
 *
 * Resolves with `{ result, toast }` once it is done — the caller words the success message.
 * Everything else is handled here and surfaces as a HandledError: failures are shown with their
 * detail, and a conflict with GitHub opens the conflict dialog and retries with the user's choice.
 */
async function runOperation(path, body = {}) {
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
async function followOperation(op, t) {
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

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ------------------------------------------------------------------ state sync

async function refresh() {
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

function renderSettings() {
  $('set-title').value = state.config.siteTitle ?? '';
  $('set-tagline').value = state.config.siteTagline ?? '';
  $('set-budget').value = Math.round(state.config.budgetBytes / 1024 / 1024);
  $('set-passcode').placeholder = state.config.hasPasscode ? 'Set — leave blank to keep current' : 'Leave blank for no passcode';
}

// ------------------------------------------------------------------ uploading

function onFilesPicked(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  for (const file of files) {
    const entry = { file, name: file.name, bytes: file.size, state: 'queued', progress: 0 };
    const key = `local:${file.name}:${file.size}:${file.lastModified}`;
    if (!state.files.has(key)) state.files.set(key, entry);
  }

  renderFileList();
  uploadQueued();
}

/**
 * Copies picked files into the studio one at a time. A second drop while this runs just adds to
 * the queue that the running loop is already walking.
 */
async function uploadQueued() {
  if (state.uploading) return;
  state.uploading = true;
  const t = toast('Copying photos into the studio…', 'progress');
  let failed = 0;

  const seen = [];
  const report = () => {
    const batch = [...seen, ...[...state.files.values()].filter((f) => f.state === 'queued')];
    const done = seen.filter((f) => f.state !== 'uploading');
    const total = batch.reduce((s, f) => s + f.bytes, 0);
    const sent = seen.reduce((s, f) => s + (f.state === 'uploading' ? f.bytes * f.progress : f.bytes), 0);
    t.update('Copying photos into the studio', 'progress').steps([
      {
        label: `Copy ${batch.length} originals into the studio`,
        state: 'running',
        detail: `${done.length} of ${batch.length} files · ${fmtBytes(sent)} of ${fmtBytes(total)}`,
        progress: total ? sent / total : 0,
      },
      { label: 'Choose a quality, then start processing', state: 'pending' },
    ]);
  };

  for (const [key, entry] of state.files) {
    if (entry.state !== 'queued') continue;
    entry.state = 'uploading';
    entry.onProgress = report;
    seen.push(entry);
    renderFileList();
    report();

    try {
      const result = await uploadOne(entry);
      entry.state = 'staged';
      // Re-key on the server-assigned id so every later call refers to the staged copy.
      state.files.delete(key);
      state.files.set(result.fileId, {
        fileId: result.fileId,
        name: entry.name,
        bytes: entry.bytes,
        state: 'staged',
        progress: 1,
      });
      state.selected.add(result.fileId);
    } catch (err) {
      entry.state = 'failed';
      entry.error = err.message;
      failed++;
      toast('', 'error').fail(`Could not copy “${entry.name}” into the studio`, err);
    }
    renderFileList();
  }

  state.uploading = false;
  const ready = [...state.files.values()].filter((f) => f.state === 'staged').length;
  t.update(
    failed
      ? `${ready} photos copied in; ${failed} could not be (see the messages above). Add those again, or carry on without them.`
      : `${ready} photos copied in. Choose a quality, then press Start processing.`,
    failed ? 'error' : 'ok',
  );
  renderUploadActions();
}

/** XHR rather than fetch: only XHR reports upload progress, and these files are large. */
function uploadOne(entry) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/stage?name=${encodeURIComponent(entry.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        entry.progress = e.loaded / e.total;
        renderFileList();
        entry.onProgress?.();
      }
    };
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.fileId) resolve(payload);
      else {
        reject(new ApiError(payload.error ? payload : {
          error: `The studio rejected the file (HTTP ${xhr.status}).`,
          detail: { status: xhr.status, body: xhr.responseText.slice(0, 2000) },
        }, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError({
      error: 'The copy was interrupted before it finished.',
      code: 'stage-interrupted',
      hint: 'Check that the studio is still running, then add the photo again.',
      detail: { file: entry.name, bytes: entry.bytes, sent: Math.round(entry.progress * entry.bytes) },
    }, 0));
    xhr.send(entry.file);
  });
}

function renderFileList() {
  const ul = $('filelist');
  ul.innerHTML = '';

  for (const [key, entry] of state.files) {
    const li = document.createElement('li');
    li.dataset.state = entry.state === 'staged' ? 'done' : entry.state;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtBytes(entry.bytes);

    const st = document.createElement('span');
    st.className = 'state';
    st.textContent =
      entry.state === 'uploading' ? `Copying ${Math.round(entry.progress * 100)}%`
      : entry.state === 'staged' ? 'Copied in'
      : entry.state === 'processing' || entry.state === 'writing' || entry.state === 'pending' ? 'Processing'
      : entry.state === 'ready' ? 'Processed'
      : entry.state === 'failed' ? entry.error || 'Failed'
      : 'Waiting';

    li.append(name, size, st);
    ul.append(li);
    void key;
  }

  renderUploadActions();
}

function renderUploadActions() {
  const staged = [...state.files.values()].filter((f) => f.state === 'staged');
  const busy = [...state.files.values()].some((f) => f.state === 'uploading' || f.state === 'queued');

  $('upload-actions').hidden = state.files.size === 0;
  $('process-btn').disabled = staged.length === 0 || busy;
  $('upload-summary').textContent = staged.length
    ? `${staged.length} ready, ${fmtBytes(staged.reduce((s, f) => s + f.bytes, 0))} in total`
    : '';
}

// ------------------------------------------------------------------ processing

async function startProcessing() {
  const fileIds = [...state.files.values()].filter((f) => f.state === 'staged').map((f) => f.fileId);
  if (fileIds.length === 0) return;

  $('panel-review').hidden = false;
  $('progress').hidden = false;
  $('process-btn').disabled = true;

  const quality = document.querySelector('input[name="quality"]:checked')?.value || 'standard';
  state.processToast = toast(`Processing ${fileIds.length} photos`, 'progress');
  state.processStartedAt = Date.now();

  try {
    const { jobId } = await api('/api/process', {
      method: 'POST',
      body: JSON.stringify({ fileIds, quality }),
    });
    state.jobId = jobId;
    pollJob();
  } catch (err) {
    state.processToast.fail('Processing could not start', err);
    state.processToast = null;
    $('process-btn').disabled = false;
  }
}

/** The processing milestones, in the same shape as a server operation's steps. */
function processSteps(job) {
  const total = job.items.length;
  const done = job.items.filter((i) => i.state === 'ready' || i.state === 'failed').length;
  const failed = job.items.filter((i) => i.state === 'failed').length;
  const current = job.items.filter((i) => i.state === 'processing' || i.state === 'writing').map((i) => i.name);
  const running = job.state === 'running';
  return [
    { label: 'Copy the originals into the studio', state: 'done' },
    {
      label: `Decode, colour-correct and compress ${total} photos`,
      state: running ? 'running' : failed === total ? 'failed' : 'done',
      startedAt: state.processStartedAt,
      detail: `${done} of ${total} done${failed ? `, ${failed} failed` : ''}${current.length ? ` · now: ${current.join(', ')}` : ''}`,
      progress: total ? done / total : 0,
    },
    { label: 'Review, name the album, and publish', state: running ? 'pending' : 'running' },
  ];
}

function pollJob() {
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    try {
      const job = await api(`/api/process/${state.jobId}`);
      applyJob(job);
      if (job.state !== 'running') {
        clearInterval(state.polling);
        state.polling = null;
        $('progress').hidden = true;

        const failed = job.items.filter((i) => i.state === 'failed').length;
        const ready = job.items.filter((i) => i.state === 'ready').length;
        if (state.processToast) {
          if (job.error) {
            state.processToast.fail('Processing stopped', job.error);
          } else if (failed) {
            state.processToast.update(
              `${failed} photos failed to process — each card below says why. The other ${ready} can still be published.`,
              'error',
            ).steps(processSteps(job));
          } else {
            state.processToast.update(`${ready} photos processed. Review them, then publish.`, 'ok');
          }
          state.processToast = null;
        }
      }
    } catch (err) {
      clearInterval(state.polling);
      state.polling = null;
      (state.processToast || toast('', 'error')).fail('Lost track of the processing progress', err);
      state.processToast = null;
      $('progress').hidden = true;
      $('process-btn').disabled = false;
    }
  }, 600);
}

function applyJob(job) {
  for (const item of job.items) {
    const entry = state.files.get(item.fileId);
    if (!entry) continue;
    entry.state = item.state;
    entry.error = item.error;
    entry.errorDetail = item.errorDetail;
    if (item.photo) entry.photo = item.photo;
    if (item.state === 'failed') state.selected.delete(item.fileId);
  }

  const done = job.items.filter((i) => i.state === 'ready' || i.state === 'failed').length;
  $('progress-fill').style.width = `${(done / job.items.length) * 100}%`;
  $('progress-label').textContent = `${done} / ${job.items.length}`;
  if (state.processToast && job.state === 'running') {
    state.processToast.update(`Processing ${job.items.length} photos`, 'progress').steps(processSteps(job));
  }
  renderFileList();

  renderReview();
}

// ------------------------------------------------------------------ review

function renderReview() {
  const grid = $('review-grid');
  grid.innerHTML = '';

  const entries = [...state.files.values()].filter((f) => f.fileId);
  let earliest = null;

  for (const entry of entries) {
    if (entry.photo?.takenAt && (!earliest || entry.photo.takenAt < earliest)) earliest = entry.photo.takenAt;
    grid.append(renderCard(entry));
  }

  if (earliest && !$('album-date').value) $('album-date').value = earliest.slice(0, 10);
  if (!$('album-date').value) $('album-date').value = new Date().toISOString().slice(0, 10);

  if (!state.coverFileId || !state.selected.has(state.coverFileId)) {
    state.coverFileId = [...state.selected][0] ?? null;
  }

  const ready = entries.filter((e) => e.state === 'ready' && state.selected.has(e.fileId));
  $('publish-btn').disabled = ready.length === 0;
  $('review-summary').textContent = ready.length
    ? `${ready.length} photos to publish, about ${fmtBytes(ready.reduce((s, e) => s + (e.photo?.bytes || 0), 0))}`
    : 'No photos ready to publish yet';
}

function renderCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';
  if (!state.selected.has(entry.fileId)) card.classList.add('deselected');
  if (state.coverFileId === entry.fileId) card.classList.add('is-cover');

  const imageWrap = document.createElement('div');
  imageWrap.className = 'card-image';

  if (entry.state === 'ready' && entry.photo) {
    const img = document.createElement('img');
    const bust = state.rotations.get(entry.fileId) || 0;
    img.src = `/api/staged/${entry.fileId}/thumb?v=${bust}`;
    img.alt = entry.name;
    img.loading = 'lazy';
    imageWrap.append(img);

    const tools = document.createElement('div');
    tools.className = 'card-tools';
    for (const deg of [90, 180, 270]) {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.textContent = `${deg}°`;
      btn.title = `Rotate ${deg}° clockwise and process again`;
      btn.onclick = (e) => { e.preventDefault(); rotate(entry, deg); };
      tools.append(btn);
    }
    imageWrap.append(tools);
  } else {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent =
      entry.state === 'processing' ? 'Decoding…'
      : entry.state === 'writing' ? 'Writing…'
      : entry.state === 'failed' ? 'Failed to process'
      : 'Queued…';
    imageWrap.append(ph);
  }

  const pick = document.createElement('label');
  pick.className = 'card-pick';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.selected.has(entry.fileId);
  checkbox.disabled = entry.state !== 'ready';
  checkbox.onchange = () => {
    if (checkbox.checked) state.selected.add(entry.fileId);
    else state.selected.delete(entry.fileId);
    renderReview();
  };
  pick.append(checkbox);
  imageWrap.append(pick);

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = entry.name;
  body.append(name);

  if (entry.error) {
    const err = document.createElement('div');
    err.className = 'card-error';
    err.textContent = entry.error;
    body.append(err);
    if (entry.errorDetail) body.append(detailsBlock(entry.errorDetail));
  }

  if (entry.photo) {
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = describePhoto(entry.photo);
    body.append(meta);

    for (const note of entry.photo.notes || []) {
      // Routine, not worth the noise. Matched against the wording in studio/lib/process.mjs, so
      // the two have to be reworded together — the notes worth reading (HDR tone mapping, an
      // orientation we could not resolve) are exactly the ones that do not start this way.
      if (/^(Converted|Rotated) /.test(note)) continue;
      const el = document.createElement('div');
      el.className = 'card-note';
      el.textContent = note;
      body.append(el);
    }

    const caption = document.createElement('input');
    caption.type = 'text';
    caption.className = 'caption';
    caption.placeholder = 'Caption (optional)';
    caption.value = state.captions.get(entry.fileId) || '';
    caption.oninput = () => state.captions.set(entry.fileId, caption.value);
    body.append(caption);

    const cover = document.createElement('label');
    cover.className = 'cover-label';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'cover';
    radio.checked = state.coverFileId === entry.fileId;
    radio.disabled = !state.selected.has(entry.fileId);
    radio.onchange = () => { state.coverFileId = entry.fileId; renderReview(); };
    cover.append(radio, document.createTextNode('Use as cover'));
    body.append(cover);
  }

  card.append(imageWrap, body);
  return card;
}

function describePhoto(photo) {
  const bits = [`${photo.w}×${photo.h}`, fmtBytes(photo.bytes)];
  if (photo.takenAt) bits.push(photo.takenAt.replace('T', ' ').slice(0, 16));
  const e = photo.exif || {};
  const shot = [e.model, e.fNumber && `f/${e.fNumber}`, e.exposure, e.iso && `ISO ${e.iso}`, e.focal && `${e.focal}mm`]
    .filter(Boolean)
    .join(' · ');
  if (shot) bits.push(shot);
  if (photo.gps) bits.push('Has GPS');
  return bits.join('  ·  ');
}

async function rotate(entry, degrees) {
  const previous = entry.state;
  entry.state = 'processing';
  renderReview();
  try {
    const { photo } = await api('/api/rotate', {
      method: 'POST',
      body: JSON.stringify({ fileId: entry.fileId, degrees }),
    });
    entry.photo = photo;
    entry.state = 'ready';
    state.rotations.set(entry.fileId, Date.now());
  } catch (err) {
    entry.state = previous;
    toast('', 'error').fail(`Rotating “${entry.name}” failed`, err);
  }
  renderReview();
}

// ------------------------------------------------------------------ publishing

async function publish() {
  const fileIds = [...state.selected].filter((id) => state.files.get(id)?.state === 'ready');
  if (fileIds.length === 0) return;

  const showLocation = $('album-location').checked;
  const captions = {};
  for (const id of fileIds) {
    const value = state.captions.get(id);
    if (value) captions[id] = value;
  }

  $('publish-btn').disabled = true;

  try {
    const { result, toast: t } = await runOperation('/api/publish', {
      fileIds,
      title: $('album-title').value,
      date: $('album-date').value,
      showLocation,
      coverFileId: state.coverFileId,
      captions,
    });

    for (const id of fileIds) state.files.delete(id);
    state.selected.clear();
    state.coverFileId = null;
    state.captions.clear();

    $('album-title').value = '';
    $('album-date').value = '';
    $('album-location').checked = false;
    $('location-warning').hidden = true;
    $('panel-review').hidden = state.files.size === 0;

    renderFileList();
    renderReview();
    await refresh();

    t.update(
      result.git?.pushed
        ? `Published ${result.added} photos to “${result.album.title}”. GitHub Actions is building; the site updates in a minute or two.`
        : `Saved ${result.added} photos to “${result.album.title}” on this computer only, because no GitHub remote is configured yet.`,
      'ok',
    );

    if (result.budget.overBytes > 0) {
      toast(
        `Published, but you are ${fmtBytes(result.budget.overBytes)} over budget. GitHub Pages sites are capped at 1GB — delete some old albums under Manage.`,
        'error',
      );
    }
  } catch (err) {
    if (!(err instanceof HandledError)) toast('', 'error').fail('Publishing failed', err);
    $('publish-btn').disabled = false;
    await refresh().catch(() => {});
  }
}

// ------------------------------------------------------------------ manage

function renderAlbums() {
  const tbody = $('albums-table').querySelector('tbody');
  tbody.innerHTML = '';

  if (state.albums.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty';
    td.textContent = 'No albums yet.';
    tr.append(td);
    tbody.append(tr);
    renderBudgetDetail();
    return;
  }

  for (const album of state.albums) {
    const tr = document.createElement('tr');

    const pickCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = album.id;
    checkbox.onchange = updateDeleteButton;
    pickCell.append(checkbox);

    tr.append(
      pickCell,
      cell(album.title),
      cell(album.date),
      cell(String(album.photoCount), 'num'),
      cell(fmtBytes(album.bytes), 'num'),
    );
    tbody.append(tr);
  }

  updateDeleteButton();
  renderBudgetDetail();
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function updateDeleteButton() {
  const checked = selectedAlbumIds();
  $('delete-albums-btn').disabled = checked.length === 0;
  $('delete-albums-btn').textContent = checked.length
    ? `Delete ${checked.length} selected albums`
    : 'Delete selected albums';
}

function selectedAlbumIds() {
  return [...$('albums-table').querySelectorAll('tbody input:checked')].map((i) => i.value);
}

function renderBudgetDetail() {
  const b = state.budget;
  const parts = [
    `${fmtBytes(b.usedBytes)} of ${fmtBytes(b.budgetBytes)} used (${fmtBytes(b.freeBytes)} free)`,
    `${state.albums.length} albums`,
  ];
  if (b.overBytes > 0) {
    parts.push(`${fmtBytes(b.overBytes)} over budget — consider deleting: ${b.suggestions.map((s) => s.title).join(', ')}`);
  }
  $('budget-detail').textContent = parts.join(' · ');
}

async function deleteSelectedAlbums() {
  const ids = selectedAlbumIds();
  if (ids.length === 0) return;

  const titles = state.albums.filter((a) => ids.includes(a.id)).map((a) => a.title).join(', ');
  if (!confirm(`Delete “${titles}”? The photos are removed from the site and the repository, and this cannot be undone.`)) return;

  $('delete-albums-btn').disabled = true;
  try {
    const { result, toast: t } = await runOperation('/api/albums/delete', { ids });
    await refresh();
    t.update(
      result.git?.pushed
        ? `Deleted ${result.removed} photos; ${fmtBytes(result.budget.usedBytes)} now in use. The site updates in a minute or two.`
        : `Deleted ${result.removed} photos locally, but nothing was pushed (no remote configured yet).`,
      'ok',
    );
  } catch (err) {
    if (!(err instanceof HandledError)) toast('', 'error').fail('Deleting failed', err);
    await refresh().catch(() => {});
  }
}

async function reclaim() {
  $('reclaim-btn').disabled = true;
  try {
    const { result: r, toast: t } = await runOperation('/api/reclaim');
    t.update(`Reclaimed ${fmtBytes(r.freed)}; the local repository is now ${fmtBytes(r.after)}.`, 'ok');
  } catch (err) {
    if (!(err instanceof HandledError)) toast('', 'error').fail('Reclaiming disk space failed', err);
  }
  $('reclaim-btn').disabled = false;
}

async function saveSettings() {
  const body = {
    siteTitle: $('set-title').value,
    siteTagline: $('set-tagline').value,
    budgetMB: Number($('set-budget').value) || undefined,
  };
  if ($('set-passcode').value) body.passcode = $('set-passcode').value;

  $('save-settings-btn').disabled = true;
  try {
    const { result: r, toast: t } = await runOperation('/api/settings', body);
    const changedPasscode = Boolean(body.passcode);
    $('set-passcode').value = '';
    await refresh();

    if (!r.git?.changed && !r.git?.pushed) {
      t.update('No settings changed.', 'ok');
    } else {
      // Everyone's saved unlock is the old hash, so changing the passcode signs all of them out.
      const note = changedPasscode ? ' The family will have to enter the passcode again next time.' : '';
      t.update(
        r.git.pushed
          ? `Settings pushed; they take effect on the site in a minute or two.${note}`
          : `Settings committed, but there is no remote to push to; they will go up with the next publish.${note}`,
        'ok',
      );
    }
  } catch (err) {
    if (!(err instanceof HandledError)) toast('', 'error').fail('Saving settings failed', err);
    await refresh().catch(() => {});
  }
  $('save-settings-btn').disabled = false;
}

// ------------------------------------------------------------------ wiring

$('file-input').addEventListener('change', (e) => {
  onFilesPicked(e.target.files);
  e.target.value = '';
});

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  onFilesPicked(e.dataTransfer.files);
});

// Dropping anywhere else on the page would otherwise navigate away from the app.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('process-btn').addEventListener('click', startProcessing);
$('publish-btn').addEventListener('click', publish);

$('clear-btn').addEventListener('click', async () => {
  await api('/api/stage/clear', { method: 'POST' }).catch(() => {});
  state.files.clear();
  state.selected.clear();
  state.captions.clear();
  state.coverFileId = null;
  renderFileList();
  renderReview();
  $('panel-review').hidden = true;
});

$('album-location').addEventListener('change', (e) => {
  $('location-warning').hidden = !e.target.checked;
});

$('tab-manage-btn').addEventListener('click', () => {
  const panel = $('panel-manage');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// On a 61MP Sony HIF at 2560px: 291 KB and 390 KB per photo measured, ~525 KB estimated for max.
const QUALITY_HINTS = {
  standard: 'Clean detail at a sensible size; right for most albums.',
  high: 'About 33% larger than standard, with sturdier fine texture.',
  max: 'About 75% larger than standard, holds up when zoomed in.',
};

function renderQualityHint() {
  const value = document.querySelector('input[name="quality"]:checked')?.value || 'standard';
  $('quality-hint').textContent = QUALITY_HINTS[value];
}

for (const input of document.querySelectorAll('input[name="quality"]')) {
  input.addEventListener('change', renderQualityHint);
}
renderQualityHint();

$('delete-albums-btn').addEventListener('click', deleteSelectedAlbums);
$('reclaim-btn').addEventListener('click', reclaim);
$('save-settings-btn').addEventListener('click', saveSettings);

refresh().catch((err) => toast('', 'error').fail('Could not load the studio’s state', err));
