import { auth, db } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js';
import { ref, onValue, get, update } from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js';
import { qs, fmtMoney } from './utils.js';
import { getCart, saveCart, enforceSingleMerchant, calcSubtotal } from './marketplace-common.js';

const merchantList = qs('merchantList');
const productList = qs('productList');
const authInfo = qs('authInfo');
const statusEl = qs('status');
const logoutBtn = qs('logoutBtn');
const merchantSearch = qs('merchantSearch');
const marketplaceHome = qs('marketplaceHome');
const merchantDetailView = qs('merchantDetailView');
const backToMarketplaceBtn = qs('backToMarketplaceBtn');
const merchantHero = qs('merchantHero');
const merchantNameTitle = qs('merchantNameTitle');
const merchantMetaSubtitle = qs('merchantMetaSubtitle');
const shareMerchantBtn = qs('shareMerchantBtn');
const productCategoryTabs = qs('productCategoryTabs');
const loadMoreMerchantsBtn = qs('loadMoreMerchantsBtn');
const chipFilters = qs('chipFilters');
const dynamicCategoryChips = qs('dynamicCategoryChips');
const modal = qs('singleMerchantModal');
const cancelSwitchBtn = qs('cancelMerchantSwitchBtn');
const confirmSwitchBtn = qs('confirmMerchantSwitchBtn');
const floatingCartBar = qs('floatingCartBar');
const floatingCartCount = qs('floatingCartCount');
const floatingCartMerchant = qs('floatingCartMerchant');
const floatingCartTotal = qs('floatingCartTotal');

let merchants = {};
let products = {};
let merchantsLoaded = false;
let currentMerchantId = null;
let currentUser = null;
let visibleMerchantCount = 8;
let selectedGlobalFilter = 'all';
let selectedCategoryFilter = '';
let selectedProductCategory = '';
let pendingAdd = null;

const pathParts = location.pathname.split('/').filter(Boolean);
const requestedMerchantId = pathParts[0] === 'marketplace' && pathParts[1]
  ? decodeURIComponent(pathParts[1])
  : new URLSearchParams(location.search).get('merchantId');

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function renderMerchantSkeleton(count = 6) {
  merchantList.innerHTML = '';
  for (let i = 0; i < count; i += 1) {
    const div = document.createElement('div');
    div.className = 'skeleton-card';
    div.innerHTML = `
      <div class="skeleton media"></div>
      <div style="display:grid; gap:8px; align-content:center;">
        <div class="skeleton line" style="width: 72%;"></div>
        <div class="skeleton line sm"></div>
        <div class="skeleton line" style="width: 88%; height: 10px;"></div>
      </div>
    `;
    merchantList.appendChild(div);
  }
}

function merchantCategory(merchant) {
  return (merchant.category || merchant.rubro || 'General').toString();
}

function merchantEta(merchant) {
  const min = Number(merchant.deliveryEtaMin || 20);
  const max = Number(merchant.deliveryEtaMax || (min + 15));
  return `${min}-${max} min`;
}

function merchantShippingFee(merchant) {
  const fee = Number(merchant.shippingFee || 0);
  if (fee <= 0) return 'Envio incluido';
  return fmtMoney(fee);
}

function merchantImage(merchant) {
  return merchant.logoUrl || merchant.imageUrl || merchant.bannerUrl || '/icons/icon.svg';
}

function parseScheduleRange(scheduleText) {
  if (!scheduleText) return null;
  const text = String(scheduleText).toLowerCase();
  const match = text.match(/(\d{1,2})[:.](\d{2})\s*(?:a|-|hasta)\s*(\d{1,2})[:.](\d{2})/i);
  if (!match) return null;
  const openH = Number(match[1]);
  const openM = Number(match[2]);
  const closeH = Number(match[3]);
  const closeM = Number(match[4]);
  if (![openH, openM, closeH, closeM].every(Number.isFinite)) return null;
  if (openH < 0 || openH > 23 || closeH < 0 || closeH > 23 || openM < 0 || openM > 59 || closeM < 0 || closeM > 59) return null;
  return {
    openMin: openH * 60 + openM,
    closeMin: closeH * 60 + closeM
  };
}

