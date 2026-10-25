const express = require('express');
const path = require('path');
const morgan = require('morgan');
const helmet = require('helmet');
const session = require('express-session');
const MongoStore = require('connect-mongo').default;
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const {
  port,
  sessionSecret,
  matomoUrl,
  matomoSiteId,
  adminEmail,
  adminPasswordHash,
  mongoUri,
  sessionCookieSecure
} = require('./src/config');
const { connectDB, disconnectDB } = require('./src/db');
const Product = require('./src/models/Product');
const User = require('./src/models/User');
const Order = require('./src/models/Order');
const AnalyticsEvent = require('./src/models/AnalyticsEvent');
const NewsletterSubscriber = require('./src/models/NewsletterSubscriber');
const { seedProducts } = require('./src/seed');
if (process.env.NODE_ENV === 'production' && !mongoUri) {
  throw new Error('MONGODB_URI must be set in production.');
}
const mongoClientPromise = connectDB().then((connection) => connection.getClient());

const app = express();
if (sessionCookieSecure) app.set('trust proxy', 1);
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));
app.use(session({
  secret: sessionSecret,
  store: MongoStore.create({
    clientPromise: mongoClientPromise,
    touchAfter: 24 * 60 * 60
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    secure: sessionCookieSecure,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use('/api', apiLimiter);

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again in 15 minutes.' }
});
const customerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Try again later.' }
});
const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many newsletter attempts. Please try again later.' }
});

const eventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

function ensureAuthenticated(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Unauthorized. Please sign in.' });
  }
  next();
}

function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.adminAuthenticated) {
    return res.status(401).json({ message: 'Admin sign-in required.' });
  }
  next();
}

function requireAdminPage(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!req.session || !req.session.adminAuthenticated) {
    return res.redirect('/admin/login');
  }
  next();
}

