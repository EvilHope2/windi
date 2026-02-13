# Windi (Web + PWA + TWA)

## Marketplace MVP (implementado)

### Flujo cliente
- `GET /marketplace` (UI): comercios activos y catalogo por comercio.
- Carrito single-merchant con validacion de cambio de comercio.
- `GET /cart` y `GET /checkout` (UI): checkout con direccion y creacion de pedido.
- `GET /me/orders` y `GET /orders/:id` (UI): historial, detalle y tracking.

### Flujo comercio
- `GET /comercio-marketplace.html` (UI): CRUD de productos y gestion de pedidos marketplace.
- Estados: `confirmed`, `preparing`, `ready_for_pickup`, `cancelled`.
- Reserva de stock al confirmar pedido (si el producto tiene stock numerico).

### Flujo repartidor
- Flujo existente de `orders` integrado con `marketplaceOrders`.
- Estados sincronizados: `assigned`, `picked_up`, `delivered`, `cancelled`.
- Tracking publico mantiene token y ubicacion en tiempo real.

### Comision Windi
- Configuracion actual: `5%` sobre `subtotal_products`.
- Persistido por pedido en:
  - `marketplaceOrders/{id}`: `commissionRate`, `commissionBase`, `commissionAmount`.
  - `marketplaceFees/{feeId}`: registro de auditoria.

## Estructura de datos marketplace
- `merchants/{merchantId}`
- `products/{productId}`
- `marketplaceOrders/{orderId}`
- `marketplaceFees/{feeId}`
- `marketplaceOrderStatusLog/{orderId}/{logId}`

## Rutas Firebase Hosting (rewrites)
- `/marketplace/**` -> `/marketplace.html`
- `/cart` -> `/cart.html`
- `/checkout` -> `/checkout.html`
- `/orders/**` -> `/order.html`
- `/me/orders` -> `/my-orders.html`
- `/merchant/products/**` -> `/comercio-marketplace.html`
- `/merchant/orders/**` -> `/comercio-marketplace.html`

## Reglas DB
- Archivo: `database.rules.json`.
- Incluye RBAC para `customer`, `comercio`, `repartidor`, `admin` en nodos marketplace.

## Comandos
- Deploy hosting: `firebase deploy --only hosting`
- Deploy reglas DB: `firebase deploy --only database`
- Deploy ambos: `firebase deploy --only hosting,database`

## Backend (Render)
- Carpeta: `backend`
- Start: `npm start`
- Test: `npm test`
- Check (syntax + static): `npm run check`
- Smoke tests: `npm run smoke`
- Env publicos:
  - `MAPBOX_PUBLIC_TOKEN`: token `pk.*` para geocoding/directions/mapas (se sirve desde `GET /public-config` para no commitearlo en git).
- Endpoint MP actual: `POST /create-shipping-payment`
- Webhook MP actual: `POST /mp/webhook`
- Endpoint entrega con validacion GPS: `POST /courier/orders/:orderId/deliver`

## UI V2 (futurista, misma paleta)
- Se unifico estilo global con tokens en `frontend/styles.css`.
- Botones 3D (hover/active/disabled), tipografia y spacing consistentes.
- Mapas con look mejorado (container premium + controles pulidos) y estilo `navigation-day-v1`.
- Cobertura aplicada a home, auth, marketplace, checkout/carrito, comercio, repartidor y admin al compartir componentes globales.

## CI automatica
- Workflow: `.github/workflows/ci.yml`
- Ejecuta en push/PR:
  - `npm run check`
  - `npm test`
  - `npm run smoke`

## Nota de T&C
- En registro comercio/repartidor se exige aceptar terminos.
