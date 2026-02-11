import { auth, db } from './firebase.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  ref,
  set,
  push,
  query,
  orderByChild,
  equalTo,
  onValue,
  update
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { generateToken, qs, fmtMoney, fmtTime } from './utils.js';

const TARIFA_BASE = 1800;
const TARIFA_KM = 500;
const COMMISSION_RATE = 0.15;

const authSection = qs('authSection');
const appSection = qs('appSection');
const statusEl = qs('status');
const pedidosList = qs('pedidosList');
const historialList = qs('historialList');
const logoutBtn = qs('logoutBtn');
const mapInfo = qs('mapInfo');
const mapContainer = qs('map');
const cotizacionTexto = qs('cotizacionTexto');

const MAPBOX_TOKEN = 'pk.eyJ1IjoiZGVsaXZlcnktcmcxIiwiYSI6ImNtbDZzdDg1ZDBlaTEzY29ta2k4OWVtZjIifQ.hzW7kFuwLzx2pHtCMDLPXQ';
const FUNCTIONS_BASE = 'https://windi-01ia.onrender.com';

let map = null;
let marker = null;
let routeAdded = false;
let routeCoords = [];
let selectedOrderId = null;
let debounceTimer = null;
let lastKm = null;
let lastPrecio = null;
let lastCommission = null;
let lastPayout = null;

const RIO_GRANDE_BBOX = [-68.0, -54.15, -67.25, -53.55];

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function calcularPrecio(km) {
  const num = Number(km);
  if (Number.isNaN(num) || num < 0) return null;
  return Math.round(TARIFA_BASE + num * TARIFA_KM);
}

function calcularComision(precio) {
  if (precio == null) return null;
  return Math.round(precio * COMMISSION_RATE);
}

function calcularPago(precio, comision) {
  if (precio == null || comision == null) return null;
  return Math.max(0, precio - comision);
}

async function geocode(address) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${MAPBOX_TOKEN}&limit=1&bbox=${RIO_GRANDE_BBOX.join(',')}&country=AR`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo geocodificar la direccion.');
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) throw new Error('Direccion no encontrada en Rio Grande.');
  return feature.center; // [lng, lat]
}

async function routeDistanceKm(origin, destination) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?access_token=${MAPBOX_TOKEN}&overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo calcular la ruta.');
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route) throw new Error('Ruta no encontrada.');
  return route.distance / 1000;
}

function setCotizacion(km, precio, comision, payout) {
  lastKm = km;
  lastPrecio = precio;
  lastCommission = comision;
  lastPayout = payout;
  if (km == null || precio == null) {
    cotizacionTexto.textContent = 'Escribi las direcciones para ver la tarifa.';
    return;
  }
  cotizacionTexto.textContent = `Distancia: ${km} km | Envio: ${fmtMoney(precio)}`;
}

async function cotizar() {
  const origen = qs('origen').value.trim();
  const destino = qs('destino').value.trim();
  if (!origen || !destino) {
    setCotizacion(null, null, null, null);
    return null;
  }

  try {
    setStatus('Calculando distancia...');
    const originCoords = await geocode(origen);
    const destCoords = await geocode(destino);
    const km = await routeDistanceKm(originCoords, destCoords);
    const kmRounded = Math.round(km * 10) / 10;
    const precio = calcularPrecio(kmRounded);
    const comision = calcularComision(precio);
    const payout = calcularPago(precio, comision);

    setCotizacion(kmRounded, precio, comision, payout);
    setStatus('');
    return { km: kmRounded, precio, comision, payout };
  } catch (err) {
    setCotizacion(null, null, null, null);
    setStatus(err.message);
    return null;
  }
}

function scheduleCotizar() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    cotizar();
  }, 700);
}

function initGeocoders() {
  if (!window.MapboxGeocoder) return;
  mapboxgl.accessToken = MAPBOX_TOKEN;

  const baseOptions = {
    accessToken: MAPBOX_TOKEN,
    mapboxgl,
    countries: 'AR',
    bbox: RIO_GRANDE_BBOX,
    placeholder: 'Direccion en Rio Grande',
    marker: false,
    types: 'address,poi'
  };

  const geocoderOrigen = new MapboxGeocoder({ ...baseOptions, placeholder: 'Origen en Rio Grande' });
  const geocoderDestino = new MapboxGeocoder({ ...baseOptions, placeholder: 'Destino en Rio Grande' });

  geocoderOrigen.addTo('#geocoder-origen');
  geocoderDestino.addTo('#geocoder-destino');

  geocoderOrigen.on('result', (e) => {
    qs('origen').value = e.result.place_name;
    scheduleCotizar();
  });
  geocoderDestino.on('result', (e) => {
    qs('destino').value = e.result.place_name;
    scheduleCotizar();
  });

  geocoderOrigen.on('clear', () => {
    qs('origen').value = '';
    setCotizacion(null, null, null, null);
  });
  geocoderDestino.on('clear', () => {
    qs('destino').value = '';
    setCotizacion(null, null, null, null);
  });

  qs('origen').classList.add('hidden');
  qs('destino').classList.add('hidden');
}

async function createShippingPayment(orderId, pagoMetodo) {
  const user = auth.currentUser;
  if (!user) return null;
  const token = await user.getIdToken();
  const res = await fetch(`${FUNCTIONS_BASE}/create-shipping-payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ orderId, pagoMetodo })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'No se pudo crear el pago');
  }
  const data = await res.json();
  return data.init_point;
}

