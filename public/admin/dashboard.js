const root = document.getElementById('admin-app');
const reportMode = root.dataset.page === 'reports';
const dateState = { range: '7d', start: '', end: '' };
const chartInstances = new Map();
let refreshTimer;
let refreshing = false;
let recentPage = 1;
let lastUpdated = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const number = (value) => new Intl.NumberFormat().format(value || 0);
const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
const time = (value) => value ? new Date(value).toLocaleString() : '—';

function dateQuery() {
  const query = new URLSearchParams({ range: dateState.range });
  if (dateState.range === 'custom') {
    query.set('start', dateState.start);
    query.set('end', dateState.end);
  }
  return query.toString();
}

function pageLayout(content, title) {
  root.innerHTML = `
    <div class="admin-layout">
      <aside class="sidebar">
        <a class="admin-brand" href="/admin">ShopSphere <span>ADMIN</span></a>
        <div class="nav-label">Workspace</div>
        <a class="side-link ${reportMode ? '' : 'active'}" href="/admin"><span>▦</span><span class="link-text">Overview</span></a>
        <a class="side-link ${reportMode ? 'active' : ''}" href="/admin/reports"><span>▤</span><span class="link-text">Reports</span></a>
        <div class="side-spacer"></div>
        <div class="sidebar-footer">Private analytics<br />ShopSphere storefront</div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <div class="topbar-title">${title}</div>
          <div class="topbar-controls">
            <select id="date-range" aria-label="Date range">
              <option value="today">Today</option>
              <option value="7d" selected>Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="custom">Custom range</option>
            </select>
            <input id="date-start" type="date" aria-label="Start date" hidden />
            <input id="date-end" type="date" aria-label="End date" hidden />
            <button class="button primary" id="refresh-button" type="button">Refresh</button>
            <button class="icon-button" id="logout-button" type="button">Sign out</button>
          </div>
        </header>
        <div class="content">
          <div id="load-error" class="error-box" hidden></div>
          <div class="heading-row">
            <div><h1>${title}</h1><p>Store activity collected with visitor analytics consent.</p></div>
            <div class="status-line">Last successful update<br /><strong id="last-updated">Loading…</strong></div>
          </div>
          <div class="notice">Near-real-time dashboard data comes from consented MongoDB events and confirmed orders. It refreshes every 30 seconds while this page is visible. Matomo reports are separate and may take time to process. Geography is not collected.</div>
          ${content}
        </div>
      </main>
    </div>`;
}

function dashboardMarkup() {
  return `
    <section class="cards" id="metric-cards">
      ${['All events', 'Page views', 'Unique sessions', 'Confirmed orders', 'Product views', 'Add to cart', 'Checkout starts', 'Sales'].map((label, index) => `
        <article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value" id="metric-${index}">…</div><div class="metric-foot">${index === 2 ? 'Anonymous browser sessions' : index === 7 ? 'Confirmed order totals' : 'Selected date range'}</div></article>
      `).join('')}
    </section>
    <div class="chart-grid">
      <section class="panel"><div class="panel-heading"><h2>Activity over time</h2><small>Events and page views</small></div><div class="chart-wrap"><canvas id="activity-chart"></canvas></div></section>
      <section class="panel"><div class="panel-heading"><h2>Conversion funnel</h2><small>Store interactions to orders</small></div><div class="chart-wrap"><canvas id="funnel-chart"></canvas></div></section>
    </div>
    <div class="chart-grid equal">
      <section class="panel"><div class="panel-heading"><h2>Most visited pages</h2></div><div class="chart-wrap short"><canvas id="pages-chart"></canvas></div></section>
      <section class="panel"><div class="panel-heading"><h2>Device types</h2><small>Approximate from browser agent</small></div><div class="chart-wrap short"><canvas id="devices-chart"></canvas></div></section>
    </div>
    <section class="panel">
      <div class="panel-heading"><h2>Recent visitor activity</h2><small id="live-count">— events in the last 5 minutes</small></div>
      <div id="recent-activity" class="loading">Loading recent activity…</div>
      <div class="table-actions"><span id="recent-page-label"></span><div><button class="icon-button" id="previous-page">Previous</button> <button class="icon-button" id="next-page">Next</button></div></div>
    </section>`;
}

