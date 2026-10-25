const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
  pagePath: { type: String, default: '/' },
  sessionId: { type: String, default: '' },
  productId: { type: String, default: '' },
  category: { type: String, default: '' },
  action: { type: String, default: '' },
  device: { type: String, default: 'Unknown' },
  browser: { type: String, default: 'Unknown' }
}, { strict: true });

analyticsEventSchema.index({ type: 1, timestamp: -1 });
analyticsEventSchema.index({ sessionId: 1, timestamp: -1 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
