import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

const app = express();
app.use(cors());
app.use(express.json({ type: '*/*' }));

const {
  MP_ACCESS_TOKEN,
  FIREBASE_DB_URL,
  FIREBASE_SERVICE_ACCOUNT,
  BACKEND_BASE_URL,
  MP_CHECKOUT_MODE,
  FRONTEND_BASE_URL,
  MAPBOX_PUBLIC_TOKEN,
  MAPBOX_TOKEN
} = process.env;

if (!MP_ACCESS_TOKEN || !FIREBASE_DB_URL || !FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing env vars: MP_ACCESS_TOKEN, FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT');
}

const serviceAccount = FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(FIREBASE_SERVICE_ACCOUNT)
  : null;

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_DB_URL
  });
}

const mpClient = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN }) : null;
const mpPayment = mpClient ? new Payment(mpClient) : null;
const DELIVERY_BASE_FEE = Number(process.env.DELIVERY_BASE_FEE || 1500);
const DELIVERY_PER_KM = Number(process.env.DELIVERY_PER_KM || 500);
const DEFAULT_DELIVER_RADIUS_METERS = Number(process.env.DELIVERY_RADIUS_METERS || 50);
const DEFAULT_DELIVER_MAX_ACCURACY_METERS = Number(process.env.DELIVERY_MAX_ACCURACY_METERS || 50);

let cachedGlobalConfig = { value: null, fetchedAt: 0 };
let cachedPublicConfig = { value: null, fetchedAt: 0 };

async function getGlobalConfig() {
  const now = Date.now();
  if (cachedGlobalConfig.value && now - cachedGlobalConfig.fetchedAt < 60_000) return cachedGlobalConfig.value;
  try {
    const snap = await admin.database().ref('config/global').get();
    const cfg = snap.exists() ? (snap.val() || {}) : {};
    const normalized = {
      deliveryBaseFee: Number.isFinite(Number(cfg.deliveryBaseFee)) ? Number(cfg.deliveryBaseFee) : DELIVERY_BASE_FEE,
      deliveryPerKm: Number.isFinite(Number(cfg.deliveryPerKm)) ? Number(cfg.deliveryPerKm) : DELIVERY_PER_KM,
      deliverRadiusMeters: Number.isFinite(Number(cfg.deliverRadiusMeters)) ? Number(cfg.deliverRadiusMeters) : DEFAULT_DELIVER_RADIUS_METERS,
      deliverMaxAccuracyMeters: Number.isFinite(Number(cfg.deliverMaxAccuracyMeters)) ? Number(cfg.deliverMaxAccuracyMeters) : DEFAULT_DELIVER_MAX_ACCURACY_METERS,
      commissionRate: Number.isFinite(Number(cfg.commissionRate)) ? Number(cfg.commissionRate) : 0.05,
      commissionBase: (cfg.commissionBase === 'total' ? 'total' : 'subtotal_products'),
      courierCommissionRate: Number.isFinite(Number(cfg.courierCommissionRate)) ? Number(cfg.courierCommissionRate) : 0.15
    };
    cachedGlobalConfig = { value: normalized, fetchedAt: now };
    return normalized;
  } catch {
    const fallback = {
      deliveryBaseFee: DELIVERY_BASE_FEE,
      deliveryPerKm: DELIVERY_PER_KM,
      deliverRadiusMeters: DEFAULT_DELIVER_RADIUS_METERS,
      deliverMaxAccuracyMeters: DEFAULT_DELIVER_MAX_ACCURACY_METERS,
      commissionRate: 0.05,
      commissionBase: 'subtotal_products',
      courierCommissionRate: 0.15
    };
    cachedGlobalConfig = { value: fallback, fetchedAt: now };
    return fallback;
  }
}

async function requireAdmin(decoded) {
  const uid = decoded?.uid;
  if (!uid) throw new Error('Unauthorized');
  const snap = await admin.database().ref(`admins/${uid}`).get();
  if (snap.val() !== true) {
    const err = new Error('Forbidden');
    err.code = 403;
    throw err;
  }
  return true;
}

