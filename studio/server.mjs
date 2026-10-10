/**
 * The studio: a local-only web app for turning a folder of camera files into a published album.
 *
 * Nothing here is exposed to the internet — it binds to loopback, has no auth, and is expected to
 * be opened by the person sitting at the machine. It holds the privileged half of the system (the
 * git credentials, the originals, the ability to delete albums), which is exactly why it must not
 * listen on anything but localhost.
 */

import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import express from 'express';

import {
  ROOT,
  albumId as makeAlbumId,
  budgetReport,
  deleteAlbum,
  deletePhotos,
  loadConfig,
  loadManifest,
  photoPaths,
  removeAlbumFiles,
  removePhotoFiles,
  saveManifest,
  writePhotoFiles,
} from './lib/gallery.mjs';
import { StudioError, describeError } from './lib/errors.mjs';
import { ensureGalleryWorktree, reclaimSpace, status as gitStatus } from './lib/git.mjs';
import { reverseGeocode } from './lib/geocode.mjs';
import {
  activeOperation,
  galleryTransaction,
  getOperation,
  recoverInterrupted,
  startOperation,
  transactionSteps,
} from './lib/operations.mjs';
import { defaultConcurrency, runBatch } from './lib/pool.mjs';

const STATE_DIR = join(ROOT, 'studio', '.state');
const STAGING_DIR = join(STATE_DIR, 'staging');
const CONFIG_PATH = join(ROOT, 'config.json');

const SUPPORTED_EXTENSIONS = new Set([
  '.hif', '.heic', '.heif', '.avif',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp',
]);

const PORT = Number(process.env.PORT) || 4478;

/** In-flight and finished processing jobs, keyed by job id. Lost on restart, which is fine. */
const jobs = new Map();

/** What crash recovery did at startup; reported to the first page load, then forgotten. */
let recovery = null;

const app = express();
app.use(express.json({ limit: '4mb' }));

// ---------------------------------------------------------------------------- state

app.get('/api/state', asyncRoute(async (_req, res) => {
  const config = await loadConfig();
  const manifest = await loadManifest(config);
  const git = await gitStatus();

  res.json({
    config: publicConfig(config),
    git,
    concurrency: config.concurrency || defaultConcurrency(),
    budget: budgetReport(manifest),
    albums: manifest.albums,
    photoCount: manifest.photos.length,
    staged: await listStaged(),
    operation: activeOperation(),
    recovery: takeRecovery(),
  });
}));

function takeRecovery() {
  const value = recovery;
  recovery = null;
  return value;
}

app.post('/api/setup', asyncRoute(async (_req, res) => {
  const result = await ensureGalleryWorktree();
  res.json({ ok: true, ...result, git: await gitStatus() });
}));

// ---------------------------------------------------------------------------- operations

app.get('/api/ops/:id', (req, res) => {
  const op = getOperation(req.params.id);
  if (!op) {
    return res.status(404).json(describeError(new StudioError(
      'The studio no longer knows about this operation; it was probably restarted.',
      { status: 404, code: 'unknown-operation', hint: 'Reload the page to see the current state.' },
    )));
  }
  res.json(op);
});

/** Long operations answer at once with an id to poll; see lib/operations.mjs. */
function accepted(res, op) {
  res.status(202).json({ opId: op.id, operation: op });
}

/** The user's answer to a conflict, which is only honoured for the exact remote commit they saw. */
function readResolution(body) {
  const r = body?.resolution;
  if (!r || !['force', 'merge'].includes(r.action) || typeof r.remoteCommit !== 'string') return null;
  return { action: r.action, remoteCommit: r.remoteCommit };
}

