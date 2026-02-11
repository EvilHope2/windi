import { auth, db } from './firebase.js';
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  ref,
  get,
  onValue,
  update,
  push,
  set
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, fmtTime } from './utils.js';

const authSection = qs('authSection');
const appSection = qs('appSection');
const statusEl = qs('status');
const loginEmail = qs('loginEmail');
const loginPassword = qs('loginPassword');
const loginBtn = qs('loginBtn');
const logoutBtn = qs('logoutBtn');
const searchInput = qs('searchInput');
const resultsInfo = qs('resultsInfo');
const deliveryList = qs('deliveryList');
const deliveryDetail = qs('deliveryDetail');
const walletDetail = qs('walletDetail');
const walletAdjustAmount = qs('walletAdjustAmount');
const walletAdjustReason = qs('walletAdjustReason');
const walletAdjustBtn = qs('walletAdjustBtn');
const tripList = qs('tripList');

let allDeliveries = {};
let wallets = {};
let selectedUid = null;
let hasAdminAccess = false;

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

async function isAdmin(uid) {
  const snap = await get(ref(db, `admins/${uid}`));
  return snap.val() === true;
}

function deliveryMatchesQuery(delivery, queryText) {
  if (!queryText) return true;
  const q = queryText.toLowerCase();
  const name = (delivery.nombreApellido || '').toLowerCase();
  const dni = String(delivery.dni || '');
  return name.includes(q) || dni.includes(q);
}

