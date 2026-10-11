/** Copying picked or dropped originals into the studio, and the file list that tracks them. */

import { ApiError } from './api.js';
import { $, fmtBytes, state } from './core.js';
import { toast } from './toasts.js';

export function onFilesPicked(fileList) {
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

export function renderFileList() {
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
