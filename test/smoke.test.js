const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '0';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_EMAIL = 'admin@shopsphere.test';
process.env.ADMIN_PASSWORD_HASH = require('bcryptjs').hashSync('test-admin-password-123', 4);

test('ShopSphere API boots and serves core catalog endpoints', async (t) => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const memoryServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = memoryServer.getUri();

  const { startServer } = require('../server');
  const { disconnectDB } = require('../src/db');
  const AnalyticsEvent = require('../src/models/AnalyticsEvent');
  const Product = require('../src/models/Product');
  const NewsletterSubscriber = require('../src/models/NewsletterSubscriber');

  const server = await startServer();
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await disconnectDB();
    await memoryServer.stop();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.equal(configResponse.status, 200);

  const config = await configResponse.json();
  assert.equal(config.appName, 'ShopSphere');

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok', database: 'connected' });

  const productsResponse = await fetch(`${baseUrl}/api/products?limit=3`);
  assert.equal(productsResponse.status, 200);

  const products = await productsResponse.json();
  assert.ok(Array.isArray(products.items));
  assert.ok(products.items.length >= 1);
  assert.equal(products.items[0].category.length > 0, true);
  const fullCatalog = await fetch(`${baseUrl}/api/products?limit=48`).then((response) => response.json());
  assert.ok(fullCatalog.total >= 30, 'the catalog should contain at least 30 distinct products');

  const categoriesResponse = await fetch(`${baseUrl}/api/categories`);
  assert.equal(categoriesResponse.status, 200);

  const categories = await categoriesResponse.json();
  assert.ok(Array.isArray(categories));
  assert.ok(categories.length >= 1);
  const badNewsletterEmail = await fetch(`${baseUrl}/api/newsletter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' })
  });
  assert.equal(badNewsletterEmail.status, 400);
  const newsletterResponse = await fetch(`${baseUrl}/api/newsletter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'subscriber@example.test' })
  });
  assert.equal(newsletterResponse.status, 201);
  const duplicateNewsletterResponse = await fetch(`${baseUrl}/api/newsletter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'subscriber@example.test' })
  });
  assert.equal(duplicateNewsletterResponse.status, 200);
  assert.equal(await NewsletterSubscriber.countDocuments(), 1);

  assert.equal((await fetch(`${baseUrl}/api/cart`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/orders`)).status, 401);
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'First',
      lastName: 'Customer',
      email: 'first@shopsphere.test',
      password: 'customer-password-123'
    })
  });
  assert.equal(registration.status, 201);
  const customerCookie = registration.headers.get('set-cookie')?.split(';')[0];
  assert.ok(customerCookie);

  const customerProfile = await fetch(`${baseUrl}/api/account/profile`, { headers: { Cookie: customerCookie } });
  assert.equal(customerProfile.status, 200);
  assert.equal((await customerProfile.json()).profile.email, 'first@shopsphere.test');
  const editedProfile = await fetch(`${baseUrl}/api/account/profile`, {
    method: 'PATCH',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Updated', lastName: 'Customer', phone: '555-0101' })
  });
  assert.equal(editedProfile.status, 200);

  const firstProduct = fullCatalog.items[0];
  const cartUpdate = await fetch(`${baseUrl}/api/cart`, {
    method: 'PUT',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: firstProduct.productId, quantity: 2 }] })
  });
  assert.equal(cartUpdate.status, 200);
  const storedCart = await fetch(`${baseUrl}/api/cart`, { headers: { Cookie: customerCookie } });
  assert.equal((await storedCart.json()).items[0].quantity, 2);
  const wishlistUpdate = await fetch(`${baseUrl}/api/wishlist`, {
    method: 'PUT',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds: [firstProduct.productId] })
  });
  assert.equal(wishlistUpdate.status, 200);
  const overStockCart = await fetch(`${baseUrl}/api/cart`, {
    method: 'PUT',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: firstProduct.productId, quantity: firstProduct.stock + 1 }] })
  });
  assert.equal(overStockCart.status, 409);

  const addressResponse = await fetch(`${baseUrl}/api/account/addresses`, {
    method: 'POST',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Home',
      fullName: 'First Customer',
      phone: '555-0101',
      address: '1 Test Street',
      city: 'Test City',
      state: 'CA',
      zip: '90001',
      country: 'USA'
    })
  });
  assert.equal(addressResponse.status, 201);
  assert.equal((await addressResponse.json()).addresses.length, 1);
  const passwordResponse = await fetch(`${baseUrl}/api/account/password`, {
    method: 'POST',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'customer-password-123', newPassword: 'customer-password-456' })
  });
  assert.equal(passwordResponse.status, 200);

  const secondRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Second',
      lastName: 'Customer',
      email: 'second@shopsphere.test',
      password: 'customer-password-123'
    })
  });
  assert.equal(secondRegistration.status, 201);
  const secondCustomerCookie = secondRegistration.headers.get('set-cookie')?.split(';')[0];
  assert.deepEqual(
    (await fetch(`${baseUrl}/api/cart`, { headers: { Cookie: secondCustomerCookie } }).then((response) => response.json())).items,
    []
  );
  assert.deepEqual(
    (await fetch(`${baseUrl}/api/wishlist`, { headers: { Cookie: secondCustomerCookie } }).then((response) => response.json())).items,
    []
  );

  const protectedSummary = await fetch(`${baseUrl}/api/admin/analytics/summary`);
  assert.equal(protectedSummary.status, 401);
  for (const endpoint of ['realtime', 'pages', 'products', 'funnel', 'daily', 'devices']) {
    const response = await fetch(`${baseUrl}/api/admin/analytics/${endpoint}`);
    assert.equal(response.status, 401, `${endpoint} should require admin authentication`);
  }

  const protectedPage = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/admin/login');

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@shopsphere.test', password: 'test-admin-password-123' })
  });
  assert.equal(loginResponse.status, 200);
  const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(sessionCookie);

  const dashboardPage = await fetch(`${baseUrl}/admin`, { headers: { Cookie: sessionCookie } });
  assert.equal(dashboardPage.status, 200);
  assert.match(await dashboardPage.text(), /Analytics dashboard/);

  const eventPayload = {
    consent: true,
    type: 'page_view',
    pagePath: '/catalog?private=value',
    sessionId: 'e927a939-f3e4-41c4-adde-e9e8e82e51f0',
    metadata: { email: 'private@example.com' }
  };
  const noConsentResponse = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...eventPayload, consent: false })
  });
  assert.equal(noConsentResponse.status, 400);

  const eventResponse = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(eventPayload)
  });
  assert.equal(eventResponse.status, 201);
  const storedEvent = await AnalyticsEvent.findOne({ sessionId: eventPayload.sessionId }).lean();
  assert.equal(storedEvent.pagePath, '/catalog');
  assert.equal(storedEvent.metadata, undefined);

  const productsForOrder = products.items;
  const orderPayload = {
    items: [{ productId: productsForOrder[0].productId, quantity: 1 }],
    customer: { firstName: 'Demo', lastName: 'Buyer', email: 'buyer@example.test', phone: '555-0100' },
    shipping: { address: '1 Demo Street', city: 'Demo City', state: 'CA', zip: '90001', country: 'USA' },
    paymentMethod: 'cash_on_delivery',
    idempotencyKey: 'b174715e-f848-4a91-9e9c-010824b1e71c',
    sessionId: 'c98837b8-6c4d-411a-bb87-23c9098998fd',
    analyticsConsent: false
  };
  const orderWithoutConsent = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderPayload)
  });
  assert.equal(orderWithoutConsent.status, 201);
  assert.equal(await AnalyticsEvent.countDocuments({ type: 'purchase_completed' }), 0);

  const consentedOrderPayload = {
    ...orderPayload,
    items: [{ productId: productsForOrder[1].productId, quantity: 1 }],
    idempotencyKey: '72a21a9b-4b8c-49c6-ad48-9ece00b4518f',
    sessionId: 'bbd16e5a-b463-49f3-9125-86fa2b23831e',
    analyticsConsent: true
  };
  const orderWithConsent = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(consentedOrderPayload)
  });
  assert.equal(orderWithConsent.status, 201);
  assert.equal(await AnalyticsEvent.countDocuments({ type: 'purchase_completed', sessionId: consentedOrderPayload.sessionId }), 1);

  const customerOrderPayload = {
    ...orderPayload,
    items: [{ productId: fullCatalog.items[2].productId, quantity: 1 }],
    shippingMethod: 'express',
    idempotencyKey: 'd8c1d3ac-7c0d-47b1-8aa8-3b05b471574f'
  };
  const orderProduct = await Product.findOne({ productId: customerOrderPayload.items[0].productId });
  const stockBeforeOrder = orderProduct.stock;
  const customerOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(customerOrderPayload)
  });
  assert.equal(customerOrder.status, 201);
  const createdOrder = await customerOrder.json();
  assert.equal(
    createdOrder.order.discount,
    Math.max((orderProduct.originalPrice || orderProduct.price) - orderProduct.price, 0)
  );
  assert.equal(createdOrder.order.subtotal - createdOrder.order.discount, orderProduct.price);
  assert.equal(createdOrder.order.total, orderProduct.price + createdOrder.order.shippingFee);
  assert.equal(createdOrder.order.shippingMethod, 'express');
  assert.equal(createdOrder.order.shippingFee, 25);
  assert.equal((await Product.findOne({ productId: orderProduct.productId })).stock, stockBeforeOrder - 1);
  const repeatedCustomerOrder = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(customerOrderPayload)
  });
  assert.equal(repeatedCustomerOrder.status, 200);
  assert.equal((await repeatedCustomerOrder.json()).duplicate, true);
  assert.equal((await Product.findOne({ productId: orderProduct.productId })).stock, stockBeforeOrder - 1);
  assert.equal(
    (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: customerCookie } }).then((response) => response.json())).orders.length,
    1
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: secondCustomerCookie } }).then((response) => response.json())).orders.length,
    0
  );
  const customerLogout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: customerCookie }
  });
  assert.equal(customerLogout.status, 200);
  assert.deepEqual(
    await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: customerCookie } }).then((response) => response.json()),
    { user: null }
  );
  const customerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'first@shopsphere.test', password: 'customer-password-456' })
  });
  assert.equal(customerLogin.status, 200);

  const summaryResponse = await fetch(`${baseUrl}/api/admin/analytics/summary?range=7d`, {
    headers: { Cookie: sessionCookie }
  });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.ok(summary.totalEvents >= 1);
  assert.ok(summary.pageViews >= 1);
  assert.ok(summary.uniqueSessions >= 1);

  for (const endpoint of ['realtime', 'pages', 'products', 'funnel', 'daily', 'devices']) {
    const response = await fetch(`${baseUrl}/api/admin/analytics/${endpoint}?range=7d`, {
      headers: { Cookie: sessionCookie }
    });
    assert.equal(response.status, 200, `${endpoint} should load for admin`);
  }
  const invalidRange = await fetch(`${baseUrl}/api/admin/analytics/summary?range=custom`, {
    headers: { Cookie: sessionCookie }
  });
  assert.equal(invalidRange.status, 400);

  const logoutResponse = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie }
  });
  assert.equal(logoutResponse.status, 200);

  const loggedOutSummary = await fetch(`${baseUrl}/api/admin/analytics/summary`, {
    headers: { Cookie: sessionCookie }
  });
  assert.equal(loggedOutSummary.status, 401);
});