function getDateRange(query) {
  const preset = query.range || '7d';
  const now = new Date();
  let start;
  let end = now;

  if (preset === 'today') {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  } else if (preset === '7d') {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (preset === '30d') {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (preset === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.start || '') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(query.end || '')) {
      return { error: 'Custom ranges require start and end dates in YYYY-MM-DD format.' };
    }
    start = new Date(`${query.start}T00:00:00.000Z`);
    end = new Date(`${query.end}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ||
        start.toISOString().slice(0, 10) !== query.start ||
        end.toISOString().slice(0, 10) !== query.end ||
        start > end) {
      return { error: 'The custom date range is invalid.' };
    }
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) {
      return { error: 'Custom ranges cannot exceed 366 days.' };
    }
  } else {
    return { error: 'Choose today, 7d, 30d, or custom.' };
  }

  return { start, end };
}

function getUserAgentGroups(userAgent = '') {
  const value = userAgent.toLowerCase();
  let browser = 'Other';
  let device = 'Desktop';

  if (/ipad|tablet/.test(value)) device = 'Tablet';
  else if (/mobile|android|iphone/.test(value)) device = 'Mobile';

  if (/edg\//.test(value)) browser = 'Edge';
  else if (/firefox\//.test(value)) browser = 'Firefox';
  else if (/chrome\//.test(value) && !/edg\//.test(value)) browser = 'Chrome';
  else if (/safari\//.test(value) && !/chrome\//.test(value)) browser = 'Safari';

  return { browser, device };
}

function adminEventMatch(range) {
  return { timestamp: { $gte: range.start, $lt: range.end } };
}

function respondWithDateError(range, res) {
  if (!range.error) return false;
  res.status(400).json({ message: range.error });
  return true;
}

app.get('/api/config', (req, res) => {
  res.json({
    matomoUrl,
    matomoSiteId,
    appName: 'ShopSphere',
    consentRequired: true
  });
});

app.get('/api/health', (req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? 'ok' : 'degraded',
    database: databaseReady ? 'connected' : 'disconnected'
  });
});

app.use('/api/admin', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.post('/api/admin/login', adminLoginLimiter, [
  body('email').isEmail().withMessage('Enter a valid admin email.'),
  body('password').isString().isLength({ min: 1, max: 200 }).withMessage('Enter your password.')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: errors.array()[0].msg });
  if (!adminEmail || !/^\$2[aby]\$\d{2}\$/.test(adminPasswordHash)) {
    return res.status(503).json({ message: 'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH.' });
  }

  const emailMatches = req.body.email.trim().toLowerCase() === adminEmail;
  let passwordMatches = false;
  try {
    passwordMatches = await bcrypt.compare(req.body.password, adminPasswordHash);
  } catch (error) {
    console.error('Admin password hash could not be checked:', error);
    return res.status(500).json({ message: 'Admin sign-in is temporarily unavailable.' });
  }
  if (!emailMatches || !passwordMatches) {
    return res.status(401).json({ message: 'Invalid admin email or password.' });
  }

  req.session.regenerate((error) => {
    if (error) {
      console.error('Could not create admin session:', error);
      return res.status(500).json({ message: 'Unable to start admin session.' });
    }
    req.session.adminAuthenticated = true;
    req.session.adminEmail = adminEmail;
    req.session.save((saveError) => {
      if (saveError) {
        console.error('Could not save admin session:', saveError);
        return res.status(500).json({ message: 'Unable to start admin session.' });
      }
      res.json({ ok: true });
    });
  });
});

app.get('/api/admin/session', ensureAdmin, (req, res) => {
  res.json({ authenticated: true, email: req.session.adminEmail });
});

app.post('/api/admin/logout', ensureAdmin, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Could not end admin session:', error);
      return res.status(500).json({ message: 'Unable to sign out.' });
    }
    res.clearCookie('connect.sid', { httpOnly: true, sameSite: 'lax', secure: sessionCookieSecure });
    res.json({ ok: true });
  });
});

app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Product.distinct('category');
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: 'Unable to load categories.' });
  }
});

app.post('/api/newsletter', newsletterLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Please enter a valid email address.')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Please enter a valid email address.' });
  try {
    const result = await NewsletterSubscriber.updateOne(
      { email: req.body.email },
      { $setOnInsert: { email: req.body.email } },
      { upsert: true, runValidators: true }
    );
    res.status(result.upsertedCount ? 201 : 200).json({
      subscribed: true,
      alreadySubscribed: result.upsertedCount === 0
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(200).json({ subscribed: true, alreadySubscribed: true });
    }
    console.error('Newsletter subscription failed:', error);
    res.status(500).json({ message: 'Unable to save your newsletter subscription.' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const { category, q, minPrice, maxPrice, sort, page = 1, limit = 12, inStock } = req.query;
    const query = {};

    if (category && category !== 'all') query.category = category;
    if (q) {
      const safeQuery = String(q).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { name: { $regex: safeQuery, $options: 'i' } },
        { category: { $regex: safeQuery, $options: 'i' } }
      ];
    }
    if (inStock === 'true') query.stock = { $gt: 0 };
    if (minPrice || maxPrice) {
      const minimum = minPrice === undefined ? undefined : Number(minPrice);
      const maximum = maxPrice === undefined ? undefined : Number(maxPrice);
      if ((minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0)) ||
          (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0)) ||
          (minimum !== undefined && maximum !== undefined && minimum > maximum)) {
        return res.status(400).json({ message: 'Enter a valid price range.' });
      }
      query.price = {};
      if (minimum !== undefined) query.price.$gte = minimum;
      if (maximum !== undefined) query.price.$lte = maximum;
    }

    let sortOrder = { createdAt: -1 };
    if (sort === 'price-low-high') sortOrder = { price: 1 };
    else if (sort === 'price-high-low') sortOrder = { price: -1 };
    else if (sort === 'price') sortOrder = { price: 1 };
    else if (sort === 'rating') sortOrder = { rating: -1, reviewCount: -1 };
    else if (sort === 'popular') sortOrder = { reviewCount: -1, rating: -1 };
    else if (sort === 'newest') sortOrder = { createdAt: -1 };

    const safePage = Math.max(1, Math.min(10000, Number.parseInt(page, 10) || 1));
    const safeLimit = Math.max(1, Math.min(48, Number.parseInt(limit, 10) || 12));
    const total = await Product.countDocuments(query);
    const items = await Product.find(query).sort(sortOrder).skip((safePage - 1) * safeLimit).limit(safeLimit);

    res.json({ items, page: safePage, totalPages: Math.max(1, Math.ceil(total / safeLimit)), total });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load products.' });
  }
});

app.get('/api/products/:slug', async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug });
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    const related = await Product.find({
      category: product.category,
      _id: { $ne: product._id }
    }).limit(4);

    res.json({ product, related });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load product.' });
  }
});

app.post('/api/auth/register', customerLoginLimiter, [
  body('email').isEmail().withMessage('Please provide a valid email.'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long.'),
  body('firstName').trim().isLength({ min: 2 }).withMessage('First name is too short.'),
  body('lastName').trim().isLength({ min: 2 }).withMessage('Last name is too short.')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password, firstName, lastName } = req.body;
  try {
    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) return res.status(409).json({ message: 'Account already exists.' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({ email: normalizedEmail, passwordHash, firstName: firstName.trim(), lastName: lastName.trim() });
    await user.save();
    req.session.regenerate((sessionError) => {
      if (sessionError) return res.status(500).json({ message: 'Account created but sign-in failed. Please log in.' });
      req.session.userId = user._id.toString();
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ message: 'Account created but sign-in failed. Please log in.' });
        res.status(201).json({ user: user.toPublicJSON() });
      });
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'An account with this email already exists.' });
    console.error('Customer registration failed:', error);
    res.status(500).json({ message: 'Unable to create account.' });
  }
});

app.post('/api/auth/login', customerLoginLimiter, [
  body('email').isEmail().withMessage('Please provide a valid email.'),
  body('password').notEmpty().withMessage('Password is required.')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    req.session.regenerate((sessionError) => {
      if (sessionError) return res.status(500).json({ message: 'Unable to start sign-in session.' });
      req.session.userId = user._id.toString();
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ message: 'Unable to start sign-in session.' });
        res.json({ user: user.toPublicJSON() });
      });
    });
  } catch (error) {
    console.error('Customer login failed:', error);
    res.status(500).json({ message: 'Unable to log in.' });
  }
});

app.post('/api/auth/logout', ensureAuthenticated, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ message: 'Unable to log out.' });
    res.clearCookie('connect.sid', { httpOnly: true, sameSite: 'lax', secure: sessionCookieSecure });
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });

  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.json({ user: null });
    res.json({ user: user.toPublicJSON() });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load account.' });
  }
});

app.get('/api/account/profile', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('email firstName lastName phone');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ profile: { email: user.email, firstName: user.firstName, lastName: user.lastName, phone: user.phone || '' } });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load profile.' });
  }
});

app.patch('/api/account/profile', ensureAuthenticated, [
  body('firstName').trim().isLength({ min: 2, max: 60 }),
  body('lastName').trim().isLength({ min: 2, max: 60 }),
  body('phone').optional({ values: 'falsy' }).trim().isLength({ max: 30 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Enter a valid first and last name.' });
  try {
    const user = await User.findByIdAndUpdate(
      req.session.userId,
      { $set: { firstName: req.body.firstName.trim(), lastName: req.body.lastName.trim(), phone: req.body.phone || '' } },
      { returnDocument: 'after', runValidators: true }
    );
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ profile: user.toPublicJSON() });
  } catch (error) {
    res.status(500).json({ message: 'Unable to update profile.' });
  }
});

app.post('/api/account/password', ensureAuthenticated, [
  body('currentPassword').isString().isLength({ min: 1, max: 200 }),
  body('newPassword').isString().isLength({ min: 8, max: 200 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'New password must be at least 8 characters.' });
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !(await user.comparePassword(req.body.currentPassword))) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    await user.save();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Unable to change password.' });
  }
});

app.get('/api/account/addresses', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('addresses');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ addresses: user.addresses });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load addresses.' });
  }
});

app.post('/api/account/addresses', ensureAuthenticated, [
  body('label').optional().trim().isLength({ max: 40 }),
  body('fullName').trim().isLength({ min: 2, max: 100 }),
  body('phone').trim().isLength({ min: 3, max: 30 }),
  body('address').trim().isLength({ min: 3, max: 200 }),
  body('city').trim().isLength({ min: 2, max: 80 }),
  body('state').trim().isLength({ min: 2, max: 80 }),
  body('zip').trim().isLength({ min: 2, max: 20 }),
  body('country').trim().isLength({ min: 2, max: 80 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Please complete all address fields.' });
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    const address = {
      label: req.body.label || 'Home',
      fullName: req.body.fullName,
      phone: req.body.phone,
      address: req.body.address,
      city: req.body.city,
      state: req.body.state,
      zip: req.body.zip,
      country: req.body.country,
      isDefault: user.addresses.length === 0
    };
    user.addresses.push(address);
    await user.save();
    res.status(201).json({ addresses: user.addresses });
  } catch (error) {
    res.status(500).json({ message: 'Unable to save address.' });
  }
});

app.get('/api/cart', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('cart');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    const ids = user.cart.map((item) => item.productId);
    const products = await Product.find({ productId: { $in: ids } }).lean();
    const productMap = new Map(products.map((product) => [product.productId, product]));
    const items = user.cart.flatMap((item) => {
      const product = productMap.get(item.productId);
      return product ? [{ ...product, quantity: Math.min(item.quantity, product.stock) }] : [];
    }).filter((item) => item.quantity > 0);
    res.json({ items });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load your cart.' });
  }
});

app.put('/api/cart', ensureAuthenticated, [
  body('items').isArray({ max: 100 }),
  body('items.*.productId').isString().trim().isLength({ min: 1, max: 80 }),
  body('items.*.quantity').isInt({ min: 1, max: 100 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Cart contains invalid products or quantities.' });
  const quantities = new Map();
  for (const item of req.body.items) {
    quantities.set(item.productId, (quantities.get(item.productId) || 0) + Number(item.quantity));
  }
  try {
    const products = await Product.find({ productId: { $in: [...quantities.keys()] } }).select('productId stock');
    if (products.length !== quantities.size) return res.status(400).json({ message: 'One or more cart products are unavailable.' });
    for (const product of products) {
      if (quantities.get(product.productId) > product.stock) {
        return res.status(409).json({ message: `Only ${product.stock} units remain in stock for ${product.productId}.` });
      }
    }
    const user = await User.findByIdAndUpdate(
      req.session.userId,
      { $set: { cart: [...quantities].map(([productId, quantity]) => ({ productId, quantity })) } },
      { returnDocument: 'after', runValidators: true }
    ).select('cart');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ ok: true, cart: user.cart });
  } catch (error) {
    res.status(500).json({ message: 'Unable to save your cart.' });
  }
});

app.get('/api/wishlist', ensureAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('wishlist');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    const products = await Product.find({ productId: { $in: user.wishlist } }).lean();
    res.json({ items: products });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load your wishlist.' });
  }
});

app.put('/api/wishlist', ensureAuthenticated, [
  body('productIds').isArray({ max: 200 }),
  body('productIds.*').isString().trim().isLength({ min: 1, max: 80 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Wishlist contains invalid product IDs.' });
  const productIds = [...new Set(req.body.productIds)];
  try {
    const count = await Product.countDocuments({ productId: { $in: productIds } });
    if (count !== productIds.length) return res.status(400).json({ message: 'One or more wishlist products are unavailable.' });
    const user = await User.findByIdAndUpdate(
      req.session.userId,
      { $set: { wishlist: productIds } },
      { returnDocument: 'after', runValidators: true }
    ).select('wishlist');
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ ok: true, productIds: user.wishlist });
  } catch (error) {
    res.status(500).json({ message: 'Unable to save your wishlist.' });
  }
});

app.get('/api/orders', ensureAuthenticated, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.session.userId }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load orders.' });
  }
});

app.post('/api/orders', [
  body('items').isArray({ min: 1 }).withMessage('Order must contain at least one item.'),
  body('items.*.productId').isString().trim().isLength({ min: 1, max: 80 }),
  body('items.*.quantity').isInt({ min: 1, max: 100 }),
  body('sessionId').optional().isUUID().withMessage('Invalid analytics session identifier.'),
  body('analyticsConsent').optional().isBoolean(),
  body('idempotencyKey').isUUID().withMessage('Invalid checkout request key.'),
  body('customer.firstName').trim().notEmpty(),
  body('customer.lastName').trim().notEmpty(),
  body('customer.email').isEmail(),
  body('customer.phone').trim().notEmpty(),
  body('shipping.address').trim().notEmpty(),
  body('shipping.city').trim().notEmpty(),
  body('shipping.state').trim().notEmpty(),
  body('shipping.zip').trim().notEmpty(),
  body('shipping.country').trim().notEmpty(),
  body('shippingMethod').optional().isIn(['standard', 'express']),
  body('paymentMethod').isIn(['cash_on_delivery', 'demo_card'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { items, customer, shipping, paymentMethod } = req.body;

  try {
    const existingOrder = await Order.findOne({ idempotencyKey: req.body.idempotencyKey });
    if (existingOrder) {
      if (existingOrder.userId !== (req.session.userId || null)) {
        return res.status(409).json({ message: 'This checkout request was already used.' });
      }
      return res.status(200).json({ order: existingOrder, duplicate: true });
    }

    const quantities = new Map();
    for (const item of items) {
      quantities.set(item.productId, (quantities.get(item.productId) || 0) + Number(item.quantity));
    }
    if ([...quantities.values()].some((quantity) => quantity > 100)) {
      return res.status(400).json({ message: 'Requested quantity exceeds the allowed amount.' });
    }
    const productIds = [...quantities.keys()];
    const products = await Product.find({ productId: { $in: productIds } });
    const productMap = new Map(products.map(product => [product.productId, product]));

    if (products.length !== quantities.size) {
      return res.status(400).json({ message: 'One or more products are unavailable.' });
    }

    let subtotal = 0;
    let discount = 0;
    const normalizedItems = [];

    for (const [productId, quantity] of quantities) {
      const product = productMap.get(productId);
      if (!product) return res.status(400).json({ message: `Product ${productId} not found.` });
      if (quantity > product.stock) {
        return res.status(400).json({ message: `Not enough stock for ${product.name}.` });
      }
      const listPrice = Math.max(product.price, Number(product.originalPrice) || product.price);
      const totalPrice = product.price * quantity;
      subtotal += listPrice * quantity;
      discount += (listPrice - product.price) * quantity;
      normalizedItems.push({
        productId: product.productId,
        name: product.name,
        quantity,
        unitPrice: product.price,
        totalPrice
      });
    }

    const shippingFee = req.body.shippingMethod === 'express' ? 25 : subtotal > 150 ? 0 : 15;
    const total = subtotal - discount + shippingFee;
    const orderReference = `SP-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

    const order = new Order({
      orderReference,
      idempotencyKey: req.body.idempotencyKey,
      userId: req.session.userId || null,
      customer,
      shipping,
      items: normalizedItems,
      subtotal,
      shippingFee,
      discount,
      total,
      shippingMethod: req.body.shippingMethod === 'express' ? 'express' : 'standard',
      paymentMethod,
      paymentStatus: paymentMethod === 'demo_card' ? 'simulated' : 'pending',
      status: 'confirmed'
    });

    const reserved = [];
    try {
      for (const item of normalizedItems) {
        const result = await Product.updateOne(
          { productId: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } }
        );
        if (result.modifiedCount !== 1) {
          throw new Error(`Not enough stock for ${item.name}.`);
        }
        reserved.push(item);
      }
      const savedOrder = await order.save();
      if (req.session.userId) {
        try {
          await User.updateOne({ _id: req.session.userId }, { $set: { cart: [] } });
        } catch (cartError) {
          console.error('Order was created but the customer cart could not be cleared:', cartError);
        }
      }

      if (req.body.analyticsConsent === true) {
        const groups = getUserAgentGroups(req.get('user-agent'));
        try {
          await AnalyticsEvent.create({
            type: 'purchase_completed',
            pagePath: '/checkout/confirmation',
            sessionId: req.body.sessionId || '',
            productId: normalizedItems[0]?.productId || '',
            category: 'checkout',
            action: 'confirmed',
            ...groups
          });
        } catch (eventError) {
          console.error('Order was created but its analytics event could not be stored:', eventError);
        }
      }

      return res.status(201).json({ order: savedOrder });
    } catch (orderError) {
      await Promise.all(reserved.map((item) =>
        Product.updateOne({ productId: item.productId }, { $inc: { stock: item.quantity } })
      ));
      if (orderError.code === 11000 && orderError.keyPattern?.idempotencyKey) {
        const duplicate = await Order.findOne({ idempotencyKey: req.body.idempotencyKey });
        if (duplicate && duplicate.userId === (req.session.userId || null)) {
          return res.status(200).json({ order: duplicate, duplicate: true });
        }
      }
      if (orderError.message.startsWith('Not enough stock')) {
        return res.status(409).json({ message: orderError.message });
      }
      throw orderError;
    }
  } catch (error) {
    console.error('Order creation failed:', error);
    res.status(500).json({ message: 'Unable to create order.' });
  }
});

