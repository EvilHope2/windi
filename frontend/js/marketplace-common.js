export const COMMISSION_CONFIG = {
  rate: 0.05,
  base: 'subtotal_products' // options: subtotal_products | total
};

const CART_KEY = 'windi_marketplace_cart_v1';

export function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || 'null') || {
      merchantId: null,
      merchantName: '',
      items: [],
      updatedAt: Date.now()
    };
  } catch {
    return { merchantId: null, merchantName: '', items: [], updatedAt: Date.now() };
  }
}

export function saveCart(cart) {
  const normalized = {
    merchantId: cart.merchantId || null,
    merchantName: cart.merchantName || '',
    items: Array.isArray(cart.items) ? cart.items : [],
    updatedAt: Date.now()
  };
  localStorage.setItem(CART_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearCart() {
  localStorage.removeItem(CART_KEY);
}

export function calcSubtotal(items = []) {
  return items.reduce((acc, item) => acc + (Number(item.unitPriceSnapshot || item.price || 0) * Number(item.qty || 0)), 0);
}

export function calcCommission(subtotalProducts, total, config = COMMISSION_CONFIG) {
  const baseAmount = config.base === 'total' ? Number(total || 0) : Number(subtotalProducts || 0);
  const commissionAmount = Math.round(baseAmount * Number(config.rate || 0));
  return {
    commissionRate: Number(config.rate || 0),
    commissionBase: config.base,
    commissionAmount
  };
}

export function enforceSingleMerchant(cart, merchantId, merchantName) {
  if (!cart.merchantId || cart.merchantId === merchantId) {
    return { ok: true, cart: { ...cart, merchantId, merchantName } };
  }
  return { ok: false, cart };
}
