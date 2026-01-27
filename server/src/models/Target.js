const mongoose = require('mongoose');

const targetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ['group', 'channel', 'status'], required: true },
    jid: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    intraDelaySec: { type: Number, default: 3 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Target', targetSchema);
