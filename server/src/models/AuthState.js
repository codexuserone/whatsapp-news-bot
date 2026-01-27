const mongoose = require('mongoose');

const authStateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    creds: { type: Object, required: true },
    keys: { type: Object, default: {} },
    updatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AuthState', authStateSchema);
