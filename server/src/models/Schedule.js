const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    mode: { type: String, enum: ['immediate', 'interval', 'times'], required: true },
    intervalMinutes: { type: Number },
    times: { type: [String], default: [] },
    timezone: { type: String, default: 'UTC' },
    feedIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Feed' }],
    targetIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Target' }],
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Template' },
    enabled: { type: Boolean, default: true },
    lastRunAt: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Schedule', scheduleSchema);
