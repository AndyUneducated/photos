/**
 * Dev-only smoke check for rendered HTML.
 *   node site/fixtures/check.mjs dist/index.html
 *   node site/fixtures/check.mjs http://127.0.0.1:4321/
 */
import fs from 'node:fs/promises';

const target = process.argv[2] || 'dist/index.html';
let html;
let status = 200;

if (/^https?:/.test(target)) {
  const res = await fetch(target);
  status = res.status;
  html = await res.text();
} else {
  html = await fs.readFile(target, 'utf8');
}

const count = (re) => (html.match(re) || []).length;

const checks = [
  ['http status 200', status === 200, status],
  ['robots meta', /name="robots" content="noindex, nofollow"/.test(html)],
  ['gate overlay', /id="gate"/.test(html) && /id="gate-form"/.test(html)],
  ['gate hash attr', /data-hash="[0-9a-f]{64}"/.test(html)],
  ['header title', /brand__title/.test(html)],
  ['album chips', count(/class="chip[^"]*"/g) >= 4, count(/class="chip[^"]*"/g)],
  ['tiles rendered', count(/class="tile"/g) === 24, count(/class="tile"/g)],
  ['thumbs deferred (data-src)', count(/data-src="/g) === 24, count(/data-src="/g)],
  ['no src on tile imgs', count(/<img class="tile__img"[^>]*\ssrc=/g) === 0],
  ['lqip inline', count(/--lqip:url\('data:image\/webp;base64,/g) === 24],
  ['width/height on every img', count(/<img class="tile__img"[^>]*width="\d+" height="\d+"/g) === 24],
  ['pswp dimensions', count(/data-pswp-width="\d+" data-pswp-height="\d+"/g) === 24],
  ['photo meta island', /id="photo-meta"/.test(html)],
  ['footer', /最新/.test(html)],
  ['no astro:assets import', !/_image\?href/.test(html)],
  ...metaIslandChecks(),
];

/**
 * The metadata island is JSON inside a <script> tag, so any `</script>` in a caption, lens name
 * or place name would end the tag early and spill the rest into the document as markup. The
 * fixtures deliberately include such a caption; these assert it survives as data.
 */
function metaIslandChecks() {
  const island = html.match(/<script type="application\/json" id="photo-meta"[^>]*>([\s\S]*?)<\/script>/);
  if (!island) return [['meta island readable', false, 'not found']];

  let parsed = null;
  try {
    parsed = JSON.parse(island[1]);
  } catch (err) {
    return [['meta island parses as JSON', false, err.message]];
  }

  const captions = Object.values(parsed).map((e) => e.caption || '');
  return [
    ['meta island parses as JSON', true, `${Object.keys(parsed).length} photos`],
    ['no raw </script> in island', !/<\/script/i.test(island[1])],
    ['hostile caption survived as text', captions.some((c) => c.includes('</script>'))],
  ];
}

let failed = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra === undefined ? '' : `  (${extra})`}`);
}
console.log(`\n${target}: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
