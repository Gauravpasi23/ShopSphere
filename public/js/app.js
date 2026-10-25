const appEl = document.getElementById('app');
const savedOrder = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('shopsphere-last-order') || 'null');
  } catch {
    return null;
  }
})();
const state = {
  products: [],
  categories: [],
  cart: JSON.parse(localStorage.getItem('shopsphere-cart') || '[]'),
  wishlist: JSON.parse(localStorage.getItem('shopsphere-wishlist') || '[]'),
  user: null,
  activePage: 'home',
  selectedCategory: 'all',
  inStockOnly: false,
  searchQuery: '',
  minPrice: '',
  maxPrice: '',
  sort: 'popular',
  page: 1,
  totalPages: 1,
  currentProduct: null,
  currentFilters: {},
  cartOpen: false,
  checkoutStep: 1,
  detailQuantity: 1,
  recentlyViewed: JSON.parse(localStorage.getItem('shopsphere-recent-products') || '[]'),
  accountSection: 'profile',
  orderRequestKey: crypto.randomUUID(),
  checkoutBusy: false,
  order: savedOrder,
  toastTimer: null,
  searchTimer: null,
  matomoEnabled: false,
  lastTrackedPath: '',
  lastMongoPage: '',
  sessionId: localStorage.getItem('shopsphere-analytics-consent') === 'accepted'
    ? sessionStorage.getItem('shopsphere-session') || crypto.randomUUID()
    : ''
};

if (state.sessionId && !sessionStorage.getItem('shopsphere-session')) {
  sessionStorage.setItem('shopsphere-session', state.sessionId);
}

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function renderAccountMenu() {
  const links = state.user
    ? `<a href="/account/profile" data-route="/account/profile">My Profile</a>
       <a href="/account/edit" data-route="/account/edit">Edit Account Details</a>
       <a href="/account/orders" data-route="/account/orders">My Orders</a>
       <a href="/account/addresses" data-route="/account/addresses">My Addresses</a>
       <a href="/account/password" data-route="/account/password">Change Password</a>
       <a href="/wishlist" data-route="/wishlist">Wishlist</a>
       <button type="button" data-action="customer-logout">Logout</button>`
    : `<a href="/login" data-route="/login">Sign in / Register</a>
       <a href="/wishlist" data-route="/wishlist">Wishlist</a>`;
  return `<details class="account-menu"><summary>👤 Account</summary><div class="account-menu-panel">${links}</div></details>`;
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  routeFromLocation();
}

function routeFromLocation() {
  const path = window.location.pathname;
  const productMatch = path.match(/^\/products\/([^/]+)$/);
  if (productMatch) {
    state.activePage = 'product';
    loadProduct(decodeURIComponent(productMatch[1])).catch((error) => {
      showToast(error.message);
      navigate('/shop', true);
    });
    return;
  }
  if (path.startsWith('/account')) {
    if (!state.user) {
      navigate(`/login?returnTo=${encodeURIComponent(path)}`, true);
      return;
    }
    state.activePage = 'account';
    state.accountSection = path.split('/')[2] || 'profile';
    render();
    return;
  }
  if (path === '/checkout' && !state.cart.length) {
    navigate('/cart', true);
    return;
  }
  const routes = {
    '/': 'home',
    '/shop': 'catalog',
    '/login': 'auth',
    '/wishlist': 'wishlist',
    '/cart': 'cart',
    '/checkout': 'checkout',
    '/order-confirmation': 'confirmation'
  };
  state.activePage = routes[path] || 'home';
  if (state.activePage === 'catalog') loadCatalog().catch((error) => showToast(error.message));
  else render();
}

async function syncCustomerData(mergeGuestData = false) {
  if (!state.user) return;
  const guestCart = mergeGuestData ? state.cart : [];
  const guestWishlist = mergeGuestData ? state.wishlist : [];
  const [cartData, wishlistData] = await Promise.all([
    fetchJson('/api/cart'),
    fetchJson('/api/wishlist')
  ]);
  const cartById = new Map(cartData.items.map((item) => [item.productId, item]));
  for (const item of guestCart) {
    const current = cartById.get(item.productId);
    cartById.set(item.productId, {
      ...(current || item),
      quantity: Math.min((current?.quantity || 0) + item.quantity, item.stock)
    });
  }
  state.cart = [...cartById.values()].filter((item) => item.stock > 0);
  state.wishlist = [...new Set([...wishlistData.items.map((item) => item.productId), ...guestWishlist])];
  saveCart();
  saveWishlist();
}

async function logoutCustomer() {
  try {
    await fetchJson('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.cart = [];
    state.wishlist = [];
    saveCart();
    saveWishlist();
    showToast('You have been logged out.');
    navigate('/', true);
  } catch (error) {
    showToast(error.message);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.errors?.[0]?.msg || 'Request failed');
  }
  return data;
}

async function trackEvent(type, payload = {}) {
  if (localStorage.getItem('shopsphere-analytics-consent') !== 'accepted') return;
  if (!state.sessionId) {
    state.sessionId = sessionStorage.getItem('shopsphere-session') || crypto.randomUUID();
    sessionStorage.setItem('shopsphere-session', state.sessionId);
  }
  const event = {
    consent: true,
    type,
    pagePath: payload.pagePath || window.location.pathname,
    sessionId: state.sessionId
  };
  ['productId', 'category', 'action'].forEach((key) => {
    if (typeof payload[key] === 'string' && payload[key]) {
      event[key] = payload[key];
    }
  });

  try {
    const response = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(event)
    });
    if (!response.ok) throw new Error(`Event service returned ${response.status}`);
  } catch (error) {
    console.warn('Event tracking failed:', error);
  }
  trackMatomoEvent(type, payload);
}

async function getSiteConfig() {
  try {
    return await fetchJson('/api/config');
  } catch (error) {
    return null;
  }
}

async function setupMatomo() {
  if (state.matomoEnabled || localStorage.getItem('shopsphere-analytics-consent') !== 'accepted') return;
  const config = await getSiteConfig();
  if (!config || !config.matomoUrl || !config.matomoSiteId) {
    return;
  }

  window._paq = window._paq || [];
  const baseUrl = config.matomoUrl.replace(/\/$/, '') + '/';
  window._paq.push(['requireConsent']);
  window._paq.push(['setSiteId', config.matomoSiteId]);
  window._paq.push(['setTrackerUrl', `${baseUrl}matomo.php`]);
  window._paq.push(['enableLinkTracking']);
  window._paq.push(['rememberConsentGiven']);
  state.matomoEnabled = true;

  if (!document.querySelector('script[data-matomo]')) {
    const script = document.createElement('script');
    script.setAttribute('data-matomo', 'true');
    script.async = true;
    script.src = `${baseUrl}matomo.js`;
    document.head.appendChild(script);
  }
  if (state.lastTrackedPath) trackMatomoPage(state.lastTrackedPath);
}

function trackMatomoEvent(type, payload = {}) {
  if (!state.matomoEnabled || !window._paq) return;
  const category = payload.category || payload.productId || 'store';
  const action = payload.action || type;
  window._paq.push(['trackEvent', 'ShopSphere', type, `${category}:${action}`]);
}

function trackMatomoPage(path) {
  if (!state.matomoEnabled || !window._paq) return;
  if (state.lastTrackedPath === path) return;
  state.lastTrackedPath = path;
  window._paq.push(['setCustomUrl', path]);
  window._paq.push(['trackPageView']);
}

