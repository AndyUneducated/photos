/**
 * The URL is the single source of truth for two pieces of view state:
 *   ?album=<id>   the active filter chip
 *   #p=<photoId>  the photo the lightbox has open
 *
 * Both are written with history.replaceState — filtering and opening a photo
 * are not navigations, but the resulting view should still be linkable.
 */

const state = { album: 'all', photo: null };

export function readUrl() {
  const url = new URL(window.location.href);
  const match = /^#p=(.+)$/.exec(url.hash);
  state.album = url.searchParams.get('album') || 'all';
  state.photo = match ? decodeURIComponent(match[1]) : null;
  return { ...state };
}

export function writeUrl(patch) {
  Object.assign(state, patch);

  const url = new URL(window.location.href);
  if (state.album && state.album !== 'all') url.searchParams.set('album', state.album);
  else url.searchParams.delete('album');

  const hash = state.photo ? '#p=' + encodeURIComponent(state.photo) : '';
  const next = url.pathname + url.search + hash;

  if (next !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(window.history.state, '', next);
  }
}
