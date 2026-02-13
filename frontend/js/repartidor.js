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
  update,
  query,
  orderByChild,
  equalTo,
  onValue,
  get,
  push
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney } from './utils.js';
import { getMapboxToken } from './mapbox-token.js';

const authSection = qs('authSection');
const appSection = qs('appSection');
const statusEl = qs('status');
const pedidosList = qs('pedidosList');
const historialList = qs('historialList');
const activoInfo = qs('activoInfo');
const startTrackingBtn = qs('startTrackingBtn');
const stopTrackingBtn = qs('stopTrackingBtn');
const deliverBtn = qs('deliverBtn');
const cancelBtn = qs('cancelBtn');
const markPickedUpBtn = qs('markPickedUpBtn');
const navEtaInfo = qs('navEtaInfo');
const logoutBtn = qs('logoutBtn');
const mapInfo = qs('mapInfo');
const mapContainer = qs('map');
const walletBalance = qs('walletBalance');
const walletPending = qs('walletPending');
const withdrawAmount = qs('withdrawAmount');
const withdrawBtn = qs('withdrawBtn');
const walletTx = qs('walletTx');
const perfilEstado = qs('perfilEstado');
const signupNombreApellido = qs('signupNombreApellido');
const signupDni = qs('signupDni');
const signupVehiculoTipo = qs('signupVehiculoTipo');
const signupPatente = qs('signupPatente');
const signupWhatsapp = qs('signupWhatsapp');
const signupTermsRepartidor = qs('signupTermsRepartidor');
const gpsStateBadge = qs('gpsStateBadge');
const gpsInfo = qs('gpsInfo');
const gpsRetryBtn = qs('gpsRetryBtn');
const deliveryDistanceInfo = qs('deliveryDistanceInfo');
const waClientBtn = qs('waClientBtn');
const supportBtn = qs('supportBtn');
const supportFab = qs('supportFab');
const quickActionsHint = qs('quickActionsHint');

const BACKEND_BASE_URL = 'https://windi-01ia.onrender.com';
const DELIVERY_RADIUS_METERS = 50;
const DELIVERY_MAX_ACCURACY_METERS = 50;
const TAKE_ORDER_MAX_ACCURACY_METERS = 100;

let map = null;
let courierMarker = null;
let pickupMarker = null;
let dropoffMarker = null;
let routeSourceReady = false;
let lastRouteFetchAt = 0;
let lastRouteKey = '';
let lastRouteOrigin = null;
let lastFitKey = '';

let activeOrder = null;
let watchId = null;
let profileApproved = false;
const DEFAULT_CURRENCY = 'ARS';
let gpsStatus = 'searching';
let currentPosition = null;
let ordersCache = null;

function normalizeArWhatsApp(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // Best-effort normalization:
  // - remove leading 0
  // - ensure country prefix 54
  const noLeading0 = digits.startsWith('0') ? digits.slice(1) : digits;
  if (noLeading0.startsWith('54')) return noLeading0;
  return `54${noLeading0}`;
}

function getCustomerWhatsapp(order) {
  return (
    order?.clienteWhatsapp ||
    order?.customerWhatsapp ||
    order?.whatsappCliente ||
    order?.delivery?.customerWhatsapp ||
    order?.delivery?.whatsapp ||
    order?.whatsapp ||
    ''
  );
}

function getCustomerName(order) {
  return (
    order?.clienteNombre ||
    order?.customerName ||
    order?.delivery?.customerName ||
    'cliente'
  );
}

function openWhatsApp(numberRaw, message) {
  const normalized = normalizeArWhatsApp(numberRaw);
  if (!normalized) {
    setStatus('No hay numero de WhatsApp disponible para este pedido.');
    return;
  }
  const text = encodeURIComponent(String(message || '').trim());
  const url = `https://wa.me/${normalized}?text=${text}`;
  const opened = window.open(url, '_blank');
  if (!opened) window.location.href = url;
}

function openSupport(order) {
  const normalized = '5492964537272';
  const orderId = order?.id || '';
  const msg = `Hola soporte Windi, necesito ayuda con el pedido ${orderId || '-'}. Mi problema es: `;
  openWhatsApp(normalized, msg);
}

function updateQuickActionsUi() {
  const hasOrder = !!activeOrder;
  if (waClientBtn) waClientBtn.disabled = !hasOrder;
  if (supportBtn) supportBtn.disabled = false;
  if (supportFab) supportFab.disabled = false;

  if (!hasOrder) {
    if (quickActionsHint) quickActionsHint.textContent = 'Acepta un pedido para habilitar acciones rapidas.';
    return;
  }
  const phone = getCustomerWhatsapp(activeOrder);
  if (waClientBtn) {
    waClientBtn.disabled = !phone;
  }
  if (quickActionsHint) {
    quickActionsHint.textContent = phone
      ? 'Acciones rapidas listas: contacto al cliente y soporte.'
      : 'Este pedido no tiene WhatsApp del cliente cargado. (Se puede seguir con navegacion y entrega igual.)';
  }
}

function isPickupStage(order) {
  const state = (order?.estado || '').toString().toLowerCase();
  return state === 'en-camino-retiro' || state === 'accepted' || state === 'asignado';
}

