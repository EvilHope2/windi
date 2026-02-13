import { auth, db } from './firebase.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, set, get, update } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs } from './utils.js';

const statusEl = qs('status');

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function normalizeArWhatsApp(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  const noLeading0 = digits.startsWith('0') ? digits.slice(1) : digits;
  if (noLeading0.startsWith('54')) return `+${noLeading0}`;
  return `+54${noLeading0}`;
}

async function ensureCustomerProfile(user) {
  const userRef = ref(db, `users/${user.uid}`);
  const snap = await get(userRef);
  const userData = snap.val() || {};
  if (!userData.role) {
    await update(userRef, {
      email: user.email || '',
      role: 'customer',
      createdAt: Date.now()
    });
    return;
  }
  if (userData.role !== 'customer') {
    throw new Error('Esta cuenta no es de cliente. Usa una cuenta cliente.');
  }
}

qs('loginBtn').addEventListener('click', async () => {
  try {
    const email = qs('loginEmail').value.trim();
    const password = qs('loginPassword').value.trim();
    if (!email || !password) return setStatus('Completa email y contrasena.');
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await ensureCustomerProfile(cred.user);
    window.location.href = '/marketplace';
  } catch (err) {
    setStatus(err.message);
  }
});

qs('signupBtn').addEventListener('click', async () => {
  try {
    const email = qs('signupEmail').value.trim();
    const whatsappRaw = qs('signupWhatsapp')?.value?.trim() || '';
    const whatsapp = normalizeArWhatsApp(whatsappRaw);
    const password = qs('signupPassword').value.trim();
    if (!email || !password) return setStatus('Completa email y contrasena.');
    if (!whatsapp || whatsapp.replace(/\D/g, '').length < 10) return setStatus('Completa tu WhatsApp valido.');
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await set(ref(db, `users/${cred.user.uid}`), {
      email,
      role: 'customer',
      whatsapp,
      createdAt: Date.now()
    });
    window.location.href = '/marketplace';
  } catch (err) {
    setStatus(err.message);
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    await ensureCustomerProfile(user);
    window.location.href = '/marketplace';
  } catch {
    // if logged with another role, stay here and show login/register
  }
});
