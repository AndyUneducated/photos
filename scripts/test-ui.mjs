/**
 * Clicks through the parts of the UI that only a browser can check, in a headless Chrome or Edge
 * driven over the DevTools protocol (Node's built-in WebSocket; nothing to install).
 *
 *   Studio, against a sandbox with two "computers" (see createSandbox in test-helpers.mjs):
 *     - photos processed in an earlier session reappear on load, and unpushed changes are flagged
 *     - a publish that conflicts with GitHub opens the dialog listing both sides; "Keep both" works
 *     - "Cancel" changes nothing
 *     - a push GitHub refuses shows a readable error with copyable technical details
 *   Site, against the last `npm run build` (dist/):
 *     - the lightbox info button is an outlined ring, not a filled disc, and toggles the caption
 *
 * Saves screenshots of each state and prints where. Skips cleanly when no Chromium browser exists.
 *
 *   node scripts/test-ui.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createSandbox, sleep } from './test-helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(tmpdir(), 'photos-ui-shots');
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
  await a.publish('A4', { push: false });
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
  console.log('\nSite');
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.log('  skipped: no dist/ (run npm run build first)');
  } else {
    preview = spawn(process.execPath, [join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'preview', '--port', String(PREVIEW_PORT)], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    const site = `http://localhost:${PREVIEW_PORT}/`;
    for (let i = 0; i < 60 && !(await fetch(site).then((r) => r.ok, () => false)); i++) await sleep(250);

    const config = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));
    await page.goto(site);
    // The gate remembers an unlock as the passcode hash; skip typing it.
    await page.eval(`localStorage.setItem('photos.unlock', ${JSON.stringify(config.passcodeHash || '')})`);
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
    const download = await page.eval(`getComputedStyle(document.querySelector('.pswp__button--download svg path')).fill`);
    check('download icon is outlined too', download === 'none', download);
    await page.shot('6-lightbox');
    await page.eval(`document.querySelector('.pswp__button--pswp-info').click()`);
    await page.waitFor(`document.querySelector('.pswp--info-open')`, 'info panel');
    check('the info button opens the photo details', true);
    await page.shot('7-lightbox-info');
  }

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
    async close() {
      ws.close();
      proc.kill();
      await sleep(500);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((x) => actual.includes(x));
}
