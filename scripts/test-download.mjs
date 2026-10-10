/**
 * Downloads: what a visitor's file contains, and the pieces that build an album download.
 *
 *   - EXIF goes into the web AVIF without touching a pixel, on simple and multi-item files alike
 *   - a processed photo carries its shooting time and camera, and never its GPS position
 *   - the ZIP writer's output unpacks with the system's own tool, CJK names included
 *   - download file names sort by shooting time and do not collide within an album
 *   - the backfill script adds EXIF to photos published before it existed, uploads the result,
 *     and does nothing the second time
 *
 *   node scripts/test-download.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import exifr from 'exifr';
import sharp from 'sharp';

import { addExif, buildExif, hasExif, readExif } from '../studio/lib/avif-exif.mjs';
import { processPhoto } from '../studio/lib/process.mjs';
import { downloadNames } from '../site/src/lib/format.js';
import { zip } from '../site/src/scripts/zip.js';
import { createSandbox, syntheticPhoto, syntheticTakenAt } from './test-helpers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(tmpdir(), `photos-download-test-${process.pid}`);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const SAMPLE = { takenAt: '2026-10-02T10:37:29', exif: { make: 'SONY', model: 'ILCE-7RM5', lens: 'FE 24-70mm F2.8 GM II', fNumber: 6.3, exposure: '1/160', iso: 100, focal: 24 } };

await mkdir(WORK, { recursive: true });
const sandbox = await createSandbox('download-test');

try {
  // ------------------------------------------------------------ container
  console.log('\nEXIF in the AVIF container');
  const pixels = await sharp(await syntheticPhoto(7, { width: 640, height: 420 })).raw().toBuffer({ resolveWithObject: true });
  const plain = await sharp(pixels.data, { raw: pixels.info }).avif({ quality: 60 }).toBuffer();
  const tiff = buildExif({ ...SAMPLE, width: 640, height: 420 });
  const tagged = addExif(plain, tiff);
  check('a plain AVIF has no EXIF item to begin with', !hasExif(plain));
  check('after adding, the file has one', hasExif(tagged));
  check('pixels are bit-identical', (await sharp(plain).raw().toBuffer()).equals(await sharp(tagged).raw().toBuffer()));
  check('libheif sees the EXIF', Boolean((await sharp(tagged).metadata()).exif));
  check('the block reads back unchanged', readExif(tagged).equals(tiff));

  const tags = await exifr.parse(tagged, { tiff: true, exif: true, reviveValues: false });
  check('shooting time is DateTimeOriginal', tags?.DateTimeOriginal === '2026:10:02 10:37:29', JSON.stringify(tags));
  check('camera, lens and exposure survive', tags?.Model === 'ILCE-7RM5' && tags?.LensModel === 'FE 24-70mm F2.8 GM II'
    && tags?.FNumber === 6.3 && tags?.ISO === 100 && tags?.FocalLength === 24 && Math.abs(tags?.ExposureTime - 1 / 160) < 1e-9);

  let threw = false;
  try { addExif(tagged, tiff); } catch { threw = true; }
  check('adding twice is refused rather than duplicated', threw);

  // An alpha channel makes sharp write two items and an iref box: the less trivial layout.
  const withAlpha = await sharp(pixels.data, { raw: pixels.info }).ensureAlpha(0.6).avif({ quality: 60 }).toBuffer();
  const alphaTagged = addExif(withAlpha, tiff);
  check('a multi-item AVIF still decodes identically, alpha included',
    (await sharp(withAlpha).raw().toBuffer()).equals(await sharp(alphaTagged).raw().toBuffer()));
  check('and its EXIF reads back', readExif(alphaTagged)?.equals(tiff));

  check('no date and no camera means no block', buildExif({ takenAt: null, exif: {} }) === null);
  const longExposure = await exifr.parse(addExif(plain, buildExif({ takenAt: SAMPLE.takenAt, exif: { exposure: '2.5s' } })), { exif: true });
  check('long exposures are written in seconds', longExposure?.ExposureTime === 2.5, JSON.stringify(longExposure));

  // ------------------------------------------------------------ pipeline
  console.log('\nWhat processing puts in the web file');
  const source = join(WORK, 'camera.jpg');
  await writeFile(source, await syntheticPhoto(4242, { width: 1200, height: 800 }));
  const processed = await processPhoto(source, { webMaxEdge: 2560, thumbMaxEdge: 640, webQuality: 66, thumbQuality: 55 });
  const webTags = await exifr.parse(processed.web.data, { tiff: true, exif: true, gps: true, reviveValues: false });
  check('the source really had GPS', Boolean(processed.gps));
  check('web file carries the shooting time', webTags?.DateTimeOriginal === syntheticTakenAt(4242).replace(/-/g, ':').replace('T', ' '), JSON.stringify(webTags));
  check('web file carries camera and lens', webTags?.Make === 'TESTCAM' && webTags?.LensModel === 'Test 35mm F2.8');
  check('web file carries no GPS', webTags && webTags.GPSLatitude === undefined && webTags.latitude === undefined);
  check('web file records its own pixel size', webTags?.ExifImageWidth === processed.web.width && webTags?.ExifImageHeight === processed.web.height);
  check('thumbnail stays bare', !hasExif(processed.thumb.data));

  // ------------------------------------------------------------ zip + names
  console.log('\nZIP and file names');
  const names = downloadNames([
    { id: 'a1', albumId: 'x', takenAt: '2026-10-02T10:37:29' },
    { id: 'a2', albumId: 'x', takenAt: '2026-10-02T10:37:29' },
    { id: 'a3', albumId: 'y', takenAt: '2026-10-02T10:37:29' },
    { id: 'a4', albumId: 'y', takenAt: '' },
  ]);
  check('named after the shooting time', names.get('a1') === '2026-10-02 10.37.29.avif', names.get('a1'));
  check('a burst in one album gets (2)', names.get('a2') === '2026-10-02 10.37.29 (2).avif', names.get('a2'));
  check('the same second in another album does not', names.get('a3') === '2026-10-02 10.37.29.avif');
  check('no date falls back to the id', names.get('a4') === 'a4.avif');

  const entries = [
    { name: '黄石 & Teton-MILC/2026-10-02 10.37.29.avif', data: new Uint8Array(tagged), takenAt: '2026-10-02T10:37:29' },
    { name: '黄石 & Teton-MILC/2026-10-02 10.37.29 (2).avif', data: new Uint8Array(alphaTagged), takenAt: '2026-10-02T10:37:29' },
    { name: 'Other/empty.txt', data: new Uint8Array(0) },
  ];
  const zipPath = join(WORK, 'album.zip');
  await writeFile(zipPath, Buffer.from(await zip(entries).arrayBuffer()));
  const out = join(WORK, 'unzipped');
  await mkdir(out, { recursive: true });
  // Windows' tar converts names to the console code page and chokes on CJK; Explorer and .NET
  // (behind Expand-Archive) read the UTF-8 flag properly, so that is the fair test there.
  const unpack = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}'`], { encoding: 'utf8' })
    : spawnSync('tar', ['-xf', zipPath, '-C', out], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
  if (unpack.error) {
    console.log('  skip  unpacking (no unzip tool on this system)');
  } else {
    check('the system’s own unzip unpacks it', unpack.status === 0, unpack.stderr);
    const ok = await Promise.all(entries.map(async (e) => {
      const got = await readFile(join(out, ...e.name.split('/'))).catch(() => null);
      return got !== null && Buffer.from(e.data).equals(got);
    }));
    check('every file comes back byte for byte, CJK folder name included', ok.every(Boolean), JSON.stringify(ok));
  }

  // ------------------------------------------------------------ backfill
  console.log('\nBackfilling photos published before EXIF');
  const a = await sandbox.machine('A', 4495, { fresh: true });
  await a.post('/api/setup');
  await a.publish('Old one');
  await a.publish('Old two');

  // Recreate the old state: web files re-encoded without their EXIF item, then published. From raw
  // pixels, because re-encoding an AVIF with sharp carries its EXIF across.
  const webFiles = await listWebFiles(a.dir);
  const manifestPath = join(a.dir, 'gallery', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const file of webFiles) {
    const before = await readFile(file);
    const { data, info } = await sharp(before).raw().toBuffer({ resolveWithObject: true });
    const bare = await sharp(data, { raw: info }).avif({ quality: 66 }).toBuffer();
    const photo = manifest.photos.find((p) => file.endsWith(`${p.id}.avif`));
    const album = manifest.albums.find((x) => x.id === photo.albumId);
    photo.bytes += bare.length - before.length;
    album.bytes += bare.length - before.length;
    manifest.usedBytes += bare.length - before.length;
    await writeFile(file, bare);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Committed, as an old publish would have: the studio discards uncommitted gallery changes as
  // leftovers of a crash.
  const galleryDir = join(a.dir, 'gallery');
  await git(['add', '-A'], galleryDir);
  await git(['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', 'old-style photos'], galleryDir);
  const sync = await a.runOp('/api/sync');
  check('the old-style gallery is on GitHub', sync.state === 'done' && (await sandbox.remoteTree()) === (await a.tree()), sync.error?.error);
  check('its photos have no EXIF', (await Promise.all(webFiles.map(async (f) => hasExif(await readFile(f))))).every((x) => !x));

  const refused = await node(['scripts/backfill-exif.mjs'], a.dir, { PORT: '4495' });
  check('backfill refuses while the studio is running', refused.code === 1 && refused.output.includes('studio is running'), refused.output);

  await a.stop();
  const first = await node(['scripts/backfill-exif.mjs'], a.dir, { PORT: '4495' });
  check('backfill succeeds', first.code === 0 && first.output.includes('2 photos updated and uploaded'), first.output);
  check('every web file now has EXIF', (await Promise.all(webFiles.map(async (f) => hasExif(await readFile(f))))).every(Boolean));
  check('GitHub has exactly what this computer has', (await sandbox.remoteTree()) === (await a.tree()));
  check('nothing is left uncommitted', !(await a.dirty()));
  const after = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sizesRight = await Promise.all(after.photos.map(async (p) => {
    const dir = join(a.dir, 'gallery', 'albums', p.albumId);
    const actual = (await readFile(join(dir, 'w', `${p.id}.avif`))).length + (await readFile(join(dir, 't', `${p.id}.avif`))).length;
    return actual === p.bytes;
  }));
  check('the manifest’s sizes match the files', sizesRight.every(Boolean));
  const tagsAfter = await exifr.parse(await readFile(webFiles[0]), { exif: true, reviveValues: false });
  const owner = after.photos.find((p) => webFiles[0].endsWith(`${p.id}.avif`));
  check('the backfilled time is the photo’s own', tagsAfter?.DateTimeOriginal === owner.takenAt.replace(/-/g, ':').replace('T', ' '), JSON.stringify(tagsAfter));

  const second = await node(['scripts/backfill-exif.mjs'], a.dir, { PORT: '4495' });
  check('running it again changes nothing', second.code === 0 && second.output.includes('Nothing to do') && (await sandbox.remoteTree()) === (await a.tree()), second.output);
} catch (e) {
  failures++;
  console.log(`\nThe test threw an exception: ${e.stack}`);
  for (const m of sandbox.machines) if (m.log.trim()) console.log(`\n--- server ${m.name} log ---\n${m.log.trim()}`);
} finally {
  await sandbox.cleanup();
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

async function listWebFiles(dir) {
  const albums = join(dir, 'gallery', 'albums');
  const out = [];
  for (const album of await readdir(albums)) {
    for (const f of await readdir(join(albums, album, 'w'))) out.push(join(albums, album, 'w', f));
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function node(args, cwd, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => ok({ code, output }));
  });
}
