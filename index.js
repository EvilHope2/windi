const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ---------------- DATA (MVP memoria) ----------------
let usuarios = [];   // {id, email, password, rol}
let pedidos = [];

// ---------------- TARIFAS ----------------
const TARIFAS = {
  base: 400,
  km: 150,
  vehiculo: { bici: 1, moto: 1.2, auto: 1.5 }
};

// ---------------- UTILS ----------------
const hash = txt =>
  crypto.createHash('sha256').update(txt).digest('hex');

function calcularPrecio(km, vehiculo) {
  return Math.round(
    (TARIFAS.base + km * TARIFAS.km) * TARIFAS.vehiculo[vehiculo]
  );
}

// ---------------- AUTH ----------------
app.post('/register', (req, res) => {
  const { email, password, rol } = req.body;

  if (usuarios.find(u => u.email === email))
    return res.status(400).json({ error: 'Usuario ya existe' });

  const user = {
    id: Date.now(),
    email,
    password: hash(password),
    rol
  };

  usuarios.push(user);
  res.json({ ok: true });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;

  const user = usuarios.find(
    u => u.email === email && u.password === hash(password)
  );

  if (!user)
    return res.status(401).json({ error: 'Credenciales inválidas' });

  res.json({
    id: user.id,
    email: user.email,
    rol: user.rol
  });
});

// ---------------- PEDIDOS ----------------
app.post('/pedido', (req, res) => {
  const { origen, destino, km, vehiculo } = req.body;

  const pedido = {
    id: Date.now(),
    origen,
    destino,
    km,
    vehiculo,
    precio: calcularPrecio(km, vehiculo),
    estado: 'buscando'
  };

  pedidos.push(pedido);
  io.emit('nuevo-pedido', pedido);
  res.json(pedido);
});

app.get('/pedidos', (req, res) => {
  res.json(pedidos.filter(p => p.estado === 'buscando'));
});

app.post('/pedido/:id/aceptar', (req, res) => {
  const pedido = pedidos.find(p => p.id == req.params.id);
  if (!pedido) return res.sendStatus(404);
  pedido.estado = 'en-camino';
  res.json(pedido);
});

// ---------------- TRACKING ----------------
io.on('connection', socket => {
  socket.on('ubicacion-repartidor', data => {
    io.emit('tracking', data);
  });
});

server.listen(3000, () =>
  console.log('Servidor en http://localhost:3000')
);