function trackPageView(path) {
  if (state.lastMongoPage !== path) {
    state.lastMongoPage = path;
    trackEvent('page_view', { pagePath: path });
  }
  trackMatomoPage(path);
}

function showConsentBanner() {
  let banner = document.getElementById('analytics-consent');
  let settingsButton = document.getElementById('consent-settings');
  const choice = localStorage.getItem('shopsphere-analytics-consent');
  if (choice === 'accepted' || choice === 'declined') {
    banner?.remove();
    if (!settingsButton) {
      settingsButton = document.createElement('button');
      settingsButton.id = 'consent-settings';
      settingsButton.className = 'consent-settings';
      settingsButton.type = 'button';
      settingsButton.textContent = 'Privacy settings';
      settingsButton.setAttribute('aria-label', 'Change analytics consent');
      settingsButton.addEventListener('click', () => {
        if (window._paq) window._paq.push(['forgetConsentGiven']);
        state.matomoEnabled = false;
        state.lastTrackedPath = '';
        state.sessionId = '';
        sessionStorage.removeItem('shopsphere-session');
        localStorage.removeItem('shopsphere-analytics-consent');
        settingsButton.remove();
        showConsentBanner();
      });
      document.body.appendChild(settingsButton);
    }
    return;
  }
  settingsButton?.remove();
  if (banner) return;
  banner = document.createElement('aside');
  banner.id = 'analytics-consent';
  banner.className = 'consent-banner';
  banner.setAttribute('aria-label', 'Analytics preferences');
  banner.innerHTML = `
    <div>
      <strong>Help improve ShopSphere?</strong>
      <p>With your permission, we collect anonymous page and shopping interaction events. We do not collect form contents or search terms.</p>
    </div>
    <div class="consent-actions">
      <button type="button" class="consent-decline">Decline</button>
      <button type="button" class="consent-accept">Allow analytics</button>
    </div>`;
  document.body.appendChild(banner);
  banner.querySelector('.consent-accept').addEventListener('click', async () => {
    localStorage.setItem('shopsphere-analytics-consent', 'accepted');
    banner.remove();
    state.sessionId = sessionStorage.getItem('shopsphere-session') || crypto.randomUUID();
    sessionStorage.setItem('shopsphere-session', state.sessionId);
    await setupMatomo();
    state.lastMongoPage = '';
    const pathMap = { home: '/home', catalog: '/catalog', auth: '/auth', wishlist: '/wishlist', product: state.currentProduct ? `/products/${state.currentProduct.slug}` : '/product', checkout: '/checkout' };
    trackPageView(pathMap[state.activePage] || '/home');
    showConsentBanner();
  });
  banner.querySelector('.consent-decline').addEventListener('click', () => {
    if (window._paq) window._paq.push(['forgetConsentGiven']);
    state.matomoEnabled = false;
    state.lastTrackedPath = '';
    state.sessionId = '';
    sessionStorage.removeItem('shopsphere-session');
    localStorage.setItem('shopsphere-analytics-consent', 'declined');
    banner.remove();
    showConsentBanner();
  });
}

function saveCart() {
  localStorage.setItem('shopsphere-cart', JSON.stringify(state.cart));
  if (state.user) {
    fetchJson('/api/cart', {
      method: 'PUT',
      body: JSON.stringify({ items: state.cart.map(({ productId, quantity }) => ({ productId, quantity })) })
    }).catch((error) => showToast(error.message));
  }
}

function saveWishlist() {
  localStorage.setItem('shopsphere-wishlist', JSON.stringify(state.wishlist));
  if (state.user) {
    fetchJson('/api/wishlist', {
      method: 'PUT',
      body: JSON.stringify({ productIds: state.wishlist })
    }).catch((error) => showToast(error.message));
  }
}

function getCartCount() {
  return state.cart.reduce((sum, item) => sum + item.quantity, 0);
}

