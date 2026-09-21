/**
 * End-to-end test of the studio's publish flow: stage a file, process it, publish it, and verify
 * that the manifest, the AVIF files and the git commit all came out right. Cleans up after itself.
 *
 *   node scripts/test-studio.mjs [path-to-photo]
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 4479;
const BASE = `http://127.0.0.1:${PORT}`;

const sample = process.argv[2] || (await firstSample());
if (!sample) {
  console.error('No test photo found. Put one in samples/, or pass its path as an argument.');
  process.exit(1);
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`Test file: ${sample}\nStarting the server…`);

const server = spawn(process.execPath, ['studio/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PHOTOS_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

try {
  await waitForServer();

  // ---------------------------------------------------------------- state
  const state = await get('/api/state');
  check('GET /api/state returns the config', Boolean(state.config?.siteTitle), JSON.stringify(state.config));
  check('gallery worktree is ready', state.git.worktreeReady === true, JSON.stringify(state.git));

  const albumsBefore = state.albums.length;
  const usedBefore = state.budget.usedBytes;

  // ---------------------------------------------------------------- stage
  const bytes = await readFile(sample);
  const staged = await post(`/api/stage?name=${encodeURIComponent(basename(sample))}`, bytes, 'application/octet-stream');
  check('staging a file returns a fileId', Boolean(staged.fileId), JSON.stringify(staged));

  // ---------------------------------------------------------------- process
  const { jobId } = await post('/api/process', { fileIds: [staged.fileId] });
  check('processing job created', Boolean(jobId));

  const job = await waitForJob(jobId);
  check('processing job finished', job.state === 'done', job.state);

  const item = job.items[0];
  check('photo processed successfully', item.state === 'ready', item.error || item.state);
  check('dimensions returned', item.photo?.w > 0 && item.photo?.h > 0, JSON.stringify(item.photo?.w));
  check('lqip generated', typeof item.photo?.lqip === 'string' && item.photo.lqip.startsWith('data:image/webp'));
  check('dominant colour generated', /^#[0-9a-f]{6}$/.test(item.photo?.color || ''), item.photo?.color);

  // ---------------------------------------------------------------- staged image is served
  const thumbRes = await fetch(`${BASE}/api/staged/${staged.fileId}/thumb`);
  const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
  check('thumbnail can be fetched', thumbRes.ok && thumbBytes.length > 500, `${thumbRes.status}, ${thumbBytes.length}B`);
  check('thumbnail is AVIF', thumbBytes.includes(Buffer.from('ftyp')) && thumbBytes.includes(Buffer.from('av01')));

  // ---------------------------------------------------------------- quality tiers
  // An ignored tier would look identical to a working one everywhere except the encoded size,
  // so size is what this measures. Measured ratio on the Sony sample is ~1.73.
  const staged2 = await post(
    `/api/stage?name=${encodeURIComponent(basename(sample))}`,
    bytes,
    'application/octet-stream',
  );
  const maxJob = await waitForJob(
    (await post('/api/process', { fileIds: [staged2.fileId], quality: 'max' })).jobId,
  );
  const maxItem = maxJob.items[0];
  check('max quality tier processed successfully', maxItem.state === 'ready', maxItem.error || maxItem.state);
  check(
    'max quality tier is clearly bigger',
    maxItem.photo?.bytes > item.photo.bytes * 1.4,
    `standard ${item.photo.bytes} B vs max ${maxItem.photo?.bytes} B`,
  );
  await fetch(`${BASE}/api/stage/${staged2.fileId}`, { method: 'DELETE' });

  // ---------------------------------------------------------------- publish
  const published = await post('/api/publish', {
    fileIds: [staged.fileId],
    title: 'Automated test album',
    showLocation: false,
    coverFileId: staged.fileId,
    captions: { [staged.fileId]: 'Test caption' },
    push: false,
  });
  check('publish succeeded', published.added === 1, JSON.stringify(published).slice(0, 200));

  const albumId = published.album.id;
  check('album id has a date prefix', /^\d{4}-\d{2}-\d{2}/.test(albumId), albumId);
  check('cover was set', published.album.coverPhotoId === item.photo.id);
  check('used space went up', published.budget.usedBytes > usedBefore);

  // ---------------------------------------------------------------- manifest on disk
  const manifest = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
  check('manifest version is 1', manifest.version === 1);
  check('manifest recorded the album', manifest.albums.length === albumsBefore + 1);

  const photo = manifest.photos.find((p) => p.id === item.photo.id);
  check('manifest recorded the photo', Boolean(photo));
  check('photo carries an albumId', photo?.albumId === albumId);
  check('caption was written through', photo?.caption === 'Test caption');
  check('no location field (album did not opt in)', photo && !('location' in photo));
  check('web path looks like p/<album>/w/<id>.avif', photo?.web === `p/${albumId}/w/${photo.id}.avif`, photo?.web);

  const webPath = join(ROOT, 'gallery', 'albums', albumId, 'w', `${photo.id}.avif`);
  const thumbPath = join(ROOT, 'gallery', 'albums', albumId, 't', `${photo.id}.avif`);
  check('web file exists', await exists(webPath), webPath);
  check('thumb file exists', await exists(thumbPath), thumbPath);
  check('bytes agrees with disk', photo.bytes === (await size(webPath)) + (await size(thumbPath)));

  // ---------------------------------------------------------------- git
  // `refs/heads/gallery` rather than `gallery`: there is also a directory called `gallery`, and
  // git would refuse the ambiguous name.
  const log = await git(['log', '--oneline', 'refs/heads/gallery']);
  check('gallery branch has a commit', log.includes('Automated test album'), log.slice(0, 200));

  const parents = await git(['rev-list', '--count', 'refs/heads/gallery']);
  check('gallery branch has exactly one commit (no history)', parents.trim() === '1', parents.trim());

  // GitHub Actions reads a workflow from the branch that was pushed, so without this copy a
  // gallery push rebuilds nothing and the site silently keeps serving the previous photos.
  const lf = (s) => s.replace(/\r\n/g, '\n').trim();
  const shipped = await git(['show', 'refs/heads/gallery:.github/workflows/deploy.yml']).catch(() => '');
  const onMain = await readFile(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  check('gallery branch carries the build workflow', lf(shipped) === lf(onMain), `${lf(shipped).length} vs ${lf(onMain).length}`);

  const stagingLeft = await readdir(join(ROOT, 'studio', '.state', 'staging')).catch(() => []);
  check('staging directory cleared after publish', stagingLeft.length === 0, stagingLeft.join(','));

  // ---------------------------------------------------------------- delete
  const deleted = await post('/api/albums/delete', { ids: [albumId], push: false });
  check('album deleted', deleted.removed === 1, JSON.stringify(deleted).slice(0, 200));
  check('usage back to the original after delete', deleted.budget.usedBytes === usedBefore);
  check('album directory removed', !(await exists(join(ROOT, 'gallery', 'albums', albumId))));

  // ---------------------------------------------------------------- settings publish
  // A passcode change is worthless if it only lands in the working tree: the site rebuilds on
  // push, so saving settings has to commit too. Restores the original config.json afterwards.
  const configPath = join(ROOT, 'config.json');
  const configBefore = await readFile(configPath, 'utf8');
  try {
    const probe = 'test-passcode-' + Date.now();
    const saved = await post('/api/settings', { passcode: probe, push: false });
    check('saving settings produced a commit', saved.git?.changed === true, JSON.stringify(saved.git));

    const wantHash = createHash('sha256').update(probe, 'utf8').digest('hex');
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    check('config.json stores the hash, not the plaintext', cfg.passcodeHash === wantHash && !configBefore.includes(probe));

    const m = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
    check('manifest picked up the new passcode hash', m.site.passcodeHash === wantHash, m.site.passcodeHash);

    const committed = await git(['show', 'refs/heads/gallery:manifest.json']);
    check('the new hash really made it into the commit', JSON.parse(committed).site.passcodeHash === wantHash);
    check('gallery still has exactly one commit', (await git(['rev-list', '--count', 'refs/heads/gallery'])).trim() === '1');

    const again = await post('/api/settings', { passcode: probe, push: false });
    check('saving again produces no empty commit', again.git?.changed === false, JSON.stringify(again.git));
  } finally {
    // Put the real hash back on disk, then save once with no passcode field so the manifest and
    // the gallery commit get re-stamped from the restored config.
    await writeFile(configPath, configBefore, 'utf8');
    await post('/api/settings', { push: false });
  }

  const restored = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
  check('passcode restored after the test', restored.site.passcodeHash === JSON.parse(configBefore).passcodeHash);
} catch (err) {
  failures++;
  console.log(`\nThe test threw an exception: ${err.message}`);
  console.log(err.stack);
} finally {
  server.kill();
}

if (serverLog.includes('Error') || serverLog.includes('error')) {
  console.log(`\n--- server log ---\n${serverLog.trim()}`);
}

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------- helpers

function basename(p) {
  return p.split(/[\\/]/).pop();
}

async function firstSample() {
  const entries = await readdir(join(ROOT, 'samples'), { withFileTypes: true }).catch(() => []);
  const match = entries.find(
    (e) => e.isFile() && /\.(hif|heic|heif|jpg|jpeg|png|tif|tiff)$/i.test(e.name),
  );
  return match ? join(ROOT, 'samples', match.name) : null;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The server never came up. Log:\n${serverLog}`);
}

async function waitForJob(jobId) {
  for (let i = 0; i < 480; i++) {
    const job = await get(`/api/process/${jobId}`);
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for the processing job');
}

async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

async function post(path, body, contentType = 'application/json') {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function size(path) {
  return (await readFile(path)).length;
}

function git(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => resolvePromise(out));
    child.on('error', reject);
  });
}
