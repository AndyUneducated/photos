/**
 * Turning staged originals into web and thumbnail AVIFs: batch jobs the page polls, cancelling
 * them, and re-running a single photo with a manual rotation.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import express from 'express';

import { loadConfig } from '../lib/gallery.mjs';
import { StudioError, describeError } from '../lib/errors.mjs';
import { defaultConcurrency, runBatch } from '../lib/pool.mjs';
import { findOriginal, stagingDir } from '../lib/staging.mjs';
import { asyncRoute } from './http.mjs';

/** In-flight and finished processing jobs, keyed by job id. Lost on restart, which is fine. */
const jobs = new Map();

export const router = express.Router();

router.post('/api/process', asyncRoute(async (req, res) => {
  const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
  if (fileIds.length === 0) throw new StudioError('There are no files to process.', { status: 400, code: 'no-files' });

  const config = await loadConfig();
  const quality = normalizeTier(req.body?.quality);
  const jobId = randomUUID();

  const items = [];
  for (const fileId of fileIds) {
    const dir = stagingDir(fileId);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    const original = await findOriginal(dir);
    // Remembered so that re-encoding a single photo (the rotate button) does not silently drop
    // the batch back to standard quality.
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, quality }, null, 2));
    items.push({ fileId, name: meta.name, originalPath: original, state: 'pending' });
  }

  const job = { id: jobId, state: 'running', startedAt: Date.now(), items, cancelled: false, quality };
  jobs.set(jobId, job);

  runJob(job, config).catch((err) => {
    job.state = 'failed';
    job.error = describeError(err, { operation: 'Processing photos' });
  });

  res.json({ jobId });
}));

router.get('/api/process/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json(describeError(new StudioError(
      'The studio no longer knows about this processing run; it was probably restarted.',
      { status: 404, code: 'unknown-job', hint: 'Reload the page. Photos that finished are kept; process the rest again.' },
    )));
  }

  res.json({
    id: job.id,
    state: job.state,
    error: job.error,
    items: job.items.map((item) => ({
      fileId: item.fileId,
      name: item.name,
      state: item.state,
      error: item.error,
      errorDetail: item.errorDetail,
      photo: item.photo,
    })),
  });
});

router.post('/api/process/:jobId/cancel', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (job) job.cancelled = true;
  res.json({ ok: true });
});

async function runJob(job, config) {
  const tasks = job.items.map((item) => ({ taskId: item.fileId, filePath: item.originalPath }));
  const byId = new Map(job.items.map((item) => [item.fileId, item]));

  await runBatch(tasks, {
    opts: pipelineOptions(config, { quality: job.quality }),
    concurrency: config.concurrency || defaultConcurrency(),
    isCancelled: () => job.cancelled,
    onEvent: (event) => {
      const item = byId.get(event.taskId);
      if (!item) return;
      if (event.type === 'start') item.state = 'processing';
      if (event.type === 'failed') {
        item.state = 'failed';
        item.error = event.error;
        item.errorDetail = { file: item.name, path: item.originalPath, error: event.error, stack: event.stack };
      }
      if (event.type === 'done') {
        item.state = 'writing';
        // Written below, once the buffers are on disk; keeps the status endpoint honest.
        item.pending = persistResult(item, event.result)
          .then((photo) => {
            item.photo = photo;
            item.state = 'ready';
          })
          .catch((err) => {
            item.state = 'failed';
            const described = describeError(err, { operation: `Saving ${item.name}` });
            item.error = described.error;
            item.errorDetail = described.detail;
          });
      }
    },
  });

  await Promise.all(job.items.map((item) => item.pending).filter(Boolean));
  job.state = job.cancelled ? 'cancelled' : 'done';
}

const QUALITY_TIERS = ['standard', 'high', 'max'];

function normalizeTier(value) {
  return QUALITY_TIERS.includes(value) ? value : 'standard';
}

/** Resolves a tier name to encoder settings, tolerating a config written before tiers existed. */
function qualityFor(config, tier) {
  const tiers = config.quality || {};
  const chosen = tiers[normalizeTier(tier)] || tiers.standard || {};
  return {
    web: chosen.web ?? config.webQuality ?? 66,
    thumb: chosen.thumb ?? config.thumbQuality ?? 55,
  };
}

function pipelineOptions(config, { manualRotate = 0, quality = 'standard' } = {}) {
  const q = qualityFor(config, quality);
  return {
    webMaxEdge: config.webMaxEdge,
    thumbMaxEdge: config.thumbMaxEdge,
    webQuality: q.web,
    thumbQuality: q.thumb,
    manualRotate,
  };
}

/**
 * Writes a pipeline result into its staging directory and returns the manifest-shaped metadata
 * the review UI displays.
 */
async function persistResult(item, result) {
  const dir = stagingDir(item.fileId);
  await writeFile(join(dir, 'web.avif'), result.web.data);
  await writeFile(join(dir, 'thumb.avif'), result.thumb.data);

  const photo = {
    id: result.id,
    w: result.web.width,
    h: result.web.height,
    tw: result.thumb.width,
    th: result.thumb.height,
    lqip: result.lqip,
    color: result.color,
    bytes: result.web.data.length + result.thumb.data.length,
    takenAt: result.takenAt,
    exif: result.exif,
    gps: result.gps,
    colourSpace: result.colourSpace,
    notes: result.notes,
    sourceName: item.name,
    sourceBytes: result.sourceBytes,
  };

  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({ fileId: item.fileId, name: item.name, state: 'ready', photo }, null, 2),
  );
  return photo;
}

/** Re-runs a single photo with an extra rotation, for when the automatic guess is wrong. */
router.post('/api/rotate', asyncRoute(async (req, res) => {
  const { fileId, degrees } = req.body || {};
  const dir = stagingDir(fileId);
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const config = await loadConfig();

  const results = await runBatch([{ taskId: fileId, filePath: await findOriginal(dir) }], {
    opts: pipelineOptions(config, { manualRotate: degrees, quality: meta.quality }),
    concurrency: 1,
  });

  const [result] = results;
  if (!result?.ok) {
    const cause = new Error(result?.error || 'unknown error');
    if (result?.stack) cause.stack = result.stack;
    throw new StudioError(`Could not re-process “${meta.name}” with the new rotation.`, {
      code: 'rotate-failed',
      hint: 'The photo keeps its previous orientation. The details say why the decoder failed.',
      cause,
    });
  }

  const photo = await persistResult({ fileId, name: meta.name }, result.result);

  // Keep any in-memory job view in sync so the UI does not flip back on its next poll.
  for (const job of jobs.values()) {
    const item = job.items.find((i) => i.fileId === fileId);
    if (item) item.photo = photo;
  }

  res.json({ photo });
}));
