import { auth, db } from './firebase.js';
import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import {
  ref,
  get,
  set,
  update,
  push,
  remove
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs } from './utils.js';
import { attachRioGrandeAutocomplete } from './address-autocomplete.js';
import { getMapboxToken } from './mapbox-token.js';

// Keep consistent with the shared autocomplete bbox to avoid rejecting edge addresses.
const RIO_GRANDE_BBOX = [-68.2, -54.05, -67.35, -53.6];
const RIO_GRANDE_CENTER = [-67.7095, -53.787];
const SUPPORT_WA = '5492964537272';

const statusEl = qs('status');

const profileForm = qs('profileForm');
const profileName = qs('profileName');
const profileWhatsapp = qs('profileWhatsapp');
const profileAvatarUrl = qs('profileAvatarUrl');
const profileEmail = qs('profileEmail');
const profileSaved = qs('profileSaved');

const addressesList = qs('addressesList');
const addAddressBtn = qs('addAddressBtn');
const addressEditor = qs('addressEditor');
const addressEditorTitle = qs('addressEditorTitle');
const addressForm = qs('addressForm');
const addressLabel = qs('addressLabel');
const addressPrimary = qs('addressPrimary');
const addressInput = qs('address');
const betweenStreets = qs('betweenStreets');
const referenceInput = qs('reference');
const addressNotes = qs('addressNotes');
const addressMapContainer = qs('addressMap');
const cancelAddressBtn = qs('cancelAddressBtn');

const prefsForm = qs('prefsForm');
const prefRingBell = qs('prefRingBell');
const prefCallOnArrive = qs('prefCallOnArrive');
const prefWhatsappOnly = qs('prefWhatsappOnly');
const prefLeaveAtDoor = qs('prefLeaveAtDoor');
const prefDefaultInstructions = qs('prefDefaultInstructions');
const prefsSaved = qs('prefsSaved');

const notifyState = qs('notifyState');
const prefPushEnabled = qs('prefPushEnabled');
const prefSoundEnabled = qs('prefSoundEnabled');
const requestNotifyBtn = qs('requestNotifyBtn');

const passwordForm = qs('passwordForm');
const currentPassword = qs('currentPassword');
const newPassword = qs('newPassword');
const logoutBtn = qs('logoutBtn');
const supportBtn = qs('supportBtn');

let currentUser = null;
let currentProfile = null;

let addressAutocomplete = null;
let editingAddressId = null;
let selectedCoords = null;

let map = null;
let pin = null;
let mapReady = false;

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

function pointInRioGrandeBBox(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  return lng >= RIO_GRANDE_BBOX[0]
    && lng <= RIO_GRANDE_BBOX[2]
    && lat >= RIO_GRANDE_BBOX[1]
    && lat <= RIO_GRANDE_BBOX[3];
}

function openWhatsApp(numberRaw, message) {
  const digits = String(numberRaw || '').replace(/\D/g, '');
  const text = encodeURIComponent(String(message || '').trim());
  const url = `https://wa.me/${digits}?text=${text}`;
  const opened = window.open(url, '_blank');
  if (!opened) window.location.href = url;
}

