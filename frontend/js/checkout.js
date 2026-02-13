import { auth, db } from './firebase.js';
import { onAuthStateChanged, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, get, set, push, update } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney, generateToken } from './utils.js';
import { getCart, clearCart, calcSubtotal, calcCommission, COMMISSION_CONFIG } from './marketplace-common.js';
import { attachRioGrandeAutocomplete } from './address-autocomplete.js';
import { getMapboxToken } from './mapbox-token.js';

const DEFAULT_DELIVERY_BASE_FEE = 1500;
const DEFAULT_DELIVERY_PER_KM = 500;
const DEFAULT_COURIER_COMMISSION_RATE = 0.15;
const RIO_GRANDE_BBOX = [-68.0, -54.15, -67.25, -53.55];
const BACKEND_BASE_URL = 'https://windi-01ia.onrender.com';

const summary = qs('summary');
const statusEl = qs('status');
const authState = qs('authState');
const shippingHint = qs('shippingHint');
const deliveryAddressInput = qs('deliveryAddress');
const customerWhatsappInput = qs('customerWhatsapp');
const submitBtn = qs('checkoutForm button[type="submit"]');

let currentUser = null;
let currentUserProfile = null;
let deliveryAutocomplete = null;
let lastQuote = null;
let quoteState = 'idle';
let quoteErrorMessage = '';

function setStatus(msg) { statusEl.textContent = msg || ''; }
function setShippingHint(msg) { if (shippingHint) shippingHint.textContent = msg || ''; }

function normalizeArWhatsApp(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  const noLeading0 = digits.startsWith('0') ? digits.slice(1) : digits;
  if (noLeading0.startsWith('54')) return `+${noLeading0}`;
  return `+54${noLeading0}`;
}

function inferCustomerName(user, profile) {
  const fromProfile = (profile?.nombreApellido || profile?.name || '').toString().trim();
  if (fromProfile) return fromProfile;
  const email = (user?.email || '').toString();
  if (email.includes('@')) return email.split('@')[0];
  return 'Cliente';
}

function parseMoney(value) {
  const num = Number(value || 0);
  return Number.isNaN(num) ? 0 : num;
}

function computeCourierCommission(deliveryFee, rate = DEFAULT_COURIER_COMMISSION_RATE) {
  const fee = Number(deliveryFee || 0);
  const r = Number(rate || 0);
  const commission = Math.round(fee * r);
  return {
    courierCommissionRate: r,
    courierCommissionAmount: commission,
    courierPayout: Math.round(fee - commission)
  };
}

function pointInRioGrandeBBox(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return lng >= RIO_GRANDE_BBOX[0]
    && lng <= RIO_GRANDE_BBOX[2]
    && lat >= RIO_GRANDE_BBOX[1]
    && lat <= RIO_GRANDE_BBOX[3];
}

function parseScheduleRange(scheduleText) {
  if (!scheduleText) return null;
  const text = String(scheduleText).toLowerCase();
  const match = text.match(/(\d{1,2})[:.](\d{2})\s*(?:a|-|hasta)\s*(\d{1,2})[:.](\d{2})/i);
  if (!match) return null;
  const openH = Number(match[1]);
  const openM = Number(match[2]);
  const closeH = Number(match[3]);
  const closeM = Number(match[4]);
  if (![openH, openM, closeH, closeM].every(Number.isFinite)) return null;
  if (openH < 0 || openH > 23 || closeH < 0 || closeH > 23 || openM < 0 || openM > 59 || closeM < 0 || closeM > 59) return null;
  return {
    openMin: openH * 60 + openM,
    closeMin: closeH * 60 + closeM
  };
}

function isOpenBySchedule(scheduleText) {
  const range = parseScheduleRange(scheduleText);
  if (!range) return true;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (range.closeMin >= range.openMin) {
    return nowMin >= range.openMin && nowMin < range.closeMin;
  }
  return nowMin >= range.openMin || nowMin < range.closeMin;
}

function merchantIsOpen(merchant) {
  const mode = (merchant?.openingMode || '').toLowerCase();
  if (mode === 'manual') return merchant?.manualOpen !== false;
  if (typeof merchant?.isOpen === 'boolean') return merchant.isOpen;
  return isOpenBySchedule(merchant?.schedule || merchant?.horario || '');
}

function getSelectedAddress() {
  if (!deliveryAutocomplete) return null;
  return deliveryAutocomplete.getSelected();
}

