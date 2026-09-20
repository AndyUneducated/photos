/**
 * Reverse geocoding for the album-level "show location" opt-in, so a photo can be labelled
 * "黄浦区, 上海市" instead of a pair of raw coordinates.
 *
 * Uses OpenStreetMap's Nominatim, which is free and needs no API key but asks for a real
 * User-Agent and at most one request per second. Results are cached on disk, so a given place is
 * only ever looked up once. Every failure mode degrades to "no label", never to a failed upload.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ROOT } from './gallery.mjs';

const CACHE_PATH = join(ROOT, 'studio', '.state', 'geocode.json');
const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'photos-studio/1.0 (personal family photo gallery)';
const MIN_INTERVAL_MS = 1100;
const TIMEOUT_MS = 8000;

let cache = null;
let lastRequestAt = 0;

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache() {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

/** Cache at ~100m precision: finer than that never changes the neighbourhood-level label. */
function cacheKey(lat, lon) {
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

/**
 * @returns {Promise<string|null>} a short human label, or null if it could not be determined
 */
export async function reverseGeocode(lat, lon, { language = 'zh-CN' } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const store = await loadCache();
  const key = cacheKey(lat, lon);
  if (key in store) return store[key];

  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = new URL(ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('zoom', '14');
  url.searchParams.set('accept-language', language);

  let label = null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) label = labelFrom(await res.json());
  } catch {
    // Offline, rate-limited or timed out: fall through and cache nothing so a later run retries.
    return null;
  }

  store[key] = label;
  await saveCache().catch(() => {});
  return label;
}

function labelFrom(payload) {
  const a = payload?.address;
  if (!a) return payload?.display_name?.split(',').slice(0, 2).join(', ').trim() || null;

  const local = a.suburb || a.city_district || a.district || a.town || a.village || a.neighbourhood;
  const region = a.city || a.county || a.state || a.province;
  const parts = [local, region].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);

  if (parts.length) return parts.join(', ');
  return [a.country].filter(Boolean).join(', ') || null;
}