const allowedEventTypes = new Set([
  'page_view', 'product_view', 'search', 'filter_applied', 'sort_applied',
  'add_to_cart', 'remove_from_cart', 'wishlist_add', 'wishlist_remove', 'checkout_started',
  'checkout_step_completed', 'newsletter_signup'
]);

app.post('/api/events', [
  body('consent').equals('true').withMessage('Analytics consent is required.'),
  body('type').isIn([...allowedEventTypes]),
  body('pagePath').optional().isString().trim().isLength({ max: 180 }),
  body('sessionId').isUUID().withMessage('A valid anonymous session identifier is required.'),
  body('productId').optional().isString().trim().isLength({ max: 80 }),
  body('category').optional().isString().trim().isLength({ max: 60 }),
  body('action').optional().isIn([
    'submitted', 'address', 'price-low-high', 'price-high-low', 'rating', 'popular', 'newest',
    'contact', 'shipping', 'review', 'subscribe'
  ])
], eventLimiter, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const pagePath = typeof req.body.pagePath === 'string' &&
      req.body.pagePath.startsWith('/') && !req.body.pagePath.startsWith('//')
      ? req.body.pagePath.split('?')[0].slice(0, 180)
      : '/';
    const groups = getUserAgentGroups(req.get('user-agent'));
    const event = new AnalyticsEvent({
      type: req.body.type,
      timestamp: new Date(),
      pagePath,
      sessionId: req.body.sessionId,
      productId: req.body.productId || '',
      category: req.body.category || '',
      action: req.body.action || '',
      ...groups
    });
    await event.save();
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error('Could not store analytics event:', error);
    res.status(500).json({ message: 'Unable to track event.' });
  }
});