function isDeliveryStage(order) {
  const state = (order?.estado || '').toString().toLowerCase();
  return state === 'en-camino';
}

function buildDefaultWallet(now = Date.now()) {
  return {
    balance: 0,
    pending: 0,
    totalEarned: 0,
    totalCommissions: 0,
    totalWithdrawn: 0,
    currency: DEFAULT_CURRENCY,
    createdAt: now,
    updatedAt: now
  };
}

async function ensureWallet(uid) {
  const walletRef = ref(db, `wallets/${uid}`);
  const snap = await get(walletRef);
  const now = Date.now();
  if (!snap.exists()) {
    await set(walletRef, buildDefaultWallet(now));
    return;
  }
  const wallet = snap.val() || {};
  const patch = {};
  if (typeof wallet.balance !== 'number') patch.balance = 0;
  if (typeof wallet.pending !== 'number') patch.pending = 0;
  if (typeof wallet.totalEarned !== 'number') patch.totalEarned = 0;
  if (typeof wallet.totalCommissions !== 'number') patch.totalCommissions = 0;
  if (typeof wallet.totalWithdrawn !== 'number') patch.totalWithdrawn = 0;
  if (!wallet.currency) patch.currency = DEFAULT_CURRENCY;
  if (!wallet.createdAt) patch.createdAt = now;
  patch.updatedAt = now;
  await update(walletRef, patch);
}

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function haversineMeters(a, b) {
  const toRad = (v) => (Number(v) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return 6371000 * c;
}

function resolveDestinationGeo(order) {
  if (!order) return null;
  const raw =
    order.destinoGeo ||
    order.delivery?.customerLocation ||
    order.delivery?.destination ||
    null;
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function computeDistanceToDestination(order, position) {
  const destination = resolveDestinationGeo(order);
  if (!destination || !position) return null;
  return haversineMeters(
    { lat: Number(position.lat), lng: Number(position.lng) },
    destination
  );
}

function getPickupGeo(order) {
  if (!order) return null;
  const raw = order.origenGeo || order.delivery?.merchantLocation || null;
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function buildRouteKey(order) {
  if (!order) return '';
  const stage = isPickupStage(order) ? 'pickup' : (isDeliveryStage(order) ? 'dropoff' : 'none');
  return `${order.id || ''}:${stage}`;
}

function metersBetween(a, b) {
  if (!a || !b) return null;
  return haversineMeters(a, b);
}

function createPinElement(kind) {
  const el = document.createElement('div');
  el.className = `courier-pin ${kind}`;
  return el;
}

async function ensureCourierMap(center) {
  if (!mapContainer) return;
  if (map && window.mapboxgl) return;
  if (!window.mapboxgl) return;
  const token = await getMapboxToken();
  if (!token) return;

  mapboxgl.accessToken = token;
  map = new mapboxgl.Map({
    container: mapContainer,
    style: 'mapbox://styles/mapbox/navigation-day-v1',
    center: [center.lng, center.lat],
    zoom: 14
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');

  courierMarker = new mapboxgl.Marker({ element: createPinElement('courier') })
    .setLngLat([center.lng, center.lat])
    .addTo(map);

  pickupMarker = new mapboxgl.Marker({ element: createPinElement('pickup') });
  dropoffMarker = new mapboxgl.Marker({ element: createPinElement('dropoff') });

  map.on('load', () => {
    map.addSource('courier-route', {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [] }
      }
    });
    map.addLayer({
      id: 'courier-route',
      type: 'line',
      source: 'courier-route',
      paint: {
        'line-color': '#0ea5e9',
        'line-width': 5,
        'line-opacity': 0.9
      }
    });
    map.addLayer({
      id: 'courier-route-glow',
      type: 'line',
      source: 'courier-route',
      paint: {
        'line-color': '#0ea5e9',
        'line-width': 10,
        'line-opacity': 0.2
      }
    }, 'courier-route');
    routeSourceReady = true;
  });
}

function setRouteGeometry(coordinates) {
  if (!map || !routeSourceReady) return;
  const source = map.getSource('courier-route');
  if (!source) return;
  source.setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: Array.isArray(coordinates) ? coordinates : [] }
  });
}

