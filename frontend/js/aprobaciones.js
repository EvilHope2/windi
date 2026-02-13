import { auth, db } from './firebase.js';
import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, get, onValue, update } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtTime } from './utils.js';

const authSection = qs('authSection');
const appSection = qs('appSection');
const statusEl = qs('status');
const loginEmail = qs('loginEmail');
const loginPassword = qs('loginPassword');
const loginBtn = qs('loginBtn');
const logoutBtn = qs('logoutBtn');
const pendingInfo = qs('pendingInfo');
const pendingList = qs('pendingList');

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

async function isAdmin(uid) {
  const snap = await get(ref(db, `admins/${uid}`));
  return snap.val() === true;
}

async function setValidation(uid, status) {
  await update(ref(db, `users/${uid}`), {
    validationStatus: status,
    validationUpdatedAt: Date.now()
  });
  setStatus(`Repartidor ${status}.`);
}

function renderPending(users) {
  pendingList.innerHTML = '';
  const entries = Object.entries(users || {})
    .filter(([, u]) => u.role === 'repartidor' && (u.validationStatus || 'pending') === 'pending')
    .sort((a, b) => (b[1].validationRequestedAt || 0) - (a[1].validationRequestedAt || 0));

  if (entries.length === 0) {
    pendingInfo.textContent = 'No hay solicitudes pendientes.';
    pendingList.innerHTML = '<div class="item"><div class="muted">Sin pendientes por revisar.</div></div>';
    return;
  }

  pendingInfo.textContent = `${entries.length} solicitudes pendientes.`;
  entries.forEach(([uid, u]) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <strong>${u.nombreApellido || 'Sin nombre'}</strong>
        <span class="status pending">pending</span>
      </div>
      <div class="muted">UID: ${uid}</div>
      <div class="muted">Email: ${u.email || '-'}</div>
      <div class="muted">DNI: ${u.dni || '-'}</div>
      <div class="muted">Vehiculo: ${u.vehiculoTipo || '-'} ${u.patente ? `| Patente: ${u.patente}` : ''}</div>
      <div class="muted">WhatsApp: ${u.whatsapp || '-'}</div>
      <div class="muted">Solicitado: ${fmtTime(u.validationRequestedAt)}</div>
      <div class="row">
        <button data-action="approve">Aprobar</button>
        <button data-action="reject" class="danger">Rechazar</button>
      </div>
    `;
    div.querySelector('[data-action="approve"]').addEventListener('click', () => setValidation(uid, 'approved'));
    div.querySelector('[data-action="reject"]').addEventListener('click', () => setValidation(uid, 'rejected'));
    pendingList.appendChild(div);
  });
}

loginBtn.addEventListener('click', async () => {
  const email = loginEmail.value.trim();
  const password = loginPassword.value.trim();
  if (!email || !password) return setStatus('Completa email y contrasena.');
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    setStatus('');
    return;
  }

  try {
    const admin = await isAdmin(user.uid);
    if (!admin) {
      setStatus('Tu cuenta no tiene permisos de admin.');
      await signOut(auth);
      return;
    }
  } catch (err) {
    setStatus(err.message);
    return;
  }

  authSection.classList.add('hidden');
  appSection.classList.remove('hidden');
  setStatus('');

  try {
    const initial = await get(ref(db, 'users'));
    renderPending(initial.val());
  } catch (err) {
    pendingInfo.textContent = 'No se pudieron cargar usuarios.';
    setStatus(`Error leyendo usuarios: ${err.message}`);
  }

  onValue(
    ref(db, 'users'),
    (snap) => {
      renderPending(snap.val());
    },
    (err) => {
      pendingInfo.textContent = 'No se pudieron cargar usuarios.';
      setStatus(`Permiso denegado o reglas no desplegadas: ${err.message}`);
    }
  );
});
