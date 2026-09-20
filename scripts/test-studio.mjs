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
  console.error('没有找到测试用的照片。把一张照片放进 samples/，或者作为参数传进来。');
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

console.log(`测试文件：${sample}\n启动服务…`);

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
  check('GET /api/state 返回配置', Boolean(state.config?.siteTitle), JSON.stringify(state.config));
  check('gallery worktree 已就绪', state.git.worktreeReady === true, JSON.stringify(state.git));

  const albumsBefore = state.albums.length;
  const usedBefore = state.budget.usedBytes;

  // ---------------------------------------------------------------- stage
  const bytes = await readFile(sample);
  const staged = await post(`/api/stage?name=${encodeURIComponent(basename(sample))}`, bytes, 'application/octet-stream');
  check('暂存文件返回 fileId', Boolean(staged.fileId), JSON.stringify(staged));

  // ---------------------------------------------------------------- process
  const { jobId } = await post('/api/process', { fileIds: [staged.fileId] });
  check('创建处理任务', Boolean(jobId));

  const job = await waitForJob(jobId);
  check('处理任务完成', job.state === 'done', job.state);

  const item = job.items[0];
  check('照片处理成功', item.state === 'ready', item.error || item.state);
  check('返回了尺寸', item.photo?.w > 0 && item.photo?.h > 0, JSON.stringify(item.photo?.w));
  check('生成了 lqip', typeof item.photo?.lqip === 'string' && item.photo.lqip.startsWith('data:image/webp'));
  check('生成了主色', /^#[0-9a-f]{6}$/.test(item.photo?.color || ''), item.photo?.color);

  // ---------------------------------------------------------------- staged image is served
  const thumbRes = await fetch(`${BASE}/api/staged/${staged.fileId}/thumb`);
  const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
  check('缩略图可以取到', thumbRes.ok && thumbBytes.length > 500, `${thumbRes.status}, ${thumbBytes.length}B`);
  check('缩略图是 AVIF', thumbBytes.includes(Buffer.from('ftyp')) && thumbBytes.includes(Buffer.from('av01')));

  // ---------------------------------------------------------------- publish
  const published = await post('/api/publish', {
    fileIds: [staged.fileId],
    title: '自动化测试相册',
    showLocation: false,
    coverFileId: staged.fileId,
    captions: { [staged.fileId]: '测试说明' },
    push: false,
  });
  check('发布成功', published.added === 1, JSON.stringify(published).slice(0, 200));

  const albumId = published.album.id;
  check('相册 id 带日期前缀', /^\d{4}-\d{2}-\d{2}/.test(albumId), albumId);
  check('封面已设置', published.album.coverPhotoId === item.photo.id);
  check('占用空间增加', published.budget.usedBytes > usedBefore);

  // ---------------------------------------------------------------- manifest on disk
  const manifest = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
  check('manifest 版本是 1', manifest.version === 1);
  check('manifest 记录了相册', manifest.albums.length === albumsBefore + 1);

  const photo = manifest.photos.find((p) => p.id === item.photo.id);
  check('manifest 记录了照片', Boolean(photo));
  check('照片带 albumId', photo?.albumId === albumId);
  check('照片说明写进去了', photo?.caption === '测试说明');
  check('没有 location 字段（相册未开启位置）', photo && !('location' in photo));
  check('web 路径形如 p/<album>/w/<id>.avif', photo?.web === `p/${albumId}/w/${photo.id}.avif`, photo?.web);

  const webPath = join(ROOT, 'gallery', 'albums', albumId, 'w', `${photo.id}.avif`);
  const thumbPath = join(ROOT, 'gallery', 'albums', albumId, 't', `${photo.id}.avif`);
  check('web 文件存在', await exists(webPath), webPath);
  check('thumb 文件存在', await exists(thumbPath), thumbPath);
  check('bytes 与磁盘一致', photo.bytes === (await size(webPath)) + (await size(thumbPath)));

  // ---------------------------------------------------------------- git
  // `refs/heads/gallery` rather than `gallery`: there is also a directory called `gallery`, and
  // git would refuse the ambiguous name.
  const log = await git(['log', '--oneline', 'refs/heads/gallery']);
  check('gallery 分支有提交', log.includes('自动化测试相册'), log.slice(0, 200));

  const parents = await git(['rev-list', '--count', 'refs/heads/gallery']);
  check('gallery 分支只有一个提交（无历史）', parents.trim() === '1', parents.trim());

  const stagingLeft = await readdir(join(ROOT, 'studio', '.state', 'staging')).catch(() => []);
  check('发布后清空了暂存目录', stagingLeft.length === 0, stagingLeft.join(','));

  // ---------------------------------------------------------------- delete
  const deleted = await post('/api/albums/delete', { ids: [albumId], push: false });
  check('删除相册', deleted.removed === 1, JSON.stringify(deleted).slice(0, 200));
  check('删除后回到原始占用', deleted.budget.usedBytes === usedBefore);
  check('相册目录已删除', !(await exists(join(ROOT, 'gallery', 'albums', albumId))));

  // ---------------------------------------------------------------- settings publish
  // A passcode change is worthless if it only lands in the working tree: the site rebuilds on
  // push, so saving settings has to commit too. Restores the original config.json afterwards.
  const configPath = join(ROOT, 'config.json');
  const configBefore = await readFile(configPath, 'utf8');
  try {
    const probe = 'test-passcode-' + Date.now();
    const saved = await post('/api/settings', { passcode: probe, push: false });
    check('保存设置产生了提交', saved.git?.changed === true, JSON.stringify(saved.git));

    const wantHash = createHash('sha256').update(probe, 'utf8').digest('hex');
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    check('config.json 存的是哈希而非明文', cfg.passcodeHash === wantHash && !configBefore.includes(probe));

    const m = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
    check('manifest 带上了新口令哈希', m.site.passcodeHash === wantHash, m.site.passcodeHash);

    const committed = await git(['show', 'refs/heads/gallery:manifest.json']);
    check('新哈希确实进了提交', JSON.parse(committed).site.passcodeHash === wantHash);
    check('gallery 仍然只有一个提交', (await git(['rev-list', '--count', 'refs/heads/gallery'])).trim() === '1');

    const again = await post('/api/settings', { passcode: probe, push: false });
    check('重复保存不产生空提交', again.git?.changed === false, JSON.stringify(again.git));
  } finally {
    // Put the real hash back on disk, then save once with no passcode field so the manifest and
    // the gallery commit get re-stamped from the restored config.
    await writeFile(configPath, configBefore, 'utf8');
    await post('/api/settings', { push: false });
  }

  const restored = JSON.parse(await readFile(join(ROOT, 'gallery', 'manifest.json'), 'utf8'));
  check('测试后口令已还原', restored.site.passcodeHash === JSON.parse(configBefore).passcodeHash);
} catch (err) {
  failures++;
  console.log(`\n测试过程中抛出异常：${err.message}`);
  console.log(err.stack);
} finally {
  server.kill();
}

if (serverLog.includes('Error') || serverLog.includes('error')) {
  console.log(`\n--- 服务端日志 ---\n${serverLog.trim()}`);
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
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
  throw new Error(`服务没有起来。日志：\n${serverLog}`);
}

async function waitForJob(jobId) {
  for (let i = 0; i < 480; i++) {
    const job = await get(`/api/process/${jobId}`);
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('处理任务超时');
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
