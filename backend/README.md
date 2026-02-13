# Windi Backend (Render)

## Deploy rapido
1. Subi este repo a GitHub.
2. En Render crea un **Web Service** desde el repo.
3. Root Directory: `backend`
4. Build Command: `npm install`
5. Start Command: `npm start`
6. (Opcional) Test Command local: `npm test`

## Environment variables
- `MP_ACCESS_TOKEN` = tu access token de MercadoPago
- `FIREBASE_DB_URL` = https://windi-rg-121f8-default-rtdb.firebaseio.com/
- `FIREBASE_SERVICE_ACCOUNT` = JSON del Service Account (como string en una sola linea)
- `BACKEND_BASE_URL` = URL del servicio en Render (ej: https://windi-01ia.onrender.com)
- `FRONTEND_BASE_URL` = URL web del frontend (ej: https://windi-rg-121f8.web.app)

## Generar Service Account
Firebase Console ? Project Settings ? Service accounts ? Generate new private key.
Copialo completo y pegalo como string en `FIREBASE_SERVICE_ACCOUNT`.

## Endpoints
- `POST /create-shipping-payment` (Authorization: Bearer <Firebase ID Token>, body: `orderId`, `pagoMetodo`)
- `POST /create-marketplace-payment` (Authorization: Bearer <Firebase ID Token>, body: `marketplaceOrderId`)
- `POST /mp/webhook` (MercadoPago webhook)
- `GET /health`

## Tests
- Ejecutar: `npm test`