async function updateCourierMapAndRoute({ force = false } = {}) {
  if (!activeOrder) {
    if (mapInfo) mapInfo.textContent = 'Acepta un pedido para ver el mapa y la ruta.';
    if (navEtaInfo) navEtaInfo.textContent = 'Sin ruta activa.';
    return;
  }
  const pickup = getPickupGeo(activeOrder);
  const dropoff = resolveDestinationGeo(activeOrder);
  const stageTarget = isPickupStage(activeOrder) ? pickup : dropoff;
  if (!pickup || !dropoff) {
    if (mapInfo) mapInfo.textContent = 'Este pedido no tiene coordenadas completas (retiro/destino).';
    return;
  }
  if (!currentPosition) {
    if (mapInfo) mapInfo.textContent = 'Activa GPS para ver tu ubicacion y calcular ruta por calles.';
    return;
  }

  await ensureCourierMap({ lat: currentPosition.lat, lng: currentPosition.lng });
  if (!map) return;

  // Markers
  if (courierMarker) courierMarker.setLngLat([currentPosition.lng, currentPosition.lat]);
  if (pickupMarker) pickupMarker.setLngLat([pickup.lng, pickup.lat]).addTo(map);
  if (dropoffMarker) dropoffMarker.setLngLat([dropoff.lng, dropoff.lat]).addTo(map);

  // Debounce route fetches
  const key = buildRouteKey(activeOrder);
  const origin = { lat: currentPosition.lat, lng: currentPosition.lng };
  const dest = stageTarget;
  const moved = lastRouteOrigin ? metersBetween(origin, lastRouteOrigin) : null;
  const now = Date.now();
  const shouldFetch = force
    || key !== lastRouteKey
    || (moved != null && moved >= 80)
    || (now - lastRouteFetchAt) >= 20000;

  if (!shouldFetch) return;
  lastRouteFetchAt = now;
  lastRouteKey = key;
  lastRouteOrigin = origin;

  try {
    const token = await getMapboxToken();
    if (!token) {
      if (mapInfo) mapInfo.textContent = 'Mapbox no configurado.';
      return;
    }
    if (mapInfo) mapInfo.textContent = isPickupStage(activeOrder) ? 'Ruta: yendo a retirar...' : 'Ruta: yendo a entregar...';

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?access_token=${token}&geometries=geojson&overview=full&alternatives=false&steps=false`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    const route = data?.routes?.[0];
    if (!route?.geometry?.coordinates?.length) {
      setRouteGeometry([]);
      if (navEtaInfo) navEtaInfo.textContent = 'No se pudo calcular ruta por calles.';
      if (mapInfo) mapInfo.textContent = 'No se pudo calcular ruta por calles. Reintentando con GPS...';
      return;
    }

    setRouteGeometry(route.geometry.coordinates);
    const km = (Number(route.distance || 0) / 1000).toFixed(1);
    const min = Math.max(1, Math.round(Number(route.duration || 0) / 60));
    if (navEtaInfo) navEtaInfo.textContent = `Ruta por calles: ${km} km | ETA aprox: ${min} min`;

    // Fit only when stage changes / new order, to avoid "jumping" all the time.
    if (lastFitKey !== key) {
      lastFitKey = key;
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([origin.lng, origin.lat]);
      bounds.extend([pickup.lng, pickup.lat]);
      bounds.extend([dropoff.lng, dropoff.lat]);
      map.fitBounds(bounds, { padding: 60, duration: 600 });
    }
  } catch {
    setRouteGeometry([]);
    if (navEtaInfo) navEtaInfo.textContent = 'No se pudo calcular ruta por calles.';
    if (mapInfo) mapInfo.textContent = 'No se pudo calcular ruta por calles.';
  }
}

function updateGpsCard() {
  if (!gpsStateBadge || !gpsInfo) return;
  if (gpsStatus === 'active' && currentPosition) {
    gpsStateBadge.className = 'status active';
    gpsStateBadge.textContent = 'GPS activo';
    const updated = new Date(currentPosition.timestamp || Date.now()).toLocaleTimeString('es-AR');
    gpsInfo.textContent = `Precision: ${Math.round(currentPosition.accuracy || 0)} m | Ultima actualizacion: ${updated}`;
    return;
  }
  if (gpsStatus === 'denied') {
    gpsStateBadge.className = 'status cancelado';
    gpsStateBadge.textContent = 'Permiso denegado';
    gpsInfo.textContent = 'Habilita ubicacion para tomar pedidos y marcar entregas.';
    return;
  }
  if (gpsStatus === 'error') {
    gpsStateBadge.className = 'status pending';
    gpsStateBadge.textContent = 'Sin senal GPS';
    gpsInfo.textContent = 'No se pudo obtener ubicacion. Reintenta.';
    return;
  }
  gpsStateBadge.className = 'status pending';
  gpsStateBadge.textContent = 'Buscando senal';
  gpsInfo.textContent = 'Esperando ubicacion en tiempo real...';
}

function canTakeOrders() {
  return profileApproved && gpsStatus === 'active' && Number(currentPosition?.accuracy || 9999) <= TAKE_ORDER_MAX_ACCURACY_METERS;
}

function canDeliverActiveOrder() {
  if (!activeOrder || !profileApproved) return { ok: false, reason: 'No hay pedido activo.' };
  if (!isDeliveryStage(activeOrder)) return { ok: false, reason: 'Primero marca el pedido como retirado.' };
  if (gpsStatus !== 'active' || !currentPosition) {
    return { ok: false, reason: 'GPS no disponible. Activa ubicacion para continuar.' };
  }
  const accuracy = Number(currentPosition.accuracy || 9999);
  if (accuracy > DELIVERY_MAX_ACCURACY_METERS) {
    return { ok: false, reason: `Senal GPS debil (${Math.round(accuracy)} m). Acercate a cielo abierto.` };
  }
  const distanceMeters = computeDistanceToDestination(activeOrder, currentPosition);
  if (distanceMeters == null) {
    return { ok: false, reason: 'Pedido sin coordenadas de destino. No se puede validar entrega.' };
  }
  if (distanceMeters > DELIVERY_RADIUS_METERS) {
    return { ok: false, reason: `Acercate al destino para confirmar la entrega (a ${Math.round(distanceMeters)} m).` };
  }
  return { ok: true, reason: `Dentro de rango (${Math.round(distanceMeters)} m).` };
}

function updateDeliveryDistanceUi() {
  if (!deliveryDistanceInfo) return;
  if (!activeOrder) {
    deliveryDistanceInfo.textContent = 'Sin destino activo.';
    return;
  }
  const distanceMeters = computeDistanceToDestination(activeOrder, currentPosition);
  if (distanceMeters == null) {
    deliveryDistanceInfo.textContent = 'Destino sin coordenadas validas. No se puede habilitar entrega.';
    return;
  }
  const eligibility = canDeliverActiveOrder();
  deliveryDistanceInfo.textContent = eligibility.ok
    ? `Distancia al destino: ${Math.round(distanceMeters)} m. Puedes marcar entregado.`
    : `Distancia al destino: ${Math.round(distanceMeters)} m. ${eligibility.reason}`;
}

function updateProfileState(userData) {
  if (userData?.restricted === true) {
    profileApproved = false;
    const reason = userData.restrictedReason ? ` Motivo: ${userData.restrictedReason}` : '';
    perfilEstado.textContent = `Cuenta restringida por admin.${reason}`;
    perfilEstado.classList.add('money-negative');
    return;
  }
  const status = userData?.validationStatus || 'pending';
  if (status === 'approved') {
    profileApproved = true;
    perfilEstado.textContent = 'Perfil aprobado. Ya puedes tomar pedidos.';
    perfilEstado.classList.remove('money-negative');
    return;
  }
  profileApproved = false;
  perfilEstado.textContent = 'Perfil en validacion manual. Demora estimada: 24 horas habiles.';
  perfilEstado.classList.add('money-negative');
}

function refreshActionButtons() {
  const hasActive = !!activeOrder && profileApproved;
  startTrackingBtn.disabled = !profileApproved;
  stopTrackingBtn.disabled = watchId === null;
  deliverBtn.disabled = !hasActive || !canDeliverActiveOrder().ok;
  cancelBtn.disabled = !hasActive;
  withdrawBtn.disabled = !profileApproved;
  if (markPickedUpBtn) markPickedUpBtn.disabled = !hasActive || !isPickupStage(activeOrder);
  updateGpsCard();
  updateDeliveryDistanceUi();
  updateCourierMapAndRoute().catch(() => {});
  updateQuickActionsUi();
  if (ordersCache) renderPedidos(ordersCache);
}

function setActiveOrder(order, id) {
  if (!order) {
    activeOrder = null;
    activoInfo.textContent = 'No hay pedido activo. Acepta uno desde "Pedidos disponibles".';
    if (mapInfo) mapInfo.textContent = 'Acepta un pedido para ver el mapa y la ruta.';
    if (navEtaInfo) navEtaInfo.textContent = 'Sin ruta activa.';
    refreshActionButtons();
    return;
  }
  activeOrder = {
    ...order,
    id,
    trackingToken: order.trackingToken,
    destinoGeo: resolveDestinationGeo(order)
  };
  const kmText = order.km != null ? `${order.km} km` : 'Km -';
  const payout = order.payout ?? order.precio;
  const method = String(order.pagoMetodo || '').toLowerCase();
  const pagoLabel = method === 'cash_delivery'
    ? 'Efectivo (cobras al recibir)'
    : method === 'transfer_delivery'
      ? 'Transferencia (cobras al recibir)'
      : 'Pago con tarjeta (Mercado Pago)';
  const etapa = isPickupStage(order) ? 'En camino a retirar' : (isDeliveryStage(order) ? 'En camino a entregar' : 'Pedido activo');
  activoInfo.textContent = `${etapa} | ${order.origen} -> ${order.destino} | ${kmText} | ${fmtMoney(payout)} | ${pagoLabel}`;
  refreshActionButtons();
}

async function stopTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (gpsStatus !== 'denied') gpsStatus = 'searching';
  currentPosition = null;
  // Best-effort: mark courier offline for admin dispatch. (Cannot guarantee on abrupt app kill.)
  try {
    const uid = auth.currentUser?.uid;
    if (uid) {
      await update(ref(db, `courierPresence/${uid}`), { status: 'offline', updatedAt: Date.now() });
    }
  } catch {}
  refreshActionButtons();
}

async function onGpsPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const now = Date.now();
  currentPosition = {
    lat: latitude,
    lng: longitude,
    accuracy: Number(accuracy || 9999),
    timestamp: pos.timestamp || now
  };
  gpsStatus = 'active';
  refreshActionButtons();

  // Presence for admin dispatch (online couriers). Only publish if the profile is approved.
  try {
    const uid = auth.currentUser?.uid;
    if (uid && profileApproved) {
      await set(ref(db, `courierPresence/${uid}`), {
        status: 'online',
        lat: latitude,
        lng: longitude,
        accuracy: Number(accuracy || 9999),
        updatedAt: now
      });
    }
  } catch {}

  if (!activeOrder) return;
  const updates = {
    ubicacion: { lat: latitude, lng: longitude, accuracy: Number(accuracy || 9999), updatedAt: now },
    updatedAt: now
  };
  try {
    const orderSnap = await get(ref(db, `orders/${activeOrder.id}`));
    const order = orderSnap.val();
    await update(ref(db, `orders/${activeOrder.id}`), updates);
    if (order?.marketplaceOrderId) {
      const nextStatus = isDeliveryStage(order) ? 'picked_up' : 'assigned';
      await update(ref(db, `marketplaceOrders/${order.marketplaceOrderId}`), {
        orderStatus: nextStatus,
        updatedAt: now,
        'delivery/courierId': auth.currentUser.uid,
        'delivery/lastLocation': {
          lat: latitude,
          lng: longitude,
          accuracy: Number(accuracy || 9999),
          updatedAt: now
        }
      });
      await set(push(ref(db, `marketplaceOrderStatusLog/${order.marketplaceOrderId}`)), {
        status: nextStatus,
        actorId: auth.currentUser.uid,
        actorRole: 'courier',
        createdAt: now
      });
    }
    await update(ref(db, `publicTracking/${activeOrder.trackingToken}`), updates);
    mapInfo.textContent = `Ubicacion actualizada ${new Date(now).toLocaleTimeString('es-AR')}`;
    updateCourierMapAndRoute().catch(() => {});
  } catch (err) {
    setStatus(err.message || 'No se pudo actualizar ubicacion.');
  }
}

function onGpsError(err) {
  if (err?.code === 1) {
    gpsStatus = 'denied';
    setStatus('Permiso de ubicacion denegado. Habilitalo para tomar pedidos y marcar entregas.');
  } else if (err?.code === 2 || err?.code === 3) {
    gpsStatus = 'error';
    setStatus('No se pudo obtener ubicacion. Reintentando...');
  } else {
    gpsStatus = 'error';
    setStatus(err?.message || 'Error de GPS.');
  }
  refreshActionButtons();
}

function startGpsWatch() {
  if (!navigator.geolocation) {
    gpsStatus = 'error';
    setStatus('Geolocalizacion no disponible en este dispositivo.');
    refreshActionButtons();
    return;
  }
  if (watchId !== null) return;
  gpsStatus = 'searching';
  refreshActionButtons();
  watchId = navigator.geolocation.watchPosition(
    (pos) => { onGpsPosition(pos); },
    (err) => { onGpsError(err); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

function renderWallet(data) {
  const balance = data?.balance ?? 0;
  const pending = data?.pending ?? 0;
  const currency = data?.currency || DEFAULT_CURRENCY;
  walletBalance.textContent = `Saldo (${currency}): ${fmtMoney(balance)}`;
  walletPending.textContent = `Pendiente (${currency}): ${fmtMoney(pending)}`;
  walletBalance.classList.toggle('money-negative', balance < 0);
  walletPending.classList.toggle('money-negative', pending < 0);
}

function renderWalletTx(data) {
  walletTx.innerHTML = '';
  if (!data) {
    walletTx.innerHTML = '<div class="item"><div class="muted">Todavia no hay movimientos en tu wallet.</div></div>';
    return;
  }
  Object.entries(data).reverse().forEach(([, tx]) => {
    const div = document.createElement('div');
    div.className = 'item';
    const amount = tx.amount ?? 0;
    const label = tx.type === 'credit' ? 'Ingreso' : tx.type === 'commission' ? 'Comision' : 'Retiro';
    div.innerHTML = `
      <div class="row">
        <strong>${label}</strong>
        <span>${fmtMoney(amount)}</span>
      </div>
      <div class="muted">${new Date(tx.createdAt || Date.now()).toLocaleString('es-AR')}</div>
    `;
    walletTx.appendChild(div);
  });
}

withdrawBtn.addEventListener('click', async () => {
  const user = auth.currentUser;
  if (!user) return;
  if (!profileApproved) return setStatus('Tu perfil aun no esta aprobado.');
  const amount = Number(withdrawAmount.value);
  if (Number.isNaN(amount) || amount <= 0) {
    return setStatus('Monto invalido.');
  }

  const walletRef = ref(db, `wallets/${user.uid}`);
  const snap = await get(walletRef);
  const wallet = snap.val() || buildDefaultWallet();
  if (amount > wallet.balance) {
    return setStatus('Saldo insuficiente.');
  }

  const now = Date.now();
  const newBalance = wallet.balance - amount;
  const newPending = (wallet.pending || 0) + amount;
  const newTotalWithdrawn = (wallet.totalWithdrawn || 0) + amount;

  await update(walletRef, {
    balance: newBalance,
    pending: newPending,
    totalWithdrawn: newTotalWithdrawn,
    updatedAt: now
  });
  const txRef = push(ref(db, `walletTx/${user.uid}`));
  await set(txRef, { type: 'withdraw', amount, createdAt: now, status: 'pending' });
  const wRef = push(ref(db, `walletWithdrawals/${user.uid}`));
  await set(wRef, { amount, createdAt: now, status: 'pending' });

  withdrawAmount.value = '';
  setStatus('Solicitud de retiro enviada.');
});

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

signupVehiculoTipo.addEventListener('change', () => {
  const tipo = signupVehiculoTipo.value;
  const requierePatente = tipo === 'auto' || tipo === 'moto';
  signupPatente.classList.toggle('hidden', !requierePatente);
  signupPatente.required = requierePatente;
  if (!requierePatente) signupPatente.value = '';
});

qs('signupBtn').addEventListener('click', async () => {
  const nombreApellido = signupNombreApellido.value.trim();
  const dni = signupDni.value.trim();
  const vehiculoTipo = signupVehiculoTipo.value;
  const patente = signupPatente.value.trim().toUpperCase();
  const whatsapp = signupWhatsapp.value.trim();
  const acceptedTerms = signupTermsRepartidor.checked;
  const email = qs('signupEmail').value.trim();
  const password = qs('signupPassword').value.trim();
  if (!nombreApellido || !dni || !vehiculoTipo || !whatsapp || !email || !password) {
    return setStatus('Completa todos los datos del registro.');
  }
  if (!acceptedTerms) {
    return setStatus('Debes aceptar los Terminos y Condiciones para registrarte.');
  }
  if ((vehiculoTipo === 'auto' || vehiculoTipo === 'moto') && !patente) {
    return setStatus('La patente es obligatoria para auto o moto.');
  }
  try {
    const now = Date.now();
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await set(ref(db, `users/${cred.user.uid}`), {
      email,
      role: 'repartidor',
      nombreApellido,
      dni,
      vehiculoTipo,
      patente: vehiculoTipo === 'bici' ? null : patente,
      whatsapp,
      validationStatus: 'pending',
      validationRequestedAt: now
    });
    await ensureWallet(cred.user.uid);
    setStatus('Registro enviado. La validacion manual puede tardar hasta 24 horas habiles.');
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await stopTracking();
  await signOut(auth);
});

if (gpsRetryBtn) {
  gpsRetryBtn.addEventListener('click', () => {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    startGpsWatch();
    setStatus('Reintentando GPS...');
  });
}

window.addEventListener('beforeunload', () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  try {
    const uid = auth.currentUser?.uid;
    if (uid) update(ref(db, `courierPresence/${uid}`), { status: 'offline', updatedAt: Date.now() });
  } catch {}
});

startTrackingBtn.addEventListener('click', () => {
  if (!profileApproved) return setStatus('Tu perfil aun no esta aprobado.');
  startGpsWatch();
  setStatus('GPS activado.');
  refreshActionButtons();
});

stopTrackingBtn.addEventListener('click', () => {
  stopTracking();
  setStatus('GPS detenido.');
});

if (waClientBtn) {
  waClientBtn.addEventListener('click', () => {
    if (!activeOrder) return setStatus('No hay pedido activo.');
    const phone = getCustomerWhatsapp(activeOrder);
    const name = getCustomerName(activeOrder);
    const msg = `Hola ${name}, soy tu repartidor de Windi. Estoy en camino con tu pedido ${activeOrder.id || ''}. ¿Podés confirmarme la referencia de tu domicilio?`;
    openWhatsApp(phone, msg);
  });
}

function handleSupportClick() {
  openSupport(activeOrder);
}

if (supportBtn) {
  supportBtn.addEventListener('click', handleSupportClick);
}

if (supportFab) {
  supportFab.addEventListener('click', handleSupportClick);
}

async function markPickedUp() {
  if (!profileApproved) return setStatus('Tu perfil aun no esta aprobado.');
  if (!activeOrder) return setStatus('No hay pedido activo.');
  if (!isPickupStage(activeOrder)) return setStatus('El pedido ya esta en etapa de entrega.');

  const now = Date.now();
  try {
    const orderRef = ref(db, `orders/${activeOrder.id}`);
    const snap = await get(orderRef);
    const order = snap.val();
    if (!order) return setStatus('Pedido no encontrado.');
    if (order.repartidorId !== auth.currentUser.uid) return setStatus('Este pedido no esta asignado a tu cuenta.');

    await update(orderRef, {
      estado: 'en-camino',
      pickedUpAt: now,
      updatedAt: now
    });

    if (order.marketplaceOrderId) {
      await update(ref(db, `marketplaceOrders/${order.marketplaceOrderId}`), {
        orderStatus: 'picked_up',
        updatedAt: now,
        'delivery/courierId': auth.currentUser.uid
      });
      await set(push(ref(db, `marketplaceOrderStatusLog/${order.marketplaceOrderId}`)), {
        status: 'picked_up',
        actorId: auth.currentUser.uid,
        actorRole: 'courier',
        createdAt: now
      });
    }

    if (order.trackingToken) {
      await update(ref(db, `publicTracking/${order.trackingToken}`), {
        estado: 'en-camino',
        updatedAt: now
      });
    }

    activeOrder = {
      ...activeOrder,
      ...order,
      estado: 'en-camino',
      pickedUpAt: now
    };
    refreshActionButtons();
    updateCourierMapAndRoute({ force: true }).catch(() => {});
    setStatus('Pedido marcado como retirado. Ruta actualizada para entrega.');
  } catch (err) {
    setStatus(err.message);
  }
}

if (markPickedUpBtn) {
  markPickedUpBtn.addEventListener('click', markPickedUp);
}

async function deliverWithServerValidation(orderId) {
  const user = auth.currentUser;
  if (!user) throw new Error('Debes iniciar sesion.');
  if (!currentPosition) throw new Error('GPS no disponible.');
  const token = await user.getIdToken();
  const res = await fetch(`${BACKEND_BASE_URL}/courier/orders/${encodeURIComponent(orderId)}/deliver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      lat: Number(currentPosition.lat),
      lng: Number(currentPosition.lng),
      accuracy: Number(currentPosition.accuracy || 9999),
      timestamp: Number(currentPosition.timestamp || Date.now())
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || 'No se pudo validar entrega.');
  }
  return data;
}

