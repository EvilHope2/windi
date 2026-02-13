import { db } from './firebase.js';
import { ref, onValue } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, fmtTime } from './utils.js';
import { getMapboxToken } from './mapbox-token.js';

const trackingInfo = qs('trackingInfo');
const mapLink = qs('mapLink');
const statusEl = qs('status');
const mapContainer = qs('map');

const params = new URLSearchParams(window.location.search);
const token = params.get('t');

let map = null;
let marker = null;
let routeAdded = false;
let routeCoords = [];

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

async function ensureMap(loc) {
  if (!map || !window.mapboxgl) {
    if (!window.mapboxgl) return;
    const token = await getMapboxToken();
    if (!token) return;
    mapboxgl.accessToken = token;
    map = new mapboxgl.Map({
      container: mapContainer,
      style: 'mapbox://styles/mapbox/navigation-day-v1',
      center: [loc.lng, loc.lat],
      zoom: 14
    });
    marker = new mapboxgl.Marker({ color: '#22c55e' })
      .setLngLat([loc.lng, loc.lat])
      .addTo(map);

    map.on('load', () => {
      map.addSource('tracking-route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [[loc.lng, loc.lat]]
          }
        }
      });
      map.addLayer({
        id: 'tracking-route',
        type: 'line',
        source: 'tracking-route',
        paint: {
          'line-color': '#0ea5e9',
          'line-width': 4
        }
      });
      routeAdded = true;
    });
    return;
  }

  marker.setLngLat([loc.lng, loc.lat]);
  map.easeTo({ center: [loc.lng, loc.lat], duration: 500 });
}

function updateRoute(loc) {
  routeCoords.push([loc.lng, loc.lat]);
  if (routeCoords.length > 200) routeCoords.shift();
  if (!routeAdded || !map) return;
  const source = map.getSource('tracking-route');
  if (!source) return;
  source.setData({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: routeCoords
    }
  });
}

if (!token) {
  trackingInfo.textContent = 'Falta el token de seguimiento.';
} else {
  const trackRef = ref(db, `publicTracking/${token}`);
  onValue(trackRef, (snap) => {
    const data = snap.val();
    if (!data) {
      trackingInfo.textContent = 'Token invalido o pedido no encontrado.';
      mapLink.textContent = '';
      return;
    }

    const loc = data.ubicacion;
    trackingInfo.innerHTML = `
      <div><strong>${data.origen} -> ${data.destino}</strong></div>
      <div class="muted">Estado: ${data.estado}</div>
      <div class="muted">Precio: ${fmtMoney(data.precio)}</div>
      <div class="muted">Actualizado: ${fmtTime(data.updatedAt)}</div>
      <div class="muted">Notas: ${data.notas || '-'}</div>
      <div class="muted">Ubicacion: ${loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : 'Sin datos'}</div>
    `;

    if (loc) {
      ensureMap(loc).catch(() => {});
      updateRoute(loc);
      const url = `https://www.mapbox.com/maps/#map=15/${loc.lat}/${loc.lng}`;
      mapLink.innerHTML = `<a href="${url}" target="_blank" rel="noreferrer">Abrir en Mapbox</a>`;
    } else {
      mapLink.textContent = '';
    }
  }, (err) => setStatus(err.message));
}
