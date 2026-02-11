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

const authSection = qs('authSection');
const appSection = qs('appSection');
const statusEl = qs('status');
const pedidosList = qs('pedidosList');
const activoInfo = qs('activoInfo');
const startTrackingBtn = qs('startTrackingBtn');
const stopTrackingBtn = qs('stopTrackingBtn');
const deliverBtn = qs('deliverBtn');
const cancelBtn = qs('cancelBtn');
const logoutBtn = qs('logoutBtn');
const mapInfo = qs('mapInfo');
const mapContainer = qs('map');
const walletBalance = qs('walletBalance');
const walletPending = qs('walletPending');
const withdrawAmount = qs('withdrawAmount');
const withdrawBtn = qs('withdrawBtn');
const walletTx = qs('walletTx');

const MAPBOX_TOKEN = 'pk.eyJ1IjoiZGVsaXZlcnktcmcxIiwiYSI6ImNtbDZzdDg1ZDBlaTEzY29ta2k4OWVtZjIifQ.hzW7kFuwLzx2pHtCMDLPXQ';

let map = null;
let marker = null;
let routeAdded = false;
let routeCoords = [];

let activeOrder = null;
let watchId = null;
const DEFAULT_CURRENCY = 'ARS';

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

function refreshActionButtons() {
  const hasActive = !!activeOrder;
  startTrackingBtn.disabled = !hasActive;
  stopTrackingBtn.disabled = watchId === null;
  deliverBtn.disabled = !hasActive;
  cancelBtn.disabled = !hasActive;
}

function ensureMap(loc) {
  if (!map || !window.mapboxgl) {
    if (!window.mapboxgl) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: mapContainer,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [loc.lng, loc.lat],
      zoom: 15
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

function setActiveOrder(order, id) {
  if (!order) {
    activeOrder = null;
    activoInfo.textContent = 'No hay pedido activo. Acepta uno desde "Pedidos disponibles".';
    mapInfo.textContent = 'Acepta un pedido y toca "Iniciar tracking" para ver el mapa.';
    refreshActionButtons();
    return;
  }
  activeOrder = { id, trackingToken: order.trackingToken };
  const kmText = order.km != null ? `${order.km} km` : 'Km -';
  const payout = order.payout ?? order.precio;
  const pagoLabel = order.pagoMetodo === 'cash_delivery' ? 'Efectivo (cobras total)' : 'Comercio paga envio';
  activoInfo.textContent = `${order.origen} -> ${order.destino} | ${kmText} | ${fmtMoney(payout)} | ${pagoLabel}`;
  refreshActionButtons();
}

async function stopTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  refreshActionButtons();
}

function renderWallet(data) {
  const balance = data?.balance ?? 0;
  const pending = data?.pending ?? 0;
  const currency = data?.currency || DEFAULT_CURRENCY;
  walletBalance.textContent = `Saldo (${currency}): ${fmtMoney(balance)}`;
  walletPending.textContent = `Pendiente (${currency}): ${fmtMoney(pending)}`;
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

qs('signupBtn').addEventListener('click', async () => {
  const email = qs('signupEmail').value.trim();
  const password = qs('signupPassword').value.trim();
  if (!email || !password) return setStatus('Completa email y contrasena.');
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await set(ref(db, `users/${cred.user.uid}`), {
      email,
      role: 'repartidor'
    });
    await ensureWallet(cred.user.uid);
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
});

startTrackingBtn.addEventListener('click', () => {
  if (!activeOrder) return setStatus('No hay pedido activo.');
  if (!navigator.geolocation) return setStatus('Geolocalizacion no disponible.');

  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const now = Date.now();
      const updates = {
        ubicacion: { lat: latitude, lng: longitude, updatedAt: now },
        updatedAt: now
      };
      await update(ref(db, `orders/${activeOrder.id}`), updates);
      await update(ref(db, `publicTracking/${activeOrder.trackingToken}`), updates);
      mapInfo.textContent = `Ubicacion actualizada ${new Date(now).toLocaleTimeString('es-AR')}`;
      ensureMap({ lat: latitude, lng: longitude });
      updateRoute({ lat: latitude, lng: longitude });
    },
    (err) => setStatus(err.message),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );

  setStatus('Tracking activo.');
  refreshActionButtons();
});

stopTrackingBtn.addEventListener('click', () => {
  stopTracking();
  setStatus('Tracking detenido.');
});

