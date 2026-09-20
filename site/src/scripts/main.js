/**
 * Wiring only. The three pieces (gate, grid, lightbox) know nothing about
 * each other; this module owns the order they run in and the URL state they
 * share.
 */
import { createGate } from './gate.js';
import { createGrid } from './grid.js';
import { createLightbox } from './lightbox.js';
import { readUrl, writeUrl } from './url.js';

const gridEl = document.getElementById('grid');
const filterEl = document.getElementById('filter');

if (gridEl) {
  const grid = createGrid(gridEl);
  const initial = readUrl();

  const lightbox = createLightbox({
    gallery: gridEl,
    onPhotoChange: (id) => writeUrl({ photo: id }),
  });

  // --- album filter -------------------------------------------------------

  const chips = filterEl ? Array.from(filterEl.querySelectorAll('.chip')) : [];
  const knownAlbums = new Set(chips.map((chip) => chip.dataset.album));

  function paintChips(album) {
    for (const chip of chips) {
      const active = chip.dataset.album === album;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
      if (active && chips.length > 1) {
        chip.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function selectAlbum(album, options) {
    const next = knownAlbums.has(album) ? album : 'all';
    paintChips(next);
    grid.setAlbum(next, options);
    writeUrl({ album: next });
  }

  for (const chip of chips) {
    chip.addEventListener('click', () => selectAlbum(chip.dataset.album));
  }

  // --- boot ---------------------------------------------------------------

  // A `#p=` deep link wins over `?album=`: the linked photo has to be in the
  // filtered set or the lightbox would open on nothing.
  let startAlbum = initial.album;
  if (initial.photo) {
    const owner = grid.albumOf(initial.photo);
    if (owner && startAlbum !== 'all' && startAlbum !== owner) startAlbum = owner;
  }
  selectAlbum(startAlbum, { animate: false });

  createGate(() => {
    grid.promoteThumbs();
    grid.startReveal();
    if (initial.photo) lightbox.openById(initial.photo);
  });
}
