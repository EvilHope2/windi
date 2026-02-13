const BACKEND_BASE_URL = 'https://windi-01ia.onrender.com';

let cached = null;

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
  if (cached !== null) return cached;

  const runtime = readRuntimeToken();
  if (runtime) {
    cached = runtime;
    return cached;
  }

  try {
    const r = await fetch(`${BACKEND_BASE_URL}/public-config`, { cache: 'no-store' });
    const j = await r.json();
    const token = String(j?.mapboxToken || j?.mapboxPublicToken || '').trim();
    cached = token || '';
    return cached;
  } catch (_) {
    cached = '';
    return cached;
  }
}

// Backwards-compat for older imports (avoid touching every callsite at once).
export const MAPBOX_TOKEN = '';