async function markDelivered() {
  if (!profileApproved) return setStatus('Tu perfil aun no esta aprobado.');
  if (!activeOrder) return setStatus('No hay pedido activo.');
  const eligibility = canDeliverActiveOrder();
  if (!eligibility.ok) return setStatus(eligibility.reason);
  try {
    await deliverWithServerValidation(activeOrder.id);
    setActiveOrder(null, null);
    setStatus('Pedido entregado.');
  } catch (err) {
    setStatus(err.message);
  }
}

deliverBtn.addEventListener('click', markDelivered);

cancelBtn.addEventListener('click', async () => {
  if (!profileApproved) return setStatus('Tu perfil aun no esta aprobado.');
  if (!activeOrder) return setStatus('No hay pedido activo.');
  const now = Date.now();
  try {
    await update(ref(db, `orders/${activeOrder.id}`), {
      estado: 'cancelado',
      canceledAt: now,
      updatedAt: now
    });
    const orderSnap = await get(ref(db, `orders/${activeOrder.id}`));
    const order = orderSnap.val();
    if (order?.marketplaceOrderId) {
      await update(ref(db, `marketplaceOrders/${order.marketplaceOrderId}`), {
        orderStatus: 'cancelled',
        updatedAt: now
      });
      await set(push(ref(db, `marketplaceOrderStatusLog/${order.marketplaceOrderId}`)), {
        status: 'cancelled',
        actorId: auth.currentUser.uid,
        actorRole: 'courier',
        createdAt: now
      });
    }
    await update(ref(db, `publicTracking/${activeOrder.trackingToken}`), {
      estado: 'cancelado',
      updatedAt: now
    });
    await stopTracking();
    setActiveOrder(null, null);
    setStatus('Pedido cancelado.');
  } catch (err) {
    setStatus(err.message);
  }
});

