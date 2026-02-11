# Windi Backend (Render)

## Deploy rapido
1. Subi este repo a GitHub.
2. En Render crea un **Web Service** desde el repo.
3. Root Directory: `backend`
4. Build Command: `npm install`
5. Start Command: `npm start`

## Environment variables
- `MP_ACCESS_TOKEN` = tu access token de MercadoPago
- `FIREBASE_DB_URL` = https://windi-rg-121f8-default-rtdb.firebaseio.com/
- `FIREBASE_SERVICE_ACCOUNT` = JSON del Service Account (como string en una sola linea)

## Generar Service Account
Firebase Console ? Project Settings ? Service accounts ? Generate new private key.
Copialo completo y pegalo como string en `FIREBASE_SERVICE_ACCOUNT`.

## Endpoints
- `POST /create-shipping-payment` (Authorization: Bearer <Firebase ID Token>)
- `GET /health`
