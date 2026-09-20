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
  selected: new Set(),
  coverFileId: null,
  captions: new Map(),
  rotations: new Map(),
};

// ------------------------------------------------------------------ plumbing

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && !(options.body instanceof Blob)
      ? { 'Content-Type': 'application/json', ...options.headers }
      : options.headers,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function banner(message, kind = 'info') {
  const el = $('banner');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.textContent = message;
  el.className = `banner ${kind}`;
  el.hidden = false;
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

  if (!data.git.worktreeReady) {
    banner('还没初始化 gallery 分支。正在自动初始化…');
    try {
      await api('/api/setup', { method: 'POST' });
      banner('gallery 分支初始化完成。', 'ok');
      setTimeout(() => banner(''), 4000);
    } catch (err) {
      banner(`初始化失败：${err.message}`, 'error');
    }
  } else if (!data.git.remote) {
    banner('还没有配置 origin 远端，发布只会提交到本地仓库，网站不会更新。', 'info');
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
  $('set-passcode').placeholder = state.config.hasPasscode ? '已设置，留空 = 不改动' : '留空 = 不设口令';
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

async function uploadQueued() {
  for (const [key, entry] of state.files) {
    if (entry.state !== 'queued') continue;
    entry.state = 'uploading';
    renderFileList();

    try {
      const result = await uploadOne(entry);
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
    }
    renderFileList();
  }
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
      }
    };
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.fileId) resolve(payload);
      else reject(new Error(payload.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('上传中断'));
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
      entry.state === 'uploading' ? `${Math.round(entry.progress * 100)}%`
      : entry.state === 'staged' ? '就绪'
      : entry.state === 'failed' ? entry.error || '失败'
      : '等待';

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
    ? `${staged.length} 张就绪，共 ${fmtBytes(staged.reduce((s, f) => s + f.bytes, 0))}`
    : '';
}

// ------------------------------------------------------------------ processing

async function startProcessing() {
  const fileIds = [...state.files.values()].filter((f) => f.state === 'staged').map((f) => f.fileId);
  if (fileIds.length === 0) return;

  banner('');
  $('panel-review').hidden = false;
  $('progress').hidden = false;
  $('process-btn').disabled = true;

  try {
    const { jobId } = await api('/api/process', { method: 'POST', body: JSON.stringify({ fileIds }) });
    state.jobId = jobId;
    pollJob();
  } catch (err) {
    banner(`处理失败：${err.message}`, 'error');
    $('process-btn').disabled = false;
  }
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
        const failed = job.items.filter((i) => i.state === 'failed');
        if (failed.length) {
          banner(`${failed.length} 张处理失败，详情见下方卡片。其余照片可以正常发布。`, 'error');
        }
      }
    } catch (err) {
      clearInterval(state.polling);
      banner(`无法获取处理进度：${err.message}`, 'error');
    }
  }, 600);
}

