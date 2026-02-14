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
  update,
  get
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { generateToken, qs, fmtMoney, fmtTime } from './utils.js';
import { attachRioGrandeAutocomplete } from './address-autocomplete.js';
import { getMapboxToken } from './mapbox-token.js';

const TARIFA_BASE = 1800;
const TARIFA_KM = 500;
const COMMISSION_RATE = 0.15;

const authSection = qs('authSection');
const appSection = qs('appSection');
const pendingSection = qs('pendingSection');
const pendingMessage = qs('pendingMessage');
const statusEl = qs('status');
const appShell = qs('appShell');
const sidebar = qs('sidebar');
const pedidosList = qs('pedidosList');
const historialList = qs('historialList');
const logoutBtn = qs('logoutBtn');
const mapInfo = qs('mapInfo');
const mapContainer = qs('map');
const cotizacionTexto = qs('cotizacionTexto');
const signupNombreApellido = qs('signupNombreApellido');
const signupWhatsapp = qs('signupWhatsapp');
const signupComercioNombre = qs('signupComercioNombre');
const signupCategoria = qs('signupCategoria');
const signupDireccion = qs('signupDireccion');
const signupLat = qs('signupLat');
const signupLng = qs('signupLng');
const signupHorario = qs('signupHorario');
const signupPrepTime = qs('signupPrepTime');
const storeOpenBadge = qs('storeOpenBadge');
const storeOpenModeText = qs('storeOpenModeText');
const storeModeAutoBtn = qs('storeModeAutoBtn');
const storeOpenNowBtn = qs('storeOpenNowBtn');
const storeCloseNowBtn = qs('storeCloseNowBtn');

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
let geocodersInitialized = false;
let signupAddressAc = null;
let originAddressAc = null;
let destinationAddressAc = null;
let merchantProfile = null;

// Keep consistent with the address autocomplete bbox to avoid rejecting valid selections.
const RIO_GRANDE_BBOX = [-68.2, -54.05, -67.35, -53.6];
const RIO_GRANDE_CENTER = [-67.7095, -53.787];
const RIO_GRANDE_RADIUS_KM = 45;

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

function distanceKm(a, b) {
  const toRad = (v) => (Number(v) * Math.PI) / 180;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLng = toRad(b[0] - a[0]);
  const c = 2 * Math.atan2(
    Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2),
    Math.sqrt(1 - (Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2))
  );
  return 6371 * c;
}

function isWithinRioGrandeZone(coords) {
  if (pointInRioGrandeBBox(coords)) return true;
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const d = distanceKm(coords, RIO_GRANDE_CENTER);
  return Number.isFinite(d) && d <= RIO_GRANDE_RADIUS_KM;
}

function isComercioRole(role) {
  const normalized = (role || '').toString().toLowerCase();
  return normalized === 'comercio' || normalized === 'merchant';
}

function isActiveStatus(status) {
  const normalized = (status || '').toString().toLowerCase();
  return normalized === 'activo' || normalized === 'active';
}

function parseScheduleRange(scheduleText) {
  if (!scheduleText) return null;
  const text = String(scheduleText).toLowerCase();
  const match = text.match(/(\d{1,2})[:.](\d{2})\s*(?:a|-|hasta)\s*(\d{1,2})[:.](\d{2})/i);
  if (!match) return null;
  const openH = Number(match[1]);
  const openM = Number(match[2]);
  const closeH = Number(match[3]);
  const closeM = Number(match[4]);
  if (![openH, openM, closeH, closeM].every(Number.isFinite)) return null;
  if (openH < 0 || openH > 23 || closeH < 0 || closeH > 23 || openM < 0 || openM > 59 || closeM < 0 || closeM > 59) return null;
  return {
    openMin: openH * 60 + openM,
    closeMin: closeH * 60 + closeM
  };
}