app.post('/api/settings', asyncRoute(async (req, res) => {
  const { siteTitle, siteTagline, passcode, budgetMB } = req.body || {};
  const configBefore = await readFile(CONFIG_PATH, 'utf8');

  const op = startOperation(
    { kind: 'settings', title: 'Saving site settings', steps: transactionSteps([['settings', 'Writing the new settings']]) },
    (op) => galleryTransaction(op, {
      // Settings only reach visitors through a rebuild, and a rebuild only runs on a push.
      // Publishing here is what makes a passcode change take effect now instead of silently
      // waiting for the next upload. Unchanged settings produce an identical tree and no push.
      message: 'gallery: update site settings',
      push: req.body?.push !== false,
      resolution: readResolution(req.body),
      journal: { configBefore },
      onRollback: () => writeFile(CONFIG_PATH, configBefore, 'utf8'),
      apply: async (op) => {
        const config = await loadConfig();
        await op.step('settings', async () => {
          if (typeof siteTitle === 'string' && siteTitle.trim()) config.siteTitle = siteTitle.trim();
          if (typeof siteTagline === 'string') config.siteTagline = siteTagline.trim();
          if (typeof budgetMB === 'number' && budgetMB > 0) {
            config.budgetBytes = Math.round(budgetMB * 1024 * 1024);
          }
          // Hashing here rather than in the browser means the plaintext passcode is never written
          // to config.json, which is a tracked file that ends up in a public repository.
          // Trimmed to match the gate, which trims what the visitor types; hashing a passcode with
          // a stray trailing space here would make it impossible to ever enter.
          if (typeof passcode === 'string') {
            const cleaned = passcode.trim();
            config.passcodeHash = cleaned
              ? createHash('sha256').update(cleaned, 'utf8').digest('hex')
              : '';
          }

          await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
          // Re-stamp the manifest so the site picks up the new title/passcode.
          await saveManifest(await loadManifest(config));
        });
        return { config: publicConfig(config) };
      },
    }),
  );
  accepted(res, op);
}));

/** Pushes whatever this computer has that GitHub does not, e.g. after a publish whose upload failed. */
app.post('/api/sync', asyncRoute(async (req, res) => {
  const op = startOperation(
    { kind: 'sync', title: 'Syncing with GitHub', steps: transactionSteps([]) },
    (op) => galleryTransaction(op, {
      message: 'gallery: sync',
      resolution: readResolution(req.body),
      apply: async () => ({}),
    }),
  );
  accepted(res, op);
}));

function publicConfig(config) {
  return {
    siteTitle: config.siteTitle,
    siteTagline: config.siteTagline,
    domain: config.domain,
    budgetBytes: config.budgetBytes,
    hasPasscode: Boolean(config.passcodeHash),
    webMaxEdge: config.webMaxEdge,
    thumbMaxEdge: config.thumbMaxEdge,
  };
}

// ---------------------------------------------------------------------------- staging

/**
 * Receives one original file, streamed straight to disk. A batch of A7R V frames is several
 * hundred megabytes, so the body is never buffered in memory.
 */
app.post('/api/stage', asyncRoute(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) throw new StudioError('The file name is missing.', { status: 400, code: 'no-name' });

  const ext = extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new StudioError(`“${name}” is not a supported photo type (${ext || 'no extension'}).`, {
      status: 415,
      code: 'unsupported-type',
      hint: 'Supported: .HIF, .HEIC, .HEIF, .AVIF, .JPG, .PNG, .TIFF and .WEBP.',
    });
  }

  const fileId = randomUUID();
  const dir = join(STAGING_DIR, fileId);
  await mkdir(dir, { recursive: true });
  const originalPath = join(dir, `original${ext}`);

  try {
    await pipeline(req, createWriteStream(originalPath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new StudioError(`Copying “${name}” into the studio was interrupted.`, {
      status: err.code === 'ENOSPC' ? 507 : 500,
      code: err.code === 'ENOSPC' ? 'disk-full' : 'stage-interrupted',
      hint: err.code === 'ENOSPC' ? 'The disk is full; free some space and add the photo again.' : 'Add the photo again.',
      cause: err,
    });
  }

  await writeFile(join(dir, 'meta.json'), JSON.stringify({ fileId, name, state: 'staged' }, null, 2));
  res.json({ fileId, name });
}));