function isOpenBySchedule(scheduleText) {
  const range = parseScheduleRange(scheduleText);
  if (!range) return true;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (range.closeMin >= range.openMin) {
    return nowMin >= range.openMin && nowMin < range.closeMin;
  }
  return nowMin >= range.openMin || nowMin < range.closeMin;
}

function merchantOpenState(merchant) {
  const mode = (merchant.openingMode || '').toLowerCase();
  if (mode === 'manual') return merchant.manualOpen !== false;
  if (typeof merchant.isOpen === 'boolean') return merchant.isOpen;
  return isOpenBySchedule(merchant.schedule || merchant.horario || '');
}

function getActiveMerchants() {
  return Object.entries(merchants)
    .filter(([, merchant]) => {
      const status = (merchant.status || '').toLowerCase();
      const isActiveStatus = status === 'active' || status === 'activo';
      const isVerified = merchant.isVerified !== false;
      return isActiveStatus && isVerified;
    })
    .sort((a, b) => (b[1].isFeatured === true) - (a[1].isFeatured === true));
}

function getMerchantProducts(merchantId) {
  return Object.entries(products)
    .filter(([, product]) => product.merchantId === merchantId && product.isActive !== false)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
}

function matchesGlobalFilter(merchant, entries) {
  if (selectedGlobalFilter === 'promo') {
    return merchant.hasPromo === true || entries.some(([, p]) => p.isPromo === true || p.promo === true);
  }
  if (selectedGlobalFilter === 'popular') {
    return merchant.isPopular === true || entries.some(([, p]) => Number(p.salesCount || 0) > 20);
  }
  return true;
}

function renderDynamicCategoryChips(activeMerchantEntries) {
  const categories = [...new Set(activeMerchantEntries.map(([, merchant]) => merchantCategory(merchant).toLowerCase()))];
  dynamicCategoryChips.innerHTML = '';
  if (!categories.length) return;

  const allChip = document.createElement('button');
  allChip.className = `mp-chip ${selectedCategoryFilter === '' ? 'active' : ''}`;
  allChip.textContent = 'Todas categorias';
  allChip.addEventListener('click', () => {
    selectedCategoryFilter = '';
    renderMerchants();
  });
  dynamicCategoryChips.appendChild(allChip);

  categories.forEach((category) => {
    const chip = document.createElement('button');
    chip.className = `mp-chip ${selectedCategoryFilter === category ? 'active' : ''}`;
    chip.textContent = category;
    chip.addEventListener('click', () => {
      selectedCategoryFilter = category;
      renderMerchants();
    });
    dynamicCategoryChips.appendChild(chip);
  });
}

