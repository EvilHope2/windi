import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import mercadopago from 'mercadopago';

const app = express();
app.use(cors());
app.use(express.json());

const { MP_ACCESS_TOKEN, FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT } = process.env;

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

if (MP_ACCESS_TOKEN) {
  mercadopago.configure({ access_token: MP_ACCESS_TOKEN });
}

async function verifyFirebaseToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new Error('Unauthorized');
  return admin.auth().verifyIdToken(token);
}

app.post('/create-shipping-payment', async (req, res) => {
  try {
    const decoded = await verifyFirebaseToken(req);
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });

    const orderSnap = await admin.database().ref(`orders/${orderId}`).get();
    if (!orderSnap.exists()) return res.status(404).json({ error: 'Pedido no encontrado' });
    const order = orderSnap.val();

    if (order.comercioId !== decoded.uid) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (order.pagoMetodo !== 'comercio_paga_envio') {
      return res.status(400).json({ error: 'Metodo de pago invalido' });
    }

    const amount = Number(order.precio || 0);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto invalido' });
    }

    const preference = {
      items: [
        {
          title: `Envio Windi - ${order.origen} -> ${order.destino}`,
          quantity: 1,
          currency_id: 'ARS',
          unit_price: amount
        }
      ],
      metadata: { orderId }
    };

    const result = await mercadopago.preferences.create(preference);
    const initPoint = result?.body?.init_point;
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

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Windi backend running on port ${PORT}`);
});
