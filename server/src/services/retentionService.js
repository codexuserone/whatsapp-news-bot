const cron = require('node-cron');
const MessageLog = require('../models/MessageLog');
const FeedItem = require('../models/FeedItem');
const ChatMessage = require('../models/ChatMessage');
const AuthState = require('../models/AuthState');
const settingsService = require('./settingsService');
const logger = require('../utils/logger');

const cleanup = async () => {
  const settings = await settingsService.getSettings();
  const retentionDate = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000);
  const authRetentionDays = settings.authRetentionDays || 60;
  const authRetentionDate = new Date(Date.now() - authRetentionDays * 24 * 60 * 60 * 1000);

  await Promise.all([
    MessageLog.deleteMany({ createdAt: { $lt: retentionDate } }),
    FeedItem.deleteMany({ createdAt: { $lt: retentionDate } }),
    ChatMessage.deleteMany({ createdAt: { $lt: retentionDate } }),
    AuthState.deleteMany({ updatedAt: { $lt: authRetentionDate } })
  ]);

  logger.info('Retention cleanup complete');
};

const scheduleRetentionCleanup = () => {
  cron.schedule('0 3 * * *', cleanup, { timezone: 'UTC' });
};

module.exports = {
  scheduleRetentionCleanup,
  cleanup
};
