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

  authInfo.textContent = user.email ? `Sesion: ${user.email}` : 'Sesion activa';
  onValue(ref(db, 'marketplaceOrders'), (snap) => {
    const all = snap.val() || {};
    const entries = Object.entries(all)
      .filter(([, o]) => o.customerId === user.uid)
      .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    ordersList.innerHTML = '';
    if (!entries.length) {
      ordersList.innerHTML = `
        <div class="empty-state">
          <strong>Sin pedidos todavia</strong>
          <div class="muted">Cuando hagas tu primer pedido, aparece aca con el seguimiento.</div>
          <a class="primary-cta" href="/marketplace">Hacer mi primer pedido</a>
        </div>
      `;
      return;
    }

    entries.forEach(([id, o]) => {
      const div = document.createElement('div');
      div.className = 'list-card';
      const status = (o.orderStatus || 'created').toString();
      const pillClass =
        status === 'delivered' ? 'good' :
        status === 'cancelled' ? 'bad' :
        status === 'preparing' || status === 'ready_for_pickup' || status === 'assigned' || status === 'picked_up' ? 'info' :
        'warn';
      div.innerHTML = `
        <div class="list-card-head">
          <div>
            <div class="list-card-title">Pedido ${id}</div>
            <div class="list-card-sub">Creado: ${fmtTime(o.createdAt)}</div>
          </div>
          <span class="status-pill ${pillClass} dot">${status}</span>
        </div>
        <div class="muted" style="margin-top:8px;">Total: <strong>${fmtMoney(o.total || 0)}</strong></div>
        <div style="margin-top:10px;">
          <a class="primary-cta" href="/orders/${encodeURIComponent(id)}">Ver estado y tracking</a>
        </div>
      `;
      ordersList.appendChild(div);
    });
  }, (err) => setStatus(err.message));
});