function getSelectedCoords() {
  const selected = getSelectedAddress();
  if (!selected) return null;
  const lng = Number(selected.lng);
  const lat = Number(selected.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

async function geocode(address) {
  const token = await getMapboxToken();
  if (!token) throw new Error('Mapbox no configurado.');
  const query = `${address}, Rio Grande, Tierra del Fuego, Argentina`;
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=5&bbox=${RIO_GRANDE_BBOX.join(',')}&country=AR&types=address,poi`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo geocodificar la direccion.');
  const data = await res.json();
  const features = Array.isArray(data.features) ? data.features : [];
  const feature = features.find((f) => pointInRioGrandeBBox(f.center));
  if (!feature) throw new Error('Direccion fuera de Rio Grande, Tierra del Fuego.');
  return feature.center;
}

async function routeDistanceKm(origin, destination) {
  const token = await getMapboxToken();
  if (!token) throw new Error('Mapbox no configurado.');
  const profiles = ['driving', 'walking'];
  for (const profile of profiles) {
    const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?access_token=${token}&overview=false`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (route && Number(route.distance) > 0) return route.distance / 1000;
  }
  throw new Error('Ruta no encontrada para el envio.');
}

async function quoteDeliveryFee(cart, customerCoords, customerAddress) {
  if (!cart?.merchantId || !customerCoords || !customerAddress) {
    return {
      km: null,
      fee: DEFAULT_DELIVERY_BASE_FEE,
      merchantCoords: null,
      customerCoords: null
    };
  }

  const merchantSnap = await get(ref(db, `merchants/${cart.merchantId}`));
  const merchant = merchantSnap.val() || {};

  let merchantCoords = null;
  if (merchant.geo && Number.isFinite(Number(merchant.geo.lng)) && Number.isFinite(Number(merchant.geo.lat))) {
    merchantCoords = [Number(merchant.geo.lng), Number(merchant.geo.lat)];
  } else if (merchant.address) {
    merchantCoords = await geocode(merchant.address);
  }
  if (!merchantCoords) throw new Error('El comercio no tiene ubicacion valida.');

  const perKm = Number(merchant.deliveryPerKm || DEFAULT_DELIVERY_PER_KM);
  const baseFee = Number(merchant.deliveryBaseFee || DEFAULT_DELIVERY_BASE_FEE);
  let roundedKm = null;
  try {
    const km = await routeDistanceKm(merchantCoords, customerCoords);
    roundedKm = Math.round(km * 10) / 10;
  } catch (err) {
    // If routing fails (e.g. Mapbox returns no route), we still allow checkout using base fee.
    roundedKm = null;
  }
  const fee = Math.round(baseFee + (roundedKm == null ? 0 : roundedKm) * perKm);

  return {
    km: roundedKm,
    fee,
    merchantCoords: { lng: merchantCoords[0], lat: merchantCoords[1] },
    customerCoords: { lng: customerCoords[0], lat: customerCoords[1] },
    merchantAddress: merchant.address || null,
    deliveryBaseFee: baseFee,
    deliveryPerKm: perKm
  };
}

function buildSummary() {
  const cart = getCart();
  summary.innerHTML = '';
  if (!cart.items.length || !cart.merchantId) {
    summary.innerHTML = '<div class="item"><div class="muted">Carrito vacio.</div></div>';
    if (submitBtn) submitBtn.disabled = true;
    return null;
  }

  const selected = getSelectedAddress();
  const hasValidAddress = !!(selected && deliveryAutocomplete && deliveryAutocomplete.isSelectionValid());
  const subtotalProducts = calcSubtotal(cart.items);
  const deliveryFee = hasValidAddress ? parseMoney(lastQuote?.fee ?? DEFAULT_DELIVERY_BASE_FEE) : 0;
  const total = subtotalProducts + deliveryFee;
  const commission = calcCommission(subtotalProducts, total, COMMISSION_CONFIG);
  const payoutMerchant = subtotalProducts - commission.commissionAmount;
  const itemCount = cart.items.reduce((acc, item) => acc + Number(item.qty || 0), 0);

  const productsHtml = cart.items.map((item) => {
    const lineTotal = Number(item.unitPriceSnapshot || 0) * Number(item.qty || 0);
    return `<div class="checkout-line"><div class="checkout-line-left"><strong>${item.nameSnapshot || 'Producto'}</strong><span class="muted">x${item.qty}</span></div><strong>${fmtMoney(lineTotal)}</strong></div>`;
  }).join('');

  summary.innerHTML = `
    <div class="checkout-summary-card">
      <div class="checkout-head">
        <div><div class="muted">Comercio</div><strong>${cart.merchantName || 'Comercio local'}</strong></div>
        <div class="checkout-count">${itemCount} ${itemCount === 1 ? 'producto' : 'productos'}</div>
      </div>
      <div class="checkout-products">${productsHtml}</div>
      <div class="checkout-total-block">
        <div class="checkout-line"><span>Subtotal</span><strong>${fmtMoney(subtotalProducts)}</strong></div>
        <div class="checkout-line"><span>Envio${lastQuote?.km != null ? ` (${lastQuote.km} km)` : ''}</span><strong>${hasValidAddress ? fmtMoney(deliveryFee) : '--'}</strong></div>
        <div class="checkout-line checkout-line-total"><span>Total a pagar</span><strong>${hasValidAddress ? fmtMoney(total) : '--'}</strong></div>
      </div>
    </div>
  `;

  if (!hasValidAddress) {
    setShippingHint('Selecciona una direccion de la lista para calcular el envio.');
  } else if (quoteState === 'loading') {
    setShippingHint('Calculando envio automaticamente...');
  } else if (quoteState === 'error') {
    setShippingHint(quoteErrorMessage || 'No se pudo calcular el envio.');
  } else if (lastQuote?.km == null) {
    setShippingHint('No se pudo calcular la ruta exacta. Se usara tarifa base.');
  } else if (lastQuote?.km != null) {
    setShippingHint(`Envio calculado automaticamente: ${lastQuote.km} km`);
  }
  if (submitBtn) submitBtn.disabled = !hasValidAddress || quoteState === 'loading';

  return { cart, subtotalProducts, deliveryFee, total, commission, payoutMerchant, hasValidAddress };
}

async function validateCartAgainstDatabase(cart) {
  const merchantSnap = await get(ref(db, `merchants/${cart.merchantId}`));
  const merchant = merchantSnap.val() || {};
  const status = (merchant.status || '').toString().toLowerCase();
  const isActive = status === 'activo' || status === 'active';
  if (!merchantSnap.exists() || !isActive || merchant.isVerified === false || merchant.closed === true || !merchantIsOpen(merchant)) {
    throw new Error('Local cerrado o no disponible en este momento.');
  }

  const productChecks = cart.items.map(async (item) => {
    const pSnap = await get(ref(db, `products/${item.productId}`));
    if (!pSnap.exists()) throw new Error(`Producto no encontrado: ${item.nameSnapshot || item.productId}`);
    const product = pSnap.val() || {};
    if (product.isActive === false) throw new Error(`Producto inactivo: ${product.name || item.nameSnapshot || item.productId}`);
    if (product.merchantId !== cart.merchantId) throw new Error('Hay productos que no pertenecen al comercio seleccionado.');
    const currentPrice = Number(product.price || 0);
    if (currentPrice <= 0) throw new Error(`Precio invalido para ${product.name || item.nameSnapshot || item.productId}`);
    if (currentPrice !== Number(item.unitPriceSnapshot || 0)) throw new Error(`El precio cambio para ${product.name || item.nameSnapshot}. Actualiza el carrito.`);
    const requestedQty = Number(item.qty || 0);
    if (requestedQty <= 0) throw new Error('Cantidad invalida en carrito.');
    const stockValue = product.stock == null ? null : Number(product.stock);
    if (stockValue != null && requestedQty > stockValue) throw new Error(`Stock insuficiente para ${product.name || item.nameSnapshot}. Disponible: ${stockValue}`);
    return {
      productId: item.productId,
      nameSnapshot: product.name || item.nameSnapshot || 'Producto',
      unitPriceSnapshot: currentPrice,
      qty: requestedQty,
      stockSnapshot: stockValue
    };
  });
  return Promise.all(productChecks);
}

async function createMarketplacePayment(marketplaceOrderId, paymentMethod) {
  const user = auth.currentUser;
  if (!user) throw new Error('Debes iniciar sesion.');
  const token = await user.getIdToken();

  const res = await fetch(`${BACKEND_BASE_URL}/create-marketplace-payment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ marketplaceOrderId, paymentMethod })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'No se pudo crear el pago en Mercado Pago');
  }
  const data = await res.json();
  return data.checkout_url || data.sandbox_init_point || data.init_point;
}

async function recalculateQuote() {
  const cart = getCart();
  const selected = getSelectedAddress();
  const coords = getSelectedCoords();
  if (!cart.items.length || !cart.merchantId || !selected || !coords || !deliveryAutocomplete?.isSelectionValid()) {
    lastQuote = null;
    quoteState = 'idle';
    quoteErrorMessage = '';
    buildSummary();
    return;
  }

  try {
    quoteState = 'loading';
    quoteErrorMessage = '';
    buildSummary();
    lastQuote = await quoteDeliveryFee(cart, coords, selected.address);
    quoteState = 'ok';
    buildSummary();
    setStatus('');
  } catch (err) {
    lastQuote = null;
    quoteState = 'error';
    quoteErrorMessage = `No se pudo calcular envio exacto (${err.message}).`;
    buildSummary();
    setStatus('');
  }
}

qs('loginBtn').addEventListener('click', async () => {
  try {
    await signInWithEmailAndPassword(auth, qs('loginEmail').value.trim(), qs('loginPassword').value.trim());
  } catch (err) {
    setStatus(err.message);
  }
});

qs('checkoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return setStatus('Debes iniciar sesion como cliente.');
  if (!deliveryAutocomplete || !deliveryAutocomplete.isSelectionValid()) {
    return setStatus('Selecciona una direccion de la lista para continuar.');
  }

  const computed = buildSummary();
  if (!computed) return setStatus('Carrito vacio.');
  if (!computed.hasValidAddress) return setStatus('Selecciona una direccion de la lista para continuar.');

  const selected = deliveryAutocomplete.getSelected();
  const address = selected.address;
  const notes = qs('deliveryNotes').value.trim();
  const paymentMethod = qs('paymentMethod').value;

  try {
    const userSnap = await get(ref(db, `users/${currentUser.uid}`));
    const userData = userSnap.val() || {};
    if (userData.role && userData.role !== 'customer') return setStatus('Tu cuenta no tiene rol customer.');
    if (!userData.role) {
      await update(ref(db, `users/${currentUser.uid}`), {
        email: currentUser.email || '',
        role: 'customer',
        createdAt: Date.now()
      });
    }

    const inputWa = normalizeArWhatsApp(customerWhatsappInput?.value || '');
    const storedWa = normalizeArWhatsApp(userData.whatsapp || '');
    const whatsapp = storedWa || inputWa;
    if (!whatsapp || whatsapp.replace(/\D/g, '').length < 10) {
      return setStatus('Completa tu WhatsApp para coordinar la entrega.');
    }

    const customerName = inferCustomerName(currentUser, userData);

    const validatedItems = await validateCartAgainstDatabase(computed.cart);
    if (!lastQuote || lastQuote.km == null) {
      lastQuote = await quoteDeliveryFee(computed.cart, [Number(selected.lng), Number(selected.lat)], address);
    }

    const subtotalProducts = validatedItems.reduce((acc, item) => acc + item.unitPriceSnapshot * item.qty, 0);
    const deliveryFee = parseMoney(lastQuote.fee);
    const total = subtotalProducts + deliveryFee;
    const commission = calcCommission(subtotalProducts, total, COMMISSION_CONFIG);
    const payoutMerchant = subtotalProducts - commission.commissionAmount;
    const courierCommission = computeCourierCommission(deliveryFee, DEFAULT_COURIER_COMMISSION_RATE);
    const now = Date.now();
    const trackingToken = generateToken();

    await update(ref(db, `users/${currentUser.uid}`), {
      email: currentUser.email || '',
      role: 'customer',
      address,
      whatsapp,
      geo: { lng: Number(selected.lng), lat: Number(selected.lat) },
      city: 'Rio Grande',
      updatedAt: now
    });

    const orderRef = push(ref(db, 'marketplaceOrders'));
    const orderId = orderRef.key;
    const deliveryRef = push(ref(db, 'orders'));
    const deliveryOrderId = deliveryRef.key;
    await set(orderRef, {
      id: orderId,
      customerId: currentUser.uid,
      merchantId: computed.cart.merchantId,
      merchantNameSnapshot: computed.cart.merchantName || '',
      items: validatedItems,
      subtotalProducts,
      deliveryFee,
      total,
      commissionRate: commission.commissionRate,
      commissionBase: commission.commissionBase,
      commissionAmount: commission.commissionAmount,
      payoutMerchant,
      paymentMethod,
      paymentStatus: paymentMethod === 'mp_card' ? 'pending' : 'pending_on_delivery',
      orderStatus: 'created',
      stockReserved: false,
      deliveryOrderId,
      delivery: {
        address,
        notes,
        courierId: null,
        trackingToken,
        customerName,
        customerWhatsapp: whatsapp,
        merchantLocation: lastQuote.merchantCoords || null,
        customerLocation: { lng: Number(selected.lng), lat: Number(selected.lat) },
        distanceKm: lastQuote.km,
        deliveryBaseFee: lastQuote.deliveryBaseFee || DEFAULT_DELIVERY_BASE_FEE,
        deliveryPerKm: lastQuote.deliveryPerKm || DEFAULT_DELIVERY_PER_KM
      },
      createdAt: now,
      updatedAt: now
    });

    await set(deliveryRef, {
      marketplaceOrderId: orderId,
      origen: computed.cart.merchantName || 'Comercio',
      destino: address,
      origenGeo: lastQuote.merchantCoords || null,
      destinoGeo: { lng: Number(selected.lng), lat: Number(selected.lat) },
      km: lastQuote.km,
      precio: deliveryFee,
      comision: courierCommission.courierCommissionAmount,
      deliveryCommissionAmount: courierCommission.courierCommissionAmount,
      payout: courierCommission.courierPayout,
      comisionRate: courierCommission.courierCommissionRate,
      totalPedido: total,
      pagoMetodo: paymentMethod === 'cash_on_delivery'
        ? 'cash_delivery'
        : paymentMethod === 'transfer_on_delivery'
          ? 'transfer_delivery'
          : 'mp_card',
      estado: 'esperando-comercio',
      notas: notes || '',
      comercioId: computed.cart.merchantId,
      customerId: currentUser.uid,
      clienteNombre: customerName,
      clienteWhatsapp: whatsapp,
      trackingToken,
      createdAt: now,
      updatedAt: now
    });
    await set(ref(db, `publicTracking/${trackingToken}`), {
      orderId: deliveryOrderId,
      marketplaceOrderId: orderId,
      origen: computed.cart.merchantName || 'Comercio',
      destino: address,
      precio: deliveryFee,
      estado: 'esperando-comercio',
      notas: notes || '',
      updatedAt: now,
      ubicacion: null
    });

    const feeRef = push(ref(db, 'marketplaceFees'));
    await set(feeRef, {
      orderId,
      merchantId: computed.cart.merchantId,
      customerId: currentUser.uid,
      commissionRate: commission.commissionRate,
      commissionBase: commission.commissionBase,
      commissionAmount: commission.commissionAmount,
      subtotalProducts,
      total,
      createdAt: now
    });

    if (paymentMethod === 'mp_card') {
      const checkoutUrl = await createMarketplacePayment(orderId, paymentMethod);
      clearCart();
      window.location.href = checkoutUrl;
      return;
    }

    clearCart();
    window.location.href = `/orders/${encodeURIComponent(orderId)}`;
  } catch (err) {
    setStatus(err.message);
  }
});

onAuthStateChanged(auth, (user) => {
  (async () => {
    currentUser = user;
    currentUserProfile = null;
    if (!deliveryAutocomplete) {
      deliveryAutocomplete = attachRioGrandeAutocomplete(deliveryAddressInput, {
        onSelect: () => {
          setStatus('');
          recalculateQuote();
        },
        onInvalidate: () => {
          setStatus('Selecciona una direccion de la lista para continuar.');
          recalculateQuote();
        }
      });
    }

    if (!user) {
      authState.textContent = 'No autenticado';
      deliveryAutocomplete.setSelectedFromStored({ address: '', lat: null, lng: null, city: 'Rio Grande' });
      setShippingHint('Inicia sesion para continuar.');
      buildSummary();
      return;
    }

    authState.textContent = `Sesion: ${user.email || user.uid}`;
    const userSnap = await get(ref(db, `users/${user.uid}`));
    const userData = userSnap.val() || {};
    currentUserProfile = userData;
    if (customerWhatsappInput) {
      customerWhatsappInput.value = userData.whatsapp ? String(userData.whatsapp) : '';
    }
    // Default instructions from profile to reduce friction at checkout.
    const defaultInstr = userData?.deliveryPrefs?.defaultInstructions;
    const notesEl = qs('deliveryNotes');
    if (notesEl && !notesEl.value.trim() && defaultInstr) {
      notesEl.value = String(defaultInstr).trim();
    }
    deliveryAutocomplete.setSelectedFromStored({
      address: userData.address || '',
      lat: userData.geo?.lat,
      lng: userData.geo?.lng,
      city: 'Rio Grande'
    });

    if (!deliveryAutocomplete.isSelectionValid()) {
      lastQuote = null;
      quoteState = 'idle';
      quoteErrorMessage = '';
      setShippingHint('Selecciona una direccion de entrega para calcular envio.');
      setStatus('Selecciona una direccion de la lista para continuar.');
      buildSummary();
      return;
    }

    setStatus('');
    recalculateQuote();
  })().catch((err) => setStatus(err.message || 'No se pudo cargar tu perfil.'));
});

buildSummary();
setShippingHint('Ingresa tu direccion para calcular el envio exacto.');