async function adminLog(actorUid, action, payload) {
  const now = Date.now();
  await admin.database().ref('adminLogs').push({
    actorUid,
    action,
    payload: payload || null,
    createdAt: now
  });
}

app.get('/public-config', (req, res) => {
  // Public token used by the frontend (Mapbox "pk.*"). Served from env to avoid committing it to git.
  (async () => {
    const envToken = String(MAPBOX_PUBLIC_TOKEN || MAPBOX_TOKEN || '').trim();
    if (envToken) {
      return res.json({ mapboxToken: envToken });
    }

    // Fallback: allow setting the public token in RTDB (useful when env vars are not applied/redeployed yet).
    // This is safe because Mapbox pk.* tokens are public by design.
    try {
      const now = Date.now();
      if (cachedPublicConfig.value && now - cachedPublicConfig.fetchedAt < 300_000) {
        return res.json({ mapboxToken: cachedPublicConfig.value });
      }
      if (!serviceAccount) {
        cachedPublicConfig = { value: '', fetchedAt: now };
        return res.json({ mapboxToken: '' });
      }
      const snap = await admin.database().ref('config/public').get();
      const token = String((snap.val() || {})?.mapboxToken || '').trim();
      cachedPublicConfig = { value: token, fetchedAt: now };
      return res.json({ mapboxToken: token });
    } catch {
      return res.json({ mapboxToken: '' });
    }
  })();
});

async function verifyFirebaseToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('Unauthorized');
  return admin.auth().verifyIdToken(token);
}

function haversineKm(a, b) {
  const toRad = (v) => (Number(v) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return 6371 * c;
}

function haversineMeters(a, b) {
  return haversineKm(a, b) * 1000;
}

function parseCoords(raw) {
  if (!raw) return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

app.post('/create-shipping-payment', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    const { orderId, pagoMetodo } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });

    const orderSnap = await admin.database().ref(`orders/${orderId}`).get();
    if (!orderSnap.exists()) return res.status(404).json({ error: 'Pedido no encontrado' });
    const order = orderSnap.val();

    if (order.comercioId !== decoded.uid) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const paymentMethod = pagoMetodo || order.pagoMetodo;
    const isCommercePayment =
      paymentMethod === 'comercio_paga_envio' || paymentMethod === 'comercio_mp_transfer';
    if (!isCommercePayment) {
      return res.status(400).json({ error: 'Metodo de pago invalido' });
    }

    if (!mpClient) {
      return res.status(500).json({ error: 'MercadoPago no configurado' });
    }

    const amount = Number(order.precio || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto invalido' });
    }

    const paymentMethods =
      paymentMethod === 'comercio_mp_transfer'
        ? {
            installments: 1,
            excluded_payment_types: [
              { id: 'credit_card' },
              { id: 'debit_card' },
              { id: 'prepaid_card' },
              { id: 'ticket' },
              { id: 'atm' }
            ]
          }
        : undefined;

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            title: `Envio Windi - ${order.origen} -> ${order.destino}`,
            quantity: 1,
            currency_id: 'ARS',
            unit_price: amount
          }
        ],
        metadata: { orderId },
        payment_methods: paymentMethods,
        notification_url: BACKEND_BASE_URL ? `${BACKEND_BASE_URL}/mp/webhook` : undefined
      }
    });

    const initPoint = result && result.init_point;
    const sandboxInitPoint = result && result.sandbox_init_point;
    const forcedMode = (MP_CHECKOUT_MODE || 'auto').toLowerCase();
    const inferredMode = String(MP_ACCESS_TOKEN || '').startsWith('TEST-') ? 'sandbox' : 'live';
    const checkoutMode = forcedMode === 'live' || forcedMode === 'sandbox' ? forcedMode : inferredMode;
    const checkoutUrl = checkoutMode === 'sandbox'
      ? (sandboxInitPoint || initPoint)
      : (initPoint || sandboxInitPoint);
    if (!checkoutUrl) return res.status(500).json({ error: 'No se pudo crear el pago' });

    await admin.database().ref(`orders/${orderId}`).update({
      mpInitPoint: initPoint || null,
      mpSandboxInitPoint: sandboxInitPoint || null,
      mpCheckoutUrl: checkoutUrl,
      mpStatus: 'pending'
    });

    return res.json({
      init_point: initPoint || null,
      sandbox_init_point: sandboxInitPoint || null,
      checkout_url: checkoutUrl
    });
  } catch (err) {
    const msg = err.message || 'Error creando pago';
    const code = msg === 'Unauthorized' ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
});