function getCartSubtotal() {
  return state.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

function getCartListSubtotal() {
  return state.cart.reduce((sum, item) => sum + ((item.originalPrice || item.price) * item.quantity), 0);
}

function getCartDiscount() {
  return Math.max(0, getCartListSubtotal() - getCartSubtotal());
}

function addToCart(product, quantity = 1) {
  if (!product || product.stock < 1 || quantity > product.stock) {
    showToast('This product is currently unavailable in that quantity.');
    return;
  }
  const existing = state.cart.find(item => item.productId === product.productId);
  if (existing) {
    const nextQty = existing.quantity + quantity;
    if (nextQty > product.stock) {
      showToast(`Only ${product.stock} left in stock.`);
      return;
    }
    existing.quantity = nextQty;
  } else {
    state.cart.push({ ...product, quantity });
  }
  saveCart();
  render();
  showToast(`${product.name} added to cart.`);
  trackEvent('add_to_cart', { productId: product.productId, category: product.category });
}

function removeFromCart(productId) {
  state.cart = state.cart.filter(item => item.productId !== productId);
  saveCart();
  render();
  trackEvent('remove_from_cart', { productId });
}

function updateCartQty(productId, delta) {
  const item = state.cart.find(entry => entry.productId === productId);
  if (!item) return;
  const nextQty = item.quantity + delta;
  if (nextQty <= 0) return removeFromCart(productId);
  if (nextQty > item.stock) {
    showToast(`Only ${item.stock} left in stock.`);
    return;
  }
  item.quantity = nextQty;
  saveCart();
  render();
}

function toggleWishlist(productId) {
  if (state.wishlist.includes(productId)) {
    state.wishlist = state.wishlist.filter(id => id !== productId);
    trackEvent('wishlist_remove', { productId });
  } else {
    state.wishlist = [...state.wishlist, productId];
    trackEvent('wishlist_add', { productId });
  }
  saveWishlist();
  render();
}

async function loadHomePage() {
  const data = await fetchJson('/api/products?sort=popular&limit=8');
  state.products = data.items;
  render();
}

async function loadProduct(slug) {
  const { product, related } = await fetchJson(`/api/products/${slug}`);
  state.currentProduct = product;
  state.detailQuantity = 1;
  state.recentlyViewed = [product.productId, ...state.recentlyViewed.filter((id) => id !== product.productId)].slice(0, 8);
  localStorage.setItem('shopsphere-recent-products', JSON.stringify(state.recentlyViewed));
  state.relatedProducts = related;
  render();
  trackEvent('product_view', { productId: product.productId, category: product.category });
}

async function loadCatalog() {
  const params = new URLSearchParams({
    category: state.selectedCategory,
    q: state.searchQuery,
    minPrice: state.minPrice,
    maxPrice: state.maxPrice,
    inStock: state.inStockOnly,
    sort: state.sort,
    page: state.page,
    limit: 12
  });

  const data = await fetchJson(`/api/products?${params.toString()}`);
  state.products = data.items;
  state.page = data.page;
  state.totalPages = data.totalPages;
  render();
}

function renderProductCard(product) {
  const inWishlist = state.wishlist.includes(product.productId);
  return `
    <article class="product-card">
      <div class="product-media">
        <img src="${product.image}" alt="${product.name}" />
        <button class="icon-button product-wishlist" data-action="toggle-wishlist" data-product-id="${product.productId}" aria-label="Add to wishlist">
          ${inWishlist ? '♥' : '♡'}
        </button>
      </div>
      <div class="product-body">
        <div class="product-category">${product.category}</div>
        <h3 class="product-name">${product.name}</h3>
        <div class="product-meta">
          <span class="rating">★ ${product.rating}</span>
          <span class="price">${currency.format(product.price)}</span>
        </div>
        <div class="product-meta" style="margin-top: 6px;">
          <span class="review-count">${product.reviewCount} demo reviews</span>
          <span class="old-price">${product.originalPrice ? currency.format(product.originalPrice) : ''}</span>
        </div>
        <div class="product-actions">
          <button class="primary-btn small-btn" data-action="view-product" data-slug="${product.slug}">View</button>
          <button class="secondary-btn small-btn" data-action="add-cart" data-product-id="${product.productId}" ${product.stock < 1 ? 'disabled' : ''}>${product.stock > 0 ? 'Add' : 'Sold out'}</button>
        </div>
      </div>
    </article>
  `;
}

function renderHome() {
  const featured = state.products.filter(item => item.featured || item.bestseller).slice(0, 4);
  const newArrivals = state.products.filter(item => item.newArrival).slice(0, 4);
  const bestsellers = state.products.filter(item => item.bestseller).slice(0, 4);

  appEl.innerHTML = `
    <div class="announcement-bar">
      <div class="container topbar-inner">
        <span>Free shipping over $150 • New season arrivals</span>
        <span>Limited time members offer</span>
      </div>
    </div>
    <header class="navbar">
      <div class="container nav-inner">
        <a href="#" class="logo">Shop<span>Sphere</span></a>
        <button class="mobile-menu-button" data-action="toggle-menu" aria-label="Open navigation" aria-expanded="false">☰</button>
        <nav class="nav-links" aria-label="Main navigation">
          <a href="#" data-page="home">Home</a>
          <a href="#" data-page="catalog">New In</a>
          <a href="#" data-page="catalog">Women</a>
          <a href="#" data-page="catalog">Men</a>
          <a href="#" data-page="catalog">Accessories</a>
          <a href="#" data-page="catalog">Sale</a>
        </nav>
        <div class="nav-actions">
          <div class="search-box">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 4a7 7 0 015.56 11.94l3.79 3.8 1.42-1.41-3.8-3.79A7 7 0 0111 4zm0 2a5 5 0 100 10 5 5 0 000-10z" fill="currentColor"/></svg>
            <input id="global-search" type="search" placeholder="Search" value="${state.searchQuery}" aria-label="Search products" />
          </div>
          ${renderAccountMenu()}
          <button class="icon-button" data-page="wishlist" aria-label="Wishlist"><span>♡</span>${state.wishlist.length ? `<span class="count-badge">${state.wishlist.length}</span>` : ''}</button>
          <button class="icon-button" data-action="toggle-cart" aria-label="Shopping cart"><span>🛒</span>${getCartCount() ? `<span class="count-badge">${getCartCount()}</span>` : ''}</button>
        </div>
      </div>
    </header>
    <main>
      <section class="hero">
        <div class="container hero-card">
          <div class="hero-grid">
            <div class="hero-copy">
              <div class="eyebrow">Curated essentials</div>
              <h1>Elevate your everyday look.</h1>
              <p class="lead">Shop elevated essentials for work, weekends, and everything in between. Thoughtful pieces that feel as premium as they look.</p>
              <div class="hero-actions">
                <button class="primary-btn" data-page="catalog">Shop now</button>
                <button class="secondary-btn" data-page="catalog">Explore new arrivals</button>
              </div>
            </div>
            <div class="hero-media">
              <img src="https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1200&q=80" alt="Editorial shopping campaign" />
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-header">
            <h2>Shop by category</h2>
          </div>
          <div class="category-grid">
            ${['Clothing','Footwear','Accessories','Electronics','Home & Living','Beauty'].map(category => `
              <button class="category-card" data-category="${category}" data-page="catalog" style="text-align:left; border:none; width:100%;">
                <img src="${state.products.find(p => p.category === category)?.image || 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=80'}" alt="${category}" />
                <h3>${category}</h3>
              </button>
            `).join('')}
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-header">
            <h2>Trending products</h2>
            <a href="#" data-page="catalog">View all</a>
          </div>
          <div class="product-grid">${featured.map(renderProductCard).join('')}</div>
        </div>
      </section>

      <section class="section">
        <div class="container banner">
          <div class="banner-copy">
            <div class="eyebrow" style="color: #dcbc9b;">Members-only offer</div>
            <h3>Save up to 40% on winter layers.</h3>
            <p>Refresh your wardrobe with premium textures, elevated essentials, and standout accessories.</p>
            <button class="primary-btn" data-page="catalog">Shop sale</button>
          </div>
          <div class="banner-art"></div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-header">
            <h2>New arrivals</h2>
            <a href="#" data-page="catalog">View all</a>
          </div>
          <div class="product-grid">${newArrivals.map(renderProductCard).join('')}</div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-header">
            <h2>Bestsellers</h2>
            <a href="#" data-page="catalog">View all</a>
          </div>
          <div class="product-grid">${bestsellers.map(renderProductCard).join('')}</div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-number">48K+</div><div>Happy shoppers</div></div>
            <div class="stat-card"><div class="stat-number">4.9/5</div><div>Average rating</div></div>
            <div class="stat-card"><div class="stat-number">2-day</div><div>Dispatch time</div></div>
            <div class="stat-card"><div class="stat-number">24/7</div><div>Customer care</div></div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section-header">
            <h2>Customer testimonials</h2>
          </div>
          <div class="testimonial-grid">
            ${[
              { name: 'Ava M.', quote: 'The fit and finish feel luxury-level. I look forward to every new drop.', rating: '★★★★★' },
              { name: 'Daniel K.', quote: 'ShopSphere has the perfect balance of premium design and practical shopping.', rating: '★★★★★' },
              { name: 'Rae T.', quote: 'Shipping was fast, packaging felt thoughtful, and the quality exceeded my expectations.', rating: '★★★★★' }
            ].map(item => `
              <article class="testimonial-card">
                <div>${item.rating}</div>
                <p>“${item.quote}”</p>
                <strong>${item.name}</strong>
              </article>
            `).join('')}
          </div>
        </div>
      </section>

      <section class="newsletter">
        <div class="container newsletter-box">
          <div class="newsletter-row">
            <div>
              <div class="eyebrow">Stay in the loop</div>
              <h3>Get style updates and early access offers.</h3>
            </div>
            <form id="newsletter-form" class="newsletter-form">
              <input id="newsletter-email" type="email" placeholder="Your email address" required />
              <button class="primary-btn" type="submit">Join now</button>
            </form>
          </div>
        </div>
      </section>
    </main>
    <footer class="footer">
      <div class="container footer-grid">
        <div class="footer-col">
          <div class="logo">Shop<span>Sphere</span></div>
          <p>Premium essentials for a considered lifestyle.</p>
        </div>
        <div class="footer-col"><h4>Customer service</h4><div class="footer-links"><a href="#">Shipping</a><a href="#">Returns</a><a href="#">Contact</a></div></div>
        <div class="footer-col"><h4>Policies</h4><div class="footer-links"><a href="#">Privacy</a><a href="#">Terms</a><a href="#">Cookies</a></div></div>
        <div class="footer-col"><h4>Follow us</h4><div class="footer-links"><a href="#">Instagram</a><a href="#">Pinterest</a><a href="#">Newsletter</a></div></div>
      </div>
    </footer>
    ${renderCartDrawer()}
  `;

  const newsletterForm = document.getElementById('newsletter-form');
  newsletterForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const emailInput = document.getElementById('newsletter-email');
    try {
      const result = await fetchJson('/api/newsletter', {
        method: 'POST',
        body: JSON.stringify({ email: emailInput.value })
      });
      showToast(result.alreadySubscribed ? 'This email is already subscribed.' : 'Your newsletter subscription was saved.');
      if (!result.alreadySubscribed) trackEvent('newsletter_signup', { action: 'subscribe' });
      emailInput.value = '';
    } catch (error) {
      showToast(error.message);
    }
  });

  bindGlobalActions();
}