app.get('/api/admin/analytics/summary', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  const match = adminEventMatch(range);
  const orderMatch = { createdAt: { $gte: range.start, $lt: range.end }, status: 'confirmed' };
  try {
    const [totalEvents, pageViews, uniqueSessions, productViews, searches, addToCart, checkoutStarts, orders, sales] =
      await Promise.all([
        AnalyticsEvent.countDocuments(match),
        AnalyticsEvent.countDocuments({ ...match, type: 'page_view' }),
        AnalyticsEvent.distinct('sessionId', { ...match, sessionId: { $ne: '' } }),
        AnalyticsEvent.countDocuments({ ...match, type: 'product_view' }),
        AnalyticsEvent.countDocuments({ ...match, type: 'search' }),
        AnalyticsEvent.countDocuments({ ...match, type: 'add_to_cart' }),
        AnalyticsEvent.countDocuments({ ...match, type: 'checkout_started' }),
        Order.countDocuments(orderMatch),
        Order.aggregate([
          { $match: orderMatch },
          { $group: { _id: null, total: { $sum: '$total' } } }
        ])
      ]);
    res.json({
      totalEvents,
      pageViews,
      uniqueSessions: uniqueSessions.length,
      productViews,
      searches,
      addToCart,
      checkoutStarts,
      confirmedOrders: orders,
      salesTotal: sales[0]?.total || 0,
      range: { start: range.start, end: range.end }
    });
  } catch (error) {
    console.error('Could not load admin analytics summary:', error);
    res.status(500).json({ message: 'Unable to load analytics summary.' });
  }
});