app.post('/create-marketplace-payment', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    const { marketplaceOrderId, paymentMethod } = req.body || {};
    if (!marketplaceOrderId) return res.status(400).json({ error: 'marketplaceOrderId requerido' });
    if (!mpClient) return res.status(500).json({ error: 'MercadoPago no configurado' });

    const orderSnap = await admin.database().ref(`marketplaceOrders/${marketplaceOrderId}`).get();
    if (!orderSnap.exists()) return res.status(404).json({ error: 'Pedido marketplace no encontrado' });
    const order = orderSnap.val() || {};
    if (order.customerId !== decoded.uid) return res.status(403).json({ error: 'No autorizado' });

    const customerLoc = order?.delivery?.customerLocation || null;
    const merchantLoc = order?.delivery?.merchantLocation || null;
    if (!customerLoc || !merchantLoc) {
      return res.status(400).json({ error: 'Direccion invalida: faltan coordenadas internas.' });
    }
    const customerLat = Number(customerLoc.lat);
    const customerLng = Number(customerLoc.lng);
    const merchantLat = Number(merchantLoc.lat);
    const merchantLng = Number(merchantLoc.lng);
    if (![customerLat, customerLng, merchantLat, merchantLng].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Direccion invalida: coordenadas incorrectas.' });
    }

    const globalCfg = await getGlobalConfig();
    const distanceKm = Math.round((haversineKm({ lat: merchantLat, lng: merchantLng }, { lat: customerLat, lng: customerLng }) * 1.25) * 10) / 10;
    const deliveryFee = Math.round(globalCfg.deliveryBaseFee + distanceKm * globalCfg.deliveryPerKm);
    const subtotalProducts = Number(order.subtotalProducts || 0);
    const total = Math.round(subtotalProducts + deliveryFee);
    if (total <= 0) return res.status(400).json({ error: 'Monto invalido' });

    await admin.database().ref(`marketplaceOrders/${marketplaceOrderId}`).update({
      deliveryFee,
      total,
      updatedAt: Date.now(),
      delivery: {
        ...(order.delivery || {}),
        distanceKm
      }
    });

    const amount = total;
    if (amount <= 0) return res.status(400).json({ error: 'Monto invalido' });

    const orderUrl = `${FRONTEND_BASE_URL || 'https://windi-rg-121f8.web.app'}/orders/${encodeURIComponent(marketplaceOrderId)}`;
    const checkoutPaymentMethod = paymentMethod || order.paymentMethod || 'mp_card';
    const paymentMethods =
      checkoutPaymentMethod === 'mp_cash'
        ? {
            installments: 1,
            excluded_payment_types: [
              { id: 'credit_card' },
              { id: 'debit_card' },
              { id: 'prepaid_card' }
            ]
          }
        : checkoutPaymentMethod === 'mp_card'
          ? {
              excluded_payment_types: [
                { id: 'ticket' },
                { id: 'atm' }
              ]
            }
          : undefined;

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [
          {
            title: `Pedido Windi #${marketplaceOrderId}`,
            quantity: 1,
            currency_id: 'ARS',
            unit_price: amount
          }
        ],
        metadata: {
          marketplaceOrderId,
          paymentMethod: checkoutPaymentMethod
        },
        payment_methods: paymentMethods,
        back_urls: {
          success: orderUrl,
          failure: orderUrl,
          pending: orderUrl
        },
        auto_return: 'approved',
        notification_url: BACKEND_BASE_URL ? `${BACKEND_BASE_URL}/mp/webhook` : undefined
      }
    });

    const initPoint = result && result.init_point;
    const sandboxInitPoint = result && result.sandbox_init_point;
    const forcedMode = (MP_CHECKOUT_MODE || 'auto').toLowerCase();
    const inferredMode = String(MP_ACCESS_TOKEN || '').startsWith('TEST-') ? 'sandbox' : 'live';
    const checkoutMode = forcedMode === 'live' || forcedMode === 'sandbox' ? forcedMode : inferredMode;
    const checkoutUrl = checkoutMode === 'sandbox'
      ? (sandboxInitPoint || initPoint)
      : (initPoint || sandboxInitPoint);
    if (!checkoutUrl) return res.status(500).json({ error: 'No se pudo crear el pago' });

    await admin.database().ref(`marketplaceOrders/${marketplaceOrderId}`).update({
      mpInitPoint: initPoint || null,
      mpSandboxInitPoint: sandboxInitPoint || null,
      mpCheckoutUrl: checkoutUrl,
      paymentStatus: 'pending',
      mpStatus: 'pending',
      updatedAt: Date.now()
    });

    return res.json({
      init_point: initPoint || null,
      sandbox_init_point: sandboxInitPoint || null,
      checkout_url: checkoutUrl
    });
  } catch (err) {
    const msg = err.message || 'Error creando pago marketplace';
    const code = msg === 'Unauthorized' ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
});

