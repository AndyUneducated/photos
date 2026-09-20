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
import { ensureGalleryWorktree, publishGallery, reclaimSpace, status as gitStatus } from './lib/git.mjs';
import { reverseGeocode } from './lib/geocode.mjs';
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
  });
}));

app.post('/api/setup', asyncRoute(async (_req, res) => {
  const result = await ensureGalleryWorktree();
  res.json({ ok: true, ...result, git: await gitStatus() });
}));

app.post('/api/settings', asyncRoute(async (req, res) => {
  const config = await loadConfig();
  const { siteTitle, siteTagline, passcode, budgetMB } = req.body || {};

  if (typeof siteTitle === 'string' && siteTitle.trim()) config.siteTitle = siteTitle.trim();
  if (typeof siteTagline === 'string') config.siteTagline = siteTagline.trim();
  if (typeof budgetMB === 'number' && budgetMB > 0) {
    config.budgetBytes = Math.round(budgetMB * 1024 * 1024);
  }
  // Hashing here rather than in the browser means the plaintext passcode is never written to
  // config.json, which is a tracked file that ends up in a public repository.
  // Trimmed to match the gate, which trims what the visitor types; hashing a passcode with a
  // stray trailing space here would make it impossible to ever enter.
  if (typeof passcode === 'string') {
    const cleaned = passcode.trim();
    config.passcodeHash = cleaned
      ? createHash('sha256').update(cleaned, 'utf8').digest('hex')
      : '';
  }

  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  // Re-stamp the manifest so the site picks up the new title/passcode.
  const manifest = await loadManifest(config);
  await saveManifest(manifest);

  // Settings only reach visitors through a rebuild, and a rebuild only runs on a push. Publishing
  // here is what makes a passcode change take effect now instead of silently waiting for the next
  // upload. publishGallery compares trees first, so re-saving unchanged settings costs nothing.
  const git = await publishGallery('gallery: 更新站点设置', { push: req.body?.push !== false });

  res.json({ ok: true, config: publicConfig(config), git });
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
  if (!name) return res.status(400).json({ error: '缺少文件名' });

  const ext = extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return res.status(415).json({ error: `不支持的文件类型 ${ext || '(无扩展名)'}` });
  }

  const fileId = randomUUID();
  const dir = join(STAGING_DIR, fileId);
  await mkdir(dir, { recursive: true });
  const originalPath = join(dir, `original${ext}`);

  try {
    await pipeline(req, createWriteStream(originalPath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
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
    return res.status(404).json({ error: '这张照片还没处理好' });
  }

  res.type('image/avif');
  // Rotating a photo rewrites this file in place, so it must never be cached.
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}));

function stagingDir(fileId) {
  // Guard against a crafted id escaping the staging root.
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new HttpError(400, '非法的文件 id');
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
  if (fileIds.length === 0) return res.status(400).json({ error: '没有要处理的文件' });

  const config = await loadConfig();
  const jobId = randomUUID();

  const items = [];
  for (const fileId of fileIds) {
    const dir = stagingDir(fileId);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    const original = await findOriginal(dir);
    items.push({ fileId, name: meta.name, originalPath: original, state: 'pending' });
  }

  const job = { id: jobId, state: 'running', startedAt: Date.now(), items, cancelled: false };
  jobs.set(jobId, job);

  runJob(job, config).catch((err) => {
    job.state = 'failed';
    job.error = err.message;
  });

  res.json({ jobId });
}));

app.get('/api/process/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在（可能是重启过）' });

  res.json({
    id: job.id,
    state: job.state,
    error: job.error,
    items: job.items.map((item) => ({
      fileId: item.fileId,
      name: item.name,
      state: item.state,
      error: item.error,
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
    opts: pipelineOptions(config),
    concurrency: config.concurrency || defaultConcurrency(),
    isCancelled: () => job.cancelled,
    onEvent: (event) => {
      const item = byId.get(event.taskId);
      if (!item) return;
      if (event.type === 'start') item.state = 'processing';
      if (event.type === 'failed') {
        item.state = 'failed';
        item.error = event.error;
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
            item.error = err.message;
          });
      }
    },
  });

  await Promise.all(job.items.map((item) => item.pending).filter(Boolean));
  job.state = job.cancelled ? 'cancelled' : 'done';
}