app.get('/api/admin/analytics/realtime', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const match = adminEventMatch(range);
  try {
    const [eventsLastFiveMinutes, recent, total] = await Promise.all([
      AnalyticsEvent.countDocuments({ timestamp: { $gte: new Date(Date.now() - 5 * 60 * 1000) } }),
      AnalyticsEvent.find(match)
        .select('timestamp type pagePath sessionId productId category action')
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AnalyticsEvent.countDocuments(match)
    ]);
    res.json({
      eventsLastFiveMinutes,
      recent,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit))
    });
  } catch (error) {
    console.error('Could not load recent admin events:', error);
    res.status(500).json({ message: 'Unable to load recent activity.' });
  }
});

app.get('/api/admin/analytics/pages', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  const match = adminEventMatch(range);
  try {
    const [pages, searchesByCategory, categories] = await Promise.all([
      AnalyticsEvent.aggregate([
        { $match: { ...match, type: 'page_view' } },
        { $group: {
          _id: '$pagePath',
          views: { $sum: 1 },
          sessions: { $addToSet: { $cond: [{ $ne: ['$sessionId', ''] }, '$sessionId', null] } }
        } },
        { $project: { page: '$_id', views: 1, sessions: { $size: { $setDifference: ['$sessions', [null]] } } } },
        { $sort: { views: -1 } },
        { $limit: 12 }
      ]),
      AnalyticsEvent.aggregate([
        { $match: { ...match, type: 'search' } },
        { $group: { _id: '$category', searches: { $sum: 1 } } },
        { $sort: { searches: -1 } },
        { $limit: 10 }
      ]),
      AnalyticsEvent.aggregate([
        { $match: { ...match, type: { $in: ['filter_applied', 'product_view'] }, category: { $ne: '' } } },
        { $group: { _id: '$category', interactions: { $sum: 1 } } },
        { $sort: { interactions: -1 } }
      ])
    ]);
    res.json({ pages, searchesByCategory, categories });
  } catch (error) {
    console.error('Could not load page analytics:', error);
    res.status(500).json({ message: 'Unable to load page analytics.' });
  }
});