function isOpenBySchedule(scheduleText) {
  const range = parseScheduleRange(scheduleText);
  if (!range) return true;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (range.closeMin >= range.openMin) {
    return nowMin >= range.openMin && nowMin < range.closeMin;
  }
  return nowMin >= range.openMin || nowMin < range.closeMin;
}

function computeMerchantOpenState(merchant) {
  const mode = (merchant?.openingMode || '').toLowerCase();
  if (mode === 'manual') {
    return {
      isOpen: merchant?.manualOpen !== false,
      mode: 'manual'
    };
  }
  if (typeof merchant?.isOpen === 'boolean') {
    return {
      isOpen: merchant.isOpen,
      mode: 'manual'
    };
  }
  return {
    isOpen: isOpenBySchedule(merchant?.schedule || merchant?.horario || ''),
    mode: 'auto'
  };
}

function renderStoreOpenControls() {
  if (!storeOpenBadge || !storeOpenModeText || !merchantProfile) return;
  const openState = computeMerchantOpenState(merchantProfile);
  const schedule = merchantProfile.schedule || merchantProfile.horario || 'Sin horario configurado';

  storeOpenBadge.className = `status ${openState.isOpen ? 'active' : 'cancelado'}`;
  storeOpenBadge.textContent = openState.isOpen ? 'Abierto' : 'Cerrado';
  storeOpenModeText.textContent = openState.mode === 'manual'
    ? 'Modo manual activado por comercio.'
    : `Modo automatico por horario: ${schedule}`;
}

async function setStoreOpeningMode(mode, manualOpen) {
  const user = auth.currentUser;
  if (!user) return;
  const payload = {
    openingMode: mode,
    updatedAt: Date.now()
  };
  if (mode === 'manual') payload.manualOpen = manualOpen === true;
  if (mode === 'auto') payload.manualOpen = null;
  await update(ref(db, `merchants/${user.uid}`), payload);
}

function setAuthLayout(isAuthView) {
  document.body.classList.toggle('auth-layout', isAuthView);
  if (appShell) appShell.classList.toggle('auth-only', isAuthView);
  if (sidebar) sidebar.classList.toggle('hidden', isAuthView);
}