function renderCatalog() {
  appEl.innerHTML = `
    <header class="navbar">
      <div class="container nav-inner">
        <a href="#" class="logo">Shop<span>Sphere</span></a>
        <button class="mobile-menu-button" data-action="toggle-menu" aria-label="Open navigation" aria-expanded="false">☰</button>
        <nav class="nav-links"><a href="#" data-page="home">Home</a><a href="#" data-page="catalog">Shop</a><a href="#">New In</a><a href="#">Best Sellers</a></nav>
        <div class="nav-actions">
          <button class="icon-button" data-page="wishlist">♡</button>${renderAccountMenu()}
          <button class="icon-button" data-action="toggle-cart">🛒${getCartCount() ? `<span class="count-badge">${getCartCount()}</span>` : ''}</button>
        </div>
      </div>
    </header>
    <main class="page-shell">
      <div class="container">
        <div class="section-header">
          <h2>Shop the collection</h2>
        </div>
        <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center; margin-bottom:20px;">
          <div class="search-box"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M11 4a7 7 0 015.56 11.94l3.79 3.8 1.42-1.41-3.8-3.79A7 7 0 0111 4zm0 2a5 5 0 100 10 5 5 0 000-10z" fill="currentColor"/></svg><input id="catalog-search" type="search" value="${state.searchQuery}" placeholder="Search products" /></div>
          <select id="category-filter">
            <option value="all">All categories</option>
            ${state.categories.map(c => `<option value="${c}" ${state.selectedCategory === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <input id="min-price" type="number" placeholder="Min" value="${state.minPrice}" style="width:100px;" />
          <input id="max-price" type="number" placeholder="Max" value="${state.maxPrice}" style="width:100px;" />
          <label class="stock-filter"><input id="stock-filter" type="checkbox" ${state.inStockOnly ? 'checked' : ''}/> In stock</label>
          <select id="sort-filter">
            <option value="popular" ${state.sort === 'popular' ? 'selected' : ''}>Popularity</option>
            <option value="rating" ${state.sort === 'rating' ? 'selected' : ''}>Rating</option>
            <option value="newest" ${state.sort === 'newest' ? 'selected' : ''}>Newest</option>
            <option value="price-low-high" ${state.sort === 'price-low-high' ? 'selected' : ''}>Price: Low to High</option>
            <option value="price-high-low" ${state.sort === 'price-high-low' ? 'selected' : ''}>Price: High to Low</option>
          </select>
          <button class="ghost-btn" id="clear-filters">Clear filters</button>
        </div>
        ${state.products.length ? `<div class="product-grid">${state.products.map(renderProductCard).join('')}</div>` : `<div class="empty-state"><h3>No matching products</h3><p>Try a different search or clear your filters.</p></div>`}
        ${state.totalPages > 1 ? `<div style="text-align:center; margin-top:20px;"><button class="primary-btn" id="load-more">Load more</button></div>` : ''}
      </div>
    </main>
    ${renderCartDrawer()}
  `;

  const searchInput = document.getElementById('catalog-search');
  searchInput?.addEventListener('input', (event) => {
    state.searchQuery = event.target.value.trim();
    state.page = 1;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      loadCatalog();
      trackEvent('search', { action: 'submitted', category: state.selectedCategory });
    }, 400);
  });

  document.getElementById('category-filter')?.addEventListener('change', (event) => {
    state.selectedCategory = event.target.value;
    state.page = 1;
    loadCatalog();
    trackEvent('filter_applied', { category: state.selectedCategory });
  });

  document.getElementById('sort-filter')?.addEventListener('change', (event) => {
    state.sort = event.target.value;
    state.page = 1;
    loadCatalog();
    trackEvent('sort_applied', { action: state.sort });
  });

  document.getElementById('min-price')?.addEventListener('input', (event) => {
    state.minPrice = event.target.value;
  });

  document.getElementById('max-price')?.addEventListener('input', (event) => {
    state.maxPrice = event.target.value;
  });
  ['min-price', 'max-price'].forEach((id) => document.getElementById(id)?.addEventListener('change', () => {
    state.page = 1;
    loadCatalog().catch((error) => showToast(error.message));
  }));
  document.getElementById('stock-filter')?.addEventListener('change', (event) => {
    state.inStockOnly = event.target.checked;
    state.page = 1;
    loadCatalog().catch((error) => showToast(error.message));
    trackEvent('filter_applied', { category: state.selectedCategory });
  });

  document.getElementById('clear-filters')?.addEventListener('click', () => {
    state.selectedCategory = 'all';
    state.searchQuery = '';
    state.minPrice = '';
    state.maxPrice = '';
    state.inStockOnly = false;
    state.sort = 'popular';
    state.page = 1;
    loadCatalog();
  });

  document.getElementById('load-more')?.addEventListener('click', () => {
    state.page += 1;
    const params = new URLSearchParams({ category: state.selectedCategory, q: state.searchQuery, minPrice: state.minPrice, maxPrice: state.maxPrice, inStock: state.inStockOnly, sort: state.sort, page: state.page, limit: 12 });
    fetchJson(`/api/products?${params.toString()}`).then((data) => {
      state.products = [...state.products, ...data.items];
      renderCatalog();
    });
  });

  bindGlobalActions();
}

function renderAuth() {
  appEl.innerHTML = `
    <header class="navbar"><div class="container nav-inner"><a href="/" class="logo" data-route="/">Shop<span>Sphere</span></a><div class="nav-actions"><button class="icon-button" data-page="home">⌂</button>${renderAccountMenu()}</div></div></header>
    <main class="page-shell">
      <div class="container auth-grid">
        <section class="auth-card">
          <h2>Welcome back</h2>
          <form id="login-form" class="field">
            <div class="field"><input type="email" id="login-email" placeholder="Email address" required /></div>
            <div class="field"><input type="password" id="login-password" placeholder="Password" required /></div>
            <button class="primary-btn" style="width:100%;" type="submit">Log in</button>
          </form>
        </section>
        <section class="auth-card">
          <h2>Create account</h2>
          <form id="register-form" class="field">
            <div class="form-grid">
              <div class="field"><input type="text" id="register-firstname" placeholder="First name" required /></div>
              <div class="field"><input type="text" id="register-lastname" placeholder="Last name" required /></div>
            </div>
            <div class="field"><input type="email" id="register-email" placeholder="Email address" required /></div>
            <div class="field"><input type="password" id="register-password" placeholder="Password" required /></div>
            <button class="secondary-btn" style="width:100%;" type="submit">Register</button>
          </form>
        </section>
      </div>
    </main>
  `;

  document.getElementById('login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
      };
      const response = await fetchJson('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
      state.user = response.user;
      await syncCustomerData(true);
      showToast('Welcome back!');
      const requestedPath = new URLSearchParams(window.location.search).get('returnTo');
      const returnTo = requestedPath && requestedPath.startsWith('/') && !requestedPath.startsWith('//')
        ? requestedPath
        : '/';
      navigate(returnTo, true);
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('register-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = {
        firstName: document.getElementById('register-firstname').value,
        lastName: document.getElementById('register-lastname').value,
        email: document.getElementById('register-email').value,
        password: document.getElementById('register-password').value
      };
      const response = await fetchJson('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
      state.user = response.user;
      await syncCustomerData(true);
      showToast('Account created successfully.');
      navigate('/', true);
    } catch (error) {
      showToast(error.message);
    }
  });

  bindGlobalActions();
}

async function renderAccount() {
  const section = state.accountSection;
  appEl.innerHTML = `<main class="page-shell"><div class="container"><p>Loading your account…</p></div></main>`;
  let data = {};
  try {
    if (section === 'orders') data = await fetchJson('/api/orders');
    else if (section === 'addresses') data = await fetchJson('/api/account/addresses');
    else data = await fetchJson('/api/account/profile');
  } catch (error) {
    showToast(error.message);
    if (error.message.toLowerCase().includes('unauthorized')) navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname)}`, true);
    return;
  }
  const profile = data.profile || state.user;
  const sectionNames = {
    profile: 'My Profile',
    edit: 'Edit account details',
    orders: 'My Orders',
    addresses: 'My Addresses',
    password: 'Change Password'
  };
  const content = section === 'orders'
    ? (data.orders.length ? data.orders.map((order) => `
      <article class="account-order">
        <div class="summary-row">        <strong>${escapeHtml(order.orderReference)}</strong><span>${new Date(order.createdAt).toLocaleDateString()}</span></div>
        <p>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(', ')}</p>
        <div class="summary-row"><span>${escapeHtml(order.status)} · ${escapeHtml(order.shippingMethod || 'standard')} delivery · ${order.paymentMethod === 'demo_card' ? 'Demo payment (simulated)' : 'Cash on delivery'}</span><strong>${currency.format(order.total)}</strong></div>
      </article>`).join('') : '<div class="empty-state"><h3>No orders yet</h3><p>Your completed orders will appear here.</p><a class="primary-btn" href="/shop" data-route="/shop">Start shopping</a></div>')
    : section === 'addresses'
      ? `<div class="account-addresses">${data.addresses.map((address) => `<article class="account-order"><strong>${escapeHtml(address.label)}</strong><p>${escapeHtml(address.fullName)}<br>${escapeHtml(address.address)}, ${escapeHtml(address.city)}, ${escapeHtml(address.state)} ${escapeHtml(address.zip)}<br>${escapeHtml(address.country)}<br>${escapeHtml(address.phone)}</p>${address.isDefault ? '<span>Default address</span>' : ''}</article>`).join('') || '<p>No saved addresses yet.</p>'}</div>
        <h3>Add an address</h3><form id="address-form" class="account-form">
          <input name="label" placeholder="Label (Home, Work)" value="Home" />
          <input name="fullName" placeholder="Full name" required />
          <input name="phone" placeholder="Phone" required />
          <input name="address" placeholder="Street address" required />
          <input name="city" placeholder="City" required /><input name="state" placeholder="State" required />
          <input name="zip" placeholder="ZIP / postal code" required /><input name="country" placeholder="Country" required />
          <button class="primary-btn" type="submit">Save address</button>
        </form>`
      : section === 'edit'
        ? `<form id="profile-form" class="account-form">
            <label>First name<input name="firstName" value="${escapeHtml(profile.firstName)}" required minlength="2" maxlength="60" /></label>
            <label>Last name<input name="lastName" value="${escapeHtml(profile.lastName)}" required minlength="2" maxlength="60" /></label>
            <label>Phone (optional)<input name="phone" value="${escapeHtml(profile.phone)}" maxlength="30" /></label>
            <p>Email: ${escapeHtml(profile.email)}</p><button class="primary-btn" type="submit">Save changes</button>
          </form>`
        : section === 'password'
          ? `<form id="password-form" class="account-form">
              <label>Current password<input name="currentPassword" type="password" required autocomplete="current-password" /></label>
              <label>New password (at least 8 characters)<input name="newPassword" type="password" required minlength="8" autocomplete="new-password" /></label>
              <button class="primary-btn" type="submit">Change password</button>
            </form>`
          : `<div class="profile-card"><p><strong>Name:</strong> ${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</p><p><strong>Email:</strong> ${escapeHtml(profile.email)}</p><p><strong>Phone:</strong> ${escapeHtml(profile.phone || 'Not added')}</p><a class="secondary-btn" href="/account/edit" data-route="/account/edit">Edit details</a></div>`;

  appEl.innerHTML = `
    <header class="navbar"><div class="container nav-inner"><a href="/" class="logo" data-route="/">Shop<span>Sphere</span></a><div class="nav-actions"><a href="/shop" data-route="/shop">Continue shopping</a>${renderAccountMenu()}<button class="icon-button" data-action="toggle-cart" aria-label="Shopping cart">🛒${getCartCount() ? `<span class="count-badge">${getCartCount()}</span>` : ''}</button></div></div></header>
    <main class="page-shell"><div class="container account-layout">
      <aside class="account-sidebar"><h2>Hello, ${escapeHtml(profile.firstName || 'Shopper')}</h2>
        ${[['profile','My Profile'],['edit','Edit Account Details'],['orders','My Orders'],['addresses','My Addresses'],['password','Change Password']].map(([key,label]) => `<a href="/account/${key === 'profile' ? 'profile' : key}" data-route="/account/${key === 'profile' ? 'profile' : key}" class="${section === key ? 'active' : ''}">${label}</a>`).join('')}
        <button class="ghost-btn" id="customer-logout">Logout</button>
      </aside>
      <section class="account-content"><h1>${sectionNames[section] || 'My Profile'}</h1>${content}</section>
    </div></main>`;

  document.querySelectorAll('[data-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.route);
  }));
  document.getElementById('customer-logout')?.addEventListener('click', async () => {
    logoutCustomer();
  });
  document.getElementById('profile-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const result = await fetchJson('/api/account/profile', { method: 'PATCH', body: JSON.stringify(payload) });
      state.user = { ...state.user, ...result.profile };
      showToast('Your details were saved.');
      navigate('/account/profile', true);
    } catch (error) {
      showToast(error.message);
    }
  });
  document.getElementById('address-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await fetchJson('/api/account/addresses', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries()))
      });
      showToast('Address saved.');
      renderAccount();
    } catch (error) {
      showToast(error.message);
    }
  });
  document.getElementById('password-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await fetchJson('/api/account/password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries()))
      });
      event.currentTarget.reset();
      showToast('Password changed.');
    } catch (error) {
      showToast(error.message);
    }
  });
  bindGlobalActions();
}