function pipelineOptions(config, manualRotate = 0) {
  return {
    webMaxEdge: config.webMaxEdge,
    thumbMaxEdge: config.thumbMaxEdge,
    webQuality: config.webQuality,
    thumbQuality: config.thumbQuality,
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
  if (!original) throw new HttpError(404, '暂存的原始文件不见了');
  return join(dir, original);
}

/** Re-runs a single photo with an extra rotation, for when the automatic guess is wrong. */
app.post('/api/rotate', asyncRoute(async (req, res) => {
  const { fileId, degrees } = req.body || {};
  const dir = stagingDir(fileId);
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  const config = await loadConfig();

  const results = await runBatch([{ taskId: fileId, filePath: await findOriginal(dir) }], {
    opts: pipelineOptions(config, degrees),
    concurrency: 1,
  });

  const [result] = results;
  if (!result?.ok) return res.status(500).json({ error: result?.error || '旋转失败' });

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

  if (fileIds.length === 0) return res.status(400).json({ error: '没有选中任何照片' });

  const config = await loadConfig();
  const manifest = await loadManifest(config);

  const staged = [];
  for (const fileId of fileIds) {
    const dir = stagingDir(fileId);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    if (!meta.photo) return res.status(409).json({ error: `${meta.name} 还没有处理完` });
    staged.push({ fileId, dir, meta });
  }

  const albumDate = date || earliestDate(staged) || today();
  const id = makeAlbumId(title, albumDate, manifest.albums.map((a) => a.id));

  const album = {
    id,
    title: String(title).trim() || albumDate,
    date: albumDate,
    coverPhotoId: null,
    showLocation: Boolean(showLocation),
    photoCount: 0,
    bytes: 0,
  };

  const added = [];
  for (const { fileId, dir, meta } of staged) {
    const photo = meta.photo;

    // Two photos with identical bytes hash to the same id; keep the first and skip the rest
    // rather than writing one file twice and double-counting it against the budget.
    if (manifest.photos.some((p) => p.id === photo.id) || added.some((p) => p.id === photo.id)) {
      continue;
    }

    const bytes = await writePhotoFiles(
      id,
      photo.id,
      await readFile(join(dir, 'web.avif')),
      await readFile(join(dir, 'thumb.avif')),
    );

    const entry = {
      id: photo.id,
      albumId: id,
      ...photoPaths(id, photo.id),
      w: photo.w,
      h: photo.h,
      tw: photo.tw,
      th: photo.th,
      lqip: photo.lqip,
      color: photo.color,
      bytes,
      takenAt: photo.takenAt || `${albumDate}T12:00:00`,
      caption: String(captions[fileId] || '').trim(),
      exif: photo.exif || {},
    };

    if (album.showLocation && photo.gps) {
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

  if (added.length === 0) {
    return res.status(409).json({ error: '这些照片都已经发布过了（内容完全相同）' });
  }

  album.coverPhotoId ||= added[0].id;
  manifest.albums.push(album);
  manifest.photos.push(...added);
  await saveManifest(manifest);

  const publishResult = await publishGallery(`gallery: ${album.title} (${added.length} 张)`, { push });

  for (const { fileId } of staged) {
    await rm(stagingDir(fileId), { recursive: true, force: true });
  }

  res.json({
    album: manifest.albums.find((a) => a.id === id),
    added: added.length,
    budget: budgetReport(manifest),
    git: publishResult,
  });
}));

app.post('/api/albums/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const config = await loadConfig();
  const manifest = await loadManifest(config);

  let removed = 0;
  for (const id of ids) {
    removed += deleteAlbum(manifest, id).length;
    await removeAlbumFiles(id);
  }

  await saveManifest(manifest);
  const git = await publishGallery(`gallery: 删除 ${ids.length} 个相册`, { push: req.body?.push !== false });

  res.json({ removed, budget: budgetReport(manifest), albums: manifest.albums, git });
}));

app.post('/api/photos/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const config = await loadConfig();
  const manifest = await loadManifest(config);

  const removed = deletePhotos(manifest, ids);
  for (const photo of removed) await removePhotoFiles(photo.albumId, photo.id);

  await saveManifest(manifest);
  const git = await publishGallery(`gallery: 删除 ${removed.length} 张照片`, { push: req.body?.push !== false });

  res.json({ removed: removed.length, budget: budgetReport(manifest), albums: manifest.albums, git });
}));

app.get('/api/albums/:id/photos', asyncRoute(async (req, res) => {
  const config = await loadConfig();
  const manifest = await loadManifest(config);
  res.json({ photos: manifest.photos.filter((p) => p.albumId === req.params.id) });
}));

app.post('/api/reclaim', asyncRoute(async (_req, res) => {
  res.json(await reclaimSpace());
}));

// ---------------------------------------------------------------------------- static + errors

app.use('/gallery', express.static(join(ROOT, 'gallery', 'albums'), { fallthrough: true }));
app.use(express.static(join(ROOT, 'studio', 'public'), { extensions: ['html'] }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '内部错误' });
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

const server = createServer(app);

// Loopback only. This process can push to your repository and delete your albums; it has no
// business being reachable from the network.
server.listen(PORT, '127.0.0.1', async () => {
  const config = await loadConfig().catch(() => ({}));
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\n  相册工作台已启动：${url}`);
  console.log(`  站点标题：${config.siteTitle ?? '(未设置)'}    并发：${config.concurrency || defaultConcurrency()}`);

  const git = await gitStatus().catch(() => null);
  if (git && !git.worktreeReady) {
    console.log('  提示：gallery 分支的 worktree 还没建好，在页面上点一下「初始化」即可。');
  }
  if (git && !git.remote) {
    console.log('  提示：还没有配置 origin 远端，发布会只提交到本地。');
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
