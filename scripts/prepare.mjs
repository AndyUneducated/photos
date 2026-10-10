/**
 * Everything between "Node and git are installed" and "the studio can start", on any platform.
 *
 * start.cmd (Windows) and start.command (macOS) only make sure Node and git exist, then hand over
 * to this script, so there is exactly one copy of the setup logic. Every step checks whether it
 * is needed first, so running it on every start costs a second or two.
 *
 * Deliberately uses nothing but Node built-ins until dependencies are installed.
 *
 *   node scripts/prepare.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MIN_NODE = [20, 11];

const step = (text) => console.log(`\n>> ${text}`);
const ok = (text) => console.log(`   ${text}`);
const warn = (text) => console.log(`   ! ${text}`);

class SetupError extends Error {}

try {
  checkNode();
  checkGit();
  await ensureDependencies();
  await ensureRepository();
  console.log('\nReady.');
} catch (err) {
  console.error(`\nSetup stopped: ${err.message}`);
  if (!(err instanceof SetupError)) console.error(err.stack);
  process.exit(1);
}

// ---------------------------------------------------------------- tools

function checkNode() {
  step('Checking Node.js');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new SetupError(
      `Node.js ${MIN_NODE.join('.')} or newer is required, but this is ${process.version}. ` +
        (process.platform === 'darwin' ? 'Run "brew upgrade node", then start again.' : 'Install the current LTS from https://nodejs.org, then start again.'),
    );
  }
  ok(`Node.js ${process.version} (${process.platform} ${process.arch})`);
}

function checkGit() {
  step('Checking git');
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new SetupError(
      process.platform === 'darwin'
        ? 'git is not working. Run "xcode-select --install" (or "brew install git"), then start again.'
        : 'git is not installed or not on the PATH. Install it from https://git-scm.com, then start again.',
    );
  }
  ok(result.stdout.trim());
}

// ---------------------------------------------------------------- dependencies

/**
 * Installs when node_modules is missing, out of date, or built for another machine. The last case
 * is the one that bites when a folder is copied from a Windows PC to a Mac: everything looks
 * installed, but sharp's native binary is the Windows one and the studio dies on its first photo.
 */
async function ensureDependencies() {
  step('Checking dependencies');
  const reason = installReason();
  if (!reason) {
    ok('Up to date');
    return;
  }

  ok(`Installing (${reason}); about 1-2 minutes the first time`);
  const hasLock = existsSync(join(ROOT, 'package-lock.json'));
  // A tree built for another platform has to go entirely; `npm ci` removes node_modules first.
  await runInherit('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund']);

  const after = loadsSharp();
  if (after !== true) {
    throw new SetupError(
      `Dependencies installed, but the image library (sharp) still does not load on this machine: ${after}\n` +
        '   Delete the node_modules folder and start again. If that does not help, the details above say what is missing.',
    );
  }
  writeFileSync(join(ROOT, 'node_modules', '.photos-platform'), platformTag());
  ok('Installed');
}

function installReason() {
  const modules = join(ROOT, 'node_modules');
  if (!existsSync(modules)) return 'first run';

  const stampPath = join(modules, '.photos-platform');
  const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : null;
  if (stamp && stamp !== platformTag()) return `node_modules was installed on ${stamp}`;

  // npm writes this file on every install; an older one means package-lock.json changed since,
  // which is what a `git pull` that touched dependencies looks like.
  const lock = join(ROOT, 'package-lock.json');
  const installed = join(modules, '.package-lock.json');
  if (!existsSync(installed)) return 'incomplete install';
  if (existsSync(lock) && statSync(lock).mtimeMs > statSync(installed).mtimeMs) return 'package-lock.json changed';

  const sharp = loadsSharp();
  if (sharp !== true) return `the image library does not load here (${sharp.split('\n')[0]})`;

  if (!stamp) writeFileSync(stampPath, platformTag());
  return null;
}

function platformTag() {
  return `${process.platform}-${process.arch}`;
}

/** true, or the first lines of why sharp cannot be loaded. Run in a child so a crash cannot take this script down. */
function loadsSharp() {
  const result = spawnSync(process.execPath, ['-e', "import('sharp').then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); })"], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? true : (result.stderr || 'unknown error').trim().split('\n').slice(0, 3).join('\n');
}

// ---------------------------------------------------------------- repository

async function ensureRepository() {
  step('Checking the repository');
  if (!existsSync(join(ROOT, '.git'))) {
    await runInherit('git', ['init', '-b', 'main']);
    ok('Initialised a new git repository');
  }

  const { status } = await import('../studio/lib/git.mjs');
  const before = await status();
  ok(`Branch: ${before.branch ?? '(none yet)'}`);
  if (!before.hasIdentity) warn('No git user.name / user.email configured; the studio will commit as "photos studio".');

  if (!before.remote) {
    warn('No GitHub remote is configured, so publishing will only save on this computer. To connect one:');
    console.log('       git remote add origin https://github.com/<username>/photos.git');
    console.log('       git push -u origin main');
  } else {
    ok(`Remote: ${before.remote}`);
    await checkRemoteAccess();
  }

  step('Checking the gallery branch');
  const { ensureGalleryWorktree } = await import('../studio/lib/git.mjs');
  const { created, adopted } = await ensureGalleryWorktree({ interactive: true });
  if (adopted) ok('Downloaded the gallery that is already on GitHub');
  else if (created) ok('Created the gallery branch and the gallery/ folder');
  else ok('In place');
}

/**
 * Talks to GitHub once with prompts allowed, here in the terminal. The studio's own git runs
 * without a terminal and cannot ask for a password, so this is the moment a new machine signs in.
 */
async function checkRemoteAccess() {
  const code = await runInherit('git', ['ls-remote', '--heads', 'origin'], { quiet: true, allowFailure: true });
  if (code === 0) {
    ok('GitHub is reachable and accepts this computer');
    return;
  }
  warn('Could not talk to GitHub (see the message above). The studio still starts, but publishing will fail until this works.');
  if (process.platform === 'darwin') {
    console.log('     To sign in on a Mac, the simplest way is the GitHub CLI:');
    console.log('       brew install gh && gh auth login && gh auth setup-git');
  } else {
    console.log('     To sign in, run this once in this folder and follow the browser prompt:');
    console.log('       git push origin main');
  }
}

/** Runs a command with the terminal attached, so prompts and progress reach the user. */
function runInherit(cmd, args, { quiet = false, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    // npm is a .cmd shim on Windows, and Node only runs those through a shell.
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: quiet ? ['inherit', 'ignore', 'inherit'] : 'inherit',
      shell: process.platform === 'win32' && cmd === 'npm',
    });
    child.on('error', (err) => reject(new SetupError(`Could not run ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolvePromise(code);
      else reject(new SetupError(`"${cmd} ${args.join(' ')}" failed (exit code ${code}); the reason is printed above.`));
    });
  });
}
