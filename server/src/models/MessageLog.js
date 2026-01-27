const mongoose = require('mongoose');

const messageLogSchema = new mongoose.Schema(
  {
    feedItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedItem' },
    targetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Target' },
    scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Schedule' },
    status: { type: String, enum: ['queued', 'sent', 'skipped', 'failed'], required: true },
    error: { type: String },
    sentAt: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageLog', messageLogSchema);
