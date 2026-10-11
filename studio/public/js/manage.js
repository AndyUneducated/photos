/** The Manage panel: the album table, deleting albums, reclaiming disk, and site settings. */

import { HandledError } from './api.js';
import { $, fmtBytes, state } from './core.js';
import { runOperation } from './operations.js';
import { refresh } from './session.js';
import { toast } from './toasts.js';

export function renderAlbums() {
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

export async function deleteSelectedAlbums() {
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

export async function reclaim() {
  $('reclaim-btn').disabled = true;
  try {
    const { result: r, toast: t } = await runOperation('/api/reclaim');
    t.update(`Reclaimed ${fmtBytes(r.freed)}; the local repository is now ${fmtBytes(r.after)}.`, 'ok');
  } catch (err) {
    if (!(err instanceof HandledError)) toast('', 'error').fail('Reclaiming disk space failed', err);
  }
  $('reclaim-btn').disabled = false;
}

export function renderSettings() {
  $('set-title').value = state.config.siteTitle ?? '';
  $('set-tagline').value = state.config.siteTagline ?? '';
  $('set-budget').value = Math.round(state.config.budgetBytes / 1024 / 1024);
  $('set-passcode').placeholder = state.config.hasPasscode ? 'Set — leave blank to keep current' : 'Leave blank for no passcode';
}

export async function saveSettings() {
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