function renderTripsForSelected() {
  tripList.innerHTML = '';
  const queryText = (searchInput.value || '').trim();
  if (!queryText || !selectedUid) {
    tripList.innerHTML = '<div class="item"><div class="muted">Busca y selecciona un repartidor para ver sus viajes.</div></div>';
    return;
  }

  const entries = Object.entries(window.__adminOrders || {})
    .filter(([, o]) => o.repartidorId === selectedUid)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 50);

  if (entries.length === 0) {
    tripList.innerHTML = '<div class="item"><div class="muted">No hay viajes para este repartidor.</div></div>';
    return;
  }

  entries.forEach(([id, o]) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <strong>${o.origen || '-'} -> ${o.destino || '-'}</strong>
        <span class="status ${o.estado || ''}">${o.estado || 'sin-estado'}</span>
      </div>
      <div class="muted">Envio: ${fmtMoney(o.precio || 0)} | Pago repartidor: ${fmtMoney(o.payout || o.precio || 0)}</div>
      <div class="muted">Actualizado: ${fmtTime(o.updatedAt)}</div>
      <div class="muted">Pedido: ${id}</div>
    `;
    tripList.appendChild(div);
  });
}

function renderSelectedDelivery() {
  if (!selectedUid || !allDeliveries[selectedUid]) {
    deliveryDetail.textContent = 'Selecciona un repartidor desde los resultados.';
    walletDetail.textContent = 'Sin seleccion.';
    renderTripsForSelected();
    return;
  }

  const d = allDeliveries[selectedUid];
  const w = wallets[selectedUid] || {};
  const validationStatus = d.validationStatus || 'pending';
  const restricted = d.restricted === true;

  deliveryDetail.innerHTML = `
    <div class="item">
      <div><strong>${d.nombreApellido || 'Sin nombre'}</strong></div>
      <div class="muted">UID: ${selectedUid}</div>
      <div class="muted">Email: ${d.email || '-'}</div>
      <div class="muted">DNI: ${d.dni || '-'}</div>
      <div class="muted">Vehiculo: ${d.vehiculoTipo || '-'} ${d.patente ? `| Patente: ${d.patente}` : ''}</div>
      <div class="muted">WhatsApp: ${d.whatsapp || '-'}</div>
      <div class="muted">Validacion: ${validationStatus}</div>
      <div class="muted">Restriccion: ${restricted ? 'Activa' : 'No'}</div>
      <div class="row">
        <button data-action="approve">Aprobar</button>
        <button data-action="pending" class="secondary">Poner pendiente</button>
        <button data-action="reject" class="danger">Rechazar</button>
      </div>
      <div class="row">
        <input id="restrictReason" type="text" placeholder="Motivo de restriccion" />
        <button data-action="restrict" class="danger">Restringir cuenta</button>
        <button data-action="unrestrict" class="secondary">Quitar restriccion</button>
      </div>
    </div>
  `;

  walletDetail.innerHTML = `
    <div class="item">
      <div class="muted">Saldo: ${fmtMoney(w.balance || 0)}</div>
      <div class="muted">Pendiente: ${fmtMoney(w.pending || 0)}</div>
      <div class="muted">Total ganado: ${fmtMoney(w.totalEarned || 0)}</div>
      <div class="muted">Total comisiones: ${fmtMoney(w.totalCommissions || 0)}</div>
      <div class="muted">Total retirado: ${fmtMoney(w.totalWithdrawn || 0)}</div>
    </div>
  `;

  deliveryDetail.querySelector('[data-action="approve"]').addEventListener('click', () => setValidation('approved'));
  deliveryDetail.querySelector('[data-action="pending"]').addEventListener('click', () => setValidation('pending'));
  deliveryDetail.querySelector('[data-action="reject"]').addEventListener('click', () => setValidation('rejected'));
  deliveryDetail.querySelector('[data-action="restrict"]').addEventListener('click', () => setRestriction(true));
  deliveryDetail.querySelector('[data-action="unrestrict"]').addEventListener('click', () => setRestriction(false));

  renderTripsForSelected();
}

function renderDeliveryList() {
  const queryText = (searchInput.value || '').trim();
  const deliveries = Object.entries(allDeliveries)
    .filter(([, d]) => d.role === 'repartidor')
    .filter(([, d]) => deliveryMatchesQuery(d, queryText))
    .sort((a, b) => (b[1].validationRequestedAt || 0) - (a[1].validationRequestedAt || 0));

  deliveryList.innerHTML = '';
  if (deliveries.length === 0) {
    deliveryList.innerHTML = '<div class="item"><div class="muted">Sin resultados para la busqueda.</div></div>';
    resultsInfo.textContent = '0 repartidores encontrados.';
    selectedUid = null;
    renderSelectedDelivery();
    return;
  }

  if (!selectedUid || !deliveries.some(([uid]) => uid === selectedUid)) {
    selectedUid = deliveries[0][0];
  }

  resultsInfo.textContent = `${deliveries.length} repartidores encontrados.`;
  deliveries.forEach(([uid, d]) => {
    const div = document.createElement('div');
    div.className = 'item';
    const selected = uid === selectedUid ? ' (seleccionado)' : '';
    div.innerHTML = `
      <div class="row">
        <strong>${d.nombreApellido || 'Sin nombre'}${selected}</strong>
        <span class="status ${d.validationStatus || 'pending'}">${d.validationStatus || 'pending'}</span>
      </div>
      <div class="muted">DNI: ${d.dni || '-'} | Vehiculo: ${d.vehiculoTipo || '-'}</div>
      <div class="muted">WhatsApp: ${d.whatsapp || '-'}</div>
      <div class="muted">${d.restricted ? 'Cuenta restringida' : 'Cuenta activa'}</div>
      <button data-uid="${uid}" class="secondary">Ver detalle</button>
    `;
    div.querySelector('button').addEventListener('click', () => {
      selectedUid = uid;
      renderDeliveryList();
      renderSelectedDelivery();
    });
    deliveryList.appendChild(div);
  });
}

async function setValidation(validationStatus) {
  if (!selectedUid) return;
  await update(ref(db, `users/${selectedUid}`), {
    validationStatus,
    validationUpdatedAt: Date.now()
  });
  setStatus(`Estado actualizado a ${validationStatus}.`);
}

async function setRestriction(restricted) {
  if (!selectedUid) return;
  const reasonInput = document.getElementById('restrictReason');
  const reason = reasonInput ? reasonInput.value.trim() : '';
  await update(ref(db, `users/${selectedUid}`), {
    restricted,
    restrictedReason: restricted ? reason || 'Restringida por admin' : null,
    restrictedAt: restricted ? Date.now() : null,
    restrictedBy: restricted ? auth.currentUser.uid : null
  });
  setStatus(restricted ? 'Cuenta restringida.' : 'Restriccion removida.');
}

async function adjustWallet() {
  if (!selectedUid) return setStatus('Selecciona un repartidor.');
  const amount = Number(walletAdjustAmount.value);
  const reason = walletAdjustReason.value.trim();
  if (Number.isNaN(amount) || amount === 0) return setStatus('Ingresa un ajuste valido (+/-).');
  if (!reason) return setStatus('Ingresa motivo del ajuste.');

  const walletRef = ref(db, `wallets/${selectedUid}`);
  const snap = await get(walletRef);
  const wallet = snap.val() || {
    balance: 0,
    pending: 0,
    totalEarned: 0,
    totalCommissions: 0,
    totalWithdrawn: 0,
    currency: 'ARS',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const now = Date.now();
  const newBalance = (wallet.balance || 0) + amount;
  await update(walletRef, {
    balance: newBalance,
    updatedAt: now
  });

  const txRef = push(ref(db, `walletTx/${selectedUid}`));
  await set(txRef, {
    type: 'admin_adjustment',
    amount,
    reason,
    createdAt: now,
    adminUid: auth.currentUser.uid
  });

  walletAdjustAmount.value = '';
  walletAdjustReason.value = '';
  setStatus('Ajuste de wallet aplicado.');
}

loginBtn.addEventListener('click', async () => {
  const email = loginEmail.value.trim();
  const password = loginPassword.value.trim();
  if (!email || !password) return setStatus('Completa email y contrasena.');
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
});

searchInput.addEventListener('input', () => {
  renderDeliveryList();
  renderTripsForSelected();
});

walletAdjustBtn.addEventListener('click', adjustWallet);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    hasAdminAccess = false;
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    setStatus('');
    return;
  }

  try {
    hasAdminAccess = await isAdmin(user.uid);
    if (!hasAdminAccess) {
      setStatus('Tu cuenta no tiene permisos de admin.');
      await signOut(auth);
      return;
    }
  } catch (err) {
    setStatus(err.message);
    return;
  }

  authSection.classList.add('hidden');
  appSection.classList.remove('hidden');
  setStatus('');

  onValue(ref(db, 'users'), (snap) => {
    allDeliveries = snap.val() || {};
    renderDeliveryList();
    renderSelectedDelivery();
  });

  onValue(ref(db, 'wallets'), (snap) => {
    wallets = snap.val() || {};
    renderSelectedDelivery();
  });

  onValue(ref(db, 'orders'), (snap) => {
    window.__adminOrders = snap.val() || {};
    renderTripsForSelected();
  });
});
