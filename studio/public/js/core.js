/** Shared page state and the tiny helpers every module uses. */

export const $ = (id) => document.getElementById(id);

export const state = {
  config: null,
  git: null,
  budget: null,
  albums: [],
  /** Staged files keyed by fileId: { fileId, name, bytes, state, photo, error } */
  files: new Map(),
  jobId: null,
  polling: null,
  /** Handle for the toast that tracks the running process job, so it mutates instead of stacking. */
  processToast: null,
  warnedNoRemote: false,
  selected: new Set(),
  coverFileId: null,
  captions: new Map(),
  rotations: new Map(),
};

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
