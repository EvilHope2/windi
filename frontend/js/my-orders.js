import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, onValue } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, fmtTime } from './utils.js';

const authInfo = qs('authInfo');
const ordersList = qs('ordersList');
const statusEl = qs('status');

function setStatus(msg) { statusEl.textContent = msg || ''; }

onAuthStateChanged(auth, (user) => {
  if (!user) {
    authInfo.textContent = 'Inicia sesion para ver tus pedidos.';
    ordersList.innerHTML = '';
    return;
  }

  authInfo.textContent = `Sesion: ${user.email || user.uid}`;
  onValue(ref(db, 'marketplaceOrders'), (snap) => {
    const all = snap.val() || {};
    const entries = Object.entries(all)
      .filter(([, o]) => o.customerId === user.uid)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    ordersList.innerHTML = '';
    if (!entries.length) {
      ordersList.innerHTML = '<div class="item"><div class="muted">Sin pedidos todavia.</div></div>';
      return;
    }

    entries.forEach(([id, o]) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div class="row">
          <strong>Pedido ${id}</strong>
          <span class="status ${o.orderStatus || 'created'}">${o.orderStatus || 'created'}</span>
        </div>
        <div class="muted">Total: ${fmtMoney(o.total || 0)}</div>
        <div class="muted">Creado: ${fmtTime(o.createdAt)}</div>
        <a href="/orders/${encodeURIComponent(id)}">Ver detalle</a>
      `;
      ordersList.appendChild(div);
    });
  }, (err) => setStatus(err.message));
});