function renderCartPage() {
  const subtotal = getCartSubtotal();
  const discount = getCartDiscount();
  const listSubtotal = getCartListSubtotal();
  const shipping = subtotal > 150 ? 0 : state.cart.length ? 15 : 0;
  appEl.innerHTML = `
    <header class="navbar"><div class="container nav-inner"><a href="/" class="logo" data-route="/">Shop<span>Sphere</span></a><div class="nav-actions">${renderAccountMenu()}<a href="/shop" data-route="/shop">Continue shopping</a></div></div></header>
    <main class="page-shell"><div class="container">
      <p class="breadcrumbs"><a href="/" data-route="/">Home</a> / Cart</p><h1>Your shopping cart</h1>
      ${state.cart.length ? `<div class="cart-layout"><section>${state.cart.map((item) => `<article class="cart-item"><img src="${item.image}" alt="${item.name}"><div class="cart-item-info"><strong>${item.name}</strong><p>${currency.format(item.price)} each</p><div class="qty-control"><button data-action="decrease-qty" data-product-id="${item.productId}">−</button><span class="qty-value">${item.quantity}</span><button data-action="increase-qty" data-product-id="${item.productId}">+</button></div></div><button class="ghost-btn small-btn" data-action="remove-cart" data-product-id="${item.productId}">Remove</button></article>`).join('')}</section>
      <aside class="summary-box"><h2>Order summary</h2><div class="summary-row"><span>Subtotal</span><strong>${currency.format(listSubtotal)}</strong></div>${discount ? `<div class="summary-row"><span>Discount</span><strong>−${currency.format(discount)}</strong></div>` : ''}<div class="summary-row"><span>Shipping</span><strong>${currency.format(shipping)}</strong></div><div class="summary-row"><span>Total</span><strong>${currency.format(subtotal + shipping)}</strong></div><button class="primary-btn checkout-cta" data-page="checkout">Continue to checkout</button><a class="continue-shopping" href="/shop" data-route="/shop">Continue shopping</a></aside></div>` : `<div class="empty-state"><h2>Your cart is empty</h2><p>Find something you love and add it here.</p><a class="primary-btn" href="/shop" data-route="/shop">Continue shopping</a></div>`}
    </div></main>`;
  document.querySelectorAll('[data-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.route);
  }));
  bindGlobalActions();
}