function reportsMarkup() {
  return `
    <div class="chart-grid equal">
      <section class="panel"><div class="panel-heading"><h2>Product interest</h2><small>Views and add-to-cart events</small></div><div class="chart-wrap"><canvas id="products-chart"></canvas></div></section>
      <section class="panel"><div class="panel-heading"><h2>Browser breakdown</h2></div><div class="chart-wrap"><canvas id="browsers-chart"></canvas></div></section>
    </div>
    <section class="panel"><div class="panel-heading"><h2>Most visited pages</h2></div><div id="pages-report" class="loading">Loading pages…</div></section>
    <div class="chart-grid equal">
      <section class="panel"><div class="panel-heading"><h2>Search interaction volume</h2><small>Search terms are intentionally not stored</small></div><div id="search-report" class="loading">Loading search data…</div></section>
      <section class="panel"><div class="panel-heading"><h2>Category activity</h2></div><div id="category-report" class="loading">Loading categories…</div></section>
    </div>
    <section class="panel"><div class="panel-heading"><h2>Most viewed products</h2></div><div id="products-report" class="loading">Loading products…</div></section>
    <section class="panel"><div class="panel-heading"><h2>Recent event log</h2></div><div id="recent-activity" class="loading">Loading recent events…</div><div class="table-actions"><span id="recent-page-label"></span><div><button class="icon-button" id="previous-page">Previous</button> <button class="icon-button" id="next-page">Next</button></div></div></section>
    <section class="panel"><div class="panel-heading"><h2>Analytics sources</h2></div><p class="muted">MongoDB contains the consented interaction events and confirmed order data shown above. Device and browser are broad categories inferred from the request’s user-agent. No visitor IP addresses or geography are stored. Matomo receives page views and selected interaction events directly from the browser when consent is granted; MongoDB records are not automatically imported into Matomo.</p></section>`;
}

function chart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (!window.Chart) {
    canvas.parentElement.innerHTML = '<div class="empty">Chart.js could not load. Check your connection and refresh.</div>';
    return;
  }
  chartInstances.get(id)?.destroy();
  chartInstances.set(id, new Chart(canvas, config));
}

function chartOptions(indexAxis = 'x') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis,
    plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7 } } },
    scales: indexAxis === 'y' ? { x: { beginAtZero: true, grid: { color: '#eef1ee' } }, y: { grid: { display: false } } } : { y: { beginAtZero: true, grid: { color: '#eef1ee' } }, x: { grid: { display: false } } }
  };
}

function makeTable(headers, rows) {
  if (!rows.length) return '<div class="empty">No data for this date range.</div>';
  return `<div class="table-wrap"><table><thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderRecent(data) {
  const container = document.getElementById('recent-activity');
  if (!container) return;
  container.innerHTML = makeTable(['Time', 'Event', 'Page', 'Product / category'], data.recent.map((event) => [
    escapeHtml(time(event.timestamp)),
    `<span class="event-pill">${escapeHtml(event.type.replaceAll('_', ' '))}</span>`,
    escapeHtml(event.pagePath || '/'),
    escapeHtml([event.productId, event.category].filter(Boolean).join(' · ') || '—')
  ]));
  const label = document.getElementById('recent-page-label');
  if (label) label.textContent = `${number(data.total)} events · page ${data.page} of ${data.totalPages}`;
  const previous = document.getElementById('previous-page');
  const next = document.getElementById('next-page');
  if (previous) previous.disabled = data.page <= 1;
  if (next) next.disabled = data.page >= data.totalPages;
  const live = document.getElementById('live-count');
  if (live) live.textContent = `${number(data.eventsLastFiveMinutes)} events in the last 5 minutes`;
}

async function request(endpoint) {
  const response = await fetch(`/api/admin/analytics/${endpoint}?${dateQuery()}${endpoint === 'realtime' ? `&page=${recentPage}&limit=15` : ''}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  });
  const data = await response.json();
  if (response.status === 401) {
    window.location.assign('/admin/login');
    throw new Error('Admin session expired. Please sign in again.');
  }
  if (!response.ok) throw new Error(data.message || `Could not load ${endpoint}.`);
  return data;
}