app.delete('/api/stage/:fileId', asyncRoute(async (req, res) => {
  await rm(stagingDir(req.params.fileId), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.post('/api/stage/clear', asyncRoute(async (_req, res) => {
  await rm(STAGING_DIR, { recursive: true, force: true });
  res.json({ ok: true });
}));

app.get('/api/staged/:fileId/:variant', asyncRoute(async (req, res) => {
  const { fileId, variant } = req.params;
  if (variant !== 'web' && variant !== 'thumb') return res.status(404).end();

  const path = join(stagingDir(fileId), `${variant}.avif`);

  let data;
  try {
    data = await readFile(path);
  } catch {
    return res.status(404).json({ error: 'This photo has not finished processing yet.' });
  }

  res.type('image/avif');
  // Rotating a photo rewrites this file in place, so it must never be cached.
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}));

function stagingDir(fileId) {
  // Guard against a crafted id escaping the staging root.
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new StudioError('Invalid file id.', { status: 400, code: 'bad-file-id' });
  return join(STAGING_DIR, fileId);
}

async function listStaged() {
  let entries;
  try {
    entries = await readdir(STAGING_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const staged = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(join(STAGING_DIR, entry.name, 'meta.json'), 'utf8'));
      staged.push(meta);
    } catch {
      // A half-written staging directory is not worth surfacing; it gets cleaned up on clear.
    }
  }
  return staged;
}

// ---------------------------------------------------------------------------- processing

app.post('/api/process', asyncRoute(async (req, res) => {
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

app.get('/api/process/:jobId', (req, res) => {
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

app.post('/api/process/:jobId/cancel', (req, res) => {
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

async function findOriginal(dir) {
  const entries = await readdir(dir);
  const original = entries.find((name) => name.startsWith('original'));
  if (!original) {
    throw new StudioError('The original file for this photo has gone missing from the studio.', {
      status: 404,
      code: 'original-missing',
      hint: 'Remove it from the list and add the photo again.',
    });
  }
  return join(dir, original);
}

/** Re-runs a single photo with an extra rotation, for when the automatic guess is wrong. */
app.post('/api/rotate', asyncRoute(async (req, res) => {
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

// ---------------------------------------------------------------------------- publishing

app.post('/api/publish', asyncRoute(async (req, res) => {
  const {
    fileIds = [],
    title = '',
    date,
    showLocation = false,
    coverFileId,
    captions = {},
    push = true,
  } = req.body || {};

  if (fileIds.length === 0) throw new StudioError('No photos are selected.', { status: 400, code: 'no-photos' });

  // Checked before starting, so a mistake is reported at once rather than as a failed operation.
  const staged = [];
  for (const fileId of fileIds) {
    const dir = stagingDir(fileId);
    const meta = await readMeta(dir);
    if (!meta.photo) {
      throw new StudioError(`“${meta.name}” has not finished processing yet.`, {
        status: 409,
        code: 'not-processed',
        hint: 'Wait for it to finish, or untick it and publish the rest.',
      });
    }
    staged.push({ fileId, dir, meta });
  }

  const albumDate = date || earliestDate(staged) || today();
  const albumTitle = String(title).trim() || albumDate;

  const op = startOperation(
    {
      kind: 'publish',
      title: `Publishing “${albumTitle}”`,
      steps: transactionSteps([
        ['photos', `Copying ${staged.length} photos into the album`],
        ['manifest', 'Adding the album to the site’s photo list'],
      ]),
    },
    (op) => {
      let summary = albumTitle;
      return galleryTransaction(op, {
        message: () => `gallery: ${summary}`,
        push,
        resolution: readResolution(req.body),
        journal: { stagingIds: fileIds },
        // Staging is only cleared once GitHub has the photos, so an abandoned or failed publish
        // can simply be retried.
        finish: () => clearStaging(fileIds),
        apply: async (op) => {
          // Loaded inside the transaction: after a merge, the manifest is GitHub's plus ours.
          const config = await loadConfig();
          const manifest = await loadManifest(config);
          const id = makeAlbumId(title, albumDate, manifest.albums.map((a) => a.id));
          const album = {
            id,
            title: albumTitle,
            date: albumDate,
            coverPhotoId: null,
            showLocation: Boolean(showLocation),
            photoCount: 0,
            bytes: 0,
          };

          const added = await op.step('photos', (step) => copyIntoAlbum(step, {
            staged, album, manifest, config, captions, coverFileId,
          }));

          if (added.length === 0) {
            throw new StudioError('All of these photos are already on the site (their contents are identical).', {
              status: 409,
              code: 'already-published',
              hint: 'Nothing new to publish. Clear the list to start over.',
            });
          }

          await op.step('manifest', async (step) => {
            album.coverPhotoId ||= added[0].id;
            manifest.albums.push(album);
            manifest.photos.push(...added);
            await saveManifest(manifest);
            step.detail = `${manifest.albums.length} albums, ${manifest.photos.length} photos in total`;
          });

          summary = `${album.title} (${added.length} photos)`;
          return {
            album: manifest.albums.find((a) => a.id === id),
            added: added.length,
            budget: budgetReport(manifest),
          };
        },
      });
    },
  );
  accepted(res, op);
}));

async function copyIntoAlbum(step, { staged, album, manifest, config, captions, coverFileId }) {
  const added = [];
  let done = 0;
  for (const { fileId, dir, meta } of staged) {
    const photo = meta.photo;
    step.detail = `${done} of ${staged.length}: ${meta.name}`;
    step.progress = done / staged.length;
    done++;

    // Two photos with identical bytes hash to the same id; keep the first and skip the rest
    // rather than writing one file twice and double-counting it against the budget.
    if (manifest.photos.some((p) => p.id === photo.id) || added.some((p) => p.id === photo.id)) {
      continue;
    }

    const bytes = await writePhotoFiles(
      album.id,
      photo.id,
      await readFile(join(dir, 'web.avif')),
      await readFile(join(dir, 'thumb.avif')),
    );

    const entry = {
      id: photo.id,
      albumId: album.id,
      ...photoPaths(album.id, photo.id),
      w: photo.w,
      h: photo.h,
      tw: photo.tw,
      th: photo.th,
      lqip: photo.lqip,
      color: photo.color,
      bytes,
      takenAt: photo.takenAt || `${album.date}T12:00:00`,
      caption: String(captions[fileId] || '').trim(),
      exif: photo.exif || {},
    };

    if (album.showLocation && photo.gps) {
      if (config.reverseGeocode) step.detail = `${done} of ${staged.length}: looking up where ${meta.name} was taken`;
      entry.location = {
        lat: round(photo.gps.lat, 6),
        lon: round(photo.gps.lon, 6),
        label: config.reverseGeocode ? await reverseGeocode(photo.gps.lat, photo.gps.lon) : null,
      };
      if (!entry.location.label) delete entry.location.label;
    }

    added.push(entry);
    if (fileId === coverFileId) album.coverPhotoId = photo.id;
  }
  step.progress = 1;
  step.detail = `${added.length} copied${added.length < staged.length ? `, ${staged.length - added.length} already on the site` : ''}`;
  return added;
}

async function clearStaging(fileIds) {
  for (const fileId of fileIds) {
    await rm(stagingDir(fileId), { recursive: true, force: true });
  }
}

async function readMeta(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  } catch (err) {
    throw new StudioError('A photo in this batch is no longer in the studio.', {
      status: 404,
      code: 'staged-missing',
      hint: 'Reload the page to see what is still there.',
      cause: err,
    });
  }
}

app.post('/api/albums/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) throw new StudioError('No albums are selected.', { status: 400, code: 'no-albums' });

  const op = startOperation(
    {
      kind: 'delete-albums',
      title: ids.length === 1 ? 'Deleting 1 album' : `Deleting ${ids.length} albums`,
      steps: transactionSteps([['delete', 'Removing the photos from the gallery']]),
    },
    (op) => galleryTransaction(op, {
      message: `gallery: delete ${ids.length} albums`,
      push: req.body?.push !== false,
      resolution: readResolution(req.body),
      apply: async (op) => {
        const manifest = await loadManifest(await loadConfig());
        const removed = await op.step('delete', async (step) => {
          let count = 0;
          for (const id of ids) {
            count += deleteAlbum(manifest, id).length;
            await removeAlbumFiles(id);
          }
          await saveManifest(manifest);
          step.detail = `${count} photos removed`;
          return count;
        });
        return { removed, budget: budgetReport(manifest), albums: manifest.albums };
      },
    }),
  );
  accepted(res, op);
}));

app.post('/api/photos/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) throw new StudioError('No photos are selected.', { status: 400, code: 'no-photos' });

  const op = startOperation(
    {
      kind: 'delete-photos',
      title: ids.length === 1 ? 'Deleting 1 photo' : `Deleting ${ids.length} photos`,
      steps: transactionSteps([['delete', 'Removing the photos from the gallery']]),
    },
    (op) => galleryTransaction(op, {
      message: `gallery: delete ${ids.length} photos`,
      push: req.body?.push !== false,
      resolution: readResolution(req.body),
      apply: async (op) => {
        const manifest = await loadManifest(await loadConfig());
        const removed = await op.step('delete', async (step) => {
          const gone = deletePhotos(manifest, ids);
          for (const photo of gone) await removePhotoFiles(photo.albumId, photo.id);
          await saveManifest(manifest);
          step.detail = `${gone.length} photos removed`;
          return gone.length;
        });
        return { removed, budget: budgetReport(manifest), albums: manifest.albums };
      },
    }),
  );
  accepted(res, op);
}));

app.get('/api/albums/:id/photos', asyncRoute(async (req, res) => {
  const config = await loadConfig();
  const manifest = await loadManifest(config);
  res.json({ photos: manifest.photos.filter((p) => p.albumId === req.params.id) });
}));

app.post('/api/reclaim', asyncRoute(async (_req, res) => {
  const op = startOperation(
    { kind: 'reclaim', title: 'Reclaiming local disk', steps: [['gc', 'Dropping old gallery snapshots and compacting the repository']] },
    (op) => op.step('gc', async (step) => {
      const result = await reclaimSpace();
      step.detail = `${Math.round(result.freed / 1024 / 1024)} MB freed`;
      return result;
    }),
  );
  accepted(res, op);
}));

// ---------------------------------------------------------------------------- static + errors

app.use('/gallery', express.static(join(ROOT, 'gallery', 'albums'), { fallthrough: true }));
app.use(express.static(join(ROOT, 'studio', 'public'), { extensions: ['html'] }));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.use((err, req, res, _next) => {
  // express.json() reports a malformed body with `status`; keep it rather than calling it a 500.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json(describeError(err, { operation: `${req.method} ${req.path}` }));
});

// ---------------------------------------------------------------------------- boot

function earliestDate(staged) {
  const dates = staged
    .map((s) => s.meta.photo?.takenAt)
    .filter(Boolean)
    .map((t) => t.slice(0, 10))
    .sort();
  return dates[0];
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

await mkdir(STAGING_DIR, { recursive: true });

// A publish that was cut off (window closed, machine slept, crash) left a journal behind. Settle it
// before serving anything, so the page never shows a half-applied gallery.
recovery = await recoverInterrupted((journal) => clearStaging(journal.stagingIds || []))
  .catch((err) => ({ outcome: 'failed', error: describeError(err, { operation: 'Recovering an interrupted operation' }) }));
if (recovery) {
  console.log(recovery.outcome === 'completed'
    ? `  Recovered: "${recovery.title}" had reached GitHub before the studio stopped; it is kept.`
    : recovery.outcome === 'rolled-back'
      ? `  Recovered: "${recovery.title}" was interrupted; the gallery was put back as it was before.`
      : `  Could not recover an interrupted operation: ${recovery.error.error}`);
}

const server = createServer(app);

// Loopback only. This process can push to your repository and delete your albums; it has no
// business being reachable from the network.
server.listen(PORT, '127.0.0.1', async () => {
  const config = await loadConfig().catch(() => ({}));
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\n  Photo studio is running at ${url}`);
  console.log(`  Site title: ${config.siteTitle ?? '(not set)'}    Concurrency: ${config.concurrency || defaultConcurrency()}`);

  const git = await gitStatus().catch(() => null);
  if (git && !git.worktreeReady) {
    console.log('  Tip: the worktree for the gallery branch is not set up yet — opening the page sets it up.');
  }
  if (git && !git.remote) {
    console.log('  Tip: no origin remote is configured yet, so publishing will only commit locally.');
  }

  if (process.env.PHOTOS_NO_OPEN !== '1') {
    const { spawn } = await import('node:child_process');
    // Open the studio in the default browser. Windows needs `cmd /c start` (empty title arg
    // required); macOS/Linux use the platform open helpers.
    const opener =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    const child = spawn(opener[0], opener[1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  }
});
