/**
 * Clicks through the parts of the UI that only a browser can check, in a headless Chrome or Edge
 * driven over the DevTools protocol (Node's built-in WebSocket; nothing to install).
 *
 *   Studio, against a sandbox with two "computers" (see createSandbox in test-helpers.mjs):
 *     - photos processed in an earlier session reappear on load, and unpushed changes are flagged
 *     - a publish that conflicts with GitHub opens the dialog listing both sides; "Keep both" works
 *     - "Cancel" changes nothing
 *     - a push GitHub refuses shows a readable error with copyable technical details
 *   Site, built into dist/ from that sandbox's gallery:
 *     - "Download" saves the album as a ZIP of the published files, named by shooting time and
 *       carrying it in their EXIF; "All" gives one folder per album
 *     - on a phone it hands the photos to the share sheet instead, and explains a refusal
 *     - a photo that fails to download is named in the error
 *     - the lightbox info button is an outlined ring, not a filled disc, and toggles the caption
 *
 * Saves screenshots of each state and prints where. Skips cleanly when no Chromium browser exists.
 * Leaves dist/ holding the sandbox build; `npm run build` makes the real one again.
 *
 *   node scripts/test-ui.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import exifr from 'exifr';

import { createSandbox, sleep } from './test-helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ASTRO = join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
const SHOTS = join(tmpdir(), 'photos-ui-shots');
const DOWNLOADS = join(tmpdir(), `photos-ui-downloads-${process.pid}`);
const DEBUG_PORT = 9339;
const PREVIEW_PORT = 4493;

const exe = findBrowser();
if (!exe) {
  console.log('skipped: no Chrome, Edge or Chromium found');
  process.exit(0);
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

await rm(SHOTS, { recursive: true, force: true });
await mkdir(SHOTS, { recursive: true });

const sandbox = await createSandbox('ui-test');
let browser = null;
let preview = null;

try {
  browser = await launchBrowser();
  const page = browser.page;

  // ------------------------------------------------------------ studio
  console.log('\nStudio');
  const a = await sandbox.machine('A', 4491, { fresh: true });
  await a.post('/api/setup');
  await a.publish('A1');
  const b = await sandbox.machine('B', 4492, { fresh: false });
  await b.post('/api/setup');
  await b.publish('B1');
  await a.publish('A2', { push: false });
  await a.stage('A3');

  await page.goto(a.base);
  await page.waitFor(`document.querySelectorAll('#review-grid .card').length === 1`, 'restored photo card');
  check('a photo processed in an earlier session reappears', true);
  check('the restore is announced', await page.eval(`toastText().includes('Restored 1 photos')`));
  check('unpushed changes are flagged with an upload button', await page.eval(
    `toastText().includes('never reached GitHub') && [...document.querySelectorAll('.toast__action')].some((b) => b.textContent.includes('Upload'))`,
  ));
  await page.shot('1-restored-session');

  await page.eval(`document.getElementById('album-title').value = 'A3'; document.getElementById('publish-btn').click()`);
  await page.waitFor(`document.getElementById('conflict-dialog').open`, 'conflict dialog');
  const lists = await page.eval(`({
    remote: document.querySelector('#conflict-only-remote').hidden ? '' : document.querySelector('#conflict-only-remote ul').textContent,
    local: document.querySelector('#conflict-only-local').hidden ? '' : document.querySelector('#conflict-only-local ul').textContent,
    summary: document.getElementById('conflict-summary').textContent,
  })`);
  check('conflict dialog lists the other computer’s album', lists.remote.includes('B1') && lists.remote.includes('added on another computer'), lists.remote);
  check('conflict dialog lists this computer’s unpushed album', lists.local.includes('A2') && lists.local.includes('added on this computer'), lists.local);
  check('conflict dialog explains the situation', /another computer/.test(lists.summary), lists.summary);
  await page.shot('2-conflict-dialog');

  await page.eval(`document.getElementById('conflict-merge').click()`);
  // Best effort: the whole publish takes a second or two, so this may land on the final state.
  if (await page.waitFor(`document.querySelector('.toast--progress .steps .step--running')`, 'progress', 4000, { soft: true })) {
    await page.shot('3-publish-progress');
  }
  await page.waitFor(`toastText().includes('Published 1 photos')`, 'publish success toast', 30000);
  check('“Keep both” publishes', true);
  check('GitHub has every album from both computers',
    sameSet(await sandbox.remoteTitles(), ['A1', 'B1', 'A2', 'A3']), (await sandbox.remoteTitles()).join(','));
  check('the published photo leaves the review list', await page.eval(`document.querySelectorAll('#review-grid .card').length === 0`));
  await page.shot('4-published');

  // Cancel: make a conflict again and walk away from it.
  // A "/" in the title, like real ones ("Yellowstone & Teton/MILC"), for the ZIP folder check below.
  await a.publishStaged(await a.stage('A4'), 'A4/MILC', { push: false });
  await b.publish('B2');
  await a.stage('A5');
  const headBefore = await a.head();
  await page.goto(a.base);
  await page.waitFor(`document.querySelectorAll('#review-grid .card').length === 1`, 'restored photo card');
  await page.eval(`document.getElementById('album-title').value = 'A5'; document.getElementById('publish-btn').click()`);
  await page.waitFor(`document.getElementById('conflict-dialog').open`, 'conflict dialog');
  await page.eval(`document.getElementById('conflict-abort').click()`);
  await page.waitFor(`toastText().includes('Cancelled')`, 'cancel toast');
  check('“Cancel” leaves this computer’s gallery untouched', (await a.head()) === headBefore && !(await a.dirty()));
  check('“Cancel” keeps the photo waiting to publish', await page.eval(`document.querySelectorAll('#review-grid .card').length === 1`));
  check('“Cancel” re-enables publishing', await page.eval(`!document.getElementById('publish-btn').disabled`));

  // A push GitHub refuses. Overwrite first so this publish gets as far as the push.
  await page.eval(`document.getElementById('publish-btn').click()`);
  await page.waitFor(`document.getElementById('conflict-dialog').open`, 'conflict dialog');
  await sandbox.rejectPushes(true);
  await page.eval(`window.confirm = () => true; document.getElementById('conflict-force').click()`);
  await page.waitFor(`document.querySelector('.toast--error .errblock')`, 'error toast', 30000);
  const err = await page.eval(`(() => {
    const t = [...document.querySelectorAll('.toast--error')].pop();
    t.querySelector('.errblock__details summary').click();
    return {
      text: t.textContent,
      failedStep: t.querySelector('.step--failed')?.textContent || '',
      details: t.querySelector('.errblock__details pre').textContent,
    };
  })()`);
  check('the error says what happened in plain words', err.text.includes('GitHub received the upload but refused'), err.text.slice(0, 200));
  check('the error says nothing was published', err.text.includes('Nothing was published'));
  check('the error shows which milestone failed', err.failedStep.includes('Uploading to GitHub'), err.failedStep);
  check('the technical details carry git’s output', err.details.includes('rejected on purpose') && err.details.includes('"command"'), err.details.slice(0, 200));
  check('the photo is still waiting after the failure', await page.eval(`document.querySelectorAll('#review-grid .card').length === 1`));
  check('this computer’s gallery was rolled back', (await a.head()) === headBefore && !(await a.dirty()));
  await page.shot('5-push-refused');
  await sandbox.rejectPushes(false);

  // ------------------------------------------------------------ site
  // Built the way CI builds it, from the sandbox studio's own gallery: its manifest, then its
  // photo files under dist/p. That way the downloads below hold files the studio really made.
  console.log('\nSite');
  const galleryDir = join(a.dir, 'gallery');
  const manifest = JSON.parse(await readFile(join(galleryDir, 'manifest.json'), 'utf8'));
  await runNode([ASTRO, 'build', '--silent'], { PHOTOS_MANIFEST: join(galleryDir, 'manifest.json') });
  await cp(join(galleryDir, 'albums'), join(ROOT, 'dist', 'p'), { recursive: true });
  preview = spawn(process.execPath, [ASTRO, 'preview', '--port', String(PREVIEW_PORT)], { cwd: ROOT, stdio: 'ignore' });
  const site = `http://localhost:${PREVIEW_PORT}/`;
  for (let i = 0; i < 60 && !(await fetch(site).then((r) => r.ok, () => false)); i++) await sleep(250);

  await page.goto(site);
  // The gate remembers an unlock as the passcode hash; skip typing it.
  await page.eval(`localStorage.setItem('photos.unlock', ${JSON.stringify(manifest.site.passcodeHash || '')})`);
  await page.goto(site);
  await page.waitFor(`document.querySelector('a.tile img.is-loaded')`, 'photo tiles');
  await page.shot('6-site-header');

  // One album, as a ZIP (a desktop browser).
  await rm(DOWNLOADS, { recursive: true, force: true });
  await mkdir(DOWNLOADS, { recursive: true });
  await browser.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  const album = manifest.albums.find((x) => x.photoCount > 0);
  const albumPhotos = manifest.photos.filter((p) => p.albumId === album.id);
  await page.eval(`document.querySelector('.chip[data-album="${album.id}"]').click()`);
  await page.eval(`document.getElementById('album-download').click()`);
  await page.waitFor(`document.querySelector('.dl-panel.is-done')`, 'album ZIP saved', 30000);
  const zipName = `${safeName(album.title)}.zip`;
  const panelText = await page.eval(`document.querySelector('.dl-panel').textContent`);
  check('the panel says the ZIP was saved', panelText.includes(`Saved “${zipName}”`), panelText);
  await page.shot('7-download-saved');
  const one = await unzipList(await waitForFile(join(DOWNLOADS, zipName)), 'one');
  check('the ZIP holds every photo of the album', one.length === albumPhotos.length, `${one.length} vs ${albumPhotos.length}`);
  const expectedName = `${albumPhotos[0].takenAt.replace('T', ' ').replace(/:/g, '.')}.avif`;
  const file = one.find((f) => f.name === expectedName);
  check('files are named by shooting time', Boolean(file), `${one.map((f) => f.name).join(', ')} (expected ${expectedName})`);
  const tags = file && await exifr.parse(file.data, { tiff: true, exif: true, gps: true, reviveValues: false });
  check('a downloaded photo carries its shooting time', tags?.DateTimeOriginal === albumPhotos[0].takenAt.replace(/-/g, ':').replace('T', ' '), JSON.stringify(tags));
  check('and no GPS position', Boolean(tags) && tags.GPSLatitude === undefined && tags.latitude === undefined);
  const original = await readFile(join(galleryDir, 'albums', album.id, 'w', `${albumPhotos[0].id}.avif`));
  check('the file is the published one, byte for byte', Boolean(file) && original.equals(file.data));

  // Everything, one folder per album.
  await page.eval(`document.querySelector('.dl-panel__close')?.click(); document.querySelector('.chip[data-album="all"]').click()`);
  await page.eval(`document.getElementById('album-download').click()`);
  await page.waitFor(`document.querySelector('.dl-panel.is-done')`, 'full ZIP saved', 30000);
  const all = await unzipList(await waitForFile(join(DOWNLOADS, `${safeName(manifest.site.title)}.zip`)), 'all');
  const folders = new Set(all.map((f) => f.path.split('/')[0]));
  check('“All” puts each album in its own folder', folders.size === manifest.albums.length && all.length === manifest.photos.length,
    `${folders.size} folders, ${all.length} files`);
  check('a “/” in an album title does not split the folder', folders.has('A4-MILC'), [...folders].join(', '));

  // A phone: the share sheet instead of a ZIP. Headless Chrome has no share sheet, so the page's
  // navigator.share is replaced by one that records what it was given.
  await page.eval(`(() => {
    document.querySelector('.dl-panel__close')?.click();
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q.includes('coarse') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
    navigator.canShare = () => true;
    navigator.share = async (data) => { window.__shared = data.files.map((f) => ({ name: f.name, type: f.type, size: f.size })); };
    document.querySelector('.chip[data-album="${album.id}"]').click();
    document.getElementById('album-download').click();
  })()`);
  await page.waitFor(`document.querySelector('.dl-panel__btn.is-primary')?.textContent === 'Save to Photos'`, 'Save to Photos button', 30000);
  await page.shot('8-share-ready');
  await page.eval(`document.querySelector('.dl-panel__btn.is-primary').click()`);
  await page.waitFor(`document.querySelector('.dl-panel.is-done')`, 'share finished');
  const shared = await page.eval('window.__shared');
  check('on a phone the photos go to the share sheet', shared?.length === albumPhotos.length, JSON.stringify(shared?.slice(0, 2)));
  check('shared as AVIF images with their names', Boolean(shared?.every((f) => f.type === 'image/avif' && f.name.endsWith('.avif'))));

  await page.eval(`(() => {
    document.querySelector('.dl-panel__close')?.click();
    navigator.share = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
    document.getElementById('album-download').click();
  })()`);
  await page.waitFor(`document.querySelector('.dl-panel__btn.is-primary')?.textContent === 'Save to Photos'`, 'Save to Photos button', 30000);
  await page.eval(`document.querySelector('.dl-panel__btn.is-primary').click()`);
  await page.waitFor(`document.querySelector('.dl-panel.is-error')`, 'share failure');
  const shareFail = await page.eval(`document.querySelector('.dl-panel').textContent`);
  check('a refused share sheet explains itself and offers the ZIP', shareFail.includes('would not take') && shareFail.includes('Download ZIP'), shareFail);

  // A photo that will not download: the panel must say which one and why.
  const victim = albumPhotos[albumPhotos.length - 1];
  const victimPath = join(ROOT, 'dist', 'p', album.id, 'w', `${victim.id}.avif`);
  await rm(victimPath);
  await page.goto(site); // also drops the share stubs
  await page.waitFor(`document.querySelector('a.tile')`, 'photo tiles');
  await page.eval(`document.querySelector('.chip[data-album="${album.id}"]').click(); document.getElementById('album-download').click()`);
  await page.waitFor(`document.querySelector('.dl-panel.is-error')`, 'download failure', 30000);
  const fail = await page.eval(`document.querySelector('.dl-panel').textContent`);
  check('a missing photo is named in the error, with the reason', fail.includes('Could not download') && fail.includes('404') && fail.includes('Try again'), fail);
  await page.shot('9-download-failed');
  await cp(join(galleryDir, 'albums', album.id, 'w', `${victim.id}.avif`), victimPath);

  // Narrow screen: the button shares the title row.
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.goto(site);
  await page.waitFor(`document.querySelector('a.tile img.is-loaded')`, 'photo tiles');
  const row = await page.eval(`(() => {
    const b = document.getElementById('album-download').getBoundingClientRect();
    const t = document.querySelector('.brand__title').getBoundingClientRect();
    return { sameRow: Math.abs((b.top + b.bottom) / 2 - (t.top + t.bottom) / 2) < 8, right: Math.round(innerWidth - b.right) };
  })()`);
  check('on a phone the button sits at the end of the title row', row.sameRow && row.right < 40, JSON.stringify(row));
  await page.shot('10-phone-header');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // Lightbox.
  await page.goto(site);
  await page.waitFor(`document.querySelector('a.tile')`, 'photo tiles');
  await page.eval(`document.querySelector('a.tile').click()`);
  await page.waitFor(`document.querySelector('.pswp__button--pswp-info svg circle')`, 'lightbox info button', 15000);
  await sleep(600);
  const icon = await page.eval(`(() => {
    const s = getComputedStyle(document.querySelector('.pswp__button--pswp-info svg circle'));
    return { fill: s.fill, stroke: s.stroke, width: s.strokeWidth };
  })()`);
  check('info icon ring is outlined, not filled', icon.fill === 'none' && icon.stroke !== 'none', JSON.stringify(icon));
  const downloadIcon = await page.eval(`getComputedStyle(document.querySelector('.pswp__button--download svg path')).fill`);
  check('download icon is outlined too', downloadIcon === 'none', downloadIcon);
  const single = await page.eval(`({ name: document.querySelector('.pswp__button--download').getAttribute('download'), file: document.querySelector('a.tile').dataset.file })`);
  check('the single-photo download uses the same file name', Boolean(single.name) && single.name === single.file, JSON.stringify(single));
  await page.shot('11-lightbox');
  await page.eval(`document.querySelector('.pswp__button--pswp-info').click()`);
  await page.waitFor(`document.querySelector('.pswp--info-open')`, 'info panel');
  check('the info button opens the photo details', true);
  await page.shot('12-lightbox-info');

  // A site with a single album: no filter, and the download carries the album's name, not the site's.
  const sole = manifest.albums.find((x) => x.title === 'A4/MILC');
  const soleManifest = join(DOWNLOADS, 'single-album.json');
  await writeFile(soleManifest, JSON.stringify({ ...manifest, albums: [sole], photos: manifest.photos.filter((p) => p.albumId === sole.id) }));
  preview.kill();
  await runNode([ASTRO, 'build', '--silent'], { PHOTOS_MANIFEST: soleManifest });
  await cp(join(galleryDir, 'albums'), join(ROOT, 'dist', 'p'), { recursive: true });
  // Restarted: preview caches the file list, and the rebuild renamed the hashed scripts.
  preview = spawn(process.execPath, [ASTRO, 'preview', '--port', String(PREVIEW_PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await fetch(site).then((r) => r.ok, () => false)); i++) await sleep(250);
  await page.goto(site);
  await page.waitFor(`document.querySelector('a.tile')`, 'photo tiles');
  check('a single album shows no filter', await page.eval(`!document.getElementById('filter')`));
  await page.eval(`document.getElementById('album-download').click()`);
  await page.waitFor(`document.querySelector('.dl-panel.is-done')`, 'single-album ZIP saved', 30000);
  const soleText = await page.eval(`document.querySelector('.dl-panel').textContent`);
  check('a single album downloads under its own name', soleText.includes('Downloaded “A4/MILC”') && soleText.includes('Saved “A4-MILC.zip”'), soleText);
  const soleFiles = await unzipList(await waitForFile(join(DOWNLOADS, 'A4-MILC.zip')), 'sole');
  check('with its photos at the top level, not in a folder', soleFiles.length === sole.photoCount && soleFiles.every((f) => !f.path.includes('/')),
    soleFiles.map((f) => f.path).join(', '));
  await page.shot('13-single-album-download');

  check('no uncaught errors in the page', browser.errors.length === 0, browser.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`\nThe test threw an exception: ${e.message}`);
  for (const m of sandbox.machines) if (m.log.trim()) console.log(`\n--- server ${m.name} log ---\n${m.log.trim()}`);
  if (browser) await browser.page.shot('error').catch(() => {});
} finally {
  preview?.kill();
  await browser?.close();
  await sandbox.cleanup();
  await rm(DOWNLOADS, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nScreenshots: ${SHOTS}`);
console.log(failures === 0 ? 'All passed.' : `${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------- browser

function findBrowser() {
  const candidates = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] || [];
  return candidates.find((p) => existsSync(p)) || null;
}

async function launchBrowser() {
  const profile = join(tmpdir(), `photos-ui-profile-${process.pid}`);
  const proc = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json(), () => []);
    target = list.find((t) => t.type === 'page');
  }
  if (!target) throw new Error('the browser did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else ok(msg.result);
    } else {
      for (const fn of listeners) fn(msg);
    }
  };
  const send = (method, params = {}) => new Promise((ok, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: ok, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const nextEvent = (method) => new Promise((ok) => {
    const fn = (msg) => { if (msg.method === method) { listeners.delete(fn); ok(msg.params); } };
    listeners.add(fn);
  });
  listeners.add((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const page = {
    async goto(url) {
      const loaded = nextEvent('Page.loadEventFired');
      await send('Page.navigate', { url });
      await loaded;
      // Shared by the checks above: all visible toast text in one string.
      await page.eval(`window.toastText = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    async waitFor(expression, label, timeout = 15000, { soft = false } = {}) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (await page.eval(`Boolean(${expression})`).catch(() => false)) return true;
        await sleep(100);
      }
      if (soft) return false;
      const toasts = await page.eval(`typeof toastText === 'function' ? toastText() : ''`).catch(() => '');
      throw new Error(`timed out waiting for ${label}${toasts ? `; toasts: ${toasts.slice(0, 400)}` : ''}`);
    },
    async shot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    },
  };

  return {
    page,
    errors,
    send,
    async close() {
      ws.close();
      proc.kill();
      await sleep(500);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- files

function runNode(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
}

/** Waits for a browser download to land and stop growing. */
async function waitForFile(path, timeout = 20000) {
  const until = Date.now() + timeout;
  let last = -1;
  while (Date.now() < until) {
    const size = existsSync(path) ? (await stat(path)).size : -1;
    if (size > 0 && size === last) return path;
    last = size;
    await sleep(300);
  }
  throw new Error(`no download at ${path}`);
}

/** Unpacks with the system's own tool (see test-download.mjs for why not tar on Windows). */
async function unzipList(zipPath, label) {
  const out = join(DOWNLOADS, `unzipped-${label}`);
  await mkdir(out, { recursive: true });
  const r = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}'`], { encoding: 'utf8' })
    : spawnSync('tar', ['-xf', zipPath, '-C', out], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
  if (r.status !== 0) throw new Error(`could not unpack ${zipPath}: ${r.stderr}`);
  const files = [];
  for (const entry of await readdir(out, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.push({ path: relative(out, full).split(sep).join('/'), name: entry.name, data: await readFile(full) });
  }
  return files;
}

/** Mirrors safeName in site/src/scripts/download.js. */
function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '') || 'Photos';
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((x) => actual.includes(x));
}