function showReportTables(pages, products) {
  const pagesEl = document.getElementById('pages-report');
  if (pagesEl) pagesEl.innerHTML = makeTable(['Page', 'Views', 'Sessions'], pages.pages.map((row) => [
    escapeHtml(row.page), number(row.views), number(row.sessions)
  ]));

  const searchesEl = document.getElementById('search-report');
  if (searchesEl) searchesEl.innerHTML = makeTable(['Category filter', 'Searches'], pages.searchesByCategory.map((row) => [
    escapeHtml(row._id || 'All categories'), number(row.searches)
  ]));

  const categoriesEl = document.getElementById('category-report');
  if (categoriesEl) categoriesEl.innerHTML = makeTable(['Category', 'Interactions'], pages.categories.map((row) => [
    escapeHtml(row._id), number(row.interactions)
  ]));

  const productsEl = document.getElementById('products-report');
  if (productsEl) productsEl.innerHTML = makeTable(['Product', 'Category', 'Views', 'Add to cart'], products.products.map((row) => [
    escapeHtml(row.name), escapeHtml(row.category), number(row.views), number(row.addToCart)
  ]));
}

async function refreshDashboard() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  const error = document.getElementById('load-error');
  const refreshButton = document.getElementById('refresh-button');
  refreshButton.disabled = true;
  if (error) error.hidden = true;

  try {
    const [summary, realtime, pages, products, funnel, daily, devices] = await Promise.all([
      request('summary'),
      request('realtime'),
      request('pages'),
      request('products'),
      request('funnel'),
      request('daily'),
      request('devices')
    ]);
    lastUpdated = new Date();
    const lastUpdatedEl = document.getElementById('last-updated');
    if (lastUpdatedEl) lastUpdatedEl.textContent = lastUpdated.toLocaleTimeString();

    const metrics = [
      number(summary.totalEvents),
      number(summary.pageViews),
      number(summary.uniqueSessions),
      number(summary.confirmedOrders),
      number(summary.productViews),
      number(summary.addToCart),
      number(summary.checkoutStarts),
      money(summary.salesTotal)
    ];
    metrics.forEach((value, index) => {
      const element = document.getElementById(`metric-${index}`);
      if (element) element.textContent = value;
    });
    renderRecent(realtime);
    showReportTables(pages, products);

    chart('activity-chart', {
      type: 'line',
      data: { labels: daily.daily.map((row) => row.date), datasets: [
        { label: 'Events', data: daily.daily.map((row) => row.events), borderColor: '#22634f', backgroundColor: 'rgba(34,99,79,.12)', fill: true, tension: .32 },
        { label: 'Page views', data: daily.daily.map((row) => row.pageViews), borderColor: '#c08a48', tension: .32 }
      ] },
      options: chartOptions()
    });
    chart('funnel-chart', {
      type: 'bar',
      data: { labels: ['Page views', 'Product views', 'Add to cart', 'Checkout', 'Orders'], datasets: [{
        label: 'Interactions',
        data: [funnel.pageViews, funnel.productViews, funnel.addToCart, funnel.checkoutStarts, funnel.purchaseCompleted],
        backgroundColor: ['#c9ddd1', '#9dbda9', '#73a088', '#4c8067', '#22634f'],
        borderRadius: 5
      }] },
      options: { ...chartOptions(), plugins: { legend: { display: false } } }
    });
    chart('pages-chart', {
      type: 'bar',
      data: { labels: pages.pages.slice(0, 7).map((row) => row.page), datasets: [{ label: 'Page views', data: pages.pages.slice(0, 7).map((row) => row.views), backgroundColor: '#52816b', borderRadius: 5 }] },
      options: { ...chartOptions('y'), plugins: { legend: { display: false } } }
    });
    chart('devices-chart', {
      type: 'doughnut',
      data: { labels: devices.devices.map((row) => row._id || 'Unknown'), datasets: [{ data: devices.devices.map((row) => row.events), backgroundColor: ['#22634f', '#78a58c', '#c08a48', '#c8d9ce'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
    chart('products-chart', {
      type: 'bar',
      data: { labels: products.products.slice(0, 8).map((row) => row.name), datasets: [
        { label: 'Views', data: products.products.slice(0, 8).map((row) => row.views), backgroundColor: '#52816b', borderRadius: 4 },
        { label: 'Add to cart', data: products.products.slice(0, 8).map((row) => row.addToCart), backgroundColor: '#c08a48', borderRadius: 4 }
      ] },
      options: chartOptions('y')
    });
    chart('browsers-chart', {
      type: 'doughnut',
      data: { labels: devices.browsers.map((row) => row._id || 'Unknown'), datasets: [{ data: devices.browsers.map((row) => row.events), backgroundColor: ['#22634f', '#78a58c', '#c08a48', '#b7c8bd', '#d7dfda'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
  } catch (loadError) {
    if (error) {
      error.textContent = loadError.message;
      error.hidden = false;
    }
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

function setRange(range) {
  dateState.range = range;
  const start = document.getElementById('date-start');
  const end = document.getElementById('date-end');
  start.hidden = range !== 'custom';
  end.hidden = range !== 'custom';
  if (range === 'custom' && (!dateState.start || !dateState.end)) {
    const today = new Date().toISOString().slice(0, 10);
    dateState.end = today;
    dateState.start = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    start.value = dateState.start;
    end.value = dateState.end;
  }
  recentPage = 1;
  refreshDashboard();
}

async function init() {
  pageLayout(reportMode ? reportsMarkup() : dashboardMarkup(), reportMode ? 'Analytics reports' : 'Analytics overview');

  try {
    const response = await fetch('/api/admin/session', { credentials: 'same-origin' });
    if (!response.ok) {
      window.location.assign('/admin/login');
      return;
    }
  } catch (error) {
    document.getElementById('load-error').textContent = 'Could not verify your admin session.';
    document.getElementById('load-error').hidden = false;
    return;
  }

  document.getElementById('date-range').addEventListener('change', (event) => setRange(event.target.value));
  document.getElementById('date-start').addEventListener('change', (event) => { dateState.start = event.target.value; recentPage = 1; refreshDashboard(); });
  document.getElementById('date-end').addEventListener('change', (event) => { dateState.end = event.target.value; recentPage = 1; refreshDashboard(); });
  document.getElementById('refresh-button').addEventListener('click', refreshDashboard);
  document.getElementById('previous-page')?.addEventListener('click', () => { recentPage = Math.max(1, recentPage - 1); refreshDashboard(); });
  document.getElementById('next-page')?.addEventListener('click', () => { recentPage += 1; refreshDashboard(); });
  document.getElementById('logout-button').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Sign out failed. Please try again.');
      window.location.assign('/admin/login');
    } catch (error) {
      const message = document.getElementById('load-error');
      message.textContent = error.message;
      message.hidden = false;
    }
  });

  await refreshDashboard();
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) refreshDashboard();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    } else if (!document.hidden && !refreshTimer) {
      refreshDashboard();
      refreshTimer = window.setInterval(refreshDashboard, 30000);
    }
  });
}

init();