app.post('/courier/orders/:orderId/deliver', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    const globalCfg = await getGlobalConfig();
    const { orderId } = req.params;
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const accuracy = Number(req.body?.accuracy);
    const gpsTimestamp = Number(req.body?.timestamp || Date.now());
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });
    if (![lat, lng, accuracy, gpsTimestamp].every(Number.isFinite)) {
      return res.status(400).json({ error: 'Ubicacion invalida.' });
    }
    if (accuracy > globalCfg.deliverMaxAccuracyMeters) {
      return res.status(400).json({ error: `Precision GPS insuficiente (${Math.round(accuracy)} m).` });
    }

    const orderRef = admin.database().ref(`orders/${orderId}`);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists()) return res.status(404).json({ error: 'Pedido no encontrado' });
    const order = orderSnap.val() || {};
    if (order.repartidorId !== decoded.uid) return res.status(403).json({ error: 'No autorizado' });
    if (order.estado !== 'en-camino' && order.estado !== 'entregado') {
      return res.status(400).json({ error: 'El pedido no esta en estado en-camino.' });
    }
    if (order.estado === 'entregado') {
      return res.json({ ok: true, alreadyDelivered: true });
    }

    let destination = parseCoords(order.destinoGeo);
    let marketplaceOrder = null;
    if (!destination && order.marketplaceOrderId) {
      const mpSnap = await admin.database().ref(`marketplaceOrders/${order.marketplaceOrderId}`).get();
      if (mpSnap.exists()) {
        marketplaceOrder = mpSnap.val() || {};
        destination = parseCoords(marketplaceOrder?.delivery?.customerLocation);
      }
    }
    if (!destination) return res.status(400).json({ error: 'Pedido sin coordenadas de destino.' });

    const courierLocation = { lat, lng };
    const distanceMeters = haversineMeters(courierLocation, destination);
    if (distanceMeters > globalCfg.deliverRadiusMeters) {
      return res.status(400).json({
        error: `Acercate al destino para confirmar la entrega (a ${Math.round(distanceMeters)} m).`,
        distanceMeters: Math.round(distanceMeters)
      });
    }

    const now = Date.now();
    const walletRef = admin.database().ref(`wallets/${decoded.uid}`);
    const walletSnap = await walletRef.get();
    const wallet = walletSnap.val() || {
      balance: 0,
      pending: 0,
      totalEarned: 0,
      totalCommissions: 0,
      totalWithdrawn: 0,
      currency: 'ARS',
      createdAt: now,
      updatedAt: now
    };

    if (!order.payoutApplied) {
      const paymentType = String(order.pagoMetodo || '').toLowerCase();
      const collectsFromCustomer = paymentType === 'cash_delivery' || paymentType === 'transfer_delivery';
      const deliveryFee = Number(order.precio || 0);
      const courierCommission = Number.isFinite(Number(order.deliveryCommissionAmount))
        ? Number(order.deliveryCommissionAmount)
        : (Number.isFinite(Number(order.comision)) ? Number(order.comision) : Math.round(deliveryFee * Number(globalCfg.courierCommissionRate || 0)));
      const courierPayout = Number.isFinite(Number(order.payout))
        ? Number(order.payout)
        : Math.round(deliveryFee - courierCommission);

      if (collectsFromCustomer) {
        const comision = courierCommission;
        const newBalance = Number(wallet.balance || 0) - comision;
        const totalCommissions = Number(wallet.totalCommissions || 0) + Math.abs(comision);
        await walletRef.update({ balance: newBalance, totalCommissions, updatedAt: now });
        await admin.database().ref(`walletTx/${decoded.uid}`).push({
          type: 'commission',
          amount: -comision,
          createdAt: now,
          orderId
        });
      } else {
        const payout = courierPayout;
        const newBalance = Number(wallet.balance || 0) + payout;
        const totalEarned = Number(wallet.totalEarned || 0) + payout;
        await walletRef.update({ balance: newBalance, totalEarned, updatedAt: now });
        await admin.database().ref(`walletTx/${decoded.uid}`).push({
          type: 'credit',
          amount: payout,
          createdAt: now,
          orderId
        });
      }
    }

    await orderRef.update({
      estado: 'entregado',
      entregadoAt: now,
      updatedAt: now,
      payoutApplied: true,
      deliveryProof: {
        location: { lat, lng },
        accuracy,
        timestamp: gpsTimestamp,
        validatedAt: now,
        distanceMeters: Math.round(distanceMeters)
      }
    });

    if (order.marketplaceOrderId) {
      const mpRef = admin.database().ref(`marketplaceOrders/${order.marketplaceOrderId}`);
      await mpRef.update({
        orderStatus: 'delivered',
        updatedAt: now
      });
      await admin.database().ref(`marketplaceOrderStatusLog/${order.marketplaceOrderId}`).push({
        status: 'delivered',
        actorId: decoded.uid,
        actorRole: 'courier',
        createdAt: now
      });
    }

    if (order.trackingToken) {
      await admin.database().ref(`publicTracking/${order.trackingToken}`).update({
        estado: 'entregado',
        updatedAt: now
      });
    }

    return res.json({ ok: true, distanceMeters: Math.round(distanceMeters), deliveredAt: now });
  } catch (err) {
    const msg = err.message || 'Error validando entrega';
    const code = msg === 'Unauthorized' ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
});