function renderPedidos(data) {
  pedidosList.innerHTML = '';
  if (!data) {
    pedidosList.innerHTML = '<div class="item"><div class="muted">No hay pedidos disponibles ahora. Actualiza en unos segundos.</div></div>';
    return;
  }

  const availableEntries = Object.entries(data)
    .filter(([, p]) => {
      const state = (p?.estado || '').toString().toLowerCase();
      const isAvailableState = state === 'buscando' || state === 'esperando-comercio';
      const isUnassigned = !p?.repartidorId;
      return isAvailableState && isUnassigned;
    })
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!availableEntries.length) {
    pedidosList.innerHTML = '<div class="item"><div class="muted">No hay pedidos disponibles ahora. Actualiza en unos segundos.</div></div>';
    return;
  }

  availableEntries.forEach(([id, p]) => {
    const div = document.createElement('div');
    div.className = 'item';
    const kmText = p.km != null ? `${p.km} km` : 'Km -';
    const payout = p.payout ?? p.precio;
    const method = String(p.pagoMetodo || '').toLowerCase();
    const pagoLabel = method === 'cash_delivery'
      ? `Efectivo (cobras ${fmtMoney(p.totalPedido)})`
      : method === 'transfer_delivery'
        ? `Transferencia (cobras ${fmtMoney(p.totalPedido)})`
        : 'Pago con tarjeta (Mercado Pago)';
    const canTake = canTakeOrders();
    div.innerHTML = `
      <div class="row">
        <strong>${p.origen} -> ${p.destino}</strong>
        <span class="status ${p.estado}">${p.estado}</span>
      </div>
      <div class="muted">${kmText} | Tarifa: ${fmtMoney(payout)}</div>
      <div class="muted">Pago: ${pagoLabel}</div>
      <div class="muted">Notas: ${p.notas || '-'}</div>
      ${canTake ? '' : '<div class="muted">Habilita GPS con buena precision para tomar pedidos.</div>'}
      <button data-id="${id}" ${canTake ? '' : 'disabled'}>Aceptar</button>
    `;
    div.querySelector('button').addEventListener('click', () => aceptarPedido(id));
    pedidosList.appendChild(div);
  });
}

