require('dotenv').config();
const crypto = require('crypto');

module.exports = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  mongoUri: process.env.MONGODB_URI || '',
  matomoUrl: process.env.MATOMO_URL || '',
  matomoSiteId: process.env.MATOMO_SITE_ID || '',
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  sessionCookieSecure: process.env.NODE_ENV === 'production'
};