function renderOrderConfirmation() {
  if (!state.order) {
    appEl.innerHTML = `<main class="page-shell"><div class="container empty-state"><h1>Order details unavailable</h1><p>Sign in and open My Orders to view your saved order.</p><a href="/account/orders" data-route="/account/orders">My Orders</a></div></main>`;
    document.querySelector('[data-route]')?.addEventListener('click', (event) => { event.preventDefault(); navigate('/account/orders'); });
    return;
  }
  appEl.innerHTML = `<main class="page-shell"><div class="container empty-state order-confirmation"><div class="eyebrow">Order confirmed</div><h1>Thank you for your order!</h1><p>Your order reference is <strong>${state.order.orderReference}</strong>.</p><p>Payment: ${state.order.paymentMethod === 'demo_card' ? 'Demo payment simulated (no charge made)' : 'Cash on delivery'}</p><p>Total: <strong>${currency.format(state.order.total)}</strong></p><a class="primary-btn" href="/shop" data-route="/shop">Back to shopping</a></div></main>`;
  document.querySelector('[data-route]')?.addEventListener('click', (event) => { event.preventDefault(); navigate('/shop'); });
}

function renderWishlist() {
  const items = state.products.filter(product => state.wishlist.includes(product.productId));
  appEl.innerHTML = `
    <header class="navbar"><div class="container nav-inner"><a href="/" class="logo" data-route="/">Shop<span>Sphere</span></a><div class="nav-actions"><button class="icon-button" data-page="home">⌂</button>${renderAccountMenu()}<button class="icon-button" data-action="toggle-cart">🛒${getCartCount() ? `<span class="count-badge">${getCartCount()}</span>` : ''}</button></div></div></header>
    <main class="page-shell">
      <div class="container">
        <div class="section-header"><h2>Wishlist</h2></div>
        ${items.length ? `<div class="wishlist-grid product-grid">${items.map(renderProductCard).join('')}</div>` : `<div class="empty-state"><h3>Your wishlist is empty</h3><p>Save pieces you love for later.</p><button class="primary-btn" data-page="catalog">Browse products</button></div>`}
      </div>
    </main>
    ${renderCartDrawer()}
  `;
  bindGlobalActions();
  document.querySelectorAll('[data-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.route);
  }));
}

function renderProductDetail() {
  if (!state.currentProduct) return;
  const product = state.currentProduct;
  appEl.innerHTML = `
    <header class="navbar"><div class="container nav-inner"><a href="/" class="logo" data-route="/">Shop<span>Sphere</span></a><div class="nav-actions"><button class="icon-button" data-page="catalog">⌂</button>${renderAccountMenu()}<button class="icon-button" data-action="toggle-cart">🛒${getCartCount() ? `<span class="count-badge">${getCartCount()}</span>` : ''}</button></div></div></header>
    <main class="page-shell">
      <div class="container product-detail">
        <p class="breadcrumbs"><a href="/" data-route="/">Home</a> / <a href="/shop" data-route="/shop">${product.category}</a> / ${product.name}</p>
        <div class="gallery">
          ${(product.gallery && product.gallery.length ? product.gallery : [product.image]).map(src => `<img src="${src}" alt="${product.name}" />`).join('')}
        </div>
        <div class="detail-card">
          <div class="product-category">${product.category}</div>
          <h2 style="margin:10px 0; font-size:2rem;">${product.name}</h2>
          <div class="rating">★ ${product.rating} (${product.reviewCount} demo reviews)</div>
          <div style="margin:18px 0; font-size:1.8rem; font-weight:800;">${currency.format(product.price)} <span class="old-price">${product.originalPrice ? currency.format(product.originalPrice) : ''}</span></div>
          <p>${product.description}</p>
          <p><strong>SKU:</strong> ${product.sku || product.productId}</p>
          ${product.specifications?.length ? `<ul class="product-specifications">${product.specifications.map((spec) => `<li>${spec}</li>`).join('')}</ul>` : ''}
          <div class="variant-options">
            <button>XS</button><button>S</button><button selected style="background:var(--text);color:#fff;">M</button><button>L</button><button>XL</button>
          </div>
          <div class="qty-control" style="margin-bottom:18px;">
            <button data-action="decrease-qty" data-product-id="${product.productId}">−</button>
            <span class="qty-value">${state.detailQuantity}</span>
            <button data-action="increase-qty" data-product-id="${product.productId}">+</button>
          </div>
          <div class="product-actions" style="margin-top:0;">
            <button class="primary-btn" data-action="add-cart" data-product-id="${product.productId}">Add to cart</button>
            <button class="secondary-btn" data-action="toggle-wishlist" data-product-id="${product.productId}">${state.wishlist.includes(product.productId) ? 'Saved' : 'Wishlist'}</button>
          </div>
          <div class="summary-box"><div class="summary-row"><span>Availability</span><strong>${product.stock > 0 ? 'In stock' : 'Sold out'}</strong></div><div class="summary-row"><span>Delivery</span><strong>Free over $150</strong></div></div>
        </div>
      </div>
      <div class="container" style="margin-top:32px;">
        <div class="section-header"><h2>Related products</h2></div>
        <div class="product-grid">${(state.relatedProducts || []).map(renderProductCard).join('')}</div>
      </div>
      <div class="container" style="margin-top:32px;">
        <div class="section-header"><h2>Recently viewed</h2></div>
        <div class="product-grid">${state.recentlyViewed.filter((id) => id !== product.productId).map((id) => state.products.find((item) => item.productId === id)).filter(Boolean).slice(0, 4).map(renderProductCard).join('')}</div>
      </div>
    </main>
    ${renderCartDrawer()}
  `;
  bindGlobalActions();
  document.querySelectorAll('[data-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.route);
  }));
}

