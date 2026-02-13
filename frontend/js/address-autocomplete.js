import { getMapboxToken } from './mapbox-token.js';
const RIO_GRANDE_BBOX = [-68.0, -54.15, -67.25, -53.55];
const RIO_GRANDE_CENTER = [-67.7095, -53.787];
const RIO_GRANDE_FALLBACK_STREETS = [
  "Bernardo O'Higgins",
  'Av. San Martin',
  'Av. Belgrano',
  'Av. Perito Moreno',
  'Av. Santa Fe',
  'Thorne',
  'Rivadavia',
  'Piedrabuena',
  'Finocchio',
  'Moyano',
  'Rosales',
  'Elcano',
  'Islas Malvinas',
  'Lasserre',
  'Fagnano'
];

function pointInRioGrandeBBox(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return lng >= RIO_GRANDE_BBOX[0]
    && lng <= RIO_GRANDE_BBOX[2]
    && lat >= RIO_GRANDE_BBOX[1]
    && lat <= RIO_GRANDE_BBOX[3];
}

function splitStreetAndNumber(raw) {
  const txt = (raw || '').trim();
  const m = txt.match(/^(.*?)(?:\s+(\d{1,6}[A-Za-z]?))?$/);
  if (!m) return { streetPart: txt, numberPart: '' };
  return {
    streetPart: (m[1] || '').trim(),
    numberPart: (m[2] || '').trim()
  };
}

function ensureStyles() {
  if (document.getElementById('addr-ac-style')) return;
  const style = document.createElement('style');
  style.id = 'addr-ac-style';
  style.textContent = `
    .addr-ac-wrap { position: relative; width: 100%; }
    .addr-ac-list {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 1000;
      max-height: 240px;
      overflow: auto;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 10px 18px rgba(15, 23, 42, 0.12);
    }
    .addr-ac-item {
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.35;
      cursor: pointer;
      border-bottom: 1px solid #eef2f7;
    }
    .addr-ac-item:last-child { border-bottom: none; }
    .addr-ac-item:hover { background: #f8fafc; }
  `;
  document.head.appendChild(style);
}

async function geocodeExactInRioGrande(address) {
  const token = await getMapboxToken();
  if (!token) return null;
  const query = `${address}, Rio Grande, Tierra del Fuego, Argentina`;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=1&bbox=${RIO_GRANDE_BBOX.join(',')}&country=AR&proximity=${RIO_GRANDE_CENTER[0]},${RIO_GRANDE_CENTER[1]}&types=address,poi`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const features = Array.isArray(data.features) ? data.features : [];
  const f = features.find((x) => pointInRioGrandeBBox(x.center));
  return f || null;
}

export function attachRioGrandeAutocomplete(input, { minChars = 1, limit = 5, onSelect, onInvalidate } = {}) {
  if (!input) return null;
  ensureStyles();

  const wrap = document.createElement('div');
  wrap.className = 'addr-ac-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement('div');
  list.className = 'addr-ac-list hidden';
  wrap.appendChild(list);

  let timer = null;
  let requestId = 0;
  let latestFeatures = [];
  let selected = null;
  const originalPlaceholder = input.placeholder || '';

  function invalidateSelection() {
    selected = null;
    input.dataset.addressSelected = 'false';
    if (typeof onInvalidate === 'function') onInvalidate();
  }

  function setSelected(item) {
    selected = item ? {
      address: item.place_name || '',
      lat: item.center ? Number(item.center[1]) : null,
      lng: item.center ? Number(item.center[0]) : null,
      city: 'Rio Grande'
    } : null;
    input.dataset.addressSelected = selected ? 'true' : 'false';
    if (selected && typeof onSelect === 'function') onSelect(selected);
  }

  async function fetchSuggestions(raw) {
    const q = (raw || '').trim();
    if (q.length < minChars) {
      latestFeatures = [];
      list.innerHTML = '';
      list.classList.add('hidden');
      return;
    }
    requestId += 1;
    const currentReq = requestId;
    latestFeatures = [];

    try {
      const token = await getMapboxToken();
      if (token) {
      const query = `${q}, Rio Grande, Tierra del Fuego, Argentina`;
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=${limit}&bbox=${RIO_GRANDE_BBOX.join(',')}&country=AR&proximity=${RIO_GRANDE_CENTER[0]},${RIO_GRANDE_CENTER[1]}&types=address,poi`;
      const res = await fetch(url);
      if (res.ok && currentReq === requestId) {
        const data = await res.json();
        if (currentReq === requestId) {
          latestFeatures = (Array.isArray(data.features) ? data.features : [])
            .filter((f) => pointInRioGrandeBBox(f.center));
        }
      }
      }
    } catch {
      // fallback below
    }

    const { streetPart, numberPart } = splitStreetAndNumber(q);
    const lowQ = (streetPart || q).toLowerCase();
    const fallbackRows = RIO_GRANDE_FALLBACK_STREETS
      .filter((s) => s.toLowerCase().includes(lowQ))
      .slice(0, limit)
      .map((s) => ({
        place_name: `${s}${numberPart ? ` ${numberPart}` : ''}, Rio Grande, Tierra del Fuego, Argentina`,
        center: null,
        _fallback: true
      }));

    const existing = new Set(latestFeatures.map((f) => (f.place_name || '').toLowerCase()));
    fallbackRows.forEach((f) => {
      const key = (f.place_name || '').toLowerCase();
      if (!existing.has(key)) latestFeatures.push(f);
    });

    list.innerHTML = '';
    latestFeatures.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'addr-ac-item';
      row.textContent = f.place_name || '';
      row.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        let chosen = f;
        if (!chosen.center || !Number.isFinite(Number(chosen.center[0])) || !Number.isFinite(Number(chosen.center[1]))) {
          const resolved = await geocodeExactInRioGrande(chosen.place_name || input.value || '');
          if (resolved) chosen = resolved;
        }
        input.value = chosen.place_name || f.place_name || '';
        setSelected(chosen);
        if (!selected || !Number.isFinite(selected.lat) || !Number.isFinite(selected.lng)) {
          invalidateSelection();
        }
        list.classList.add('hidden');
      });
      list.appendChild(row);
    });

    if (latestFeatures.length) list.classList.remove('hidden');
    else list.classList.add('hidden');
  }

  input.addEventListener('input', () => {
    invalidateSelection();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fetchSuggestions(input.value).catch(() => {
        latestFeatures = [];
        list.innerHTML = '';
        list.classList.add('hidden');
      });
    }, 260);
  });

  input.addEventListener('focus', () => {
    input.placeholder = originalPlaceholder || 'Escribe tu direccion';
    if (latestFeatures.length) list.classList.remove('hidden');
  });

  input.addEventListener('blur', () => {
    setTimeout(() => list.classList.add('hidden'), 120);
  });

  return {
    isSelectionValid() {
      return selected != null
        && !!selected.address
        && Number.isFinite(Number(selected.lat))
        && Number.isFinite(Number(selected.lng));
    },
    getSelected() {
      return selected;
    },
    setSelectedFromStored(value) {
      if (!value || !value.address || !Number.isFinite(Number(value.lat)) || !Number.isFinite(Number(value.lng))) {
        selected = null;
        input.dataset.addressSelected = 'false';
        input.value = value && value.address ? value.address : '';
        return;
      }
      input.value = value.address;
      selected = {
        address: value.address,
        lat: Number(value.lat),
        lng: Number(value.lng),
        city: value.city || 'Rio Grande'
      };
      input.dataset.addressSelected = 'true';
    }
  };
}