async function markDelivered() {
  if (!activeOrder) return setStatus('No hay pedido activo.');
  const now = Date.now();
  try {
    const orderRef = ref(db, `orders/${activeOrder.id}`);
    const snap = await get(orderRef);
    const order = snap.val();
    if (!order) return setStatus('Pedido no encontrado.');
    if (order.repartidorId !== auth.currentUser.uid) {
      return setStatus('Este pedido no esta asignado a tu cuenta.');
    }
    if (order.estado !== 'en-camino') {
      return setStatus('Solo puedes entregar pedidos en estado en-camino.');
    }

    const walletRef = ref(db, `wallets/${auth.currentUser.uid}`);
    const wSnap = await get(walletRef);
    const wallet = wSnap.val() || buildDefaultWallet();

    if (!order.payoutApplied) {
      if (order.pagoMetodo === 'cash_delivery') {
        const comision = order.comision ?? 0;
        const newBalance = (wallet.balance || 0) - comision;
        const totalCommissions = (wallet.totalCommissions || 0) + Math.abs(comision);
        await update(walletRef, { balance: newBalance, totalCommissions, updatedAt: now });
        const txRef = push(ref(db, `walletTx/${auth.currentUser.uid}`));
        await set(txRef, { type: 'commission', amount: -comision, createdAt: now, orderId: activeOrder.id });
      } else {
        const payout = order.payout ?? order.precio ?? 0;
        const newBalance = (wallet.balance || 0) + payout;
        const totalEarned = (wallet.totalEarned || 0) + payout;
        await update(walletRef, { balance: newBalance, totalEarned, updatedAt: now });
        const txRef = push(ref(db, `walletTx/${auth.currentUser.uid}`));
        await set(txRef, { type: 'credit', amount: payout, createdAt: now, orderId: activeOrder.id });
      }
    }

    await update(orderRef, {
      estado: 'entregado',
      entregadoAt: now,
      updatedAt: now,
      payoutApplied: true
    });
    if (activeOrder.trackingToken) {
      await update(ref(db, `publicTracking/${activeOrder.trackingToken}`), {
        estado: 'entregado',
        updatedAt: now
      });
    }

    await stopTracking();
    setActiveOrder(null, null);
    setStatus('Pedido entregado.');
  } catch (err) {
    setStatus(err.message);
  }
}

deliverBtn.addEventListener('click', markDelivered);

cancelBtn.addEventListener('click', async () => {
  if (!activeOrder) return setStatus('No hay pedido activo.');
  const now = Date.now();
  try {
    await update(ref(db, `orders/${activeOrder.id}`), {
      estado: 'cancelado',
      canceledAt: now,
      updatedAt: now
    });
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

  Object.entries(data).reverse().forEach(([id, p]) => {
    const div = document.createElement('div');
    div.className = 'item';
    const kmText = p.km != null ? `${p.km} km` : 'Km -';
    const payout = p.payout ?? p.precio;
    const pagoLabel = p.pagoMetodo === 'cash_delivery' ? `Efectivo (cobras ${fmtMoney(p.totalPedido)})` : 'Comercio paga envio';
    div.innerHTML = `
      <div class="row">
        <strong>${p.origen} -> ${p.destino}</strong>
        <span class="status ${p.estado}">${p.estado}</span>
      </div>
      <div class="muted">${kmText} | Tarifa: ${fmtMoney(payout)}</div>
      <div class="muted">Pago: ${pagoLabel}</div>
      <div class="muted">Notas: ${p.notas || '-'}</div>
      <button data-id="${id}">Aceptar</button>
    `;
    div.querySelector('button').addEventListener('click', () => aceptarPedido(id));
    pedidosList.appendChild(div);
  });
}

async function aceptarPedido(id) {
  const orderSnap = await get(ref(db, `orders/${id}`));
  const order = orderSnap.val();
  if (!order) return setStatus('Pedido no encontrado.');

  const now = Date.now();
  await update(ref(db, `orders/${id}`), {
    estado: 'en-camino',
    repartidorId: auth.currentUser.uid,
    acceptedAt: now,
    updatedAt: now
  });
  await update(ref(db, `publicTracking/${order.trackingToken}`), {
    estado: 'en-camino',
    updatedAt: now
  });

  setActiveOrder(order, id);
  setStatus('Pedido aceptado.');
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
      setStatus('Creando perfil de repartidor...');
      set(userRef, { email: user.email || '', role: 'repartidor' });
      return;
    }
    if (u.role !== 'repartidor') {
      setStatus('Tu usuario no tiene rol de repartidor.');
      signOut(auth);
      return;
    }

    authSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    setStatus('');
    ensureWallet(user.uid).catch((err) => setStatus(err.message));
    refreshActionButtons();

    const q = query(ref(db, 'orders'), orderByChild('estado'), equalTo('buscando'));
    onValue(q, (ordersSnap) => renderPedidos(ordersSnap.val()));

    const activeQuery = query(ref(db, 'orders'), orderByChild('repartidorId'), equalTo(user.uid));
    onValue(activeQuery, (snapOrders) => {
      const data = snapOrders.val();
      if (!data) return setActiveOrder(null, null);
      const entry = Object.entries(data).find(([, p]) => p.estado === 'en-camino');
      if (!entry) return setActiveOrder(null, null);
      const [id, order] = entry;
      setActiveOrder(order, id);
      if (order.ubicacion) {
        ensureMap(order.ubicacion);
        updateRoute(order.ubicacion);
      }
    });

    const walletRef = ref(db, `wallets/${user.uid}`);
    onValue(walletRef, (snapWallet) => renderWallet(snapWallet.val()));
    const txRef = ref(db, `walletTx/${user.uid}`);
    onValue(txRef, (snapTx) => renderWalletTx(snapTx.val()));
  });
});
