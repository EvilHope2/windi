import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, get, update } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs } from './utils.js';
import { attachRioGrandeAutocomplete } from './address-autocomplete.js';
import { getMapboxToken } from './mapbox-token.js';

const RIO_GRANDE_BBOX = [-68.0, -54.15, -67.25, -53.55];
const RIO_GRANDE_CENTER = [-67.7095, -53.787];
const statusEl = qs('status');
const form = qs('addressForm');
const addressInput = qs('address');
const referenceInput = qs('reference');
const mapContainer = qs('addressMap');

let currentUser = null;
let addressAutocomplete = null;
let map = null;
let marker = null;
let selectedCoords = null;

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

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

async function ensureMap() {
  if (map) return;
  if (!window.mapboxgl) throw new Error('Mapbox no esta disponible.');
  const token = await getMapboxToken();
  if (!token) throw new Error('Mapbox no configurado.');
  mapboxgl.accessToken = token;

  map = new mapboxgl.Map({
    container: mapContainer,
    style: 'mapbox://styles/mapbox/navigation-day-v1',
    center: RIO_GRANDE_CENTER,
    zoom: 12.5,
    maxBounds: RIO_GRANDE_BBOX
  });

  marker = new mapboxgl.Marker({ draggable: true, color: '#dc2626' })
    .setLngLat(RIO_GRANDE_CENTER)
    .addTo(map);

  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    const coords = [Number(lngLat.lng), Number(lngLat.lat)];
    if (!pointInRioGrandeBBox(coords)) {
      setStatus('Solo disponible en Rio Grande.');
      marker.setLngLat(selectedCoords || RIO_GRANDE_CENTER);
      return;
    }
    selectedCoords = coords;
    setStatus('');
  });
}

async function setMapPoint(coords) {
  await ensureMap();
  if (!pointInRioGrandeBBox(coords)) {
    setStatus('Solo disponible en Rio Grande.');
    return false;
  }
  selectedCoords = [Number(coords[0]), Number(coords[1])];
  marker.setLngLat(selectedCoords);
  map.easeTo({ center: selectedCoords, zoom: 15, duration: 500 });
  setStatus('');
  return true;
}

async function loadProfile(user) {
  const userRef = ref(db, `users/${user.uid}`);
  const snap = await get(userRef);
  const userData = snap.val() || {};
  if (userData.role && userData.role !== 'customer') {
    throw new Error('Tu cuenta no tiene rol cliente.');
  }

  referenceInput.value = userData.reference || '';
  const lat = userData.geo && Number.isFinite(Number(userData.geo.lat)) ? Number(userData.geo.lat) : null;
  const lng = userData.geo && Number.isFinite(Number(userData.geo.lng)) ? Number(userData.geo.lng) : null;
  const storedAddress = userData.address || '';

  if (!addressAutocomplete) return;
  addressAutocomplete.setSelectedFromStored({
    address: storedAddress,
    lat,
    lng,
    city: 'Rio Grande'
  });

  if (lat != null && lng != null) {
    await setMapPoint([lng, lat]);
  } else {
    await ensureMap();
    selectedCoords = null;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return setStatus('Debes iniciar sesion.');
  if (!addressAutocomplete || !addressAutocomplete.isSelectionValid()) {
    return setStatus('Selecciona una direccion de la lista para continuar.');
  }
  if (!selectedCoords || !pointInRioGrandeBBox(selectedCoords)) {
    return setStatus('Ajusta el marcador dentro de Rio Grande para continuar.');
  }

  try {
    const selected = addressAutocomplete.getSelected();
    const address = selected.address;
    const now = Date.now();

    await update(ref(db, `users/${currentUser.uid}`), {
      email: currentUser.email || '',
      role: 'customer',
      address,
      reference: referenceInput.value.trim() || null,
      geo: {
        lng: Number(selectedCoords[0]),
        lat: Number(selectedCoords[1])
      },
      city: 'Rio Grande',
      updatedAt: now
    });
    setStatus('Direccion guardada correctamente.');
  } catch (err) {
    setStatus(err.message);
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = '/marketplace-auth';
    return;
  }
  currentUser = user;
  try {
    await ensureMap();
    if (!addressAutocomplete) {
      addressAutocomplete = attachRioGrandeAutocomplete(addressInput, {
        onSelect: async (selected) => {
          if (selected && selected.lng != null && selected.lat != null) {
            await setMapPoint([Number(selected.lng), Number(selected.lat)]);
          } else {
            selectedCoords = null;
          }
        },
        onInvalidate: () => {
          selectedCoords = null;
          setStatus('Selecciona una direccion de la lista para continuar.');
        }
      });
    }
    await loadProfile(user);
    setStatus('');
  } catch (err) {
    setStatus(err.message);
  }
});
