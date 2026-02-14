import { getMapboxToken } from './mapbox-token.js';

// Slightly wider bbox than before to avoid rejecting valid addresses near the edges.
// NOTE: We still validate that the result belongs to Rio Grande via Mapbox context.
const RIO_GRANDE_BBOX = [-68.2, -54.05, -67.35, -53.6];
const RIO_GRANDE_CENTER = [-67.7095, -53.787];

const RIO_GRANDE_FALLBACK_STREETS = [
  "Bernardo O'Higgins",
  'Av. San Martin',
  'Av. Belgrano',
  'Av. Perito Moreno',
  'Av. Santa Fe',
  'Shelknam',
  'Selknam',
  'Oroski',
  'Orosky',
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

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function featureIsRioGrande(feature) {
  const place = norm(feature?.place_name);
  if (place.includes('rio grande')) return true;
  const ctx = Array.isArray(feature?.context) ? feature.context : [];
  return ctx.some((c) => {
    const txt = norm(c?.text);
    if (!txt) return false;
    // Mapbox context can include place/locality.
    return txt === 'rio grande' || txt.includes('rio grande');
  });
}

function pointInBBox(coords, bbox) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
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

function buildTypedAddressLabel({ streetText, numberPart }) {
  const street = String(streetText || '').trim();
  const num = String(numberPart || '').trim();
  if (!street) return '';
  const withNum = num ? `${street} ${num}` : street;
  return `${withNum}, Rio Grande, Tierra del Fuego, Argentina`;
}

function ensureStyles() {
  if (document.getElementById('addr-ac-style')) return;
  const style = document.createElement('style');
  style.id = 'addr-ac-style';
  style.textContent = `
    .addr-ac-wrap { position: relative; width: 100%; }
    .addr-ac-list {
      position: relative;
      margin-top: 8px;
      z-index: 1;
      max-height: 260px;
      overflow: auto;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 16px 28px rgba(15, 23, 42, 0.14);
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
    .addr-ac-item strong { font-weight: 800; }
    .addr-ac-sub { display:block; margin-top:2px; color:#64748b; font-size:12px; }
    .addr-ac-empty { padding: 10px 12px; color:#64748b; font-size:13px; }
  `;
  document.head.appendChild(style);
}

async function mapboxGeocode(query, { limit = 8 } = {}) {
  const token = await getMapboxToken();
  if (!token) return [];
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}`
    + `&autocomplete=true&limit=${limit}`
    + `&bbox=${RIO_GRANDE_BBOX.join(',')}`
    + `&country=AR`
    + `&proximity=${RIO_GRANDE_CENTER[0]},${RIO_GRANDE_CENTER[1]}`
    + `&types=address`
    + `&language=es`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const features = Array.isArray(data.features) ? data.features : [];
  return features;
}

async function mapboxGeocodeStreet(query, { limit = 8 } = {}) {
  const token = await getMapboxToken();
  if (!token) return [];
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}`
    + `&autocomplete=true&limit=${limit}`
    + `&bbox=${RIO_GRANDE_BBOX.join(',')}`
    + `&country=AR`
    + `&proximity=${RIO_GRANDE_CENTER[0]},${RIO_GRANDE_CENTER[1]}`
    + `&types=street`
    + `&language=es`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const features = Array.isArray(data.features) ? data.features : [];
  return features;
}

async function geocodeStreetInRioGrande(streetText) {
  const q = String(streetText || '').trim();
  if (!q) return null;
  const features = await mapboxGeocodeStreet(`${q}, Rio Grande, Tierra del Fuego, Argentina`, { limit: 5 });
  const f = features.find((x) => featureIsRioGrande(x) && pointInBBox(x.center, RIO_GRANDE_BBOX));
  return f || null;
}

async function geocodeExactInRioGrande(address) {
  const q = String(address || '').trim();
  if (!q) return null;
  const features = await mapboxGeocode(q, { limit: 5 });
  const f = features.find((x) => featureIsRioGrande(x) && pointInBBox(x.center, RIO_GRANDE_BBOX));
  return f || null;
}