function showPendingState(msg) {
  authSection.classList.add('hidden');
  appSection.classList.add('hidden');
  pendingSection.classList.remove('hidden');
  setAuthLayout(true);
  pendingMessage.textContent = msg;
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
  const token = await getMapboxToken();
  if (!token) throw new Error('Mapbox no configurado.');
  const query = `${address}, Rio Grande, Tierra del Fuego, Argentina`;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=5&bbox=${RIO_GRANDE_BBOX.join(',')}&country=AR&proximity=${RIO_GRANDE_CENTER[0]},${RIO_GRANDE_CENTER[1]}&types=address,poi`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo geocodificar la direccion.');
  const data = await res.json();
  const features = Array.isArray(data.features) ? data.features : [];
  const feature = features.find((f) => isWithinRioGrandeZone(f.center));
  if (!feature) throw new Error('Direccion fuera de Rio Grande, Tierra del Fuego.');
  return feature.center; // [lng, lat]
}

async function routeDistanceKm(origin, destination) {
  const token = await getMapboxToken();
  if (!token) throw new Error('Mapbox no configurado.');
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?access_token=${token}&overview=false`;
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
  const origenSel = originAddressAc ? originAddressAc.getSelected() : null;
  const destinoSel = destinationAddressAc ? destinationAddressAc.getSelected() : null;
  if (!origenSel || !destinoSel) {
    setCotizacion(null, null, null, null);
    return null;
  }

  try {
    setStatus('Calculando distancia...');
    const originCoords = [Number(origenSel.lng), Number(origenSel.lat)];
    const destCoords = [Number(destinoSel.lng), Number(destinoSel.lat)];
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
  geocodersInitialized = true;
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
  return data.checkout_url || data.sandbox_init_point || data.init_point;
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
  const nombreApellido = signupNombreApellido.value.trim();
  const email = qs('signupEmail').value.trim();
  const whatsapp = signupWhatsapp.value.trim();
  const password = qs('signupPassword').value.trim();
  const comercioNombre = signupComercioNombre.value.trim();
  const categoria = signupCategoria.value;
  const direccion = signupDireccion.value.trim();
  let lat = Number(signupLat.value);
  let lng = Number(signupLng.value);
  const horario = signupHorario.value.trim();
  const prepTimeMin = Number(signupPrepTime.value || 0);
  const acceptedTerms = qs('signupTermsComercio').checked;
  if (!nombreApellido || !email || !whatsapp || !password || !comercioNombre || !categoria || !direccion) {
    return setStatus('Completa todos los datos obligatorios del registro.');
  }
  if (password.length < 6) return setStatus('La contrasena debe tener al menos 6 caracteres.');
  const selectedAddress = signupAddressAc ? signupAddressAc.getSelected() : null;
  if (!signupAddressAc || !signupAddressAc.isSelectionValid() || !selectedAddress) {
    return setStatus('Selecciona una direccion del comercio desde la lista para continuar.');
  }
  lng = Number(selectedAddress.lng);
  lat = Number(selectedAddress.lat);
  signupLng.value = String(lng);
  signupLat.value = String(lat);
  if (!isWithinRioGrandeZone([lng, lat])) {
    const textHasRioGrande = direccion.toLowerCase().includes('rio grande');
    if (!textHasRioGrande) {
      return setStatus('La direccion del comercio debe estar dentro de Rio Grande, Tierra del Fuego.');
    }
  }
  if (!acceptedTerms) return setStatus('Debes aceptar los Terminos y Condiciones para registrarte.');
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const now = Date.now();
    await set(ref(db, `users/${cred.user.uid}`), {
      email,
      role: 'comercio',
      status: 'pendiente',
      nombreApellido,
      whatsapp,
      comercioNombre,
      categoria,
      direccion,
      geo: { lat, lng },
      horario: horario || null,
      prepTimeMin: prepTimeMin > 0 ? prepTimeMin : null,
      createdAt: now
    });
    await set(ref(db, `merchants/${cred.user.uid}`), {
      name: comercioNombre,
      category: categoria,
      address: direccion,
      geo: { lat, lng },
      whatsapp,
      schedule: horario || null,
      prepTimeMin: prepTimeMin > 0 ? prepTimeMin : null,
      status: 'pendiente',
      isVerified: false,
      ownerName: nombreApellido,
      ownerEmail: email,
      createdAt: now
    });
    showPendingState('Tu comercio esta pendiente de verificacion. Te avisaremos cuando sea aprobado.');
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
});

if (storeModeAutoBtn) {
  storeModeAutoBtn.addEventListener('click', async () => {
    try {
      await setStoreOpeningMode('auto');
      setStatus('Modo automatico activado.');
    } catch (err) {
      setStatus(err.message);
    }
  });
}

if (storeOpenNowBtn) {
  storeOpenNowBtn.addEventListener('click', async () => {
    try {
      await setStoreOpeningMode('manual', true);
      setStatus('Local marcado como abierto.');
    } catch (err) {
      setStatus(err.message);
    }
  });
}

if (storeCloseNowBtn) {
  storeCloseNowBtn.addEventListener('click', async () => {
    try {
      await setStoreOpeningMode('manual', false);
      setStatus('Local marcado como cerrado.');
    } catch (err) {
      setStatus(err.message);
    }
  });
}

