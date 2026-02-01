const cron = require('node-cron');
const { supabase } = require('../db/supabase');
const settingsService = require('./settingsService');
const logger = require('../utils/logger');

const cleanup = async () => {
  try {
    const settings = await settingsService.getSettings();
    const retentionDate = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000);
    const authRetentionDays = settings.authRetentionDays || 60;
    const authRetentionDate = new Date(Date.now() - authRetentionDays * 24 * 60 * 60 * 1000);

    await Promise.all([
      supabase.from('message_logs').delete().lt('created_at', retentionDate.toISOString()),
      supabase.from('feed_items').delete().lt('created_at', retentionDate.toISOString()),
      supabase.from('chat_messages').delete().lt('created_at', retentionDate.toISOString())
    ]);

    logger.info('Retention cleanup complete');
  } catch (error) {
    logger.error({ error }, 'Retention cleanup failed');
  }
};

const scheduleRetentionCleanup = () => {
  cron.schedule('0 3 * * *', cleanup, { timezone: 'UTC' });
};

module.exports = {
  scheduleRetentionCleanup,
  cleanup
};
