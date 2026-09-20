/**
 * Everything that happens to the masonry grid itself: promoting thumbnails
 * from data-src once the gate is passed, the scroll-reveal, and album
 * filtering. No dependencies.
 */

const REVEAL_STAGGER_MS = 45;
const REVEAL_MAX_STAGGER = 8;
const FILTER_STAGGER_MS = 26;
const FILTER_MAX_STAGGER = 10;
const LEAVE_MS = 170;

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createGrid(root) {
  const tiles = root ? Array.from(root.querySelectorAll('.tile')) : [];
  let promoted = false;
  let leaveTimer = 0;
  let album = 'all';

  // --- thumbnails ---------------------------------------------------------

  function markLoaded(img) {
    img.classList.add('is-loaded');
  }

  /**
   * Thumbnails carry their URL in data-src so that nothing downloads while the
   * gate is up. This is the only place a src is ever assigned.
   */
  function promoteThumbs() {
    if (promoted) return;
    promoted = true;

    for (const tile of tiles) {
      const img = tile.querySelector('.tile__img');
      const src = img && img.dataset.src;
      if (!img || !src || img.getAttribute('src')) continue;

      img.addEventListener('load', () => markLoaded(img), { once: true });
      // A missing file should leave the LQIP showing, not an empty hole.
      img.addEventListener('error', () => tile.classList.add('is-broken'), { once: true });
      img.src = src;

      // Served from cache: `load` may already have fired before we listened.
      if (img.complete && img.naturalWidth > 0) markLoaded(img);
    }
  }

  // --- scroll reveal ------------------------------------------------------

  function revealAll() {
    for (const tile of tiles) tile.classList.add('is-in');
  }

  function startReveal() {
    if (!tiles.length) return;
    if (reducedMotion() || !('IntersectionObserver' in window)) {
      revealAll();
      return;
    }

    const observer = new IntersectionObserver(
      (entries, obs) => {
        let batch = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const tile = entry.target;
          // Stagger within the batch that entered together, not globally:
          // a fast scroll should not queue up a second of delays.
          tile.style.transitionDelay = Math.min(batch, REVEAL_MAX_STAGGER) * REVEAL_STAGGER_MS + 'ms';
          tile.classList.add('is-in');
          batch += 1;
          obs.unobserve(tile);
          window.setTimeout(() => {
            tile.style.transitionDelay = '';
          }, 900);
        }
      },
      { rootMargin: '280px 0px', threshold: 0.01 },
    );

    // Hidden tiles are observed too: display:none never intersects, and the
    // observer fires by itself once a filter change puts them back in flow.
    for (const tile of tiles) observer.observe(tile);
  }

  // --- filtering ----------------------------------------------------------

  function apply(hide, show) {
    for (const tile of hide) {
      tile.classList.add('is-hidden');
      tile.classList.remove('is-leaving');
    }
    for (const tile of show) {
      tile.classList.remove('is-hidden');
    }
  }

  function setAlbum(next, options) {
    const animate = !(options && options.animate === false) && !reducedMotion();
    album = next || 'all';

    const hide = [];
    const show = [];
    for (const tile of tiles) {
      const matches = album === 'all' || tile.dataset.album === album;
      const hidden = tile.classList.contains('is-hidden');
      if (matches && hidden) show.push(tile);
      else if (!matches && !hidden) hide.push(tile);
    }

    window.clearTimeout(leaveTimer);

    if (!animate || (!hide.length && !show.length)) {
      apply(hide, show);
      return;
    }

    // Two beats: the leaving tiles fade and shrink in place, then the column
    // layout reflows and the arriving tiles fade up in a short stagger.
    for (const tile of hide) tile.classList.add('is-leaving');

    leaveTimer = window.setTimeout(() => {
      for (const tile of show) tile.classList.add('is-entering');
      apply(hide, show);

      // Two frames: one for the browser to lay the tiles out with the
      // entering state applied, one to transition out of it.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          show.forEach((tile, i) => {
            tile.style.transitionDelay = Math.min(i, FILTER_MAX_STAGGER) * FILTER_STAGGER_MS + 'ms';
            // Tiles that were never scrolled into view are still observed and
            // get their `is-in` from the IntersectionObserver instead.
            tile.classList.remove('is-entering');
            window.setTimeout(() => {
              tile.style.transitionDelay = '';
            }, 800);
          });
        });
      });
    }, hide.length ? LEAVE_MS : 0);
  }

  // --- queries used by the lightbox ---------------------------------------

  function visibleTiles() {
    return tiles.filter((tile) => !tile.classList.contains('is-hidden'));
  }

  function albumOf(photoId) {
    const tile = tiles.find((t) => t.dataset.id === photoId);
    return tile ? tile.dataset.album : null;
  }

  return {
    tiles,
    promoteThumbs,
    startReveal,
    setAlbum,
    visibleTiles,
    albumOf,
    get album() {
      return album;
    },
  };
}