// Admin API (RBAC enforced in backend)
app.get('/admin/config/global', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const cfg = await getGlobalConfig();
    return res.json({ ok: true, config: cfg });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/admin/config/global', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const body = req.body || {};
    const patch = {
      deliveryBaseFee: Number.isFinite(Number(body.deliveryBaseFee)) ? Number(body.deliveryBaseFee) : undefined,
      deliveryPerKm: Number.isFinite(Number(body.deliveryPerKm)) ? Number(body.deliveryPerKm) : undefined,
      deliverRadiusMeters: Number.isFinite(Number(body.deliverRadiusMeters)) ? Number(body.deliverRadiusMeters) : undefined,
      deliverMaxAccuracyMeters: Number.isFinite(Number(body.deliverMaxAccuracyMeters)) ? Number(body.deliverMaxAccuracyMeters) : undefined,
      commissionRate: Number.isFinite(Number(body.commissionRate)) ? Number(body.commissionRate) : undefined,
      commissionBase: body.commissionBase === 'total' ? 'total' : 'subtotal_products',
      courierCommissionRate: Number.isFinite(Number(body.courierCommissionRate)) ? Number(body.courierCommissionRate) : undefined,
      updatedAt: Date.now(),
      updatedBy: decoded.uid
    };
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
    await admin.database().ref('config/global').update(patch);
    cachedGlobalConfig = { value: null, fetchedAt: 0 };
    await adminLog(decoded.uid, 'config_global_update', patch);
    return res.json({ ok: true });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.get('/admin/summary', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayStart = startOfDay.getTime();

    const [mpOrdersSnap, ordersSnap, merchantsSnap, usersSnap, feesSnap] = await Promise.all([
      admin.database().ref('marketplaceOrders').get(),
      admin.database().ref('orders').get(),
      admin.database().ref('merchants').get(),
      admin.database().ref('users').get(),
      admin.database().ref('marketplaceFees').get()
    ]);

    const mpOrders = mpOrdersSnap.val() || {};
    const orders = ordersSnap.val() || {};
    const merchants = merchantsSnap.val() || {};
    const users = usersSnap.val() || {};
    const fees = feesSnap.val() || {};

    const mpEntriesToday = Object.values(mpOrders).filter((o) => Number(o.createdAt || 0) >= dayStart);
    const deliveriesToday = Object.values(orders).filter((o) => Number(o.createdAt || 0) >= dayStart);
    const inCourse = mpEntriesToday.filter((o) => !['delivered', 'cancelled'].includes(String(o.orderStatus || 'created')));
    const delivered = mpEntriesToday.filter((o) => String(o.orderStatus) === 'delivered');
    const pendingMerchants = Object.values(merchants).filter((m) => ['pendiente', 'pending'].includes(String(m.status || '').toLowerCase()));

    const couriers = Object.values(users).filter((u) => String(u.role || '').toLowerCase() === 'repartidor');
    const couriersOnline = couriers.filter((u) => u && u.uid && false);
    // presence is handled in frontend; backend summary computes online from courierPresence
    const presenceSnap = await admin.database().ref('courierPresence').get();
    const presence = presenceSnap.val() || {};
    const onlineCount = Object.values(presence).filter((p) => Number(p.updatedAt || 0) >= (now - 2 * 60_000)).length;

    const feesToday = Object.values(fees).filter((f) => Number(f.createdAt || 0) >= dayStart);
    const commissionToday = feesToday.reduce((acc, f) => acc + Number(f.commissionAmount || 0), 0);

    return res.json({
      ok: true,
      kpis: {
        pedidosHoy: mpEntriesToday.length,
        enviosHoy: deliveriesToday.length,
        pedidosEnCurso: inCourse.length,
        pedidosEntregados: delivered.length,
        comerciosPendientes: pendingMerchants.length,
        repartidoresOnline: onlineCount,
        comisionHoy: Math.round(commissionToday)
      }
    });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/admin/merchants/:uid/approve', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const uid = req.params.uid;
    const now = Date.now();
    await admin.database().ref(`users/${uid}`).update({ status: 'activo', validationUpdatedAt: now });
    await admin.database().ref(`merchants/${uid}`).update({ status: 'activo', isVerified: true, updatedAt: now });
    await adminLog(decoded.uid, 'merchant_approve', { uid });
    return res.json({ ok: true });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/admin/merchants/:uid/reject', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const uid = req.params.uid;
    const reason = String(req.body?.reason || '').trim() || null;
    const now = Date.now();
    await admin.database().ref(`users/${uid}`).update({ status: 'rechazado', rejectionReason: reason, validationUpdatedAt: now });
    await admin.database().ref(`merchants/${uid}`).update({ status: 'rechazado', isVerified: false, rejectionReason: reason, updatedAt: now });
    await adminLog(decoded.uid, 'merchant_reject', { uid, reason });
    return res.json({ ok: true });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/admin/merchants/:uid/suspend', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const uid = req.params.uid;
    const reason = String(req.body?.reason || '').trim() || null;
    const now = Date.now();
    await admin.database().ref(`users/${uid}`).update({ status: 'suspendido', suspensionReason: reason, validationUpdatedAt: now });
    await admin.database().ref(`merchants/${uid}`).update({ status: 'suspendido', isVerified: false, suspensionReason: reason, updatedAt: now });
    await adminLog(decoded.uid, 'merchant_suspend', { uid, reason });
    return res.json({ ok: true });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/admin/orders/:marketplaceOrderId/status', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const marketplaceOrderId = req.params.marketplaceOrderId;
    const status = String(req.body?.status || '').trim();
    const reason = String(req.body?.reason || '').trim() || null;
    if (!status) return res.status(400).json({ error: 'status requerido' });
    const now = Date.now();
    await admin.database().ref(`marketplaceOrders/${marketplaceOrderId}`).update({ orderStatus: status, updatedAt: now });
    await admin.database().ref(`marketplaceOrderStatusLog/${marketplaceOrderId}`).push({
      status,
      actorId: decoded.uid,
      actorRole: 'admin',
      reason,
      createdAt: now
    });
    await adminLog(decoded.uid, 'order_status_change', { marketplaceOrderId, status, reason });
    return res.json({ ok: true });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/admin/dispatch/assign', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    await requireAdmin(decoded);
    const marketplaceOrderId = String(req.body?.marketplaceOrderId || '').trim();
    const deliveryOrderId = String(req.body?.deliveryOrderId || '').trim();
    const courierId = String(req.body?.courierId || '').trim();
    if (!courierId) return res.status(400).json({ error: 'courierId requerido' });

    let mpId = marketplaceOrderId;
    let delId = deliveryOrderId;
    if (!mpId && delId) {
      const delSnap = await admin.database().ref(`orders/${delId}`).get();
      const del = delSnap.val() || {};
      mpId = del.marketplaceOrderId || '';
    }
    if (!delId && mpId) {
      const mpSnap = await admin.database().ref(`marketplaceOrders/${mpId}`).get();
      const mp = mpSnap.val() || {};
      delId = mp.deliveryOrderId || '';
    }
    if (!mpId || !delId) return res.status(400).json({ error: 'marketplaceOrderId y/o deliveryOrderId requerido' });

    const now = Date.now();
    await admin.database().ref(`orders/${delId}`).update({
      repartidorId: courierId,
      estado: 'en-camino-retiro',
      assignedByAdmin: decoded.uid,
      assignedAt: now,
      updatedAt: now
    });
    await admin.database().ref(`marketplaceOrders/${mpId}`).update({
      orderStatus: 'assigned',
      'delivery/courierId': courierId,
      updatedAt: now
    });
    await admin.database().ref(`marketplaceOrderStatusLog/${mpId}`).push({
      status: 'assigned',
      actorId: decoded.uid,
      actorRole: 'admin',
      createdAt: now
    });
    await adminLog(decoded.uid, 'dispatch_assign', { marketplaceOrderId: mpId, deliveryOrderId: delId, courierId });
    return res.json({ ok: true });
  } catch (err) {
    const msg = err.message || 'Error';
    const code = err.code || (msg === 'Unauthorized' ? 401 : 500);
    return res.status(code).json({ error: msg });
  }
});

