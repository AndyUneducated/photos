/**
 * Page state, first-run setup, operation polling, site settings and the manual sync.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import express from 'express';

import { ROOT, budgetReport, loadConfig, loadManifest, saveManifest } from '../lib/gallery.mjs';
import { StudioError, describeError } from '../lib/errors.mjs';
import { ensureGalleryWorktree, status as gitStatus } from '../lib/git.mjs';
import { activeOperation, galleryTransaction, getOperation, startOperation, transactionSteps } from '../lib/operations.mjs';
import { defaultConcurrency } from '../lib/pool.mjs';
import { listStaged } from '../lib/staging.mjs';
import { accepted, asyncRoute, readResolution } from './http.mjs';

const CONFIG_PATH = join(ROOT, 'config.json');

/** What crash recovery did at startup; reported to the first page load, then forgotten. */
let recovery = null;

export function setRecovery(value) {
  recovery = value;
}

function takeRecovery() {
  const value = recovery;
  recovery = null;
  return value;
}

export const router = express.Router();

router.get('/api/state', asyncRoute(async (_req, res) => {
  const config = await loadConfig();
  const manifest = await loadManifest(config);
  const git = await gitStatus();

  res.json({
    config: publicConfig(config),
    git,
    concurrency: config.concurrency || defaultConcurrency(),
    budget: budgetReport(manifest),
    albums: manifest.albums,
    photoCount: manifest.photos.length,
    staged: await listStaged(),
    operation: activeOperation(),
    recovery: takeRecovery(),
  });
}));

router.post('/api/setup', asyncRoute(async (_req, res) => {
  const result = await ensureGalleryWorktree();
  res.json({ ok: true, ...result, git: await gitStatus() });
}));

router.get('/api/ops/:id', (req, res) => {
  const op = getOperation(req.params.id);
  if (!op) {
    return res.status(404).json(describeError(new StudioError(
      'The studio no longer knows about this operation; it was probably restarted.',
      { status: 404, code: 'unknown-operation', hint: 'Reload the page to see the current state.' },
    )));
  }
  res.json(op);
});

router.post('/api/settings', asyncRoute(async (req, res) => {
  const { siteTitle, siteTagline, passcode, budgetMB } = req.body || {};
  const configBefore = await readFile(CONFIG_PATH, 'utf8');

  const op = startOperation(
    { kind: 'settings', title: 'Saving site settings', steps: transactionSteps([['settings', 'Writing the new settings']]) },
    (op) => galleryTransaction(op, {
      // Settings only reach visitors through a rebuild, and a rebuild only runs on a push.
      // Publishing here is what makes a passcode change take effect now instead of silently
      // waiting for the next upload. Unchanged settings produce an identical tree and no push.
      message: 'gallery: update site settings',
      push: req.body?.push !== false,
      resolution: readResolution(req.body),
      journal: { configBefore },
      onRollback: () => writeFile(CONFIG_PATH, configBefore, 'utf8'),
      apply: async (op) => {
        const config = await loadConfig();
        await op.step('settings', async () => {
          if (typeof siteTitle === 'string' && siteTitle.trim()) config.siteTitle = siteTitle.trim();
          if (typeof siteTagline === 'string') config.siteTagline = siteTagline.trim();
          if (typeof budgetMB === 'number' && budgetMB > 0) {
            config.budgetBytes = Math.round(budgetMB * 1024 * 1024);
          }
          // Hashing here rather than in the browser means the plaintext passcode is never written
          // to config.json, which is a tracked file that ends up in a public repository.
          // Trimmed to match the gate, which trims what the visitor types; hashing a passcode with
          // a stray trailing space here would make it impossible to ever enter.
          if (typeof passcode === 'string') {
            const cleaned = passcode.trim();
            config.passcodeHash = cleaned
              ? createHash('sha256').update(cleaned, 'utf8').digest('hex')
              : '';
          }

          await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
          // Re-stamp the manifest so the site picks up the new title/passcode.
          await saveManifest(await loadManifest(config));
        });
        return { config: publicConfig(config) };
      },
    }),
  );
  accepted(res, op);
}));

/** Pushes whatever this computer has that GitHub does not, e.g. after a publish whose upload failed. */
router.post('/api/sync', asyncRoute(async (req, res) => {
  const op = startOperation(
    { kind: 'sync', title: 'Syncing with GitHub', steps: transactionSteps([]) },
    (op) => galleryTransaction(op, {
      message: 'gallery: sync',
      resolution: readResolution(req.body),
      apply: async () => ({}),
    }),
  );
  accepted(res, op);
}));

function publicConfig(config) {
  return {
    siteTitle: config.siteTitle,
    siteTagline: config.siteTagline,
    domain: config.domain,
    budgetBytes: config.budgetBytes,
    hasPasscode: Boolean(config.passcodeHash),
    webMaxEdge: config.webMaxEdge,
    thumbMaxEdge: config.thumbMaxEdge,
  };
}
