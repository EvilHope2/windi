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
    cartList.innerHTML = '<div class="item"><div class="muted">Carrito vacio.</div></div>';
    totals.textContent = '';
    return;
  }

  cart.items.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <strong>${item.nameSnapshot || 'Producto'}</strong>
        <span>${fmtMoney((item.unitPriceSnapshot || 0) * (item.qty || 0))}</span>
      </div>
      <div class="row">
        <button data-op="dec" class="secondary">-</button>
        <span style="text-align:center;">${item.qty}</span>
        <button data-op="inc" class="secondary">+</button>
        <button data-op="del" class="danger">Quitar</button>
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
