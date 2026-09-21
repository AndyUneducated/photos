/**
 * A tiny fixed-size worker pool for the photo pipeline.
 *
 * Concurrency is deliberately conservative. Each in-flight 61MP HEIF needs a few hundred megabytes
 * of WASM heap, so running one job per core would exhaust memory long before it saturated the CPU.
 */

import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const WORKER_PATH = join(import.meta.dirname, 'worker.mjs');

/** Rough peak memory for one in-flight 61MP frame: decode buffers plus the interleaved RGBA copy. */
const BYTES_PER_JOB = 700 * 1024 * 1024;

export function defaultConcurrency() {
  const byCpu = Math.max(1, availableParallelism() - 1);
  const byMemory = Math.max(1, Math.floor((totalmem() * 0.5) / BYTES_PER_JOB));
  return Math.min(4, byCpu, byMemory);
}

/**
 * Runs `tasks` through the pipeline, calling `onEvent` as each one starts and finishes.
 *
 * @param {Array<{taskId: string, filePath: string}>} tasks
 * @param {object} options
 * @param {object} options.opts pipeline options passed through to `processPhoto`
 * @param {number} [options.concurrency]
 * @param {(event: object) => void} [options.onEvent]
 * @param {() => boolean} [options.isCancelled]
 * @returns {Promise<Array<{taskId: string, ok: boolean, result?: object, error?: string}>>}
 */
export async function runBatch(tasks, { opts, concurrency, onEvent = () => {}, isCancelled = () => false }) {
  if (tasks.length === 0) return [];

  const size = Math.max(1, Math.min(concurrency || defaultConcurrency(), tasks.length));
  const queue = [...tasks];
  const results = [];
  const workers = [];

  try {
    await new Promise((resolvePromise, reject) => {
      let active = 0;
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolvePromise();
      };

      const pump = (worker) => {
        if (settled) return;

        if (isCancelled()) {
          if (active === 0) finish();
          return;
        }

        const task = queue.shift();
        if (!task) {
          if (active === 0) finish();
          return;
        }

        active++;
        worker.busy = task;
        onEvent({ type: 'start', taskId: task.taskId, filePath: task.filePath });
        worker.postMessage({ type: 'task', taskId: task.taskId, filePath: task.filePath, opts });
      };

      for (let i = 0; i < size; i++) {
        const worker = new Worker(WORKER_PATH);
        workers.push(worker);

        worker.on('message', (msg) => {
          const task = worker.busy;
          worker.busy = null;
          active--;

          if (msg.type === 'done') {
            const entry = { taskId: msg.taskId, ok: true, result: msg.result };
            results.push(entry);
            onEvent({ type: 'done', ...entry });
          } else {
            const entry = { taskId: msg.taskId, ok: false, error: msg.error, filePath: task?.filePath };
            results.push(entry);
            onEvent({ type: 'failed', ...entry });
          }

          pump(worker);
        });

        worker.on('error', (err) => {
          // A worker-level error (usually out of memory in the WASM heap) kills that thread, so we
          // fail the task it was holding and keep the remaining workers going.
          const task = worker.busy;
          worker.busy = null;
          if (task) {
            active--;
            const entry = { taskId: task.taskId, ok: false, error: err.message, filePath: task.filePath };
            results.push(entry);
            onEvent({ type: 'failed', ...entry });
          }

          const replacement = workers.indexOf(worker);
          if (replacement !== -1) workers.splice(replacement, 1);
          worker.terminate().catch(() => {});

          if (workers.length === 0 && queue.length > 0) {
            finish(new Error('Every processing thread crashed, most likely from running out of memory. Try setting concurrency to 1 in config.json and running it again.'));
          } else if (active === 0 && queue.length === 0) {
            finish();
          } else {
            // Hand the dead worker's share of the queue to an idle one — never to a busy worker,
            // which would overwrite the task it is holding and lose it.
            const idle = workers.find((w) => !w.busy);
            if (idle) pump(idle);
          }
        });

        pump(worker);
      }
    });
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }

  // Preserve the caller's ordering rather than completion order.
  const byId = new Map(results.map((r) => [r.taskId, r]));
  return tasks.map((t) => byId.get(t.taskId)).filter(Boolean);
}