function renderHistorial(data) {
  historialList.innerHTML = '';
  if (!data) {
    historialList.innerHTML = '<div class="item"><div class="muted">Todavia no tienes viajes finalizados.</div></div>';
    return;
  }
  const closed = Object.entries(data)
    .filter(([, p]) => p.estado === 'entregado' || p.estado === 'cancelado')
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));

  if (closed.length === 0) {
    historialList.innerHTML = '<div class="item"><div class="muted">Todavia no tienes viajes finalizados.</div></div>';
    return;
  }

  closed.forEach(([id, p]) => {
    const div = document.createElement('div');
    div.className = 'item';
    const payout = p.payout ?? p.precio ?? 0;
    const closedAt = p.entregadoAt || p.canceledAt || p.updatedAt;
    div.innerHTML = `
      <div class="row">
        <strong>${p.origen} -> ${p.destino}</strong>
        <span class="status ${p.estado}">${p.estado}</span>
      </div>
      <div class="muted">Tarifa: ${fmtMoney(payout)} | Total pedido: ${fmtMoney(p.totalPedido || 0)}</div>
      <div class="muted">Notas: ${p.notas || '-'}</div>
      <div class="muted">Fecha: ${new Date(closedAt || Date.now()).toLocaleString('es-AR')}</div>
      <div class="muted">ID: ${id}</div>
    `;
    historialList.appendChild(div);
  });
}

