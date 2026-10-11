/**
 * Adding originals to the studio, removing them, and serving their processed previews.
 */

import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import express from 'express';

import { StudioError } from '../lib/errors.mjs';
import { STAGING_DIR, SUPPORTED_EXTENSIONS, stagingDir } from '../lib/staging.mjs';
import { asyncRoute } from './http.mjs';

export const router = express.Router();

/**
 * Receives one original file, streamed straight to disk. A batch of A7R V frames is several
 * hundred megabytes, so the body is never buffered in memory.
 */
router.post('/api/stage', asyncRoute(async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) throw new StudioError('The file name is missing.', { status: 400, code: 'no-name' });

  const ext = extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new StudioError(`“${name}” is not a supported photo type (${ext || 'no extension'}).`, {
      status: 415,
      code: 'unsupported-type',
      hint: 'Supported: .HIF, .HEIC, .HEIF, .AVIF, .JPG, .PNG, .TIFF and .WEBP.',
    });
  }

  const fileId = randomUUID();
  const dir = join(STAGING_DIR, fileId);
  await mkdir(dir, { recursive: true });
  const originalPath = join(dir, `original${ext}`);

  try {
    await pipeline(req, createWriteStream(originalPath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new StudioError(`Copying “${name}” into the studio was interrupted.`, {
      status: err.code === 'ENOSPC' ? 507 : 500,
      code: err.code === 'ENOSPC' ? 'disk-full' : 'stage-interrupted',
      hint: err.code === 'ENOSPC' ? 'The disk is full; free some space and add the photo again.' : 'Add the photo again.',
      cause: err,
    });
  }

  await writeFile(join(dir, 'meta.json'), JSON.stringify({ fileId, name, state: 'staged' }, null, 2));
  res.json({ fileId, name });
}));

router.delete('/api/stage/:fileId', asyncRoute(async (req, res) => {
  await rm(stagingDir(req.params.fileId), { recursive: true, force: true });
  res.json({ ok: true });
}));

router.post('/api/stage/clear', asyncRoute(async (_req, res) => {
  await rm(STAGING_DIR, { recursive: true, force: true });
  res.json({ ok: true });
}));

router.get('/api/staged/:fileId/:variant', asyncRoute(async (req, res) => {
  const { fileId, variant } = req.params;
  if (variant !== 'web' && variant !== 'thumb') return res.status(404).end();

  const path = join(stagingDir(fileId), `${variant}.avif`);

  let data;
  try {
    data = await readFile(path);
  } catch {
    return res.status(404).json({ error: 'This photo has not finished processing yet.' });
  }

  res.type('image/avif');
  // Rotating a photo rewrites this file in place, so it must never be cached.
  res.setHeader('Cache-Control', 'no-store');
  res.send(data);
}));
