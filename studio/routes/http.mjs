/**
 * Small helpers every route module shares: error forwarding, the 202 answer for long operations,
 * and reading a conflict resolution out of a request body.
 */

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/** Long operations answer at once with an id to poll; see lib/operations.mjs. */
export function accepted(res, op) {
  res.status(202).json({ opId: op.id, operation: op });
}

/** The user's answer to a conflict, which is only honoured for the exact remote commit they saw. */
export function readResolution(body) {
  const r = body?.resolution;
  if (!r || !['force', 'merge'].includes(r.action) || typeof r.remoteCommit !== 'string') return null;
  return { action: r.action, remoteCommit: r.remoteCommit };
}
