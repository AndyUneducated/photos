/** Talking to the studio server, and the error shapes that come back. */

/**
 * A failure as the server describes it: `error` (the headline), `hint` (what to do), `code`, and
 * `detail` (command, stderr, stack — for whoever debugs it). See studio/lib/errors.mjs.
 */
export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.error || `Request failed (${status})`);
    this.payload = { ...payload, error: this.message };
    this.status = status;
  }
}

/** Thrown once a failure has already been shown to the user, so callers only need to clean up. */
export class HandledError extends Error {}

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: options.body && !(options.body instanceof Blob)
        ? { 'Content-Type': 'application/json', ...options.headers }
        : options.headers,
    });
  } catch (err) {
    throw new ApiError({
      error: 'The studio is not responding.',
      code: 'studio-unreachable',
      hint: 'Check that the studio window (the terminal running it) is still open. If it closed, start it again; nothing that already finished is lost.',
      detail: { request: `${options.method || 'GET'} ${path}`, error: String(err) },
    }, 0);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError({
      error: 'The studio sent back a response it could not read.',
      code: 'bad-response',
      detail: { request: `${options.method || 'GET'} ${path}`, status: res.status, body: text.slice(0, 2000) },
    }, res.status);
  }
  if (!res.ok) throw new ApiError(data, res.status);
  return data;
}

/** Normalises anything thrown into the server's error shape. */
export function errorPayload(err) {
  if (err instanceof ApiError) return err.payload;
  if (err && typeof err === 'object' && 'error' in err && !(err instanceof Error)) return err;
  return { error: err?.message || String(err), code: 'client-error', detail: { stack: err?.stack } };
}
