const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    jid: { type: String, required: true, index: true },
    messageId: { type: String, required: true, index: true },
    senderJid: { type: String },
    fromMe: { type: Boolean, default: false },
    text: { type: String },
    normalizedText: { type: String, index: true },
    url: { type: String },
    normalizedUrl: { type: String, index: true },
    timestamp: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