async function aceptarPedido(id) {
  if (!profileApproved) return setStatus('Tu perfil aun no esta aprobado.');
  if (!canTakeOrders()) return setStatus('Activa GPS con precision suficiente para tomar pedidos.');
  const orderSnap = await get(ref(db, `orders/${id}`));
  const order = orderSnap.val();
  if (!order) return setStatus('Pedido no encontrado.');
  const estado = (order.estado || '').toString().toLowerCase();
  if (estado !== 'buscando' && estado !== 'esperando-comercio') {
    return setStatus('Este pedido ya no esta disponible para aceptar.');
  }
  if (order.repartidorId) {
    return setStatus('Este pedido ya fue asignado.');
  }

  const now = Date.now();
  await update(ref(db, `orders/${id}`), {
    estado: 'en-camino-retiro',
    repartidorId: auth.currentUser.uid,
    acceptedAt: now,
    updatedAt: now
  });
  if (order.marketplaceOrderId) {
    await update(ref(db, `marketplaceOrders/${order.marketplaceOrderId}`), {
      orderStatus: 'assigned',
      'delivery/courierId': auth.currentUser.uid,
      updatedAt: now
    });
    await set(push(ref(db, `marketplaceOrderStatusLog/${order.marketplaceOrderId}`)), {
      status: 'assigned',
      actorId: auth.currentUser.uid,
      actorRole: 'courier',
      createdAt: now
    });
  }
  await update(ref(db, `publicTracking/${order.trackingToken}`), {
    estado: 'en-camino-retiro',
    updatedAt: now
  });

  setActiveOrder({ ...order, estado: 'en-camino-retiro', repartidorId: auth.currentUser.uid }, id);
  updateCourierMapAndRoute({ force: true }).catch(() => {});
  setStatus('Pedido aceptado. Ruta generada para el retiro.');
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    stopTracking().catch(() => {});
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    gpsStatus = 'searching';
    currentPosition = null;
    updateGpsCard();
    setStatus('');
    return;
  }

  const userRef = ref(db, `users/${user.uid}`);
  onValue(userRef, (snap) => {
    const u = snap.val();
    if (!u) {
      setStatus('Creando perfil de repartidor...');
      set(userRef, {
        email: user.email || '',
        role: 'repartidor',
        validationStatus: 'pending',
        validationRequestedAt: Date.now()
      });
      return;
    }
    if (u.role !== 'repartidor') {
      setStatus('Tu usuario no tiene rol de repartidor.');
      signOut(auth);
      return;
    }

    authSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    updateProfileState(u);
    setStatus(profileApproved ? '' : 'Tu perfil esta en revision manual (hasta 24 horas habiles).');
    ensureWallet(user.uid).catch((err) => setStatus(err.message));
    startGpsWatch();
    refreshActionButtons();

    onValue(ref(db, 'orders'), (ordersSnap) => {
      ordersCache = ordersSnap.val() || null;
      renderPedidos(ordersCache);
    });

    const activeQuery = query(ref(db, 'orders'), orderByChild('repartidorId'), equalTo(user.uid));
    onValue(activeQuery, (snapOrders) => {
      const data = snapOrders.val();
      renderHistorial(data);
      if (!data) return setActiveOrder(null, null);
      const entry = Object.entries(data).find(([, p]) => p.estado === 'en-camino')
        || Object.entries(data).find(([, p]) => p.estado === 'en-camino-retiro');
      if (!entry) return setActiveOrder(null, null);
      const [id, order] = entry;
      setActiveOrder(order, id);
      updateCourierMapAndRoute({ force: true }).catch(() => {});
    });

    const walletRef = ref(db, `wallets/${user.uid}`);
    onValue(walletRef, (snapWallet) => renderWallet(snapWallet.val()));
    const txRef = ref(db, `walletTx/${user.uid}`);
    onValue(txRef, (snapTx) => renderWalletTx(snapTx.val()));
  });
});
