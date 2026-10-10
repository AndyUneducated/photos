/**
 * "Download" in the header: every photo in the album being viewed (or all of them under "All").
 *
 * Phones and tablets get the system share sheet, whose "Save N Images" puts the photos straight
 * into Photos; a ZIP there lands in Files and has to be unpacked and saved one by one. Computers
 * get a ZIP, with one folder per album when "All" spans several.
 *
 * The share sheet only opens from a tap, and browsers forget a tap after a few seconds, far less
 * than fetching an album takes. So it is two taps: one to fetch, then "Save to Photos" once the
 * files are in memory. The files are the same AVIFs the site shows, shooting time included.
 */
import { zip } from './zip.js';

const CONCURRENCY = 4;
const ATTEMPTS = 3;

export function createDownloader({ button, grid }) {
  if (!button) return;
  const titles = JSON.parse(button.dataset.titles || '{}');
  let busy = false;

  button.addEventListener('click', () => {
    if (!busy) start();
  });

  async function start() {
    const album = grid.album;
    const tiles = grid.tiles.filter((t) => album === 'all' || t.dataset.album === album);
    if (!tiles.length) return;
    // A site with one album has no filter, so "all" is that album and should carry its name.
    const albumsHere = new Set(tiles.map((t) => t.dataset.album));
    const only = albumsHere.size === 1 ? [...albumsHere][0] : null;
    const title = titles[album === 'all' ? only : album] || titles.all || 'Photos';
    const folders = album === 'all' && albumsHere.size > 1;

    busy = true;
    button.disabled = true;
    const ctrl = new AbortController();
    let cancelled = false;
    const panel = openPanel(`Downloading “${title}”`, () => {
      cancelled = true;
      ctrl.abort();
    });

    try {
      const files = await fetchAll(tiles, ctrl, (done, bytes) => {
        panel.progress(done / tiles.length, `${done} of ${photos(tiles.length)} · ${mb(bytes)}`);
      });
      const total = files.reduce((sum, f) => sum + f.data.length, 0);
      const saveZip = () => {
        const blob = zip(files.map((f) => ({
          name: folders ? `${safeName(titles[f.album] || f.album)}/${f.name}` : f.name,
          data: f.data,
          takenAt: f.takenAt,
        })));
        const name = `${safeName(title)}.zip`;
        saveBlob(blob, name);
        panel.finish(`Downloaded “${title}”`, `Saved “${name}” · ${mb(blob.size)}`);
      };

      if (canShareFiles()) {
        const shareFiles = files.map((f) => new File([f.data], f.name, { type: 'image/avif' }));
        panel.ready(`“${title}” is ready`, `${photos(files.length)} · ${mb(total)}`, [
          ['Save to Photos', async () => {
            try {
              await navigator.share({ files: shareFiles, title });
              panel.finish(`Downloaded “${title}”`, `${photos(files.length)} handed to the system`);
            } catch (err) {
              if (err && err.name === 'AbortError') return; // closed the sheet; let them try again
              panel.fail(`The share sheet would not take these photos (${describe(err)}). The ZIP has the same files.`, [['Download ZIP', saveZip]]);
            }
          }],
          ['ZIP instead', saveZip],
        ]);
      } else {
        panel.progress(1, 'Packing the ZIP…');
        await new Promise((r) => setTimeout(r, 30)); // let the label paint before the busy loop
        saveZip();
      }
    } catch (err) {
      if (cancelled) panel.close();
      else panel.fail(err.message, [['Try again', () => { panel.close(); start(); }]]);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
}

/** Phones and tablets only: desktop browsers can share files too, but there a ZIP is what people expect. */
function canShareFiles() {
  if (!navigator.canShare || !window.matchMedia('(pointer: coarse)').matches) return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe.avif', { type: 'image/avif' })] });
  } catch {
    return false;
  }
}

async function fetchAll(tiles, ctrl, onProgress) {
  const out = new Array(tiles.length);
  let next = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (next < tiles.length && !ctrl.signal.aborted) {
      const i = next++;
      const tile = tiles[i];
      const name = tile.dataset.file || `${tile.dataset.id}.avif`;
      const data = await fetchOne(tile.href, name, ctrl.signal);
      out[i] = { name, data, album: tile.dataset.album, takenAt: tile.dataset.taken };
      done++;
      bytes += data.length;
      onProgress(done, bytes);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, worker));
  } catch (err) {
    ctrl.abort(); // stop the other workers too
    throw err;
  }
  return out;
}

async function fetchOne(url, name, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt >= ATTEMPTS) {
        throw new Error(`Could not download “${name}” after ${ATTEMPTS} tries (${describe(err)}). Check the connection and try again.`);
      }
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking at once can cancel the save in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Album titles may contain `/` ("Yellowstone & Teton/MILC") and other characters no file system takes. */
function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '') || 'Photos';
}

function photos(n) {
  return n === 1 ? '1 photo' : `${n} photos`;
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function describe(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TypeError') return 'network error';
  return err.message || err.name || String(err);
}

// ---------------------------------------------------------------- panel

function openPanel(heading, onCancel) {
  const el = document.createElement('div');
  el.className = 'dl-panel';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="dl-panel__head">
      <span class="dl-panel__title"></span>
      <button class="dl-panel__close" type="button" aria-label="Cancel">×</button>
    </div>
    <div class="dl-panel__bar"><span></span></div>
    <p class="dl-panel__text">Starting…</p>
    <div class="dl-panel__actions"></div>`;
  const titleEl = el.querySelector('.dl-panel__title');
  titleEl.textContent = heading;
  const bar = el.querySelector('.dl-panel__bar span');
  const text = el.querySelector('.dl-panel__text');
  const actions = el.querySelector('.dl-panel__actions');
  const closeBtn = el.querySelector('.dl-panel__close');
  let running = true;
  let timer = 0;

  closeBtn.addEventListener('click', () => {
    if (running) onCancel();
    close();
  });
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  function close() {
    clearTimeout(timer);
    el.remove();
  }

  function setActions(list) {
    actions.replaceChildren(...list.map(([label, fn], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === 0 ? 'dl-panel__btn is-primary' : 'dl-panel__btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }));
  }

  return {
    close,
    progress(fraction, label) {
      bar.style.width = `${Math.round(fraction * 100)}%`;
      text.textContent = label;
    },
    ready(heading, label, list) {
      running = false;
      closeBtn.setAttribute('aria-label', 'Close');
      titleEl.textContent = heading;
      bar.style.width = '100%';
      text.textContent = label;
      setActions(list);
    },
    finish(heading, label) {
      running = false;
      el.classList.remove('is-error');
      el.classList.add('is-done');
      titleEl.textContent = heading;
      bar.style.width = '100%';
      text.textContent = label;
      setActions([]);
      timer = setTimeout(close, 6000);
    },
    fail(message, list) {
      running = false;
      closeBtn.setAttribute('aria-label', 'Close');
      titleEl.textContent = 'Download stopped';
      el.classList.add('is-error');
      text.textContent = message;
      setActions(list);
    },
  };
}
