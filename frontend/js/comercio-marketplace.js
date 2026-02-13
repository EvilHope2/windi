import { auth, db } from './firebase.js';
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  ref,
  onValue,
  set,
  update,
  push,
  get,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, fmtTime } from './utils.js';

const authSection = qs('authSection');
const appSection = qs('appSection');
const productsList = qs('productsList');
const ordersList = qs('ordersList');
const statusEl = qs('status');

let currentUser = null;
let editingId = null;
let allProducts = {};
let allOrders = {};
const ALLOWED_STATUS = ['confirmed', 'preparing', 'ready_for_pickup', 'cancelled'];

function setStatus(msg) { statusEl.textContent = msg || ''; }

async function ensureMerchantProfile(uid, email) {
  const snap = await get(ref(db, `merchants/${uid}`));
  if (snap.exists()) return;
  await set(ref(db, `merchants/${uid}`), {
    name: email || 'Comercio',
    address: '',
    geo: null,
    whatsapp: '',
    status: 'active',
    createdAt: Date.now()
  });
}

function renderProducts() {
  productsList.innerHTML = '';
  const entries = Object.entries(allProducts).filter(([, p]) => p.merchantId === currentUser.uid);
  if (!entries.length) {
    productsList.innerHTML = '<div class="item"><div class="muted">Sin productos.</div></div>';
    return;
  }

  entries.forEach(([id, p]) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <strong>${p.name}</strong>
        <span>${fmtMoney(p.price || 0)}</span>
      </div>
      <div class="muted">Categoria: ${p.category || 'general'} | Stock: ${p.stock ?? '-'}</div>
      <div class="muted">${p.isActive === false ? 'Inactivo' : 'Activo'}</div>
      <div class="row">
        <button data-act="edit" class="secondary">Editar</button>
        <button data-act="toggle" class="secondary">${p.isActive === false ? 'Activar' : 'Desactivar'}</button>
        <button data-act="delete" class="danger">Eliminar</button>
      </div>
    `;
    div.querySelector('[data-act="edit"]').addEventListener('click', () => loadProductForEdit(id, p));
    div.querySelector('[data-act="toggle"]').addEventListener('click', () => update(ref(db, `products/${id}`), { isActive: p.isActive === false }));
    div.querySelector('[data-act="delete"]').addEventListener('click', () => update(ref(db, `products/${id}`), { isActive: false, deletedAt: Date.now() }));
    productsList.appendChild(div);
  });
}

function loadProductForEdit(id, p) {
  editingId = id;
  qs('pName').value = p.name || '';
  qs('pDesc').value = p.description || '';
  qs('pPrice').value = p.price || 0;
  qs('pCategory').value = p.category || '';
  qs('pImage').value = p.imageUrl || '';
  qs('pStock').value = p.stock ?? '';
}

function renderOrders() {
  ordersList.innerHTML = '';
  const entries = Object.entries(allOrders)
    .filter(([, o]) => o.merchantId === currentUser.uid)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  if (!entries.length) {
    ordersList.innerHTML = '<div class="item"><div class="muted">Sin pedidos marketplace.</div></div>';
    return;
  }

  entries.forEach(([id, o]) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <strong>Pedido ${id}</strong>
        <span class="status ${o.orderStatus}">${o.orderStatus}</span>
      </div>
      <div class="muted">Total: ${fmtMoney(o.total || 0)} | Creado: ${fmtTime(o.createdAt)}</div>
      <div class="muted">Direccion: ${o.delivery?.address || '-'}</div>
      <div class="row">
        <button data-s="confirmed" class="secondary">Confirmar</button>
        <button data-s="preparing" class="secondary">Preparando</button>
        <button data-s="ready_for_pickup">Listo para retiro</button>
        <button data-s="cancelled" class="danger">Cancelar</button>
      </div>
    `;
    div.querySelectorAll('button[data-s]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await setOrderStatus(id, o, btn.getAttribute('data-s'));
        } catch (err) {
          setStatus(err.message);
        }
      });
    });
    ordersList.appendChild(div);
  });
}

