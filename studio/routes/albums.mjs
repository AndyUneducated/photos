/**
 * Managing what is already published: deleting albums or photos, listing an album's photos, and
 * reclaiming the local disk that old gallery snapshots take up.
 */

import express from 'express';

import {
  budgetReport,
  deleteAlbum,
  deletePhotos,
  loadConfig,
  loadManifest,
  removeAlbumFiles,
  removePhotoFiles,
  saveManifest,
} from '../lib/gallery.mjs';
import { StudioError } from '../lib/errors.mjs';
import { reclaimSpace } from '../lib/git.mjs';
import { galleryTransaction, startOperation, transactionSteps } from '../lib/operations.mjs';
import { accepted, asyncRoute, readResolution } from './http.mjs';

export const router = express.Router();

router.post('/api/albums/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) throw new StudioError('No albums are selected.', { status: 400, code: 'no-albums' });

  const op = startOperation(
    {
      kind: 'delete-albums',
      title: ids.length === 1 ? 'Deleting 1 album' : `Deleting ${ids.length} albums`,
      steps: transactionSteps([['delete', 'Removing the photos from the gallery']]),
    },
    (op) => galleryTransaction(op, {
      message: `gallery: delete ${ids.length} albums`,
      push: req.body?.push !== false,
      resolution: readResolution(req.body),
      apply: async (op) => {
        const manifest = await loadManifest(await loadConfig());
        const removed = await op.step('delete', async (step) => {
          let count = 0;
          for (const id of ids) {
            count += deleteAlbum(manifest, id).length;
            await removeAlbumFiles(id);
          }
          await saveManifest(manifest);
          step.detail = `${count} photos removed`;
          return count;
        });
        return { removed, budget: budgetReport(manifest), albums: manifest.albums };
      },
    }),
  );
  accepted(res, op);
}));

router.post('/api/photos/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) throw new StudioError('No photos are selected.', { status: 400, code: 'no-photos' });

  const op = startOperation(
    {
      kind: 'delete-photos',
      title: ids.length === 1 ? 'Deleting 1 photo' : `Deleting ${ids.length} photos`,
      steps: transactionSteps([['delete', 'Removing the photos from the gallery']]),
    },
    (op) => galleryTransaction(op, {
      message: `gallery: delete ${ids.length} photos`,
      push: req.body?.push !== false,
      resolution: readResolution(req.body),
      apply: async (op) => {
        const manifest = await loadManifest(await loadConfig());
        const removed = await op.step('delete', async (step) => {
          const gone = deletePhotos(manifest, ids);
          for (const photo of gone) await removePhotoFiles(photo.albumId, photo.id);
          await saveManifest(manifest);
          step.detail = `${gone.length} photos removed`;
          return gone.length;
        });
        return { removed, budget: budgetReport(manifest), albums: manifest.albums };
      },
    }),
  );
  accepted(res, op);
}));

router.get('/api/albums/:id/photos', asyncRoute(async (req, res) => {
  const config = await loadConfig();
  const manifest = await loadManifest(config);
  res.json({ photos: manifest.photos.filter((p) => p.albumId === req.params.id) });
}));

router.post('/api/reclaim', asyncRoute(async (_req, res) => {
  const op = startOperation(
    { kind: 'reclaim', title: 'Reclaiming local disk', steps: [['gc', 'Dropping old gallery snapshots and compacting the repository']] },
    (op) => op.step('gc', async (step) => {
      const result = await reclaimSpace();
      step.detail = `${Math.round(result.freed / 1024 / 1024)} MB freed`;
      return result;
    }),
  );
  accepted(res, op);
}));
