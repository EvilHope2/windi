const BACKEND_BASE_URL = 'https://windi-01ia.onrender.com';

let cachedToken = null;
let cachedAt = 0;
const EMPTY_TTL_MS = 15_000; // retry soon if backend was missing token
const TOKEN_TTL_MS = 24 * 60 * 60_000;

function readRuntimeToken() {
  try {
    const w = typeof window !== 'undefined' ? window : null;
    const fromWindow = w && (w.__WINDI_MAPBOX_TOKEN__ || w.MAPBOX_TOKEN);
    if (fromWindow) return String(fromWindow).trim();
  } catch (_) {}

  try {
    if (typeof localStorage !== 'undefined') {
      const fromLs = localStorage.getItem('WINDI_MAPBOX_TOKEN');
      if (fromLs) return String(fromLs).trim();
    }
  } catch (_) {}

  return '';
}

export async function getMapboxToken() {
  const now = Date.now();
  if (cachedToken !== null) {
    const ttl = cachedToken ? TOKEN_TTL_MS : EMPTY_TTL_MS;
    if (now - cachedAt < ttl) return cachedToken;
    // expired, refetch
  }

  const runtime = readRuntimeToken();
  if (runtime) {
    cachedToken = runtime;
    cachedAt = now;
    return cachedToken;
  }

  try {
    const r = await fetch(`${BACKEND_BASE_URL}/public-config`, { cache: 'no-store' });
    const j = await r.json();
    const token = String(j?.mapboxToken || j?.mapboxPublicToken || '').trim();
    cachedToken = token || '';
    cachedAt = now;
    return cachedToken;
  } catch (_) {
    cachedToken = '';
    cachedAt = now;
    return cachedToken;
  }
}

// Backwards-compat for older imports (avoid touching every callsite at once).
export const MAPBOX_TOKEN = '';
