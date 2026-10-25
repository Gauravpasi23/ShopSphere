const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  phone: { type: String, default: '', maxlength: 30 },
  addresses: [{
    label: { type: String, default: 'Home', maxlength: 40 },
    fullName: { type: String, required: true, maxlength: 100 },
    phone: { type: String, required: true, maxlength: 30 },
    address: { type: String, required: true, maxlength: 200 },
    city: { type: String, required: true, maxlength: 80 },
    state: { type: String, required: true, maxlength: 80 },
    zip: { type: String, required: true, maxlength: 20 },
    country: { type: String, required: true, maxlength: 80 },
    isDefault: { type: Boolean, default: false }
  }],
  cart: [{
    productId: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 }
  }],
  wishlist: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id,
    email: this.email,
    firstName: this.firstName,
    lastName: this.lastName,
    phone: this.phone || ''
  };
};

module.exports = mongoose.model('User', userSchema);