function renderMerchants() {
  const term = (merchantSearch.value || '').trim().toLowerCase();
  const activeMerchantEntries = getActiveMerchants();
  renderDynamicCategoryChips(activeMerchantEntries);

  const filtered = activeMerchantEntries
    .filter(([id, merchant]) => {
      const entries = getMerchantProducts(id);
      const merchantText = `${merchant.name || ''} ${merchantCategory(merchant)}`.toLowerCase();
      const anyProductMatch = entries.some(([, product]) => `${product.name || ''} ${product.description || ''}`.toLowerCase().includes(term));
      const searchMatch = term ? (merchantText.includes(term) || anyProductMatch) : true;
      const categoryMatch = selectedCategoryFilter ? merchantCategory(merchant).toLowerCase() === selectedCategoryFilter : true;
      const quickFilterMatch = matchesGlobalFilter(merchant, entries);
      return searchMatch && categoryMatch && quickFilterMatch;
    });

  const list = filtered.slice(0, visibleMerchantCount);
  merchantList.innerHTML = '';

  if (!list.length) {
    merchantList.innerHTML = '<div class="mp-merchant-card"><div class="muted">No encontramos comercios para ese filtro.</div></div>';
    loadMoreMerchantsBtn.classList.add('hidden');
    return;
  }

  list.forEach(([id, merchant]) => {
    const entries = getMerchantProducts(id);
    const highlighted = merchant.isFeatured === true || merchant.hasPromo === true;
    const isOpen = merchantOpenState(merchant);
    const card = document.createElement('article');
    card.className = 'mp-merchant-card';
    card.innerHTML = `
      <div class="mp-merchant-main">
        <img class="mp-merchant-media" src="${merchantImage(merchant)}" alt="${merchant.name || 'Comercio'}" loading="lazy" />
        <div>
          <strong>${merchant.name || 'Comercio local'}</strong>
          <div class="muted">${merchantCategory(merchant)}</div>
          <div class="mp-merchant-meta-line">
            <span class="mp-tag ${isOpen ? 'open' : 'closed'}">${isOpen ? 'Abierto' : 'Cerrado'}</span>
            <span class="mp-tag">${merchantEta(merchant)}</span>
            <span class="mp-tag">${merchantShippingFee(merchant)}</span>
            ${highlighted ? '<span class="mp-tag promo">Destacado</span>' : ''}
            ${entries.some(([, p]) => p.isPromo === true || p.promo === true) ? '<span class="mp-tag promo">Promo</span>' : ''}
          </div>
        </div>
      </div>
      <div class="mp-merchant-actions">
        <button data-id="${id}" class="secondary">Ver productos</button>
      </div>
    `;
    card.querySelector('button').addEventListener('click', () => openMerchant(id, true));
    merchantList.appendChild(card);
  });

  if (filtered.length > list.length) {
    loadMoreMerchantsBtn.classList.remove('hidden');
  } else {
    loadMoreMerchantsBtn.classList.add('hidden');
  }
}

function renderProductCategories(entries) {
  const categories = [...new Set(entries.map(([, product]) => (product.category || 'General').toString()))];
  productCategoryTabs.innerHTML = '';
  selectedProductCategory = selectedProductCategory && categories.includes(selectedProductCategory) ? selectedProductCategory : '';

  const allTab = document.createElement('button');
  allTab.className = `mp-tab ${selectedProductCategory === '' ? 'active' : ''}`;
  allTab.textContent = 'Todos';
  allTab.addEventListener('click', () => {
    selectedProductCategory = '';
    renderMerchantProducts();
  });
  productCategoryTabs.appendChild(allTab);

  categories.forEach((category) => {
    const tab = document.createElement('button');
    tab.className = `mp-tab ${selectedProductCategory === category ? 'active' : ''}`;
    tab.textContent = category;
    tab.addEventListener('click', () => {
      selectedProductCategory = category;
      renderMerchantProducts();
    });
    productCategoryTabs.appendChild(tab);
  });
}

function productImage(product) {
  return product.imageUrl || '/icons/icon.svg';
}

function renderMerchantProducts() {
  if (!currentMerchantId || !merchants[currentMerchantId]) return;
  const entries = getMerchantProducts(currentMerchantId);
  renderProductCategories(entries);

  const filtered = selectedProductCategory
    ? entries.filter(([, p]) => (p.category || 'General').toString() === selectedProductCategory)
    : entries;

  productList.innerHTML = '';
  if (!filtered.length) {
    productList.innerHTML = '<article class="mp-product-card"><div class="muted">Sin productos para esta categoria.</div></article>';
    return;
  }

  filtered.forEach(([id, product]) => {
    const stockValue = product.stock == null ? null : Number(product.stock);
    const outOfStock = stockValue != null && stockValue <= 0;

    const card = document.createElement('article');
    card.className = 'mp-product-card';
    card.innerHTML = `
      <img class="mp-product-image" src="${productImage(product)}" alt="${product.name || 'Producto'}" loading="lazy" />
      <div>
        <h3 class="mp-product-title">${product.name || 'Producto'}</h3>
        <p class="mp-product-desc">${product.description || 'Sin descripcion'}</p>
        <strong>${fmtMoney(product.price || 0)}</strong>
      </div>
      <button class="mp-add-btn" data-id="${id}" ${outOfStock ? 'disabled' : ''}>+</button>
    `;

    const addBtn = card.querySelector('.mp-add-btn');
    addBtn.addEventListener('click', () => addToCart(id, product, addBtn));
    productList.appendChild(card);
  });
}

