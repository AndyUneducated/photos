/**
 * Decoder smoke test. Point it at real camera files and inspect the results:
 *
 *   node scripts/test-decode.mjs samples/*.HIF samples/*.heic
 *
 * Writes the generated derivatives to `samples/out/` so they can be opened and eyeballed, and
 * prints the EXIF, colour space and rotation decisions the pipeline made.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { isHeif, readColourInfo } from '../studio/lib/heif.mjs';
import { processPhoto } from '../studio/lib/process.mjs';
import { readFile } from 'node:fs/promises';

const OUT_DIR = 'samples/out';

const OPTS = {
  webMaxEdge: 2560,
  thumbMaxEdge: 640,
  webQuality: 58,
  thumbQuality: 50,
};

const files = process.argv.slice(2);
if (files.length === 0) {
  try {
    const entries = await readdir('samples', { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && /\.(hif|heic|heif|jpg|jpeg|png|tif|tiff)$/i.test(e.name)) {
        files.push(join('samples', e.name));
      }
    }
  } catch {
    // no samples directory yet
  }
}

if (files.length === 0) {
  console.error('没有找到样本文件。把照片放进 samples/ 目录，或者把路径作为参数传进来。');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

let failures = 0;

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  try {
    const source = await readFile(file);
    console.log(`  容器      : ${isHeif(source) ? 'HEIF' : `非 HEIF (${extname(file)})`}  ${fmtBytes(source.length)}`);
    if (isHeif(source)) {
      console.log(`  colr box  : ${JSON.stringify(readColourInfo(source))}`);
    }

    const t0 = performance.now();
    const result = await processPhoto(file, OPTS);
    const ms = Math.round(performance.now() - t0);

    console.log(`  耗时      : ${ms} ms`);
    console.log(`  色彩空间  : ${result.colourSpace}`);
    console.log(`  web       : ${result.web.width}x${result.web.height}  ${fmtBytes(result.web.data.length)}`);
    console.log(`  thumb     : ${result.thumb.width}x${result.thumb.height}  ${fmtBytes(result.thumb.data.length)}`);
    console.log(`  lqip      : ${result.lqip.length} 字符   主色 ${result.color}`);
    console.log(`  拍摄时间  : ${result.takenAt ?? '(无)'}`);
    console.log(`  EXIF      : ${JSON.stringify(result.exif)}`);
    console.log(`  GPS       : ${result.gps ? `${result.gps.lat}, ${result.gps.lon}` : '(无)'}`);
    for (const note of result.notes) console.log(`  注意      : ${note}`);

    const stem = basename(file, extname(file));
    await writeFile(join(OUT_DIR, `${stem}.web.avif`), result.web.data);
    await writeFile(join(OUT_DIR, `${stem}.thumb.avif`), result.thumb.data);
    // A JPEG copy makes it easy to open the result in anything, including this terminal's host.
    const sharp = (await import('sharp')).default;
    await sharp(result.web.data).jpeg({ quality: 88 }).toFile(join(OUT_DIR, `${stem}.preview.jpg`));
  } catch (err) {
    failures++;
    console.log(`  失败      : ${err.message}`);
    if (process.env.VERBOSE) console.log(err.stack);
  }
}

console.log(`\n完成：${files.length - failures}/${files.length} 成功，输出在 ${OUT_DIR}/`);
process.exit(failures ? 1 : 0);

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
