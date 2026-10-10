/**
 * Every failure the studio reports carries two things: a sentence the person at the keyboard can
 * act on, and the raw detail (command, exit code, stderr, stack, which step) that someone
 * debugging it needs. Raw git stderr alone is precise but unreadable; a friendly sentence alone is
 * impossible to debug. The UI shows the first and keeps the second one click away, copyable.
 */

import { release } from 'node:os';

export class StudioError extends Error {
  /**
   * @param {string} message  Plain-language summary, shown as the headline.
   * @param {object} [o]
   * @param {number} [o.status]  HTTP status to answer with.
   * @param {string} [o.code]    Stable machine-readable code, e.g. `git-auth`.
   * @param {string} [o.hint]    What to do about it.
   * @param {object} [o.extra]   Additional fields merged into the response (e.g. a conflict diff).
   * @param {Error}  [o.cause]   The underlying error, whose detail is preserved.
   */
  constructor(message, { status = 500, code = 'internal', hint, extra, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StudioError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

/**
 * Known git failure signatures, matched against stderr. Order matters: the first match wins, and
 * a rejected lease must be recognised before the generic network patterns.
 */
const GIT_PATTERNS = [
  {
    test: /stale info|\[rejected\]|fetch first|non-fast-forward/i,
    code: 'git-remote-changed',
    message: 'The gallery on GitHub changed while this was being published.',
    hint: 'Another computer probably published at the same moment. Try again to see what differs.',
  },
  {
    test: /\[remote rejected\]|hook declined|protected branch|GH001|exceeds GitHub's file size limit/i,
    code: 'git-push-refused',
    message: 'GitHub received the upload but refused to accept it.',
    hint:
      'A rule on the repository (branch protection, a file size limit, or a hook) turned it down. ' +
      'The lines starting with "remote:" in the details below are GitHub’s own reason.',
  },
  {
    test: /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or password|Permission denied \(publickey\)|returned error: 403|access denied/i,
    code: 'git-auth',
    message: 'GitHub refused to let this computer push to the repository.',
    hint:
      'Sign in once from a terminal in the project folder by running "git push origin main" ' +
      '(on a Mac, "gh auth login" followed by "gh auth setup-git" also works), then try again.',
  },
  {
    test: /Could not resolve host|Failed to connect|Connection timed out|Connection refused|Network is unreachable|Operation timed out|unable to access|SSL_ERROR|schannel/i,
    code: 'git-network',
    message: 'Could not reach GitHub.',
    hint: 'Check the internet connection (and any VPN or proxy), then try again.',
  },
  {
    test: /HTTP 413|pack exceeds maximum|RPC failed|remote end hung up|early EOF|unexpected disconnect/i,
    code: 'git-upload-cut',
    message: 'The upload to GitHub was cut off part-way through.',
    hint:
      'Usually a slow or unstable connection combined with a large batch. Try again, or publish ' +
      'fewer photos at once. If it keeps happening, run: git config http.postBuffer 524288000',
  },
  {
    test: /index\.lock|Unable to create '.*\.lock'/i,
    code: 'git-locked',
    message: 'Another git program is using the repository right now.',
    hint:
      'Close other git tools and try again. If nothing else is running, a crashed git left a ' +
      'lock file behind: delete the index.lock file named in the details below.',
  },
  {
    test: /No space left on device|ENOSPC/i,
    code: 'disk-full',
    message: 'The disk is full.',
    hint: 'Free some space on this computer, then try again.',
  },
  {
    test: /not a git repository/i,
    code: 'git-no-repo',
    message: 'This folder is not a git repository.',
    hint: 'Run the start script again (start.cmd on Windows, start.command on a Mac); it sets the repository up.',
  },
];

const NODE_CODES = {
  ENOENT: { message: 'A file the studio needed is missing.', hint: 'The details show which one.' },
  EACCES: { message: 'The studio is not allowed to write to a file it needs.', hint: 'Check the folder permissions, or close programs that may be holding the file open.' },
  EPERM: { message: 'The operating system blocked access to a file.', hint: 'A virus scanner, sync tool or open editor may be holding it; close it and try again.' },
  EBUSY: { message: 'A file is in use by another program.', hint: 'Close programs that may be holding it open and try again.' },
  ENOSPC: { message: 'The disk is full.', hint: 'Free some space on this computer, then try again.' },
};

/**
 * Shapes any thrown value into the JSON body the studio answers with.
 *
 * @param {unknown} err
 * @param {{ step?: string, operation?: string }} [context]
 */
export function describeError(err, context = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const root = rootCause(e);
  const stderr = root.stderr || e.stderr || '';

  let message = e.message;
  let code = e.code && typeof e.code === 'string' && !NODE_CODES[e.code] ? e.code : 'internal';
  let hint = e.hint;

  if (!(e instanceof StudioError)) {
    const known = (stderr || e.message) && GIT_PATTERNS.find((p) => p.test.test(`${stderr}\n${e.message}`));
    const nodeCode = NODE_CODES[root.code];
    if (known) {
      ({ message, code, hint } = known);
    } else if (nodeCode) {
      ({ message, hint } = nodeCode);
      code = root.code.toLowerCase();
    } else if (root.name === 'GitError') {
      code = 'git-failed';
      const firstLine = stderr.split('\n').map((l) => l.trim()).find(Boolean);
      message = `Git could not complete "${root.args?.[0] ?? 'a command'}"${firstLine ? `: ${firstLine.replace(/^(fatal|error): /, '')}` : '.'}`;
    }
  } else if (!hint && stderr) {
    hint = GIT_PATTERNS.find((p) => p.test.test(stderr))?.hint;
  }

  const detail = {
    code,
    operation: context.operation,
    step: context.step,
    error: root === e ? e.message : `${e.message}\nCaused by: ${root.message}`,
    command: root.args ? `git ${root.args.join(' ')}` : undefined,
    cwd: root.cwd,
    exitCode: root.exitCode,
    stderr: stderr || undefined,
    errno: !(root instanceof StudioError) && typeof root.code === 'string' ? root.code : undefined,
    path: root.path,
    stack: root.stack,
    time: new Date().toISOString(),
    platform: `${process.platform} ${release()} ${process.arch}, node ${process.version}`,
  };
  for (const key of Object.keys(detail)) if (detail[key] === undefined) delete detail[key];

  return {
    error: message,
    code,
    ...(hint ? { hint } : {}),
    ...(e.extra || {}),
    detail,
  };
}

function rootCause(err) {
  let current = err;
  while (current.cause instanceof Error) current = current.cause;
  return current;
}