export function attachRioGrandeAutocomplete(input, { minChars = 2, limit = 8, onSelect, onInvalidate } = {}) {
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

  function commitSelection(item, { overrideAddress } = {}) {
    const typed = String(input.value || '').trim();
    const typedHasNumber = /\d{1,6}/.test(typed);
    const missingHouseNumber = typedHasNumber && !item?.address; // Mapbox 'address' field indicates house number
    const addressText = String(overrideAddress || item?.place_name || '').trim();

    selected = item ? {
      address: addressText,
      lat: item.center ? Number(item.center[1]) : null,
      lng: item.center ? Number(item.center[0]) : null,
      city: 'Rio Grande',
      // When Mapbox doesn't provide an address point for the height, we still allow selecting the street.
      // Caller should suggest adjusting the pin on the map for precision.
      approximate: missingHouseNumber === true
    } : null;
    input.dataset.addressSelected = selected ? 'true' : 'false';
    if (selected && typeof onSelect === 'function') onSelect(selected);
  }

  function hideListSoon() {
    setTimeout(() => list.classList.add('hidden'), 120);
  }

  function renderList(features) {
    const typed = String(input.value || '').trim();
    const { numberPart } = splitStreetAndNumber(typed);
    const typedHasNumber = /\d{1,6}/.test(typed);

    list.innerHTML = '';
    if (!features.length) {
      const empty = document.createElement('div');
      empty.className = 'addr-ac-empty';
      empty.textContent = 'Sin sugerencias. Escribe calle y altura (solo Rio Grande).';
      list.appendChild(empty);
      list.classList.remove('hidden');
      return;
    }
    features.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'addr-ac-item';

      const isStreetLike = !f?.address && typedHasNumber;
      const primaryText = (f.text || f.place_name || '').toString();
      const displayPrimary = isStreetLike && numberPart ? `${primaryText} ${numberPart}` : primaryText;
      const overrideAddress = isStreetLike ? buildTypedAddressLabel({ streetText: primaryText, numberPart }) : '';

      const main = document.createElement('div');
      main.innerHTML = `<strong>${displayPrimary}</strong>`;
      const sub = document.createElement('span');
      sub.className = 'addr-ac-sub';
      sub.textContent = (f.place_name || '').toString();
      main.appendChild(sub);
      row.appendChild(main);

      row.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        let chosen = f;
        if (!chosen.center || !Number.isFinite(Number(chosen.center[0])) || !Number.isFinite(Number(chosen.center[1]))) {
          const typedRaw = overrideAddress || chosen.place_name || input.value || '';
          const resolved = await geocodeExactInRioGrande(typedRaw);
          if (resolved) {
            chosen = resolved;
          } else {
            const { streetPart } = splitStreetAndNumber(typedRaw);
            const resolvedStreet = await geocodeStreetInRioGrande(streetPart || typedRaw);
            if (resolvedStreet) chosen = resolvedStreet;
          }
        }
        if (!featureIsRioGrande(chosen)) {
          invalidateSelection();
          setTimeout(() => { input.focus(); }, 0);
          return;
        }
        const finalAddressText = overrideAddress || chosen.place_name || f.place_name || '';
        input.value = finalAddressText;
        commitSelection(chosen, { overrideAddress: finalAddressText });
        if (!selected || !Number.isFinite(selected.lat) || !Number.isFinite(selected.lng)) {
          invalidateSelection();
        }
        list.classList.add('hidden');
      });
      list.appendChild(row);
    });

    if (features.length) list.classList.remove('hidden');
    else list.classList.add('hidden');
  }

  async function fetchSuggestions(raw) {
    const q = (raw || '').trim();
    if (q.length < minChars) {
      latestFeatures = [];
      renderList([]);
      return;
    }

    requestId += 1;
    const currentReq = requestId;
    latestFeatures = [];

    try {
      // If the user types just a street and number, keeping the raw input improves "altura" results.
      const baseQuery = q;
      const typedHasNumber = /\d{1,6}/.test(baseQuery);
      const addrFeatures = await mapboxGeocode(baseQuery, { limit });
      const addrFiltered = addrFeatures
        .filter((f) => featureIsRioGrande(f))
        .filter((f) => pointInBBox(f.center, RIO_GRANDE_BBOX));

      // If we typed an altura but got no address points, fall back to street results
      // so the user can still select and then adjust the pin (in mi-cuenta).
      let streetFiltered = [];
      const hasAddressPoint = addrFiltered.some((f) => !!f.address);
      if (typedHasNumber && !hasAddressPoint) {
        const streetFeatures = await mapboxGeocodeStreet(baseQuery, { limit });
        streetFiltered = streetFeatures
          .filter((f) => featureIsRioGrande(f))
          .filter((f) => pointInBBox(f.center, RIO_GRANDE_BBOX));
      }

      if (currentReq === requestId) {
        // Put true address points first.
        latestFeatures = [...addrFiltered, ...streetFiltered];
      }
    } catch {
      // fallback below
    }

    // Fallback for common streets to keep UX responsive even if Mapbox is slow.
    const { streetPart, numberPart } = splitStreetAndNumber(q);
    const lowQ = norm(streetPart || q);
    const fallbackRows = RIO_GRANDE_FALLBACK_STREETS
      .filter((s) => norm(s).includes(lowQ))
      .slice(0, limit)
      .map((s) => ({
        text: s,
        place_name: `${s}${numberPart ? ` ${numberPart}` : ''}, Rio Grande, Tierra del Fuego, Argentina`,
        center: null,
        _fallback: true
      }));

    const existing = new Set(latestFeatures.map((f) => norm(f.place_name || '')));
    fallbackRows.forEach((f) => {
      const key = norm(f.place_name || '');
      if (!existing.has(key)) latestFeatures.push(f);
    });

    renderList(latestFeatures);
  }

  async function attemptAutoResolve() {
    if (selected) return;
    const q = (input.value || '').trim();
    if (q.length < minChars) return;
    // Best-effort: if user typed the full address with number, resolve it on blur.
    const resolved = await geocodeExactInRioGrande(`${q}, Rio Grande, Tierra del Fuego, Argentina`);
    if (!resolved) return;
    input.value = resolved.place_name || q;
    commitSelection(resolved);
  }

  input.addEventListener('input', () => {
    // If the user edits the input after selecting, we force them to select again.
    if (selected && norm(input.value) !== norm(selected.address)) invalidateSelection();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fetchSuggestions(input.value).catch(() => {
        latestFeatures = [];
        renderList([]);
      });
    }, 240);
  });

  input.addEventListener('focus', () => {
    input.placeholder = originalPlaceholder || 'Escribe tu direccion';
    if (latestFeatures.length) list.classList.remove('hidden');
  });

  input.addEventListener('blur', () => {
    attemptAutoResolve().catch(() => {});
    hideListSoon();
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) list.classList.add('hidden');
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
