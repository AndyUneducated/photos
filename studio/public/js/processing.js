/** Starting a processing job and following it until every photo is encoded or has failed. */

import { api } from './api.js';
import { $, state } from './core.js';
import { renderReview } from './review.js';
import { toast } from './toasts.js';
import { renderFileList } from './upload.js';

export async function startProcessing() {
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
