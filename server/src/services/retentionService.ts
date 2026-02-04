const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const settingsService = require('./settingsService');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

const cleanup = async (): Promise<void> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn('Supabase not available, skipping retention cleanup');
    return;
  }
  
  try {
    const settings = await settingsService.getSettings();
    const retentionDays = Number(settings.log_retention_days ?? settings.retentionDays ?? 14);
    const retentionDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const processingTimeoutMinutes = Number(settings.processingTimeoutMinutes || 30);
    const processingCutoff = new Date(Date.now() - processingTimeoutMinutes * 60 * 1000);

    await Promise.all([
      supabase.from('message_logs').delete().lt('created_at', retentionDate.toISOString()),
      supabase.from('feed_items').delete().lt('created_at', retentionDate.toISOString()),
      supabase.from('chat_messages').delete().lt('created_at', retentionDate.toISOString()),
      supabase
        .from('message_logs')
        .update({ status: 'pending', processing_started_at: null, error_message: 'Reset stuck processing log' })
        .eq('status', 'processing')
        .lt('processing_started_at', processingCutoff.toISOString())
    ]);

    logger.info('Retention cleanup complete');
  } catch (error) {
    logger.error({ error: getErrorMessage(error) }, 'Retention cleanup failed');
  }
};

const scheduleRetentionCleanup = (): void => {
  cron.schedule('0 3 * * *', cleanup, { timezone: 'UTC' });
};

module.exports = {
  scheduleRetentionCleanup,
  cleanup
};
export {};