function renderCartDrawer() {
  const subtotal = getCartSubtotal();
  const discount = getCartDiscount();
  const listSubtotal = getCartListSubtotal();
  const shipping = subtotal > 150 ? 0 : state.cart.length ? 15 : 0;
  const total = subtotal + shipping;
  return `
    <aside class="drawer ${state.cartOpen ? 'visible' : ''}" aria-label="Shopping cart drawer">
      <div class="drawer-panel">
        <div class="panel-header">
          <h3>Your cart</h3>
          <button class="icon-button" data-action="toggle-cart" aria-label="Close cart">✕</button>
        </div>
        ${state.cart.length ? `
          <div>
            ${state.cart.map(item => `
              <div class="cart-item">
                <img src="${item.image}" alt="${item.name}" />
                <div style="flex:1;">
                  <div style="font-weight:700;">${item.name}</div>
                  <div style="color: var(--muted);">${currency.format(item.price)}</div>
                  <div class="qty-control" style="margin-top:8px;">
                    <button data-action="decrease-qty" data-product-id="${item.productId}">−</button>
                    <span class="qty-value">${item.quantity}</span>
                    <button data-action="increase-qty" data-product-id="${item.productId}">+</button>
                  </div>
                </div>
                <button class="ghost-btn small-btn" data-action="remove-cart" data-product-id="${item.productId}">Remove</button>
              </div>
            `).join('')}
          </div>
          <div class="summary-box">
            <div class="summary-row"><span>Subtotal</span><strong>${currency.format(listSubtotal)}</strong></div>
            ${discount ? `<div class="summary-row"><span>Discount</span><strong>−${currency.format(discount)}</strong></div>` : ''}
            <div class="summary-row"><span>Shipping</span><strong>${currency.format(shipping)}</strong></div>
            <div class="summary-row"><span>Total</span><strong>${currency.format(total)}</strong></div>
            <button class="primary-btn checkout-cta" data-page="checkout">Checkout</button>
          </div>
        ` : `
          <div class="empty-state">
            <h3>Your cart is empty</h3>
            <p>Add some premium essentials to get started.</p>
            <button class="primary-btn" data-page="catalog">Continue shopping</button>
          </div>
        `}
      </div>
    </aside>
  `;
}

function renderCheckout() {
  const shippingFee = state.shippingMethod === 'express' ? 25 : getCartSubtotal() > 150 ? 0 : 15;
  const discount = getCartDiscount();
  const listSubtotal = getCartListSubtotal();
  appEl.innerHTML = `
    <header class="navbar"><div class="container nav-inner"><a href="/" class="logo" data-route="/">Shop<span>Sphere</span></a><div class="nav-actions">${renderAccountMenu()}<a href="/cart" class="secondary-btn" data-route="/cart">← Back to Cart</a></div></div></header>
    <main class="page-shell">
      <div class="container checkout-panel">
        <p class="breadcrumbs"><a href="/" data-route="/">Home</a> / <a href="/cart" data-route="/cart">Cart</a> / Checkout</p>
        <div class="stepper">
          <span class="${state.checkoutStep === 1 ? 'active' : ''}">1. Contact</span>
          <span class="${state.checkoutStep === 2 ? 'active' : ''}">2. Address</span>
          <span class="${state.checkoutStep === 3 ? 'active' : ''}">3. Shipping</span>
          <span class="${state.checkoutStep === 4 ? 'active' : ''}">4. Review</span>
          <span class="${state.checkoutStep === 5 ? 'active' : ''}">5. Payment</span>
        </div>
        <div class="checkout-grid">
          <div style="flex:1;">
            ${state.checkoutStep === 1 ? `
              <form id="checkout-form">
                <div class="form-grid">
                  <div class="field"><input name="firstName" placeholder="First name" value="${state.customer?.firstName || state.user?.firstName || ''}" required /></div>
                  <div class="field"><input name="lastName" placeholder="Last name" value="${state.customer?.lastName || state.user?.lastName || ''}" required /></div>
                </div>
                <div class="field"><input name="email" type="email" placeholder="Email" value="${state.customer?.email || state.user?.email || ''}" required /></div>
                <div class="field"><input name="phone" placeholder="Phone" value="${state.customer?.phone || state.user?.phone || ''}" required /></div>
                <button class="primary-btn" type="submit">Continue</button>
              </form>
            ` : ''}
            ${state.checkoutStep === 2 ? `
              <form id="shipping-form">
                <div class="field"><input name="address" placeholder="Address" value="${state.shipping?.address || ''}" required /></div>
                <div class="form-grid">
                  <div class="field"><input name="city" placeholder="City" value="${state.shipping?.city || ''}" required /></div>
                  <div class="field"><input name="state" placeholder="State" value="${state.shipping?.state || ''}" required /></div>
                </div>
                <div class="form-grid">
                  <div class="field"><input name="zip" placeholder="ZIP" value="${state.shipping?.zip || ''}" required /></div>
                  <div class="field"><input name="country" placeholder="Country" value="${state.shipping?.country || ''}" required /></div>
                </div>
                <button class="primary-btn" type="submit">Continue</button>
              </form>
            ` : ''}
            ${state.checkoutStep === 3 ? `
              <div>
                <h3>Choose a shipping method</h3>
                <label class="shipping-choice"><input type="radio" name="shipping-method" value="standard" ${state.shippingMethod !== 'express' ? 'checked' : ''}/> Standard delivery — ${getCartSubtotal() > 150 ? 'Free' : '$15'}</label>
                <label class="shipping-choice"><input type="radio" name="shipping-method" value="express" ${state.shippingMethod === 'express' ? 'checked' : ''}/> Express delivery — $25</label>
                <button class="primary-btn" id="confirm-shipping">Continue</button>
              </div>
            ` : ''}
            ${state.checkoutStep === 4 ? `
              <div>
                <h3>Order review</h3>
                ${state.cart.map(item => `<div class="summary-row"><span>${item.name} × ${item.quantity}</span><strong>${currency.format(item.price * item.quantity)}</strong></div>`).join('')}
                <div class="summary-row"><span>Subtotal</span><strong>${currency.format(listSubtotal)}</strong></div>
                ${discount ? `<div class="summary-row"><span>Discount</span><strong>−${currency.format(discount)}</strong></div>` : ''}
                <div class="summary-row"><span>Shipping</span><strong>${currency.format(shippingFee)}</strong></div>
                <div class="summary-row"><span>Total</span><strong>${currency.format(getCartSubtotal() + shippingFee)}</strong></div>
                <button class="primary-btn" id="confirm-review">Continue to payment</button>
              </div>
            ` : ''}
            ${state.checkoutStep === 5 ? `
              <div>
                <h3>Payment</h3>
                <div class="field"><select id="payment-method"><option value="cash_on_delivery">Cash on Delivery (demo)</option><option value="demo_card">Demo Card (simulated)</option></select></div>
                <p style="color:var(--muted);">This is a demo storefront. No real card details are collected.</p>
                <button class="primary-btn" id="place-order">Place order</button>
              </div>
            ` : ''}
            ${state.checkoutStep > 1 ? '<button class="ghost-btn checkout-back" id="checkout-previous">← Back to previous step</button>' : ''}
          </div>
          <aside class="summary-box" style="min-width: 300px;">
            <h3>Order summary</h3>
            ${state.cart.map(item => `<div class="summary-row"><span>${item.name}</span><span>${currency.format(item.price * item.quantity)}</span></div>`).join('')}
            <div class="summary-row"><span>Subtotal</span><span>${currency.format(listSubtotal)}</span></div>
            ${discount ? `<div class="summary-row"><span>Discount</span><span>−${currency.format(discount)}</span></div>` : ''}
            <div class="summary-row"><span>Shipping</span><span>${currency.format(shippingFee)}</span></div>
            <div class="summary-row"><span>Total</span><strong>${currency.format(getCartSubtotal() + shippingFee)}</strong></div>
          </aside>
        </div>
      </div>
    </main>
  `;

  document.getElementById('checkout-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    state.customer = Object.fromEntries(formData.entries());
    state.checkoutStep = 2;
    renderCheckout();
    trackEvent('checkout_started', { action: 'contact' });
  });

  document.getElementById('shipping-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.target);
    state.shipping = Object.fromEntries(formData.entries());
    state.checkoutStep = 3;
    renderCheckout();
    trackEvent('checkout_step_completed', { action: 'address' });
  });

  document.getElementById('confirm-shipping')?.addEventListener('click', () => {
    state.shippingMethod = document.querySelector('input[name="shipping-method"]:checked')?.value || 'standard';
    state.checkoutStep = 4;
    renderCheckout();
    trackEvent('checkout_step_completed', { action: 'shipping' });
  });

  document.getElementById('confirm-review')?.addEventListener('click', () => {
    state.checkoutStep = 5;
    renderCheckout();
    trackEvent('checkout_step_completed', { action: 'review' });
  });

  document.getElementById('checkout-previous')?.addEventListener('click', () => {
    state.checkoutStep -= 1;
    renderCheckout();
  });

  document.getElementById('place-order')?.addEventListener('click', async () => {
    if (state.checkoutBusy) return;
    if (!state.customer || !state.shipping) {
      showToast('Please complete contact and shipping details first.');
      return;
    }

    try {
      state.checkoutBusy = true;
      const payload = {
        items: state.cart.map(product => ({ productId: product.productId, quantity: product.quantity })),
        customer: {
          firstName: state.customer.firstName,
          lastName: state.customer.lastName,
          email: state.customer.email,
          phone: state.customer.phone
        },
        shipping: {
          address: state.shipping.address,
          city: state.shipping.city,
          state: state.shipping.state,
          zip: state.shipping.zip,
          country: state.shipping.country
        },
        shippingMethod: state.shippingMethod || 'standard',
        paymentMethod: document.getElementById('payment-method').value,
        idempotencyKey: state.orderRequestKey,
        sessionId: state.sessionId,
        analyticsConsent: localStorage.getItem('shopsphere-analytics-consent') === 'accepted'
      };

      const response = await fetchJson('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
      state.cart = [];
      saveCart();
      state.order = response.order;
      sessionStorage.setItem('shopsphere-last-order', JSON.stringify({
        orderReference: response.order.orderReference,
        total: response.order.total,
        paymentMethod: response.order.paymentMethod,
        shippingFee: response.order.shippingFee
      }));
      state.orderRequestKey = crypto.randomUUID();
      showToast('Order placed successfully!');
      navigate('/order-confirmation');
      if (state.matomoEnabled && window._paq) {
        window._paq.push(['trackEcommerceOrder', state.order.orderReference, state.order.total, state.order.subtotal, 0, state.order.shippingFee]);
      }
    } catch (error) {
      showToast(error.message || 'unable to place order');
    } finally {
      state.checkoutBusy = false;
    }
  });

  document.querySelectorAll('[data-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(link.dataset.route);
  }));
}