function ensureMap(loc) {
  if (!map || !window.mapboxgl) {
    if (!window.mapboxgl) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: mapContainer,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [loc.lng, loc.lat],
      zoom: 14
    });
    marker = new mapboxgl.Marker({ color: '#0ea5e9' })
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
          'line-color': '#22c55e',
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

function resetMap() {
  routeCoords = [];
  routeAdded = false;
  if (map) {
    map.remove();
    map = null;
    marker = null;
  }
}

qs('origen').addEventListener('input', scheduleCotizar);
qs('destino').addEventListener('input', scheduleCotizar);

qs('loginBtn').addEventListener('click', async () => {
  const email = qs('loginEmail').value.trim();
  const password = qs('loginPassword').value.trim();
  if (!email || !password) return setStatus('Completa email y contrasena.');
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setStatus(err.message);
  }
});

qs('signupBtn').addEventListener('click', async () => {
  const email = qs('signupEmail').value.trim();
  const password = qs('signupPassword').value.trim();
  const acceptedTerms = qs('signupTermsComercio').checked;
  if (!email || !password) return setStatus('Completa email y contrasena.');
  if (!acceptedTerms) return setStatus('Debes aceptar los Terminos y Condiciones para registrarte.');
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await set(ref(db, `users/${cred.user.uid}`), {
      email,
      role: 'comercio'
    });
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
});

qs('pedidoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const origen = qs('origen').value.trim();
  const destino = qs('destino').value.trim();
  const totalPedido = Number(qs('totalPedido').value);
  const estado = qs('estado').value;
  const notas = qs('notas').value.trim();
  const pagoMetodo = qs('pagoMetodo').value;
  const shouldOpenPayment = pagoMetodo === 'comercio_paga_envio' || pagoMetodo === 'comercio_mp_transfer';
  const paymentWindow = shouldOpenPayment ? window.open('about:blank', '_blank') : null;
  if (paymentWindow && !paymentWindow.closed) {
    paymentWindow.document.body.innerHTML = '<p style="font-family:sans-serif;padding:16px;">Generando enlace de pago...</p>';
  }

  if (!origen || !destino || Number.isNaN(totalPedido) || totalPedido <= 0) {
    return setStatus('Completa origen, destino y total del pedido.');
  }

  let km = lastKm;
  let precio = lastPrecio;
  let comision = lastCommission;
  let payout = lastPayout;

  if (km == null || precio == null || comision == null || payout == null) {
    const result = await cotizar();
    if (!result) return;
    km = result.km;
    precio = result.precio;
    comision = result.comision;
    payout = result.payout;
  }

  if (km == null || precio == null || comision == null || payout == null) {
    return setStatus('No se pudo calcular la tarifa.');
  }

  const token = generateToken();
  const orderRef = push(ref(db, 'orders'));
  const orderId = orderRef.key;
  const now = Date.now();

  const orderData = {
    origen,
    destino,
    km,
    precio,
    comision,
    payout,
    comisionRate: COMMISSION_RATE,
    totalPedido,
    pagoMetodo,
    estado,
    notas,
    comercioId: auth.currentUser.uid,
    createdAt: now,
    updatedAt: now,
    trackingToken: token
  };

  try {
    await set(orderRef, orderData);
    await set(ref(db, `publicTracking/${token}`), {
      orderId,
      origen,
      destino,
      km,
      precio,
      comision,
      payout,
      comisionRate: COMMISSION_RATE,
      totalPedido,
      pagoMetodo,
      estado,
      notas,
      updatedAt: now,
      ubicacion: null
    });

    if (shouldOpenPayment) {
      const initPoint = await createShippingPayment(orderId, pagoMetodo);
      await update(ref(db, `orders/${orderId}`), { mpInitPoint: initPoint, mpStatus: 'pending' });
      setStatus('Pedido creado. Abrir pago del envio.');
      if (paymentWindow) {
        paymentWindow.location.replace(initPoint);
      } else {
        const opened = window.open(initPoint, '_blank');
        if (!opened) window.location.href = initPoint;
      }
    } else {
      setStatus('Pedido creado.');
    }

    e.target.reset();
    setCotizacion(null, null, null, null);
  } catch (err) {
    if (paymentWindow && !paymentWindow.closed) {
      paymentWindow.document.body.innerHTML = `<p style="font-family:sans-serif;padding:16px;">No se pudo abrir Mercado Pago.<br>${err.message || 'Error'}</p>`;
    }
    setStatus(err.message);
  }
});

