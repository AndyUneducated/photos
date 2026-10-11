/**
 * Publishing processed photos as a new album: copy into the gallery, add to the manifest, commit
 * and push, all inside one gallery transaction.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import express from 'express';

import {
  albumId as makeAlbumId,
  budgetReport,
  loadConfig,
  loadManifest,
  photoPaths,
  saveManifest,
  writePhotoFiles,
} from '../lib/gallery.mjs';
import { StudioError } from '../lib/errors.mjs';
import { reverseGeocode } from '../lib/geocode.mjs';
import { galleryTransaction, startOperation, transactionSteps } from '../lib/operations.mjs';
import { clearStaging, readMeta, stagingDir } from '../lib/staging.mjs';
import { accepted, asyncRoute, readResolution } from './http.mjs';

export const router = express.Router();

router.post('/api/publish', asyncRoute(async (req, res) => {
  const {
    fileIds = [],
    title = '',
    date,
    showLocation = false,
    coverFileId,
    captions = {},
    push = true,
  } = req.body || {};

  if (fileIds.length === 0) throw new StudioError('No photos are selected.', { status: 400, code: 'no-photos' });

  // Checked before starting, so a mistake is reported at once rather than as a failed operation.
  const staged = [];
  for (const fileId of fileIds) {
    const dir = stagingDir(fileId);
    const meta = await readMeta(dir);
    if (!meta.photo) {
      throw new StudioError(`“${meta.name}” has not finished processing yet.`, {
        status: 409,
        code: 'not-processed',
        hint: 'Wait for it to finish, or untick it and publish the rest.',
      });
    }
    staged.push({ fileId, dir, meta });
  }

  const albumDate = date || earliestDate(staged) || today();
  const albumTitle = String(title).trim() || albumDate;

  const op = startOperation(
    {
      kind: 'publish',
      title: `Publishing “${albumTitle}”`,
      steps: transactionSteps([
        ['photos', `Copying ${staged.length} photos into the album`],
        ['manifest', 'Adding the album to the site’s photo list'],
      ]),
    },
    (op) => {
      let summary = albumTitle;
      return galleryTransaction(op, {
        message: () => `gallery: ${summary}`,
        push,
        resolution: readResolution(req.body),
        journal: { stagingIds: fileIds },
        // Staging is only cleared once GitHub has the photos, so an abandoned or failed publish
        // can simply be retried.
        finish: () => clearStaging(fileIds),
        apply: async (op) => {
          // Loaded inside the transaction: after a merge, the manifest is GitHub's plus ours.
          const config = await loadConfig();
          const manifest = await loadManifest(config);
          const id = makeAlbumId(title, albumDate, manifest.albums.map((a) => a.id));
          const album = {
            id,
            title: albumTitle,
            date: albumDate,
            coverPhotoId: null,
            showLocation: Boolean(showLocation),
            photoCount: 0,
            bytes: 0,
          };

          const added = await op.step('photos', (step) => copyIntoAlbum(step, {
            staged, album, manifest, config, captions, coverFileId,
          }));

          if (added.length === 0) {
            throw new StudioError('All of these photos are already on the site (their contents are identical).', {
              status: 409,
              code: 'already-published',
              hint: 'Nothing new to publish. Clear the list to start over.',
            });
          }

          await op.step('manifest', async (step) => {
            album.coverPhotoId ||= added[0].id;
            manifest.albums.push(album);
            manifest.photos.push(...added);
            await saveManifest(manifest);
            step.detail = `${manifest.albums.length} albums, ${manifest.photos.length} photos in total`;
          });

          summary = `${album.title} (${added.length} photos)`;
          return {
            album: manifest.albums.find((a) => a.id === id),
            added: added.length,
            budget: budgetReport(manifest),
          };
        },
      });
    },
  );
  accepted(res, op);
}));

async function copyIntoAlbum(step, { staged, album, manifest, config, captions, coverFileId }) {
  const added = [];
  let done = 0;
  for (const { fileId, dir, meta } of staged) {
    const photo = meta.photo;
    step.detail = `${done} of ${staged.length}: ${meta.name}`;
    step.progress = done / staged.length;
    done++;

    // Two photos with identical bytes hash to the same id; keep the first and skip the rest
    // rather than writing one file twice and double-counting it against the budget.
    if (manifest.photos.some((p) => p.id === photo.id) || added.some((p) => p.id === photo.id)) {
      continue;
    }

    const bytes = await writePhotoFiles(
      album.id,
      photo.id,
      await readFile(join(dir, 'web.avif')),
      await readFile(join(dir, 'thumb.avif')),
    );

    const entry = {
      id: photo.id,
      albumId: album.id,
      ...photoPaths(album.id, photo.id),
      w: photo.w,
      h: photo.h,
      tw: photo.tw,
      th: photo.th,
      lqip: photo.lqip,
      color: photo.color,
      bytes,
      takenAt: photo.takenAt || `${album.date}T12:00:00`,
      caption: String(captions[fileId] || '').trim(),
      exif: photo.exif || {},
    };

    if (album.showLocation && photo.gps) {
      if (config.reverseGeocode) step.detail = `${done} of ${staged.length}: looking up where ${meta.name} was taken`;
      entry.location = {
        lat: round(photo.gps.lat, 6),
        lon: round(photo.gps.lon, 6),
        label: config.reverseGeocode ? await reverseGeocode(photo.gps.lat, photo.gps.lon) : null,
      };
      if (!entry.location.label) delete entry.location.label;
    }

    added.push(entry);
    if (fileId === coverFileId) album.coverPhotoId = photo.id;
  }
  step.progress = 1;
  step.detail = `${added.length} copied${added.length < staged.length ? `, ${staged.length - added.length} already on the site` : ''}`;
  return added;
}

function earliestDate(staged) {
  const dates = staged
    .map((s) => s.meta.photo?.takenAt)
    .filter(Boolean)
    .map((t) => t.slice(0, 10))
    .sort();
  return dates[0];
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
