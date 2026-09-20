/**
 * Checks that the automatic orientation fix and the studio's manual rotate buttons compose.
 *
 * sharp resets all rotation state every time `rotate()` is called, so applying them as two
 * separate pipeline calls silently drops the first one. This is easy to regress and invisible
 * until someone notices a sideways photo on the live site.
 */

import { processPhoto } from '../studio/lib/process.mjs';

const file = process.argv[2] || 'samples/nokia_ski.heic';
const base = { webMaxEdge: 2560, thumbMaxEdge: 640, webQuality: 58, thumbQuality: 50 };

const results = {};
for (const degrees of [0, 90, 180, 270]) {
  const out = await processPhoto(file, { ...base, manualRotate: degrees });
  results[degrees] = out;
  console.log(`${String(degrees).padStart(3)}°  ${out.web.width}×${out.web.height}  id=${out.id}`);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const a = results[0];
check('90° 交换了长宽', results[90].web.width === a.web.height && results[90].web.height === a.web.width);
check('180° 保持长宽', results[180].web.width === a.web.width && results[180].web.height === a.web.height);
check('270° 交换了长宽', results[270].web.width === a.web.height && results[270].web.height === a.web.width);
// The id is the hash of the *source* file, so rotating must not change it — otherwise rotating a
// photo after publishing would orphan the old files.
check('id 只取决于源文件，不随旋转变化', new Set(Object.values(results).map((r) => r.id)).size === 1);
check('每个角度都产出了非空 AVIF', Object.values(results).every((r) => r.web.data.length > 1000));

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures ? 1 : 0);
