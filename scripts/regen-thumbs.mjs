/**
 * Rebuilds published thumbnails that are smaller than config.json's `thumbMaxEdge`, from each
 * photo's web image (the originals are not kept). Shrinking the 2560px image is visually lossless,
 * so a regenerated thumbnail looks the same as one made from the camera file. Safe to run again:
 * thumbnails already at the configured size are left alone.
 *
 *   node scripts/regen-thumbs.mjs            # change and upload
 *   node scripts/regen-thumbs.mjs --local    # change and commit here only
 *
 * Close the studio first: both would be writing the same gallery.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { runGalleryScript } from './gallery-script.mjs';

sharp.cache(false);

await runGalleryScript({
  kind: 'regen-thumbs',
  title: 'Rebuilding thumbnails',
  stepLabel: 'Rebuilding each thumbnail from its web image',
  message: (n) => `gallery: rebuild ${n} thumbnails`,
  async eachPhoto(photo, { config, dir }) {
    const edge = config.thumbMaxEdge;
    const target = Math.min(edge, Math.max(photo.w, photo.h));
    if (Math.max(photo.tw, photo.th) >= target) return false;

    const thumbFile = join(dir, 't', `${photo.id}.avif`);
    const before = (await readFile(thumbFile)).length;
    // Through raw pixels: encoding straight from the web AVIF would copy its EXIF into the thumbnail.
    const { data, info } = await sharp(await readFile(join(dir, 'w', `${photo.id}.avif`)))
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const quality = config.quality?.standard?.thumb ?? 55;
    const thumb = await sharp(data, { raw: info }).avif({ quality, effort: 4, chromaSubsampling: '4:2:0' }).toBuffer();

    await writeFile(thumbFile, thumb);
    photo.tw = info.width;
    photo.th = info.height;
    photo.bytes += thumb.length - before;
    return true;
  },
});