app.get('/api/admin/analytics/products', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  try {
    const products = await AnalyticsEvent.aggregate([
      { $match: { ...adminEventMatch(range), type: { $in: ['product_view', 'add_to_cart'] }, productId: { $ne: '' } } },
      { $group: {
        _id: '$productId',
        views: { $sum: { $cond: [{ $eq: ['$type', 'product_view'] }, 1, 0] } },
        addToCart: { $sum: { $cond: [{ $eq: ['$type', 'add_to_cart'] }, 1, 0] } }
      } },
      { $lookup: { from: Product.collection.name, localField: '_id', foreignField: 'productId', as: 'product' } },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      { $project: { productId: '$_id', name: { $ifNull: ['$product.name', 'Unknown product'] }, category: { $ifNull: ['$product.category', ''] }, views: 1, addToCart: 1 } },
      { $sort: { views: -1, addToCart: -1 } },
      { $limit: 12 }
    ]);
    res.json({ products });
  } catch (error) {
    console.error('Could not load product analytics:', error);
    res.status(500).json({ message: 'Unable to load product analytics.' });
  }
});

app.get('/api/admin/analytics/funnel', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  const match = adminEventMatch(range);
  try {
    const [pageViews, productViews, addToCart, checkoutStarts, purchaseCompleted] = await Promise.all([
      AnalyticsEvent.countDocuments({ ...match, type: 'page_view' }),
      AnalyticsEvent.countDocuments({ ...match, type: 'product_view' }),
      AnalyticsEvent.countDocuments({ ...match, type: 'add_to_cart' }),
      AnalyticsEvent.countDocuments({ ...match, type: 'checkout_started' }),
      AnalyticsEvent.countDocuments({ ...match, type: 'purchase_completed' })
    ]);
    res.json({ pageViews, productViews, addToCart, checkoutStarts, purchaseCompleted });
  } catch (error) {
    console.error('Could not load conversion funnel:', error);
    res.status(500).json({ message: 'Unable to load conversion funnel.' });
  }
});

