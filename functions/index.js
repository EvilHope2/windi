const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const mercadopago = require('mercadopago');

admin.initializeApp();

const mpToken = functions.config().mercadopago && functions.config().mercadopago.token;
if (mpToken) {
  mercadopago.configure({ access_token: mpToken });
}

exports.createShippingPayment = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Unauthorized' });

      const decoded = await admin.auth().verifyIdToken(token);
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

      if (!mpToken) {
        return res.status(500).json({ error: 'MercadoPago no configurado' });
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
        metadata: {
          orderId
        }
      };

      const result = await mercadopago.preferences.create(preference);
      const initPoint = result && result.body && result.body.init_point;
      if (!initPoint) return res.status(500).json({ error: 'No se pudo crear el pago' });

      await admin.database().ref(`orders/${orderId}`).update({
        mpInitPoint: initPoint,
        mpStatus: 'pending'
      });

      return res.json({ init_point: initPoint });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error creando pago' });
    }
  });
});
