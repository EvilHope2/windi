import { db } from './firebase.js';
import { ref, onValue } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, fmtTime } from './utils.js';

const detail = qs('orderDetail');
const statusEl = qs('status');
const pathParts = location.pathname.split('/').filter(Boolean);
const idFromPath = pathParts[0] === 'orders' && pathParts[1] ? pathParts[1] : null;
const id = idFromPath || new URLSearchParams(location.search).get('id');

function setStatus(msg) { statusEl.textContent = msg || ''; }

function renderStatusLog(orderId) {
  onValue(ref(db, `marketplaceOrderStatusLog/${orderId}`), (snap) => {
    const logs = snap.val() || {};
    const entries = Object.values(logs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const logHtml = entries.length
      ? entries.map((entry) => `<li>${entry.status} · ${fmtTime(entry.createdAt)} · ${entry.actorRole || 'system'}</li>`).join('')
      : '<li>Sin movimientos aun.</li>';
    const list = qs('orderStatusHistory');
    if (list) list.innerHTML = logHtml;
  }, (err) => setStatus(err.message));
}

if (!id) {
  detail.innerHTML = '<div class="muted">Falta id de pedido.</div>';
} else {
  onValue(ref(db, `marketplaceOrders/${id}`), (snap) => {
    const o = snap.val();
    if (!o) {
      detail.innerHTML = '<div class="muted">Pedido no encontrado.</div>';
      return;
    }
    const trackUrl = o.delivery?.trackingToken ? `${location.origin}/tracking.html?t=${encodeURIComponent(o.delivery.trackingToken)}` : '';
    detail.innerHTML = `
      <div class="title-row"><span class="icon">P</span><h2>Pedido ${id}</h2></div>
      <div class="item"><div class="muted">Estado</div><strong>${o.orderStatus}</strong></div>
      <div class="item"><div class="muted">Pago</div><strong>${o.paymentStatus}</strong></div>
      <div class="item"><div class="muted">Subtotal</div><strong>${fmtMoney(o.subtotalProducts)}</strong></div>
      <div class="item"><div class="muted">Envio</div><strong>${fmtMoney(o.deliveryFee)}</strong></div>
      <div class="item"><div class="muted">Total</div><strong>${fmtMoney(o.total)}</strong></div>
      <div class="item"><div class="muted">Direccion</div><strong>${o.delivery?.address || '-'}</strong></div>
      <div class="item"><div class="muted">Creado</div><strong>${fmtTime(o.createdAt)}</strong></div>
      ${trackUrl ? `<div class="item"><a href="${trackUrl}">Ver tracking del delivery</a></div>` : ''}
      <div class="item"><div class="muted">Historial de estado</div><ul id="orderStatusHistory" class="muted"></ul></div>
    `;
    renderStatusLog(id);
  }, (err) => setStatus(err.message));
}
