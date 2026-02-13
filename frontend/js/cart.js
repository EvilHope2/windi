import { qs, fmtMoney } from './utils.js';
import { getCart, saveCart, clearCart, calcSubtotal } from './marketplace-common.js';

const cartList = qs('cartList');
const merchantInfo = qs('merchantInfo');
const totals = qs('totals');
const statusEl = qs('status');

function setStatus(msg) { statusEl.textContent = msg || ''; }

function render() {
  const cart = getCart();
  cartList.innerHTML = '';
  merchantInfo.textContent = cart.merchantId ? `Comercio: ${cart.merchantName || cart.merchantId}` : 'Sin comercio seleccionado.';

  if (!cart.items.length) {
    cartList.innerHTML = `
      <div class="empty-state">
        <strong>Tu carrito esta vacio</strong>
        <div class="muted">Explora comercios y agrega productos para continuar.</div>
        <a class="primary-cta" href="/marketplace">Explorar marketplace</a>
      </div>
    `;
    totals.textContent = '';
    return;
  }

  cart.items.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'list-card';
    const lineTotal = Number(item.unitPriceSnapshot || 0) * Number(item.qty || 0);
    div.innerHTML = `
      <div class="cart-row">
        <div>
          <div class="list-card-head">
            <div>
              <div class="list-card-title">${item.nameSnapshot || 'Producto'}</div>
              <div class="list-card-sub">${fmtMoney(item.unitPriceSnapshot || 0)} c/u</div>
            </div>
            <span class="status-pill info dot">En carrito</span>
          </div>
        </div>
        <div class="right">
          <div class="cart-price">${fmtMoney(lineTotal)}</div>
          <div class="qty-stepper" aria-label="Cantidad">
            <button data-op="dec" class="secondary" type="button" aria-label="Restar">-</button>
            <span>${item.qty}</span>
            <button data-op="inc" class="secondary" type="button" aria-label="Sumar">+</button>
          </div>
          <button data-op="del" class="danger" type="button" style="width:auto; padding:8px 10px; font-size:12px;">Quitar</button>
        </div>
      </div>
    `;
    div.querySelector('[data-op="dec"]').addEventListener('click', () => updateQty(item.productId, -1));
    div.querySelector('[data-op="inc"]').addEventListener('click', () => updateQty(item.productId, 1));
    div.querySelector('[data-op="del"]').addEventListener('click', () => removeItem(item.productId));
    cartList.appendChild(div);
  });

  totals.textContent = `Subtotal productos: ${fmtMoney(calcSubtotal(cart.items))}`;
}

function updateQty(productId, delta) {
  const cart = getCart();
  const item = cart.items.find((i) => i.productId === productId);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart.items = cart.items.filter((i) => i.productId !== productId);
  saveCart(cart);
  render();
}

function removeItem(productId) {
  const cart = getCart();
  cart.items = cart.items.filter((i) => i.productId !== productId);
  if (cart.items.length === 0) {
    cart.merchantId = null;
    cart.merchantName = '';
  }
  saveCart(cart);
  render();
}

qs('clearBtn').addEventListener('click', () => {
  clearCart();
  render();
  setStatus('Carrito vaciado.');
});

render();
