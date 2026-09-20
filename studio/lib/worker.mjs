/**
 * Worker-thread wrapper around the photo pipeline.
 *
 * Decoding HEIF happens inside a WebAssembly module, which is single-threaded and blocks the
 * thread it runs on, so processing a batch on the main thread would freeze the studio's HTTP
 * server for minutes. Each worker also gets its own libheif instance and its own WASM heap, which
 * matters because a 61MP frame needs several hundred megabytes of scratch space.
 */

import { parentPort } from 'node:worker_threads';

import { processPhoto } from './process.mjs';

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'task') return;

  try {
    const result = await processPhoto(msg.filePath, msg.opts);
    parentPort.postMessage({ type: 'done', taskId: msg.taskId, result });
  } catch (err) {
    parentPort.postMessage({
      type: 'failed',
      taskId: msg.taskId,
      error: err?.message || String(err),
      stack: err?.stack,
    });
  }
});
