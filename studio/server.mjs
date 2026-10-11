/**
 * The studio: a local-only web app for turning a folder of camera files into a published album.
 *
 * Nothing here is exposed to the internet — it binds to loopback, has no auth, and is expected to
 * be opened by the person sitting at the machine. It holds the privileged half of the system (the
 * git credentials, the originals, the ability to delete albums), which is exactly why it must not
 * listen on anything but localhost.
 *
 * The API lives in routes/, one module per area: state (page state, setup, settings, sync,
 * operation polling), staging (adding originals), process (encoding and rotation), publish, and
 * albums (deleting and housekeeping).
 */

import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import express from 'express';

import { ROOT, loadConfig } from './lib/gallery.mjs';
import { describeError } from './lib/errors.mjs';
import { status as gitStatus } from './lib/git.mjs';
import { recoverInterrupted } from './lib/operations.mjs';
import { defaultConcurrency } from './lib/pool.mjs';
import { STAGING_DIR, clearStaging } from './lib/staging.mjs';
import { router as albums } from './routes/albums.mjs';
import { router as processing } from './routes/process.mjs';
import { router as publish } from './routes/publish.mjs';
import { router as staging } from './routes/staging.mjs';
import { router as state, setRecovery } from './routes/state.mjs';

const PORT = Number(process.env.PORT) || 4478;

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use(state, staging, processing, publish, albums);

app.use('/gallery', express.static(join(ROOT, 'gallery', 'albums'), { fallthrough: true }));
app.use(express.static(join(ROOT, 'studio', 'public'), { extensions: ['html'] }));

app.use((err, req, res, _next) => {
  // express.json() reports a malformed body with `status`; keep it rather than calling it a 500.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json(describeError(err, { operation: `${req.method} ${req.path}` }));
});

// ---------------------------------------------------------------------------- boot

await mkdir(STAGING_DIR, { recursive: true });

// A publish that was cut off (window closed, machine slept, crash) left a journal behind. Settle it
// before serving anything, so the page never shows a half-applied gallery.
const recovery = await recoverInterrupted((journal) => clearStaging(journal.stagingIds || []))
  .catch((err) => ({ outcome: 'failed', error: describeError(err, { operation: 'Recovering an interrupted operation' }) }));
setRecovery(recovery);
if (recovery) {
  console.log(recovery.outcome === 'completed'
    ? `  Recovered: "${recovery.title}" had reached GitHub before the studio stopped; it is kept.`
    : recovery.outcome === 'rolled-back'
      ? `  Recovered: "${recovery.title}" was interrupted; the gallery was put back as it was before.`
      : `  Could not recover an interrupted operation: ${recovery.error.error}`);
}

const server = createServer(app);

// Loopback only. This process can push to your repository and delete your albums; it has no
// business being reachable from the network.
server.listen(PORT, '127.0.0.1', async () => {
  const config = await loadConfig().catch(() => ({}));
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\n  Photo studio is running at ${url}`);
  console.log(`  Site title: ${config.siteTitle ?? '(not set)'}    Concurrency: ${config.concurrency || defaultConcurrency()}`);

  const git = await gitStatus().catch(() => null);
  if (git && !git.worktreeReady) {
    console.log('  Tip: the worktree for the gallery branch is not set up yet — opening the page sets it up.');
  }
  if (git && !git.remote) {
    console.log('  Tip: no origin remote is configured yet, so publishing will only commit locally.');
  }

  if (process.env.PHOTOS_NO_OPEN !== '1') {
    const { spawn } = await import('node:child_process');
    // Open the studio in the default browser. Windows needs `cmd /c start` (empty title arg
    // required); macOS/Linux use the platform open helpers.
    const opener =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    const child = spawn(opener[0], opener[1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  }
});