async function setOrderStatus(orderId, order, status) {
  if (!ALLOWED_STATUS.includes(status)) {
    setStatus('Estado no permitido.');
    return;
  }
  const now = Date.now();
  if (status === 'confirmed' && order.stockReserved !== true) {
    for (const item of order.items || []) {
      const stockRef = ref(db, `products/${item.productId}/stock`);
      const qty = Number(item.qty || 0);
      if (qty <= 0) continue;
      const tx = await runTransaction(stockRef, (currentStock) => {
        if (currentStock == null) return currentStock;
        if (Number(currentStock) < qty) return;
        return Number(currentStock) - qty;
      });
      if (!tx.committed && tx.snapshot.val() != null) {
        throw new Error(`Stock insuficiente para ${item.nameSnapshot || item.productId}.`);
      }
    }
  }

  await update(ref(db, `marketplaceOrders/${orderId}`), {
    orderStatus: status,
    stockReserved: status === 'confirmed' || order.stockReserved === true,
    updatedAt: now
  });
  await set(push(ref(db, `marketplaceOrderStatusLog/${orderId}`)), {
    status,
    actorId: currentUser.uid,
    actorRole: 'merchant',
    createdAt: now
  });

  if (order.deliveryOrderId) {
    const deliveryState =
      status === 'ready_for_pickup' ? 'buscando' :
      status === 'cancelled' ? 'cancelado' :
      'esperando-comercio';
    await update(ref(db, `orders/${order.deliveryOrderId}`), {
      estado: deliveryState,
      updatedAt: now
    });
    const token = order.delivery?.trackingToken;
    if (token) {
      await update(ref(db, `publicTracking/${token}`), {
        estado: deliveryState,
        updatedAt: now
      });
    }
  }
  setStatus(`Pedido ${orderId} -> ${status}`);
}

qs('loginBtn').addEventListener('click', async () => {
  try {
    await signInWithEmailAndPassword(auth, qs('loginEmail').value.trim(), qs('loginPassword').value.trim());
  } catch (err) {
    setStatus(err.message);
  }
});

qs('logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
});

qs('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const payload = {
    merchantId: currentUser.uid,
    name: qs('pName').value.trim(),
    description: qs('pDesc').value.trim(),
    price: Number(qs('pPrice').value || 0),
    category: qs('pCategory').value.trim() || 'general',
    imageUrl: qs('pImage').value.trim(),
    stock: qs('pStock').value ? Number(qs('pStock').value) : null,
    isActive: true,
    updatedAt: Date.now()
  };

  if (!payload.name || payload.price <= 0) return setStatus('Nombre y precio validos son obligatorios.');

  try {
    if (editingId) {
      await update(ref(db, `products/${editingId}`), payload);
      editingId = null;
    } else {
      const r = push(ref(db, 'products'));
      await set(r, { ...payload, createdAt: Date.now() });
    }
    e.target.reset();
    setStatus('Producto guardado.');
  } catch (err) {
    setStatus(err.message);
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    return;
  }

  const userSnap = await get(ref(db, `users/${user.uid}`));
  const userData = userSnap.val() || {};
  if (userData.role !== 'comercio') {
    setStatus('Tu usuario no tiene rol comercio.');
    await signOut(auth);
    return;
  }
  if (userData.status !== 'activo') {
    setStatus('Tu comercio esta pendiente o rechazado. Debe estar activo para usar Marketplace.');
    await signOut(auth);
    return;
  }

  currentUser = user;
  await ensureMerchantProfile(user.uid, user.email || '');

  authSection.classList.add('hidden');
  appSection.classList.remove('hidden');
  setStatus('');

  onValue(ref(db, 'products'), (snap) => {
    allProducts = snap.val() || {};
    renderProducts();
  });

  onValue(ref(db, 'marketplaceOrders'), (snap) => {
    allOrders = snap.val() || {};
    renderOrders();
  });
});
