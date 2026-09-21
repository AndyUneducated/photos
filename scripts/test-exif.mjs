/**
 * Checks that shooting data survives the trip out of a HEIF file.
 *
 * Two failures this guards against, both silent — the upload succeeds and the loss only shows up
 * as a blank info panel on the live site:
 *
 *  - exifr refuses to identify a 10-bit `.HIF` (its brand check demands the literal `heic`), so
 *    every Sony and Canon frame used to come through with no camera, lens, exposure or date.
 *  - A timestamp carrying an offset gets resolved to an absolute instant, which then renders in
 *    whatever timezone the uploading machine happens to sit in, moving photos shot abroad to the
 *    wrong hour and usually the wrong day.
 *
 * Run it against your own files: `node scripts/test-exif.mjs`. It needs samples/ to be populated
 * and reports "skipped" when it is not, so it stays honest on a fresh clone.
 */

import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import exifr from 'exifr';

import { isHeif, readExifBlock } from '../studio/lib/heif.mjs';
import { readExif } from '../studio/lib/exif.mjs';

const SAMPLES = 'samples';
const IMAGE = /\.(hif|heic|heif|jpe?g|avif)$/i;

async function sampleFiles() {
  try {
    return (await readdir(SAMPLES)).filter((f) => IMAGE.test(f)).sort();
  } catch {
    return [];
  }
}

/** Child mode: report what this process reads, so the parent can compare across timezones. */
if (process.env.PHOTOS_EXIF_TZ_CHILD) {
  const out = {};
  for (const name of await sampleFiles()) {
    out[name] = (await readExif(await readFile(join(SAMPLES, name)))).takenAt;
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

const files = await sampleFiles();
if (files.length === 0) {
  console.log(`No images in ${SAMPLES}/, skipped. Drop a few camera originals in there and run it again.`);
  process.exit(0);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

for (const name of files) {
  const buf = await readFile(join(SAMPLES, name));
  const meta = await readExif(buf);
  const block = isHeif(buf) ? readExifBlock(buf) : null;

  console.log(`\n=== ${name} ===`);
  console.log(`  Exif block: ${block ? `${block.length} bytes` : '(none)'}`);
  console.log(`  EXIF      : ${JSON.stringify(meta.exif)}`);
  console.log(`  taken at  : ${meta.takenAt ?? '(none)'}`);

  if (isHeif(buf)) {
    // Deliberately dumber than the code under test: if the item list near the head of the file
    // names an `Exif` item, the box walk has to come back with one. Without this the whole test
    // would quietly pass the moment extraction regressed, since every later assertion is
    // conditional on having a block.
    const declaresExif = buf.subarray(0, 64 * 1024).includes(Buffer.from('Exif', 'latin1'));
    if (declaresExif) check('file declares an Exif item, so it must be extractable', Boolean(block));

    if (block) {
      const magic = block.toString('latin1', 0, 4);
      check('Exif block is a TIFF structure', magic === 'II*\0' || magic === 'MM\0*');
    }
  }

  // Re-derive the expectation straight from the undecoded tags, so the test does not simply
  // restate whatever the implementation happens to produce.
  const literal = block || !isHeif(buf)
    ? await exifr
        .parse(block || buf, { tiff: true, ifd0: true, exif: true, reviveValues: false, translateValues: false })
        .catch(() => null)
    : null;
  const stamp = literal?.DateTimeOriginal || literal?.CreateDate || literal?.ModifyDate;

  if (stamp) {
    const expected = String(stamp).replace(
      /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2}).*$/,
      '$1-$2-$3T$4:$5:$6'
    );
    check(`taken-at matches what the camera wrote (${expected})`, meta.takenAt === expected);
  }

  if (literal && (literal.Make || literal.Model)) {
    check('camera model was read', Boolean(meta.exif.make || meta.exif.model));
  }
}

// The whole point of reading the raw digits is that the answer cannot depend on this machine.
console.log('\n=== timezone independence ===');
const readUnder = (tz) => {
  const res = spawnSync(process.execPath, [process.argv[1]], {
    env: { ...process.env, TZ: tz, PHOTOS_EXIF_TZ_CHILD: '1' },
    encoding: 'utf8',
  });
  return res.stdout;
};
const here = readUnder('America/Los_Angeles');
const away = readUnder('Asia/Tokyo');
console.log(`  America/Los_Angeles: ${here}`);
console.log(`  Asia/Tokyo         : ${away}`);
check('taken-at is unchanged across timezones', here === away && here.length > 0);

console.log(failures === 0 ? '\nAll passed.' : `\n${failures} failed.`);
process.exit(failures ? 1 : 0);
