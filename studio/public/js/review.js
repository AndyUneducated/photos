/** The review grid (pick, caption, cover, rotate) and publishing the chosen photos as an album. */

import { HandledError, api } from './api.js';
import { $, fmtBytes, state } from './core.js';
import { runOperation } from './operations.js';
import { refresh } from './session.js';
import { detailsBlock, toast } from './toasts.js';
import { renderFileList } from './upload.js';

export function renderReview() {
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

export async function publish() {
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
