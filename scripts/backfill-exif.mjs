/**
 * Adds the download EXIF block (shooting time, camera, lens, exposure; never GPS) to published
 * photos that predate it, then publishes the result. New photos get it while processing; see
 * studio/lib/avif-exif.mjs. Safe to run again: photos that already have it are left alone.
 *
 *   node scripts/backfill-exif.mjs            # change and upload
 *   node scripts/backfill-exif.mjs --local    # change and commit here only
 *
 * Close the studio first: both would be writing the same gallery.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { addExif, buildExif, hasExif } from '../studio/lib/avif-exif.mjs';
import { runGalleryScript } from './gallery-script.mjs';

await runGalleryScript({
  kind: 'backfill-exif',
  title: 'Adding shooting details to published photos',
  stepLabel: 'Writing shooting time and camera details into each photo',
  message: (n) => `gallery: add shooting details to ${n} photos`,
  async eachPhoto(photo, { dir }) {
    const file = join(dir, 'w', `${photo.id}.avif`);
    const before = await readFile(file);
    if (hasExif(before)) return false;
    const tiff = buildExif({ takenAt: photo.takenAt, exif: photo.exif, width: photo.w, height: photo.h });
    if (!tiff) return false;
    const after = addExif(before, tiff);
    await writeFile(file, after);
    photo.bytes += after.length - before.length;
    return true;
  },
});
