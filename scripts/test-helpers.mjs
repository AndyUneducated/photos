/**
 * Shared bits for the test scripts.
 */

import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const IDENT = ['-c', 'user.name=test', '-c', 'user.email=test@localhost'];

/**
 * A photo-like JPEG that is different for every seed, so each one hashes to a distinct photo id.
 * Smooth gradients plus grain, because flat colour compresses to nothing and would make the
 * quality-tier size comparisons meaningless.
 *
 * Carries camera EXIF like a real photo, including GPS, so tests can check what survives into the
 * published files and what must not. The shooting time varies with the seed.
 */
export async function syntheticPhoto(seed, { width = 1800, height = 1200 } = {}) {
  const raw = Buffer.alloc(width * height * 3);
  let state = (seed * 2654435761) >>> 0 || 1;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
  const phase = seed * 1.7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grain = (rand() - 0.5) * 50;
      raw[i] = clamp(128 + 90 * Math.sin(x / 210 + phase) + grain);
      raw[i + 1] = clamp(128 + 80 * Math.cos(y / 170 - phase) + grain);
      raw[i + 2] = clamp(120 + 70 * Math.sin((x + y) / 260 + phase * 2) + grain);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .blur(0.8)
    .withExif(syntheticExif(seed))
    .jpeg({ quality: 92 })
    .toBuffer();
}

export function syntheticTakenAt(seed) {
  const p = (n) => String(n).padStart(2, '0');
  return `2026-05-${p(1 + (seed % 28))}T${p(seed % 24)}:${p(seed % 60)}:${p((seed >> 3) % 60)}`;
}

