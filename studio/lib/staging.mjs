/**
 * The staging area: one directory per added file under studio/.state/staging/<fileId>/, holding
 * the original, its meta.json and, once processed, web.avif and thumb.avif. Files stay here until
 * GitHub has them, so a failed or abandoned publish can simply be retried.
 */

import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { StudioError } from './errors.mjs';
import { ROOT } from './gallery.mjs';

export const STAGING_DIR = join(ROOT, 'studio', '.state', 'staging');

export const SUPPORTED_EXTENSIONS = new Set([
  '.hif', '.heic', '.heif', '.avif',
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp',
]);

export function stagingDir(fileId) {
  // Guard against a crafted id escaping the staging root.
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new StudioError('Invalid file id.', { status: 400, code: 'bad-file-id' });
  return join(STAGING_DIR, fileId);
}

export async function listStaged() {
  let entries;
  try {
    entries = await readdir(STAGING_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const staged = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(join(STAGING_DIR, entry.name, 'meta.json'), 'utf8'));
      staged.push(meta);
    } catch {
      // A half-written staging directory is not worth surfacing; it gets cleaned up on clear.
    }
  }
  return staged;
}

export async function findOriginal(dir) {
  const entries = await readdir(dir);
  const original = entries.find((name) => name.startsWith('original'));
  if (!original) {
    throw new StudioError('The original file for this photo has gone missing from the studio.', {
      status: 404,
      code: 'original-missing',
      hint: 'Remove it from the list and add the photo again.',
    });
  }
  return join(dir, original);
}

export async function readMeta(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  } catch (err) {
    throw new StudioError('A photo in this batch is no longer in the studio.', {
      status: 404,
      code: 'staged-missing',
      hint: 'Reload the page to see what is still there.',
      cause: err,
    });
  }
}

export async function clearStaging(fileIds) {
  for (const fileId of fileIds) {
    await rm(stagingDir(fileId), { recursive: true, force: true });
  }
}