qs('pedidoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const origenSel = originAddressAc ? originAddressAc.getSelected() : null;
  const destinoSel = destinationAddressAc ? destinationAddressAc.getSelected() : null;
  const origen = origenSel ? (origenSel.address || '').trim() : '';
  const destino = destinoSel ? (destinoSel.address || '').trim() : '';
  const totalPedido = Number(qs('totalPedido').value);
  const estado = qs('estado').value;
  const notas = qs('notas').value.trim();
  const pagoMetodo = qs('pagoMetodo').value;
  const shouldOpenPayment = pagoMetodo === 'comercio_paga_envio' || pagoMetodo === 'comercio_mp_transfer';
  const paymentWindow = shouldOpenPayment ? window.open('about:blank', '_blank') : null;
  if (paymentWindow && !paymentWindow.closed) {
    paymentWindow.document.body.innerHTML = '<p style="font-family:sans-serif;padding:16px;">Generando enlace de pago...</p>';
  }

  if (!origenSel || !destinoSel || !origen || !destino || Number.isNaN(totalPedido) || totalPedido <= 0) {
    return setStatus('Selecciona origen y destino de la lista, y completa el total del pedido.');
  }

  const profileSnap = await get(ref(db, `users/${auth.currentUser.uid}`));
  const profile = profileSnap.val() || {};
  if (!isComercioRole(profile.role) || !isActiveStatus(profile.status)) {
    return setStatus('Tu comercio no esta activo para operar.');
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
    origenGeo: { lng: Number(origenSel.lng), lat: Number(origenSel.lat) },
    destinoGeo: { lng: Number(destinoSel.lng), lat: Number(destinoSel.lat) },
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
      const checkoutUrl = await createShippingPayment(orderId, pagoMetodo);
      await update(ref(db, `orders/${orderId}`), { mpInitPoint: checkoutUrl, mpStatus: 'pending' });
      setStatus('Pedido creado. Abrir pago del envio.');
      if (paymentWindow) {
        paymentWindow.location.replace(checkoutUrl);
      } else {
        const opened = window.open(checkoutUrl, '_blank');
        if (!opened) window.location.href = checkoutUrl;
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

async function cambiarEstadoPedido({ id, order, nextEstado }) {
  const now = Date.now();
  const trackingToken = order?.trackingToken;
  if (!trackingToken) throw new Error('Tracking no disponible.');

  await update(ref(db, `orders/${id}`), {
    estado: nextEstado,
    updatedAt: now
  });

  await update(ref(db, `publicTracking/${trackingToken}`), {
    estado: nextEstado,
    updatedAt: now
  });

  // Keep marketplace order status in sync when this order comes from marketplace.
  if (order?.marketplaceOrderId) {
    const map = {
      preparando: 'preparing',
      'listo-para-retirar': 'ready_for_pickup',
      buscando: 'ready_for_pickup'
    };
    const orderStatus = map[nextEstado] || null;
    if (orderStatus) {
      await update(ref(db, `marketplaceOrders/${order.marketplaceOrderId}`), {
        orderStatus,
        updatedAt: now
      });
      await set(push(ref(db, `marketplaceOrderStatusLog/${order.marketplaceOrderId}`)), {
        status: orderStatus,
        actorId: auth.currentUser.uid,
        actorRole: 'comercio',
        createdAt: now
      });
    }
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
  ensureMap(order.ubicacion).catch(() => {});
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
      ${!isClosed ? `<div class="row order-actions"></div>` : ''}
    `;

    if (!isClosed) {
      const actionsRow = div.querySelector('.order-actions');

      function addBtn(label, action, cls = '') {
        const b = document.createElement('button');
        if (cls) b.className = cls;
        b.textContent = label;
        b.dataset.action = action;
        actionsRow.appendChild(b);
        return b;
      }

      const estado = (p.estado || '').toString().toLowerCase();

      // Status flow:
      // esperando-comercio -> preparando -> listo-para-retirar -> buscando -> en-camino-retiro -> ...
      if (estado === 'esperando-comercio') {
        addBtn('Marcar preparando', 'preparando');
        addBtn('Marcar listo', 'listo', 'secondary');
      } else if (estado === 'preparando') {
        addBtn('Marcar listo', 'listo');
      } else if (estado === 'listo-para-retirar') {
        addBtn('Pedir delivery', 'buscar', 'cta');
      } else if (estado === 'buscando') {
        const msg = document.createElement('div');
        msg.className = 'muted';
        msg.textContent = 'Buscando repartidor cercano...';
        actionsRow.appendChild(msg);
      }

      // Always allow cancel while not closed.
      addBtn('Cancelar', 'cancelar', 'danger');

      actionsRow.addEventListener('click', async (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
        if (!btn) return;
        const action = btn.dataset.action;
        try {
          if (action === 'cancelar') {
            await cancelarPedido(id, p.trackingToken);
            return;
          }
          if (action === 'preparando') {
            await cambiarEstadoPedido({ id, order: p, nextEstado: 'preparando' });
            setStatus('Pedido marcado como preparando.');
            return;
          }
          if (action === 'listo') {
            await cambiarEstadoPedido({ id, order: p, nextEstado: 'listo-para-retirar' });
            setStatus('Pedido listo para retirar.');
            return;
          }
          if (action === 'buscar') {
            // Publish to couriers: only orders in estado=buscando are shown on repartidor panel.
            await cambiarEstadoPedido({ id, order: p, nextEstado: 'buscando' });
            setStatus('Buscando repartidor. Se mostrara a los mas cercanos.');
            return;
          }
        } catch (err) {
          setStatus(err.message);
        }
      });

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
        ensureMap(p.ubicacion).catch(() => {});
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
    setAuthLayout(true);
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    pendingSection.classList.add('hidden');
    setStatus('');
    return;
  }

  const userRef = ref(db, `users/${user.uid}`);
  onValue(userRef, (snap) => {
    const u = snap.val();
    if (!u) {
      setStatus('Creando perfil de comercio...');
      set(userRef, { email: user.email || '', role: 'comercio', status: 'pendiente', createdAt: Date.now() });
      return;
    }
    if (!isComercioRole(u.role)) {
      setStatus('Tu usuario no tiene rol de comercio.');
      signOut(auth);
      return;
    }

    if (!isActiveStatus(u.status)) {
      const userStatus = (u.status || '').toString().toLowerCase();
      const msg = userStatus === 'rechazado' || userStatus === 'rejected'
        ? `Tu comercio fue rechazado.${u.rejectionReason ? ` Motivo: ${u.rejectionReason}` : ''}`
        : 'Tu comercio esta pendiente de verificacion manual. Te avisaremos cuando sea aprobado.';
      showPendingState(msg);
      return;
    }

    authSection.classList.add('hidden');
    pendingSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    setAuthLayout(false);
    setStatus('');

    initGeocoders();

    onValue(ref(db, `merchants/${user.uid}`), (merchantSnap) => {
      merchantProfile = merchantSnap.val() || {};
      renderStoreOpenControls();
    });

    const q = query(ref(db, 'orders'), orderByChild('comercioId'), equalTo(user.uid));
    onValue(q, (ordersSnap) => renderPedidos(ordersSnap.val()));
  }, (err) => {
    setStatus(`Error al cargar perfil de comercio: ${err.message}`);
  });
});

// Signup requires selecting address/geo even before login.
initGeocoders();
signupAddressAc = attachRioGrandeAutocomplete(signupDireccion, {
  onSelect: (selected) => {
    signupLng.value = String(selected.lng ?? '');
    signupLat.value = String(selected.lat ?? '');
    setStatus('');
  },
  onInvalidate: () => {
    signupLng.value = '';
    signupLat.value = '';
    setStatus('Selecciona una direccion del comercio desde la lista.');
  }
});
originAddressAc = attachRioGrandeAutocomplete(qs('origen'), {
  onSelect: () => {
    setStatus('');
    scheduleCotizar();
  },
  onInvalidate: () => {
    setCotizacion(null, null, null, null);
  }
});
destinationAddressAc = attachRioGrandeAutocomplete(qs('destino'), {
  onSelect: () => {
    setStatus('');
    scheduleCotizar();
  },
  onInvalidate: () => {
    setCotizacion(null, null, null, null);
  }
});
