import { auth, db } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, onValue, get } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, fmtTime } from './utils.js';

const detail = qs('orderDetail');
const statusEl = qs('status');
const pathParts = location.pathname.split('/').filter(Boolean);
const idFromPath = pathParts[0] === 'orders' && pathParts[1] ? pathParts[1] : null;
const id = idFromPath || new URLSearchParams(location.search).get('id');

function setStatus(msg) { statusEl.textContent = msg || ''; }

let currentUid = null;
onAuthStateChanged(auth, (u) => { currentUid = u ? u.uid : null; });

function stepperModel(status) {
  const s = String(status || 'created');
  const steps = [
    { key: 'created', label: 'Pedido creado' },
    { key: 'confirmed', label: 'Confirmado' },
    { key: 'preparing', label: 'Preparando' },
    { key: 'ready_for_pickup', label: 'Listo para retirar' },
    { key: 'assigned', label: 'Repartidor asignado' },
    { key: 'picked_up', label: 'En camino' },
    { key: 'delivered', label: 'Entregado' }
  ];

  if (s === 'cancelled') {
    return {
      steps: [
        { key: 'created', label: 'Pedido creado' },
        { key: 'cancelled', label: 'Cancelado' }
      ],
      active: 'cancelled'
    };
  }

  const idx = Math.max(0, steps.findIndex((x) => x.key === s));
  const active = steps[idx] ? steps[idx].key : 'created';
  return { steps, active };
}

function renderStepper(status) {
  const { steps, active } = stepperModel(status);
  const activeIdx = steps.findIndex((x) => x.key === active);
  const html = steps.map((st, i) => {
    const cls = i < activeIdx ? 'done' : (i === activeIdx ? 'active' : '');
    const num = i < activeIdx ? '?' : String(i + 1);
    return `
      <div class="step ${cls}">
        <div class="dot">${num}</div>
        <div>
          <div class="label">${st.label}</div>
          <div class="time">${i === activeIdx ? 'Estado actual' : ''}</div>
        </div>
      </div>
    `;
  }).join('');
  return `<div class="stepper">${html}</div>`;
}

function renderStatusLog(orderId) {
  onValue(ref(db, `marketplaceOrderStatusLog/${orderId}`), (snap) => {
    const logs = snap.val() || {};
    const entries = Object.values(logs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const logHtml = entries.length
      ? entries.map((entry) => `<li>${entry.status} ? ${fmtTime(entry.createdAt)} ? ${entry.actorRole || 'system'}</li>`).join('')
      : '<li>Sin movimientos aun.</li>';
    const list = qs('orderStatusHistory');
    if (list) list.innerHTML = logHtml;
  }, (err) => setStatus(err.message));
}

let pinLoaded = false;

async function loadPinOnce(orderId) {
  if (pinLoaded) return;
  pinLoaded = true;
  try {
    const pinSnap = await get(ref(db, `orderPins/${orderId}`));
    const pin = pinSnap.val() || {};
    const code = String(pin.code || '').trim();
    const box = qs('pinBox');
    if (box) {
      box.innerHTML = `Codigo de entrega: <strong>${code ? code : '----'}</strong>`;
    }
  } catch {
    // ignore
  }
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
    const status = String(o.orderStatus || 'created');
    const paymentStatus = String(o.paymentStatus || '');
    const canPayNow = String(o.paymentMethod || '') === 'mp_card' && paymentStatus === 'pending' && o.mpCheckoutUrl;
    const canSeePin = !!(currentUid && String(o.customerId || '') === String(currentUid));

    const pillClass =
      status === 'delivered' ? 'good' :
      status === 'cancelled' ? 'bad' :
      status === 'preparing' || status === 'ready_for_pickup' || status === 'assigned' || status === 'picked_up' ? 'info' :
      'warn';

    detail.innerHTML = `
      <div class="title-row"><span class="icon">P</span><h2>Pedido ${id}</h2></div>
      <div class="list-card" style="margin-top:10px;">
        <div class="list-card-head">
          <div>
            <div class="list-card-title">Estado</div>
            <div class="list-card-sub">${fmtTime(o.updatedAt || o.createdAt)}</div>
          </div>
          <span class="status-pill ${pillClass} dot">${status}</span>
        </div>
        ${renderStepper(status)}
        ${trackUrl ? `<div style="margin-top:12px;"><a class="primary-cta" href="${trackUrl}">Ver tracking en vivo</a></div>` : ''}
      </div>

      <div class="list-card" style="margin-top:10px;">
        <div class="list-card-title">Resumen</div>
        <div class="list-card-sub">Direccion: ${o.delivery?.address || '-'}</div>
        <div class="muted" style="margin-top:10px;">Subtotal: <strong>${fmtMoney(o.subtotalProducts)}</strong></div>
        <div class="muted">Envio: <strong>${fmtMoney(o.deliveryFee)}</strong></div>
        <div class="muted">Total: <strong>${fmtMoney(o.total)}</strong></div>
        <div class="muted">Pago: <strong>${paymentStatus || '-'}</strong></div>
        ${canSeePin ? `<div id="pinBox" class="muted" style="margin-top:10px;">Codigo de entrega: <strong>----</strong></div><div class="muted" style="font-size:12px;">Mostralo al repartidor al recibir. No lo compartas por chat.</div>` : ''}
        ${canPayNow ? `<div class="row" style="margin-top:12px;"><button id="payNowBtn" type="button">Pagar ahora (Mercado Pago)</button></div>` : ''}
      </div>

      <div class="list-card" style="margin-top:10px;">
        <div class="list-card-title">Historial</div>
        <ul id="orderStatusHistory" class="muted" style="margin:8px 0 0; padding-left:18px;"></ul>
      </div>
    `;

    const payBtn = qs('payNowBtn');
    if (payBtn && o.mpCheckoutUrl) {
      payBtn.addEventListener('click', () => {
        window.location.href = o.mpCheckoutUrl;
      });
    }

    renderStatusLog(id);

    if (canSeePin) {
      loadPinOnce(id).catch(() => {});
    }
  }, (err) => setStatus(err.message));
}