function getUserAddresses(profile) {
  const raw = profile?.addresses && typeof profile.addresses === 'object' ? profile.addresses : null;
  if (raw) {
    return Object.entries(raw)
      .map(([id, a]) => ({ id, ...(a || {}) }))
      .filter((a) => !!a.address)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  const legacyLat = profile?.geo && Number.isFinite(Number(profile.geo.lat)) ? Number(profile.geo.lat) : null;
  const legacyLng = profile?.geo && Number.isFinite(Number(profile.geo.lng)) ? Number(profile.geo.lng) : null;
  const legacyAddress = (profile?.address || '').toString();
  if (legacyAddress && legacyLat != null && legacyLng != null) {
    return [{
      id: 'legacy',
      label: 'Casa',
      address: legacyAddress,
      lat: legacyLat,
      lng: legacyLng,
      reference: profile?.reference || null,
      betweenStreets: null,
      notes: null,
      createdAt: profile?.updatedAt || Date.now(),
      updatedAt: profile?.updatedAt || Date.now()
    }];
  }
  return [];
}

function getPrimaryAddressId(profile) {
  const pid = (profile?.primaryAddressId || '').toString();
  return pid || null;
}

function findPrimaryAddress(profile) {
  const list = getUserAddresses(profile);
  const pid = getPrimaryAddressId(profile);
  if (pid) {
    const found = list.find((a) => a.id === pid);
    if (found) return found;
  }
  if (list.length === 1) return list[0];
  return null;
}

function renderAddresses(profile) {
  const list = getUserAddresses(profile);
  const primaryId = getPrimaryAddressId(profile);

  addressesList.innerHTML = '';
  if (!list.length) {
    addressesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Todavia no tenes direcciones</div>
        <div class="empty-sub">Agrega tu direccion para poder pedir en Windi.</div>
        <div class="row" style="margin-top:12px;">
          <button id="emptyAddAddressBtn" type="button">Agregar direccion</button>
        </div>
      </div>
    `;
    const btn = qs('emptyAddAddressBtn');
    if (btn) btn.addEventListener('click', () => openAddressEditor(null).catch((err) => setStatus(err.message)));
    return;
  }

  list.forEach((addr) => {
    const isPrimary = primaryId ? addr.id === primaryId : (addr.id === 'legacy');
    const wrapper = document.createElement('div');
    wrapper.className = 'address-card';
    wrapper.innerHTML = `
      <div class="address-top">
        <div>
          <div class="address-title">${addr.label || 'Direccion'} ${isPrimary ? '<span class="pill">Principal</span>' : ''}</div>
          <div class="muted">${addr.address || ''}</div>
          ${addr.reference ? `<div class="muted">Ref: ${String(addr.reference)}</div>` : ''}
        </div>
      </div>
      <div class="address-actions">
        <button type="button" class="secondary" data-action="edit">Editar</button>
        ${isPrimary ? '' : '<button type="button" data-action="primary">Marcar principal</button>'}
        ${addr.id === 'legacy' ? '' : '<button type="button" class="danger" data-action="delete">Eliminar</button>'}
      </div>
    `;
    wrapper.querySelector('[data-action="edit"]')?.addEventListener('click', () => openAddressEditor(addr));
    wrapper.querySelector('[data-action="primary"]')?.addEventListener('click', () => setPrimaryAddress(addr));
    wrapper.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteAddress(addr));
    addressesList.appendChild(wrapper);
  });
}

async function ensureMap() {
  if (mapReady) return;
  if (!window.mapboxgl) throw new Error('Mapbox no esta disponible.');
  const token = await getMapboxToken();
  if (!token) throw new Error('Mapbox no configurado.');
  mapboxgl.accessToken = token;

  map = new mapboxgl.Map({
    container: addressMapContainer,
    style: 'mapbox://styles/mapbox/navigation-day-v1',
    center: RIO_GRANDE_CENTER,
    zoom: 12.5,
    maxBounds: RIO_GRANDE_BBOX
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');

  pin = new mapboxgl.Marker({ draggable: true, color: '#dc2626' })
    .setLngLat(RIO_GRANDE_CENTER)
    .addTo(map);

  pin.on('dragend', () => {
    const ll = pin.getLngLat();
    const coords = [Number(ll.lng), Number(ll.lat)];
    if (!pointInRioGrandeBBox(coords)) {
      setStatus('Solo disponible en Rio Grande.');
      pin.setLngLat(selectedCoords || RIO_GRANDE_CENTER);
      return;
    }
    selectedCoords = coords;
    setStatus('');
  });

  mapReady = true;
}

async function setMapPoint(coords) {
  await ensureMap();
  if (!pointInRioGrandeBBox(coords)) {
    setStatus('Solo disponible en Rio Grande.');
    return false;
  }
  selectedCoords = [Number(coords[0]), Number(coords[1])];
  pin.setLngLat(selectedCoords);
  map.easeTo({ center: selectedCoords, zoom: 15, duration: 500 });
  setStatus('');
  return true;
}

function openEditorUi() {
  addressEditor.classList.remove('hidden');
  // Mapbox needs to be resized when container becomes visible
  setTimeout(() => {
    try { map?.resize(); } catch {}
  }, 50);
}

function closeEditorUi() {
  addressEditor.classList.add('hidden');
  editingAddressId = null;
  selectedCoords = null;
  addressPrimary.checked = false;
  addressLabel.value = 'Casa';
  betweenStreets.value = '';
  referenceInput.value = '';
  addressNotes.value = '';
  if (addressAutocomplete) {
    addressAutocomplete.setSelectedFromStored({ address: '', lat: null, lng: null, city: 'Rio Grande' });
  } else {
    addressInput.value = '';
  }
  setStatus('');
}

async function openAddressEditor(addr) {
  editingAddressId = addr?.id || null;
  addressEditorTitle.textContent = editingAddressId && editingAddressId !== 'legacy' ? 'Editar direccion' : 'Nueva direccion';
  addressLabel.value = addr?.label || 'Casa';
  betweenStreets.value = addr?.betweenStreets || '';
  referenceInput.value = addr?.reference || '';
  addressNotes.value = addr?.notes || '';

  // Primary
  const primaryId = getPrimaryAddressId(currentProfile);
  addressPrimary.checked = !!(primaryId && editingAddressId === primaryId);

  if (!addressAutocomplete) {
    addressAutocomplete = attachRioGrandeAutocomplete(addressInput, {
      onSelect: async (selected) => {
        if (selected && selected.lng != null && selected.lat != null) {
          // Map is best-effort: the address selection should still work even if map fails.
          try { await setMapPoint([Number(selected.lng), Number(selected.lat)]); } catch {}
          if (selected.approximate) {
            setStatus('No encontramos la altura exacta para esta calle. Ajusta el pin para ubicar tu casa.');
          } else {
            setStatus('');
          }
        } else {
          selectedCoords = null;
        }
      },
      onInvalidate: () => {
        selectedCoords = null;
        setStatus('Selecciona una direccion de la lista para continuar.');
      }
    });
  }

  addressAutocomplete.setSelectedFromStored({
    address: addr?.address || '',
    lat: addr?.lat,
    lng: addr?.lng,
    city: 'Rio Grande'
  });

  openEditorUi();
  setTimeout(() => { try { addressInput?.focus(); } catch {} }, 0);

  // Map load is best-effort. Even if Mapbox is missing/misconfigured, the user should be able to type/select.
  try {
    await ensureMap();
    if (addr?.lng != null && addr?.lat != null) {
      await setMapPoint([Number(addr.lng), Number(addr.lat)]);
    } else {
      selectedCoords = null;
    }
  } catch (err) {
    selectedCoords = null;
    setStatus(err?.message || 'No se pudo cargar el mapa. Igualmente podes buscar la direccion.');
  }
}

async function setPrimaryAddress(addr) {
  if (!currentUser) return;
  if (!addr || addr.lng == null || addr.lat == null || !addr.address) return;
  const now = Date.now();

  await update(ref(db, `users/${currentUser.uid}`), {
    primaryAddressId: addr.id === 'legacy' ? null : addr.id,
    address: addr.address,
    reference: addr.reference || null,
    geo: { lng: Number(addr.lng), lat: Number(addr.lat) },
    city: 'Rio Grande',
    updatedAt: now
  });
  setStatus('Direccion principal actualizada.');
}

async function deleteAddress(addr) {
  if (!currentUser) return;
  if (!addr || !addr.id || addr.id === 'legacy') return;
  const ok = confirm('Eliminar esta direccion?');
  if (!ok) return;
  await remove(ref(db, `users/${currentUser.uid}/addresses/${addr.id}`));
  const primaryId = getPrimaryAddressId(currentProfile);
  if (primaryId && primaryId === addr.id) {
    await update(ref(db, `users/${currentUser.uid}`), { primaryAddressId: null, updatedAt: Date.now() });
  }
  setStatus('Direccion eliminada.');
}

async function loadProfile(uid) {
  const userRef = ref(db, `users/${uid}`);
  const snap = await get(userRef);
  const data = snap.val() || {};
  if (data.role && data.role !== 'customer') throw new Error('Tu cuenta no tiene rol cliente.');
  currentProfile = data;
  return data;
}

function renderProfile(user, profile) {
  profileEmail.value = user?.email || '';
  profileName.value = profile?.nombreApellido || profile?.name || '';
  profileWhatsapp.value = profile?.whatsapp || '';
  profileAvatarUrl.value = profile?.avatarUrl || '';
  profileSaved.textContent = '';
}

function renderPrefs(profile) {
  const prefs = profile?.deliveryPrefs || {};
  prefRingBell.checked = prefs.ringBell === true;
  prefCallOnArrive.checked = prefs.callOnArrive === true;
  prefWhatsappOnly.checked = prefs.whatsappOnly === true;
  prefLeaveAtDoor.checked = prefs.leaveAtDoor === true;
  prefDefaultInstructions.value = prefs.defaultInstructions || '';
  prefsSaved.textContent = '';
}

function refreshNotifyUi(profile) {
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  const hasSW = !!navigator.serviceWorker;
  const pushSupported = hasSW && permission !== 'unsupported';
  const prefs = profile?.notifyPrefs || {};

  notifyState.textContent = pushSupported
    ? `Permiso: ${permission}`
    : 'Push no disponible en este dispositivo.';

  prefPushEnabled.disabled = !pushSupported;
  prefPushEnabled.checked = prefs.pushEnabled === true;

  prefSoundEnabled.checked = prefs.soundEnabled !== false;
}

profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const name = profileName.value.trim();
  const wa = normalizeArWhatsApp(profileWhatsapp.value.trim());
  if (!name) return setStatus('Completa tu nombre y apellido.');
  if (!wa || wa.replace(/\D/g, '').length < 10) return setStatus('WhatsApp invalido.');

  try {
    const now = Date.now();
    await update(ref(db, `users/${currentUser.uid}`), {
      email: currentUser.email || '',
      role: 'customer',
      nombreApellido: name,
      whatsapp: wa,
      avatarUrl: profileAvatarUrl.value.trim() || null,
      updatedAt: now
    });
    profileSaved.textContent = 'Guardado.';
    setStatus('');
  } catch (err) {
    setStatus(err.message);
  }
});

addAddressBtn.addEventListener('click', () => openAddressEditor(null).catch((err) => setStatus(err.message)));
cancelAddressBtn.addEventListener('click', closeEditorUi);

addressForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return setStatus('Debes iniciar sesion.');
  if (!addressAutocomplete || !addressAutocomplete.isSelectionValid()) {
    return setStatus('Selecciona una direccion de la lista para continuar.');
  }
  if (!selectedCoords || !pointInRioGrandeBBox(selectedCoords)) {
    return setStatus('Ajusta el marcador dentro de Rio Grande para continuar.');
  }
  const selected = addressAutocomplete.getSelected();
  const address = selected.address;
  const now = Date.now();
  const payload = {
    label: addressLabel.value || 'Casa',
    address,
    lng: Number(selectedCoords[0]),
    lat: Number(selectedCoords[1]),
    betweenStreets: betweenStreets.value.trim() || null,
    reference: referenceInput.value.trim() || null,
    notes: addressNotes.value.trim() || null,
    updatedAt: now,
    city: 'Rio Grande'
  };

  try {
    if (editingAddressId && editingAddressId !== 'legacy') {
      await update(ref(db, `users/${currentUser.uid}/addresses/${editingAddressId}`), payload);
      if (addressPrimary.checked) {
        await update(ref(db, `users/${currentUser.uid}`), {
          primaryAddressId: editingAddressId,
          address,
          reference: payload.reference,
          geo: { lng: payload.lng, lat: payload.lat },
          city: 'Rio Grande',
          updatedAt: now
        });
      }
    } else {
      const newRef = push(ref(db, `users/${currentUser.uid}/addresses`));
      const id = newRef.key;
      await set(newRef, { ...payload, createdAt: now });
      if (addressPrimary.checked) {
        await update(ref(db, `users/${currentUser.uid}`), {
          primaryAddressId: id,
          address,
          reference: payload.reference,
          geo: { lng: payload.lng, lat: payload.lat },
          city: 'Rio Grande',
          updatedAt: now
        });
      } else {
        // If user has no primary yet, keep legacy fields in sync (best default UX).
        const primary = findPrimaryAddress(currentProfile);
        if (!primary) {
          await update(ref(db, `users/${currentUser.uid}`), {
            primaryAddressId: id,
            address,
            reference: payload.reference,
            geo: { lng: payload.lng, lat: payload.lat },
            city: 'Rio Grande',
            updatedAt: now
          });
        }
      }
    }

    closeEditorUi();
    setStatus('Direccion guardada.');
    currentProfile = await loadProfile(currentUser.uid);
    renderAddresses(currentProfile);
  } catch (err) {
    setStatus(err.message);
  }
});

prefsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  try {
    await update(ref(db, `users/${currentUser.uid}`), {
      deliveryPrefs: {
        ringBell: prefRingBell.checked,
        callOnArrive: prefCallOnArrive.checked,
        whatsappOnly: prefWhatsappOnly.checked,
        leaveAtDoor: prefLeaveAtDoor.checked,
        defaultInstructions: prefDefaultInstructions.value.trim() || null
      },
      updatedAt: Date.now()
    });
    prefsSaved.textContent = 'Guardado.';
    setStatus('');
  } catch (err) {
    setStatus(err.message);
  }
});

prefPushEnabled.addEventListener('change', async () => {
  if (!currentUser) return;
  await update(ref(db, `users/${currentUser.uid}`), {
    notifyPrefs: {
      ...(currentProfile?.notifyPrefs || {}),
      pushEnabled: prefPushEnabled.checked
    },
    updatedAt: Date.now()
  });
});

prefSoundEnabled.addEventListener('change', async () => {
  if (!currentUser) return;
  await update(ref(db, `users/${currentUser.uid}`), {
    notifyPrefs: {
      ...(currentProfile?.notifyPrefs || {}),
      soundEnabled: prefSoundEnabled.checked
    },
    updatedAt: Date.now()
  });
});

requestNotifyBtn.addEventListener('click', async () => {
  if (typeof Notification === 'undefined') {
    setStatus('Notificaciones no disponibles en este dispositivo.');
    return;
  }
  try {
    await Notification.requestPermission();
    refreshNotifyUi(currentProfile);
    setStatus('');
  } catch {
    setStatus('No se pudo solicitar permiso de notificaciones.');
  }
});

passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!auth.currentUser) return;
  const curr = currentPassword.value;
  const next = newPassword.value;
  if (!curr || !next) return setStatus('Completa contrasena actual y nueva.');
  if (String(next).length < 6) return setStatus('La nueva contrasena debe tener al menos 6 caracteres.');
  try {
    const cred = EmailAuthProvider.credential(auth.currentUser.email || '', curr);
    await reauthenticateWithCredential(auth.currentUser, cred);
    await updatePassword(auth.currentUser, next);
    currentPassword.value = '';
    newPassword.value = '';
    setStatus('Contrasena actualizada.');
  } catch (err) {
    setStatus(err.message || 'No se pudo cambiar la contrasena.');
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
  window.location.href = '/marketplace-auth';
});

supportBtn.addEventListener('click', () => {
  const msg = 'Hola soporte Windi, necesito ayuda con mi cuenta. Mi problema es: ';
  openWhatsApp(SUPPORT_WA, msg);
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = '/marketplace-auth';
    return;
  }
  currentUser = user;
  setStatus('');
  try {
    const profile = await loadProfile(user.uid);
    renderProfile(user, profile);
    renderAddresses(profile);
    renderPrefs(profile);
    refreshNotifyUi(profile);

    // UX: if user has no addresses yet, open the editor automatically to avoid confusion.
    if (!getUserAddresses(profile).length) {
      openAddressEditor(null).catch(() => {});
    }
  } catch (err) {
    setStatus(err.message);
  }
});
