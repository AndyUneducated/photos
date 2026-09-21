/**
 * Throwaway dev-only fixture generator.
 *
 *   node site/fixtures/generate.mjs
 *
 * Writes:
 *   site/fixtures/manifest.json   a manifest that satisfies MANIFEST.md
 *   site/public/p/<album>/w|t/*.avif   real AVIF files so `astro dev` shows pictures
 *
 * Fully deterministic and re-runnable: ids are hashes of a stable seed, the
 * output directories are wiped first. None of this ships to production — the
 * generated images are gitignored and the real gallery/manifest.json wins over
 * this fixture in site/src/lib/manifest.js.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_IMAGES = path.join(ROOT, 'site', 'public', 'p');
const OUT_MANIFEST = path.join(ROOT, 'site', 'fixtures', 'manifest.json');

const THUMB_MAX_EDGE = 640;
const PASSCODE = 'family'; // dev passcode for the gate overlay

// --- shapes -----------------------------------------------------------------

const SHAPES = {
  portrait: [1706, 2560], // 2:3
  landscape: [2560, 1707], // 3:2
  pano: [2560, 1440], // 16:9
  square: [2048, 2048],
};

// --- cameras ----------------------------------------------------------------

const A7RV = { make: 'SONY', model: 'ILCE-7RM5' };
const IPHONE = { make: 'Apple', model: 'iPhone 15 Pro' };

const sony = (lens, fNumber, exposure, iso, focal) => ({ ...A7RV, lens, fNumber, exposure, iso, focal });
const iphone = (fNumber, exposure, iso, focal) => ({
  ...IPHONE,
  lens: `iPhone 15 Pro back camera ${focal === 24 ? '6.765' : '2.22'}mm f/${fNumber}`,
  fNumber,
  exposure,
  iso,
  focal,
});

// --- albums -----------------------------------------------------------------

const ALBUMS = [
  {
    id: '2026-09-19-shanghai-night',
    title: 'Shanghai After Dark',
    date: '2026-09-19',
    showLocation: true,
    cover: 0,
    palette: ['#1b2a6b', '#7b2f8f', '#f25f4c', '#0d1030'],
    photos: [
      { shape: 'pano', at: '2026-09-19T21:48:12', caption: 'The Bund, the last boat of the night on the river.', exif: sony('FE 24-70mm F2.8 GM II', 2.8, '1/60', 3200, 24), loc: [31.2397, 121.4905, 'The Bund, Huangpu District, Shanghai'] },
      { shape: 'portrait', at: '2026-09-19T21:31:05', caption: '', exif: sony('FE 35mm F1.4 GM', 1.4, '1/125', 1600, 35), loc: [31.2339, 121.4753, 'East Nanjing Road, Huangpu District, Shanghai'] },
      // Edge case: text that would close the metadata island's <script> tag if left unescaped,
      // turning the rest of the JSON into markup. Captions are ours, but lens names come out of
      // the file and place names come back from Nominatim, so the escaping has to hold.
      { shape: 'landscape', at: '2026-09-19T21:02:44', caption: 'A street corner under the neon.</script><img src=x onerror="alert(1)">', exif: sony('FE 35mm F1.4 GM', 2, '1/80', 2500, 35) },
      { shape: 'portrait', at: '2026-09-19T20:47:19', caption: '', exif: iphone(1.78, '1/40', 1250, 24), loc: [31.2304, 121.4737] },
      { shape: 'landscape', at: '2026-09-19T20:22:58', caption: '', exif: sony('FE 70-200mm F2.8 GM OSS II', 2.8, '1/200', 6400, 135) },
      { shape: 'square', at: '2026-09-19T20:03:31', caption: 'Steam rising off a street food stall.', exif: iphone(1.78, '1/60', 800, 24) },
      { shape: 'portrait', at: '2026-09-19T19:41:07', caption: '', exif: sony('FE 24-70mm F2.8 GM II', 4, '1/160', 800, 70) },
      { shape: 'landscape', at: '2026-09-19T19:18:52', caption: 'Not quite dark yet.', exif: sony('FE 24-70mm F2.8 GM II', 8, '1/250', 200, 24) },
      // Edge case: a photo the uploader could not read any EXIF from.
      { shape: 'landscape', at: '2026-09-19T18:55:04', caption: 'A scan of an old print, no metadata on it.', exif: {} },
      // Edge case: partial EXIF only.
      { shape: 'portrait', at: '2026-09-19T18:30:20', caption: '', exif: { make: 'SONY', model: 'ILCE-7RM5', iso: 100 } },
    ],
  },
  {
    id: '2026-04-11-kyoto-walk',
    title: 'A Walk Through Kyoto',
    date: '2026-04-11',
    showLocation: false,
    cover: 1,
    palette: ['#1f3d2b', '#d98cab', '#f0e6d2', '#0e1a14'],
    photos: [
      { shape: 'portrait', at: '2026-04-11T16:42:11', caption: 'The Path of Philosophy, cherry blossoms just opening.', exif: sony('FE 35mm F1.4 GM', 1.8, '1/500', 100, 35) },
      { shape: 'landscape', at: '2026-04-11T15:58:47', caption: '', exif: sony('FE 24-70mm F2.8 GM II', 5.6, '1/320', 100, 48) },
      { shape: 'pano', at: '2026-04-11T15:12:03', caption: 'The Kamo River, very windy.', exif: sony('FE 24-70mm F2.8 GM II', 8, '1/640', 100, 24) },
      { shape: 'portrait', at: '2026-04-11T14:33:29', caption: '', exif: iphone(1.78, '1/1200', 50, 24) },
      { shape: 'square', at: '2026-04-11T13:47:55', caption: 'A bowl of soba.', exif: iphone(2.2, '1/120', 320, 13) },
      { shape: 'landscape', at: '2026-04-11T12:21:16', caption: '', exif: sony('FE 70-200mm F2.8 GM OSS II', 4, '1/1000', 200, 200) },
      { shape: 'portrait', at: '2026-04-11T11:05:41', caption: '', exif: sony('FE 35mm F1.4 GM', 2.8, '1/800', 100, 35) },
      { shape: 'landscape', at: '2026-04-11T09:52:08', caption: 'A back lane early in the morning.', exif: sony('FE 24-70mm F2.8 GM II', 4, '1/250', 400, 35) },
    ],
  },
  {
    id: '2026-01-03-home-weekend',
    title: 'A Weekend at Home',
    date: '2026-01-03',
    showLocation: false,
    // Edge case: no coverPhotoId at all.
    cover: null,
    palette: ['#3a2a1d', '#c98a4b', '#efe3d0', '#141010'],
    photos: [
      { shape: 'landscape', at: '2026-01-03T16:11:02', caption: 'Afternoon light.', exif: sony('FE 35mm F1.4 GM', 1.4, '1/60', 640, 35) },
      { shape: 'portrait', at: '2026-01-03T15:40:38', caption: '', exif: iphone(1.78, '1/30', 500, 24) },
      { shape: 'square', at: '2026-01-03T14:22:19', caption: '', exif: iphone(1.78, '1/50', 400, 24) },
      { shape: 'portrait', at: '2026-01-03T12:58:44', caption: 'The block tower she built all by herself.', exif: sony('FE 35mm F1.4 GM', 2, '1/125', 800, 35) },
      { shape: 'landscape', at: '2026-01-03T11:14:27', caption: '', exif: sony('FE 24-70mm F2.8 GM II', 2.8, '1/100', 1000, 50) },
      { shape: 'portrait', at: '2026-01-03T10:02:55', caption: 'Breakfast.', exif: iphone(1.78, '1/60', 250, 24) },
    ],
  },
];

// --- helpers ----------------------------------------------------------------

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const photoId = (albumId, index) => sha256(`${albumId}#${index}`).slice(0, 12);

function gradientSvg(w, h, palette, index) {
  const [a, b, c, dark] = palette;
  const angle = (index * 37) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" gradientTransform="rotate(${angle} 0.5 0.5)">
      <stop offset="0%" stop-color="${a}"/>
      <stop offset="45%" stop-color="${b}"/>
      <stop offset="100%" stop-color="${c}"/>
    </linearGradient>
    <radialGradient id="v" cx="50%" cy="45%" r="75%">
      <stop offset="55%" stop-color="${dark}" stop-opacity="0"/>
      <stop offset="100%" stop-color="${dark}" stop-opacity="0.75"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w * 0.72}" cy="${h * 0.28}" r="${Math.min(w, h) * 0.22}" fill="${dark}" fill-opacity="0.28"/>
  <circle cx="${w * 0.22}" cy="${h * 0.74}" r="${Math.min(w, h) * 0.3}" fill="${c}" fill-opacity="0.18"/>
  <rect width="${w}" height="${h}" fill="url(#v)"/>
  <text x="${w / 2}" y="${h / 2}" fill="#ffffff" fill-opacity="0.82" font-family="Helvetica, Arial, sans-serif"
        font-size="${Math.round(Math.min(w, h) * 0.16)}" font-weight="700" text-anchor="middle"
        dominant-baseline="central">${String(index + 1).padStart(2, '0')}</text>
</svg>`;
}

function thumbSize(w, h) {
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

// --- main -------------------------------------------------------------------

await fs.rm(OUT_IMAGES, { recursive: true, force: true });
await fs.mkdir(OUT_IMAGES, { recursive: true });
await fs.writeFile(
  path.join(OUT_IMAGES, '.gitignore'),
  '# Dev fixture images, regenerate with: node site/fixtures/generate.mjs\n# Production photos are copied into dist/p by scripts/collect.mjs.\n*\n!.gitignore\n',
);

const albums = [];
const photos = [];
let usedBytes = 0;

for (const album of ALBUMS) {
  const wDir = path.join(OUT_IMAGES, album.id, 'w');
  const tDir = path.join(OUT_IMAGES, album.id, 't');
  await fs.mkdir(wDir, { recursive: true });
  await fs.mkdir(tDir, { recursive: true });

  let albumBytes = 0;
  const ids = [];

  for (const [i, spec] of album.photos.entries()) {
    const [w, h] = SHAPES[spec.shape];
    const [tw, th] = thumbSize(w, h);
    const id = photoId(album.id, i);
    ids.push(id);

    const svg = Buffer.from(gradientSvg(w, h, album.palette, i));
    const base = sharp(svg, { density: 96 });

    const webBuf = await base.clone().resize(w, h).avif({ quality: 58, effort: 0 }).toBuffer();
    const thumbBuf = await base.clone().resize(tw, th).avif({ quality: 50, effort: 0 }).toBuffer();
    const lqipBuf = await base.clone().resize(16, 16, { fit: 'inside' }).webp({ quality: 40 }).toBuffer();

    await fs.writeFile(path.join(wDir, `${id}.avif`), webBuf);
    await fs.writeFile(path.join(tDir, `${id}.avif`), thumbBuf);

    const bytes = webBuf.length + thumbBuf.length;
    albumBytes += bytes;
    usedBytes += bytes;

    const photo = {
      id,
      albumId: album.id,
      web: `p/${album.id}/w/${id}.avif`,
      thumb: `p/${album.id}/t/${id}.avif`,
      w,
      h,
      tw,
      th,
      lqip: `data:image/webp;base64,${lqipBuf.toString('base64')}`,
      bytes,
      takenAt: spec.at,
      caption: spec.caption,
      exif: spec.exif,
    };
    if (album.showLocation && spec.loc) {
      const [lat, lon, label] = spec.loc;
      photo.location = label ? { lat, lon, label } : { lat, lon };
    }
    photos.push(photo);
    process.stdout.write(`  ${album.id}/${id}  ${w}x${h}  ${(bytes / 1024).toFixed(0)} KB\n`);
  }

  const entry = {
    id: album.id,
    title: album.title,
    date: album.date,
    showLocation: album.showLocation,
    photoCount: album.photos.length,
    bytes: albumBytes,
  };
  // Only set coverPhotoId when the fixture says there is one.
  if (album.cover !== null) entry.coverPhotoId = ids[album.cover];
  albums.push(entry);
}

// Contract: photos newest first.
photos.sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : 0));

const manifest = {
  version: 1,
  updatedAt: new Date('2026-09-19T21:40:11.000Z').toISOString(),
  site: {
    title: 'Anning Photos',
    tagline: 'Family album',
    passcodeHash: sha256(PASSCODE),
  },
  budgetBytes: 838860800,
  usedBytes,
  albums,
  photos,
};

await fs.writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nwrote ${photos.length} photos in ${albums.length} albums`);
console.log(`manifest: ${path.relative(ROOT, OUT_MANIFEST)}`);
console.log(`images:   ${path.relative(ROOT, OUT_IMAGES)}`);
console.log(`passcode: "${PASSCODE}" -> ${manifest.site.passcodeHash}`);