app.post('/mp/webhook', async (req, res) => {
  try {
    if (!mpPayment) return res.status(500).send('MP not configured');

    const body = req.body || {};
    const query = req.query || {};
    const type = body.type || body.topic || query.type || query.topic || null;
    const data = body.data || null;
    const paymentId =
      (data && (data.id || data['id'])) ||
      body.id ||
      body['data.id'] ||
      query.id ||
      query['data.id'] ||
      null;

    if (type !== 'payment' || !paymentId) {
      return res.status(200).send('Ignored');
    }

    const payment = await mpPayment.get({ id: paymentId });
    const status = payment?.status;
    const orderId = payment?.metadata?.orderId;
    const marketplaceOrderId = payment?.metadata?.marketplaceOrderId;

    if (orderId && status) {
      await admin.database().ref(`orders/${orderId}`).update({
        mpStatus: status,
        mpPaymentId: paymentId,
        mpPaidAt: status === 'approved' ? Date.now() : null
      });
    }
    if (marketplaceOrderId && status) {
      await admin.database().ref(`marketplaceOrders/${marketplaceOrderId}`).update({
        mpStatus: status,
        paymentStatus: status === 'approved' ? 'paid' : status,
        mpPaymentId: paymentId,
        mpPaidAt: status === 'approved' ? Date.now() : null,
        updatedAt: Date.now()
      });
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Error');
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Windi backend running on port ${PORT}`);
});
