/**
 * Studio UI. Vanilla ES modules, no build step — this only ever runs in the local browser against
 * the local server, so there is nothing to bundle and nothing to ship.
 *
 * This file only wires the page together; the work lives in js/: api (server calls and error
 * shapes), toasts, operations (long server operations and the conflict dialog), session (state
 * refresh and restore), upload, processing, review (the grid and publishing), and manage.
 */

import { api } from './js/api.js';
import { $, state } from './js/core.js';
import { deleteSelectedAlbums, reclaim, saveSettings } from './js/manage.js';
import { startProcessing } from './js/processing.js';
import { publish, renderReview } from './js/review.js';
import { refresh } from './js/session.js';
import { toast } from './js/toasts.js';
import { onFilesPicked, renderFileList } from './js/upload.js';

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