function applyJob(job) {
  for (const item of job.items) {
    const entry = state.files.get(item.fileId);
    if (!entry) continue;
    entry.state = item.state;
    entry.error = item.error;
    if (item.photo) entry.photo = item.photo;
    if (item.state === 'failed') state.selected.delete(item.fileId);
  }

  const done = job.items.filter((i) => i.state === 'ready' || i.state === 'failed').length;
  $('progress-fill').style.width = `${(done / job.items.length) * 100}%`;
  $('progress-label').textContent = `${done} / ${job.items.length}`;

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
    ? `将发布 ${ready.length} 张，占用约 ${fmtBytes(ready.reduce((s, e) => s + (e.photo?.bytes || 0), 0))}`
    : '还没有可发布的照片';
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
      btn.title = `顺时针旋转 ${deg}° 后重新处理`;
      btn.onclick = (e) => { e.preventDefault(); rotate(entry, deg); };
      tools.append(btn);
    }
    imageWrap.append(tools);
  } else {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent =
      entry.state === 'processing' ? '解码中…'
      : entry.state === 'writing' ? '写入中…'
      : entry.state === 'failed' ? '处理失败'
      : '排队中…';
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
  }

  if (entry.photo) {
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = describePhoto(entry.photo);
    body.append(meta);

    for (const note of entry.photo.notes || []) {
      if (note.startsWith('已从') || note.startsWith('已按')) continue; // routine, not worth the noise
      const el = document.createElement('div');
      el.className = 'card-note';
      el.textContent = note;
      body.append(el);
    }

    const caption = document.createElement('input');
    caption.type = 'text';
    caption.className = 'caption';
    caption.placeholder = '说明（可选）';
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
    cover.append(radio, document.createTextNode('设为封面'));
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
  if (photo.gps) bits.push('含 GPS');
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
    banner(`旋转失败：${err.message}`, 'error');
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
  banner('正在写入相册并推送到 GitHub…');

  try {
    const result = await api('/api/publish', {
      method: 'POST',
      body: JSON.stringify({
        fileIds,
        title: $('album-title').value,
        date: $('album-date').value,
        showLocation,
        coverFileId: state.coverFileId,
        captions,
      }),
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

    const pushed = result.git?.pushed;
    banner(
      pushed
        ? `已发布 ${result.added} 张到「${result.album.title}」。GitHub Actions 正在构建，大约一两分钟后网站更新。`
        : `已在本地提交 ${result.added} 张到「${result.album.title}」，但没有推送（还没配置远端）。`,
      'ok',
    );

    if (result.budget.overBytes > 0) {
      banner(
        `已发布，但空间超了 ${fmtBytes(result.budget.overBytes)}。GitHub Pages 站点上限是 1GB，请到「管理」里删掉一些旧相册。`,
        'error',
      );
    }
  } catch (err) {
    banner(`发布失败：${err.message}`, 'error');
    $('publish-btn').disabled = false;
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
    td.textContent = '还没有相册。';
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
    ? `删除选中的 ${checked.length} 个相册`
    : '删除选中的相册';
}

function selectedAlbumIds() {
  return [...$('albums-table').querySelectorAll('tbody input:checked')].map((i) => i.value);
}

function renderBudgetDetail() {
  const b = state.budget;
  const parts = [
    `已用 ${fmtBytes(b.usedBytes)} / ${fmtBytes(b.budgetBytes)}（剩余 ${fmtBytes(b.freeBytes)}）`,
    `共 ${state.albums.length} 个相册`,
  ];
  if (b.overBytes > 0) {
    parts.push(`超出 ${fmtBytes(b.overBytes)}，建议先删除：${b.suggestions.map((s) => s.title).join('、')}`);
  }
  $('budget-detail').textContent = parts.join(' · ');
}

async function deleteSelectedAlbums() {
  const ids = selectedAlbumIds();
  if (ids.length === 0) return;

  const titles = state.albums.filter((a) => ids.includes(a.id)).map((a) => a.title).join('、');
  if (!confirm(`确定删除「${titles}」？照片会从网站和仓库里移除，无法恢复。`)) return;

  $('delete-albums-btn').disabled = true;
  banner('正在删除并推送…');
  try {
    const result = await api('/api/albums/delete', { method: 'POST', body: JSON.stringify({ ids }) });
    await refresh();
    banner(`已删除 ${result.removed} 张照片，现在用了 ${fmtBytes(result.budget.usedBytes)}。`, 'ok');
  } catch (err) {
    banner(`删除失败：${err.message}`, 'error');
  }
}

async function reclaim() {
  $('reclaim-btn').disabled = true;
  banner('正在回收 git 空间…');
  try {
    const r = await api('/api/reclaim', { method: 'POST' });
    banner(`回收完成，释放了 ${fmtBytes(r.freed)}，本地仓库现在 ${fmtBytes(r.after)}。`, 'ok');
  } catch (err) {
    banner(`回收失败：${err.message}`, 'error');
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
    await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    $('set-passcode').value = '';
    await refresh();
    banner('设置已保存。下次发布时网站会应用新设置。', 'ok');
  } catch (err) {
    banner(`保存失败：${err.message}`, 'error');
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

$('delete-albums-btn').addEventListener('click', deleteSelectedAlbums);
$('reclaim-btn').addEventListener('click', reclaim);
$('save-settings-btn').addEventListener('click', saveSettings);

refresh().catch((err) => banner(`无法连接本地服务：${err.message}`, 'error'));