function openMerchant(merchantId, shouldPush) {
  const merchant = merchants[merchantId];
  if (!merchant) return;

  currentMerchantId = merchantId;
  marketplaceHome.classList.remove('active');
  merchantDetailView.classList.add('active');

  merchantHero.innerHTML = `<img src="${merchantImage(merchant)}" alt="${merchant.name || 'Comercio'}" loading="lazy" />`;
  merchantNameTitle.textContent = merchant.name || 'Comercio local';
  const openText = merchantOpenState(merchant) ? 'Abierto' : 'Cerrado';
  merchantMetaSubtitle.textContent = `${merchantCategory(merchant)} | ${openText} | ${merchantEta(merchant)} | ${merchantShippingFee(merchant)}`;

  if (shouldPush) {
    history.pushState({ merchantId }, '', `/marketplace/${encodeURIComponent(merchantId)}`);
  }

  renderMerchantProducts();
}

function closeMerchant(shouldPush) {
  merchantDetailView.classList.remove('active');
  marketplaceHome.classList.add('active');
  if (shouldPush) {
    history.pushState({}, '', '/marketplace');
  }
}

function openSingleMerchantModal(next) {
  pendingAdd = next;
  modal.classList.remove('hidden');
}

function closeSingleMerchantModal() {
  pendingAdd = null;
  modal.classList.add('hidden');
}

function addToCart(productId, product, button) {
  const cart = getCart();
  const enforce = enforceSingleMerchant(cart, product.merchantId, merchants[product.merchantId]?.name || 'Comercio');

  if (!enforce.ok) {
    openSingleMerchantModal({ productId, product });
    return;
  }

  const working = enforce.cart;
  const existing = working.items.find((item) => item.productId === productId);
  const stockValue = product.stock == null ? null : Number(product.stock);
  const existingQty = existing ? Number(existing.qty || 0) : 0;

  if (stockValue != null && existingQty + 1 > stockValue) {
    setStatus('No hay stock suficiente para esa cantidad.');
    return;
  }

  if (existing) {
    existing.qty += 1;
  } else {
    working.items.push({
      productId,
      merchantId: product.merchantId,
      nameSnapshot: product.name,
      unitPriceSnapshot: Number(product.price || 0),
      qty: 1,
      imageUrl: product.imageUrl || ''
    });
  }

  saveCart(working);
  updateFloatingCart();
  setStatus('Producto agregado al carrito.');

  if (button) {
    button.classList.remove('pulse');
    void button.offsetWidth;
    button.classList.add('pulse');
  }
}

function forceSwitchMerchantAndAdd() {
  if (!pendingAdd) return;
  const next = pendingAdd;
  const cart = getCart();
  cart.items = [];
  cart.merchantId = next.product.merchantId;
  cart.merchantName = merchants[next.product.merchantId]?.name || 'Comercio';
  saveCart(cart);
  closeSingleMerchantModal();
  addToCart(next.productId, next.product, null);
}