app.get('/api/admin/analytics/daily', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  try {
    const daily = await AnalyticsEvent.aggregate([
      { $match: adminEventMatch(range) },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
        events: { $sum: 1 },
        pageViews: { $sum: { $cond: [{ $eq: ['$type', 'page_view'] }, 1, 0] } },
        sessions: { $addToSet: { $cond: [{ $ne: ['$sessionId', ''] }, '$sessionId', null] } }
      } },
      { $project: { date: '$_id', events: 1, pageViews: 1, sessions: { $size: { $setDifference: ['$sessions', [null]] } } } },
      { $sort: { date: 1 } }
    ]);
    res.json({ daily });
  } catch (error) {
    console.error('Could not load daily analytics:', error);
    res.status(500).json({ message: 'Unable to load daily analytics.' });
  }
});

app.get('/api/admin/analytics/devices', ensureAdmin, async (req, res) => {
  const range = getDateRange(req.query);
  if (respondWithDateError(range, res)) return;
  try {
    const [devices, browsers] = await Promise.all(['device', 'browser'].map((field) =>
      AnalyticsEvent.aggregate([
        { $match: adminEventMatch(range) },
        { $group: { _id: `$${field}`, events: { $sum: 1 } } },
        { $sort: { events: -1 } }
      ])
    ));
    res.json({ devices, browsers });
  } catch (error) {
    console.error('Could not load device analytics:', error);
    res.status(500).json({ message: 'Unable to load device analytics.' });
  }
});

app.use('/api/analytics', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, ensureAdmin);

app.get('/admin/login', (req, res) => {
  if (req.session?.adminAuthenticated) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});

app.get(['/admin', '/admin/'], requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html'));
});

app.get('/admin/reports', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'reports.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let server;

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SESSION_SECRET) {
      throw new Error('SESSION_SECRET must be set in production.');
    }
    if (!adminEmail || !/^\$2[aby]\$\d{2}\$/.test(adminPasswordHash)) {
      throw new Error('ADMIN_EMAIL and a bcrypt ADMIN_PASSWORD_HASH must be set in production.');
    }
  }
  await mongoClientPromise;
  await seedProducts();

  return new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`ShopSphere listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}

async function stopServer() {
  if (server && server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          return reject(error);
        }
        resolve();
      });
    });
    server = null;
  }
  await disconnectDB();
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start ShopSphere:', error);
    process.exit(1);
  });
}

module.exports = { app, startServer, stopServer };