async function cancelarPedido(id, token) {
  const now = Date.now();
  try {
    await update(ref(db, `orders/${id}`), {
      estado: 'cancelado',
      canceledAt: now,
      updatedAt: now
    });
    await update(ref(db, `publicTracking/${token}`), {
      estado: 'cancelado',
      updatedAt: now
    });
    setStatus('Pedido cancelado.');
  } catch (err) {
    setStatus(err.message);
  }
}

function selectOrderForMap(order) {
  selectedOrderId = order ? order.id : null;
  resetMap();
  if (!order || !order.ubicacion) {
    mapInfo.textContent = 'Esperando ubicacion del repartidor...';
    return;
  }
  mapInfo.textContent = `${order.origen} -> ${order.destino}`;
  ensureMap(order.ubicacion);
  updateRoute(order.ubicacion);
}

function renderPedidos(data) {
  pedidosList.innerHTML = '';
  historialList.innerHTML = '';
  if (!data) {
    pedidosList.innerHTML = '<div class="muted">No hay pedidos.</div>';
    historialList.innerHTML = '<div class="muted">Sin historial.</div>';
    selectOrderForMap(null);
    return;
  }

  const entries = Object.entries(data).reverse();
  let activeCount = 0;
  let historyCount = 0;
  let firstActive = null;

  entries.forEach(([id, p]) => {
    const isClosed = p.estado === 'entregado' || p.estado === 'cancelado';
    const div = document.createElement('div');
    div.className = 'item';
    const trackingUrl = `${location.origin}/tracking.html?t=${encodeURIComponent(p.trackingToken)}`;
    const closedTime = p.entregadoAt || p.canceledAt;
    const pagoLabel = p.pagoMetodo === 'cash_delivery'
      ? 'Efectivo al delivery'
      : p.pagoMetodo === 'comercio_mp_transfer'
        ? 'Comercio paga por transferencia MP'
        : 'Comercio paga envio';
    const mpLink = p.mpInitPoint ? `<a href="${p.mpInitPoint}" target="_blank">Pagar envio</a>` : '';

    div.innerHTML = `
      <div class="row">
        <strong>${p.origen} -> ${p.destino}</strong>
        <span class="status ${p.estado}">${p.estado}</span>
      </div>
      <div class="muted">Km: ${p.km ?? '-'} | Envio: ${fmtMoney(p.precio)} | Total pedido: ${fmtMoney(p.totalPedido)}</div>
      <div class="muted">Pago: ${pagoLabel} ${mpLink}</div>
      <div class="muted">Notas: ${p.notas || '-'}</div>
      <div class="muted">Tracking: <a href="${trackingUrl}">${trackingUrl}</a></div>
      ${isClosed ? `<div class="muted">Cerrado: ${fmtTime(closedTime)}</div>` : ''}
      ${!isClosed ? `<div class="row"><button data-action="cancelar" class="danger">Cancelar</button></div>` : ''}
    `;

    if (!isClosed) {
      div.querySelector('button[data-action="cancelar"]').addEventListener('click', () => cancelarPedido(id, p.trackingToken));
      pedidosList.appendChild(div);
      activeCount += 1;
      if (!firstActive) {
        firstActive = { ...p, id };
      }
    } else {
      historialList.appendChild(div);
      historyCount += 1;
    }

    if (selectedOrderId && selectedOrderId === id) {
      if (p.ubicacion) {
        ensureMap(p.ubicacion);
        updateRoute(p.ubicacion);
      }
    }
  });

  if (activeCount === 0) {
    pedidosList.innerHTML = '<div class="muted">No hay pedidos activos.</div>';
  }
  if (historyCount === 0) {
    historialList.innerHTML = '<div class="muted">Sin historial.</div>';
  }

  if (!selectedOrderId && firstActive) {
    selectOrderForMap(firstActive);
  }

  if (selectedOrderId && !entries.find(([id]) => id === selectedOrderId)) {
    selectOrderForMap(firstActive);
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    setStatus('');
    return;
  }

  const userRef = ref(db, `users/${user.uid}`);
  onValue(userRef, (snap) => {
    const u = snap.val();
    if (!u) {
      setStatus('Creando perfil de comercio...');
      set(userRef, { email: user.email || '', role: 'comercio' });
      return;
    }
    if (u.role !== 'comercio') {
      setStatus('Tu usuario no tiene rol de comercio.');
      signOut(auth);
      return;
    }

    authSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    setStatus('');

    initGeocoders();

    const q = query(ref(db, 'orders'), orderByChild('comercioId'), equalTo(user.uid));
    onValue(q, (ordersSnap) => renderPedidos(ordersSnap.val()));
  });
});