function syntheticExif(seed) {
  const date = syntheticTakenAt(seed).replace(/-/g, ':').replace('T', ' ');
  return {
    IFD0: { Make: 'TESTCAM CORPORATION', Model: 'T-1000', DateTime: date },
    IFD2: {
      DateTimeOriginal: date,
      ExposureTime: '1/250',
      FNumber: '28/10',
      ISOSpeedRatings: '200',
      FocalLength: '35/1',
      LensModel: 'Test 35mm F2.8',
    },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 25/1 10/1' },
  };
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/**
 * A throwaway world for testing GitHub interaction without GitHub: a bare repository standing in
 * for it, plus any number of independent studio checkouts ("computers"), each with its own server.
 * Pushes can be made to fail on demand (`rejectPushes(true)`), as a server-side hook would.
 */
export async function createSandbox(label) {
  const dir = join(tmpdir(), `photos-${label}-${process.pid}`);
  const remote = join(dir, 'github.git');
  const rejectFlag = join(dir, 'reject-pushes');
  const machines = [];
  let seed = Math.floor(Math.random() * 1e6);

  await mkdir(dir, { recursive: true });
  await run('git', ['init', '--quiet', '--bare', '-b', 'main', remote], dir);
  // Git for Windows runs hooks through its bundled sh, so one script serves every platform.
  const hook = join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh\nif [ -f "${rejectFlag.replace(/\\/g, '/')}" ]; then echo "test: push rejected on purpose" >&2; exit 1; fi\nexit 0\n`);
  await chmod(hook, 0o755);

  /** One "computer": its own checkout of the code and its own studio server. */
  async function machine(name, port, { fresh }) {
    const mdir = join(dir, name);
    if (fresh) {
      await mkdir(mdir, { recursive: true });
      for (const entry of ['studio', 'scripts', 'config.json', '.github', 'package.json', '.gitignore']) {
        await cp(join(ROOT, entry), join(mdir, entry), {
          recursive: true,
          filter: (src) => !src.includes(join('studio', '.state')),
        });
      }
      await run('git', ['init', '--quiet', '-b', 'main'], mdir);
      await run('git', ['add', '-A'], mdir);
      await run('git', [...IDENT, 'commit', '--quiet', '-m', 'code'], mdir);
      await run('git', ['remote', 'add', 'origin', remote], mdir);
      await run('git', ['push', '--quiet', 'origin', 'main'], mdir);
    } else {
      await run('git', ['clone', '--quiet', '--branch', 'main', remote, mdir], dir);
    }
    // A junction rather than a symlink: it needs no special rights on Windows.
    await symlink(join(ROOT, 'node_modules'), join(mdir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    // Commits made by the studio need an identity; keep the sandbox off the user's global one.
    await run('git', ['config', 'user.name', `computer ${name}`], mdir);
    await run('git', ['config', 'user.email', `${name}@localhost`], mdir);

    const base = `http://127.0.0.1:${port}`;
    const m = {
      name,
      dir: mdir,
      base,
      log: '',
      server: null,
      async start() {
        m.server = spawn(process.execPath, ['studio/server.mjs'], {
          cwd: mdir,
          env: { ...process.env, PORT: String(port), PHOTOS_NO_OPEN: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        m.server.stdout.on('data', (d) => { m.log += d; });
        m.server.stderr.on('data', (d) => { m.log += d; });
        for (let i = 0; i < 80; i++) {
          try {
            // Not /api/state: that would consume the one-time recovery report.
            if ((await fetch(`${base}/app.css`)).ok) return;
          } catch { /* not up yet */ }
          await sleep(250);
        }
        throw new Error(`server ${name} never came up:\n${m.log}`);
      },
      async stop() {
        // A killed process reports a signalCode and leaves exitCode null.
        if (!m.server || m.server.exitCode !== null || m.server.signalCode !== null) return;
        const exited = new Promise((r) => m.server.once('exit', r));
        m.server.kill();
        await exited;
      },
      async get(path) {
        const res = await fetch(base + path);
        return res.json();
      },
      async post(path, body = {}, contentType = 'application/json') {
        const res = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body: contentType === 'application/json' ? JSON.stringify(body) : body,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`${name} POST ${path} -> ${res.status} ${JSON.stringify(data)}`);
        return data;
      },
      async runOp(path, body) {
        const { opId } = await m.post(path, body);
        for (let i = 0; i < 600; i++) {
          const op = await m.get(`/api/ops/${opId}`);
          if (op.state !== 'running') return op;
          await sleep(150);
        }
        throw new Error(`${name}: timed out on ${path}`);
      },
      /** Stages and processes one new synthetic photo; returns its fileId. */
      async stage(title) {
        const bytes = await syntheticPhoto(seed++, { width: 900, height: 600 });
        const { fileId } = await m.post(`/api/stage?name=${encodeURIComponent(`${title}.jpg`)}`, bytes, 'application/octet-stream');
        const { jobId } = await m.post('/api/process', { fileIds: [fileId] });
        for (let i = 0; i < 400; i++) {
          const job = await m.get(`/api/process/${jobId}`);
          if (job.state !== 'running') {
            if (job.items[0].state !== 'ready') throw new Error(`${name}: processing ${title} failed: ${job.items[0].error}`);
            return fileId;
          }
          await sleep(150);
        }
        throw new Error(`${name}: processing ${title} timed out`);
      },
      publishStaged(fileId, title, extra = {}) {
        return m.runOp('/api/publish', { fileIds: [fileId], title, date: '2026-01-01', ...extra });
      },
      async publish(title, extra) {
        return m.publishStaged(await m.stage(title), title, extra);
      },
      async isStaged(fileId) {
        return (await m.get('/api/state')).staged.some((s) => s.fileId === fileId);
      },
      async localTitles() {
        const manifest = JSON.parse(await readFile(join(mdir, 'gallery', 'manifest.json'), 'utf8'));
        return manifest.albums.map((x) => x.title);
      },
      head: () => run('git', ['rev-parse', 'refs/heads/gallery'], mdir),
      tree: () => run('git', ['rev-parse', 'refs/heads/gallery^{tree}'], mdir),
      dirty: async () => Boolean(await run('git', ['status', '--porcelain', '--untracked-files=all'], join(mdir, 'gallery'))),
    };
    machines.push(m);
    await m.start();
    return m;
  }

  return {
    dir,
    machine,
    machines,
    async rejectPushes(on) {
      if (on) await writeFile(rejectFlag, '1');
      else await rm(rejectFlag, { force: true });
    },
    async remoteTitles() {
      const text = await run('git', ['--git-dir', remote, 'show', 'refs/heads/gallery:manifest.json'], dir).catch(() => '{"albums":[]}');
      return JSON.parse(text).albums.map((x) => x.title);
    },
    remoteTree: () => run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/gallery^{tree}'], dir),
    async cleanup() {
      for (const m of machines) await m.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

export function run(cmd, args, cwd = ROOT) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')}: ${err.trim()}`))));
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
