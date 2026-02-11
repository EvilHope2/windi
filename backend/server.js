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
  BACKEND_BASE_URL
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

async function verifyFirebaseToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('Unauthorized');
  return admin.auth().verifyIdToken(token);
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
    if (!initPoint) return res.status(500).json({ error: 'No se pudo crear el pago' });

    await admin.database().ref(`orders/${orderId}`).update({
      mpInitPoint: initPoint,
      mpStatus: 'pending'
    });

    return res.json({ init_point: initPoint });
  } catch (err) {
    const msg = err.message || 'Error creando pago';
    const code = msg === 'Unauthorized' ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
});

app.post('/mp/webhook', async (req, res) => {
  try {
    if (!mpPayment) return res.status(500).send('MP not configured');

    const { type, data } = req.body || {};
    const paymentId = data && (data.id || data['id']);

    if (type !== 'payment' || !paymentId) {
      return res.status(200).send('Ignored');
    }

    const payment = await mpPayment.get({ id: paymentId });
    const status = payment?.status;
    const orderId = payment?.metadata?.orderId;

    if (orderId && status) {
      await admin.database().ref(`orders/${orderId}`).update({
        mpStatus: status,
        mpPaymentId: paymentId,
        mpPaidAt: status === 'approved' ? Date.now() : null
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