function render() {
  const pathMap = {
    home: '/',
    catalog: '/shop',
    auth: '/login',
    wishlist: '/wishlist',
    product: window.location.pathname,
    checkout: '/checkout',
    cart: '/cart',
    account: window.location.pathname,
    confirmation: '/order-confirmation'
  };
  if (state.activePage === 'catalog') renderCatalog();
  else if (state.activePage === 'auth') renderAuth();
  else if (state.activePage === 'wishlist') renderWishlist();
  else if (state.activePage === 'product') renderProductDetail();
  else if (state.activePage === 'checkout') renderCheckout();
  else if (state.activePage === 'cart') renderCartPage();
  else if (state.activePage === 'account') renderAccount();
  else if (state.activePage === 'confirmation') renderOrderConfirmation();
  else renderHome();

  const pagePath = state.activePage === 'product' && state.currentProduct
    ? `/products/${state.currentProduct.slug}`
    : pathMap[state.activePage] || '/';
  trackPageView(pagePath);
  showConsentBanner();
}

function bindGlobalActions() {
  document.querySelectorAll('[data-page]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      const page = element.dataset.page;
      if (page === 'catalog') {
        state.page = 1;
        state.selectedCategory = element.dataset.category || 'all';
        navigate('/shop');
      } else if (page === 'home') {
        navigate('/');
      } else if (page === 'auth') {
        navigate('/login');
      } else if (page === 'wishlist') {
        navigate('/wishlist');
      } else if (page === 'checkout') {
        navigate('/checkout');
      } else if (page === 'cart') {
        navigate('/cart');
      } else if (page === 'account') {
        navigate(state.user ? '/account/profile' : `/login?returnTo=${encodeURIComponent('/account/profile')}`);
      }
    });
  });

  document.querySelectorAll('[data-action="toggle-cart"]').forEach((button) => {
    button.addEventListener('click', () => {
      state.cartOpen = !state.cartOpen;
      render();
    });
  });

  document.querySelectorAll('[data-action="toggle-menu"]').forEach((button) => {
    button.addEventListener('click', () => {
      const menu = document.querySelector('.nav-links');
      const open = menu?.classList.toggle('open') || false;
      button.setAttribute('aria-expanded', String(open));
    });
  });

  document.querySelectorAll('[data-action="add-cart"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const productId = button.dataset.productId;
      const product = await fetchJson(`/api/products?category=all&limit=100`).then((data) => data.items.find(item => item.productId === productId));
      addToCart(product, state.activePage === 'product' ? state.detailQuantity : 1);
    });
  });

  document.querySelectorAll('[data-action="toggle-wishlist"]').forEach((button) => {
    button.addEventListener('click', () => {
      const productId = button.dataset.productId;
      toggleWishlist(productId);
      if (state.activePage === 'product') {
        renderProductDetail();
      }
    });
  });

  document.querySelectorAll('[data-action="view-product"]').forEach((button) => {
    button.addEventListener('click', () => {
      const slug = button.dataset.slug;
      navigate(`/products/${encodeURIComponent(slug)}`);
    });
  });

  document.querySelectorAll('[data-action="increase-qty"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.activePage === 'product') {
        if (state.detailQuantity < state.currentProduct.stock) state.detailQuantity += 1;
        else showToast(`Only ${state.currentProduct.stock} left in stock.`);
        renderProductDetail();
      } else updateCartQty(button.dataset.productId, 1);
    });
  });

  document.querySelectorAll('[data-action="decrease-qty"]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.activePage === 'product') {
        state.detailQuantity = Math.max(1, state.detailQuantity - 1);
        renderProductDetail();
      } else updateCartQty(button.dataset.productId, -1);
    });
  });

  document.querySelectorAll('[data-action="remove-cart"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeFromCart(button.dataset.productId);
    });
  });
}

(async function bootstrap() {
  try {
    const data = await fetchJson('/api/products?sort=popular&limit=48');
    state.products = data.items;
    state.categories = await fetchJson('/api/categories');
    const authResponse = await fetchJson('/api/auth/me');
    state.user = authResponse.user;
    if (state.user) await syncCustomerData();
    await setupMatomo();
    routeFromLocation();
    if (state.cart.length) {
      state.cartOpen = false;
    }
  } catch (error) {
    console.error('Failed to bootstrap:', error);
    renderHome();
  }
})();

window.addEventListener('popstate', routeFromLocation);
document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-route]');
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  navigate(link.dataset.route);
}, true);
document.addEventListener('click', (event) => {
  if (event.target.closest?.('[data-action="customer-logout"]')) logoutCustomer();
});