function updateFloatingCart() {
  const cart = getCart();
  if (!cart.items.length || !cart.merchantId) {
    floatingCartBar.classList.add('hidden');
    return;
  }

  const count = cart.items.reduce((acc, item) => acc + Number(item.qty || 0), 0);
  const subtotal = calcSubtotal(cart.items);

  floatingCartCount.textContent = `${count} ${count === 1 ? 'producto' : 'productos'}`;
  floatingCartMerchant.textContent = cart.merchantName || 'Comercio';
  floatingCartTotal.textContent = fmtMoney(subtotal);
  floatingCartBar.classList.remove('hidden');
}

function setGlobalFilterFromChip(targetChip) {
  chipFilters.querySelectorAll('.mp-chip').forEach((chip) => chip.classList.remove('active'));
  targetChip.classList.add('active');
  selectedGlobalFilter = targetChip.getAttribute('data-filter') || 'all';
  visibleMerchantCount = 8;
  renderMerchants();
}

function applyAuthRedirect() {
  window.location.href = '/marketplace-auth';
}

merchantSearch.addEventListener('input', () => {
  visibleMerchantCount = 8;
  renderMerchants();
});

chipFilters.querySelectorAll('.mp-chip').forEach((chip) => {
  chip.addEventListener('click', () => setGlobalFilterFromChip(chip));
});

loadMoreMerchantsBtn.addEventListener('click', () => {
  visibleMerchantCount += 8;
  renderMerchants();
});

logoutBtn.addEventListener('click', async () => {
  await signOut(auth);
  applyAuthRedirect();
});

backToMarketplaceBtn.addEventListener('click', () => closeMerchant(true));

shareMerchantBtn.addEventListener('click', async () => {
  if (!currentMerchantId || !merchants[currentMerchantId]) return;
  const merchant = merchants[currentMerchantId];
  const url = `${location.origin}/marketplace/${encodeURIComponent(currentMerchantId)}`;
  const payload = {
    title: merchant.name || 'Comercio Windi',
    text: `Mira este comercio en Windi: ${merchant.name || 'Comercio local'}`,
    url
  };

  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch {
      // fallback below
    }
  }
  await navigator.clipboard.writeText(url);
  setStatus('Link copiado para compartir.');
});

cancelSwitchBtn.addEventListener('click', closeSingleMerchantModal);
confirmSwitchBtn.addEventListener('click', forceSwitchMerchantAndAdd);

window.addEventListener('popstate', () => {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'marketplace' && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    if (merchants[id]) openMerchant(id, false);
    return;
  }
  closeMerchant(false);
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    applyAuthRedirect();
    return;
  }

  const userRef = ref(db, `users/${user.uid}`);
  const userSnap = await get(userRef);
  const userData = userSnap.val() || {};

  if (!userData.role) {
    await update(userRef, {
      email: user.email || '',
      role: 'customer',
      createdAt: Date.now()
    });
  } else if (userData.role !== 'customer') {
    setStatus('Esta cuenta no tiene rol cliente.');
    await signOut(auth);
    applyAuthRedirect();
    return;
  }

  authInfo.textContent = user.email ? user.email : 'Sesion activa';
  updateFloatingCart();
});

onValue(ref(db, 'merchants'), (snap) => {
  merchants = snap.val() || {};
  merchantsLoaded = true;

  if (requestedMerchantId && merchants[requestedMerchantId]) {
    openMerchant(requestedMerchantId, false);
  } else {
    const currentParts = location.pathname.split('/').filter(Boolean);
    if (currentParts[0] === 'marketplace' && currentParts[1] && merchants[decodeURIComponent(currentParts[1])]) {
      openMerchant(decodeURIComponent(currentParts[1]), false);
    } else {
      closeMerchant(false);
    }
  }

  renderMerchants();
}, (err) => setStatus(err.message));

onValue(ref(db, 'products'), (snap) => {
  products = snap.val() || {};
  renderMerchants();
  renderMerchantProducts();
}, (err) => setStatus(err.message));

// No fallback from /users due read restrictions for non-admin users.

// Initial UX: show skeleton before first DB payload arrives.
if (merchantList) {
  renderMerchantSkeleton(6);
}
