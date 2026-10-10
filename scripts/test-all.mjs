/**
 * Runs every test that can run on this machine, in order, and reports one verdict.
 *
 *   npm test
 *
 * The decoder tests need real camera files in samples/ and are skipped without them, and the UI
 * test skips itself without Chrome or Edge; everything else generates its own data and runs
 * anywhere, including a fresh clone.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ASTRO = join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
const FIXTURE = join(ROOT, 'site', 'fixtures', 'manifest.json');

const results = [];

await suite('site: build from fixtures', async () => {
  await node([ASTRO, 'build', '--silent'], { PHOTOS_MANIFEST: FIXTURE });
  await node(['site/fixtures/check.mjs', 'dist/index.html']);
});

await suite('site: a single album still shows its name', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const album = fixture.albums[0];
  const single = { ...fixture, albums: [album], photos: fixture.photos.filter((p) => p.albumId === album.id) };
  const dir = join(tmpdir(), `photos-single-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  await writeFile(path, JSON.stringify(single));

  await node([ASTRO, 'build', '--silent'], { PHOTOS_MANIFEST: path });
  const html = await readFile(join(ROOT, 'dist', 'index.html'), 'utf8');
  const escaped = album.title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (!html.includes('class="album-label"')) throw new Error('no album label in the header');
  if (!html.includes(escaped)) throw new Error(`album title "${album.title}" not in the page`);
  if (html.includes('id="filter"')) throw new Error('the filter row should not render for one album');
  console.log(`  PASS  header shows "${album.title}" with no filter row`);
});

await suite('studio: stage, process, publish, delete', () => node(['scripts/test-studio.mjs']));
await suite('studio: publishing from two computers', () => node(['scripts/test-sync.mjs']));
await suite('downloads: EXIF, ZIP, backfill', () => node(['scripts/test-download.mjs']));
await suite('ui: studio, downloads and lightbox in a headless browser', () => node(['scripts/test-ui.mjs']));
await suite('decoder: EXIF survives', () => node(['scripts/test-exif.mjs']));

if (existsSync(join(ROOT, 'samples', 'nokia_ski.heic'))) {
  await suite('decoder: rotation composes', () => node(['scripts/test-rotate.mjs']));
} else {
  results.push({ name: 'decoder: rotation composes', status: 'skipped (needs samples/nokia_ski.heic)' });
}

console.log('\n================ summary');
for (const r of results) console.log(`  ${r.status.padEnd(8)}  ${r.name}${r.error ? ` — ${r.error}` : ''}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(failed ? `\n${failed} suite(s) failed.` : '\nAll suites passed.');
process.exit(failed ? 1 : 0);

async function suite(name, fn) {
  console.log(`\n================ ${name}`);
  try {
    await fn();
    results.push({ name, status: 'ok' });
  } catch (err) {
    results.push({ name, status: 'FAIL', error: err.message.split('\n')[0] });
  }
}

function node(args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${args.join(' ')} exited with ${code}`))));
  });
}
