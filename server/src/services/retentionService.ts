const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const settingsService = require('./settingsService');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

let watchdogInFlight = false;

const resetStuckProcessingLogs = async (): Promise<number> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return 0;
  }

  try {
    const settings = await settingsService.getSettings();
    const processingTimeoutMinutes = Number(settings.processingTimeoutMinutes || 30);
    const timeoutMs = Math.max(processingTimeoutMinutes, 5) * 60 * 1000;
    const processingCutoff = new Date(Date.now() - timeoutMs);

    const { data, error } = await supabase
      .from('message_logs')
      .update({ status: 'pending', processing_started_at: null })
      .eq('status', 'processing')
      .lt('processing_started_at', processingCutoff.toISOString())
      .select('id');

    if (error) {
      logger.warn({ error: error.message }, 'Failed to reset stuck processing logs');
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      logger.info({ count }, 'Reset stuck processing logs');
    }
    return count;
  } catch (error) {
    logger.error({ error: getErrorMessage(error) }, 'Reset stuck processing logs failed');
    return 0;
  }
};

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
    await resetStuckProcessingLogs();

    await Promise.all([
      supabase.from('message_logs').delete().lt('created_at', retentionDate.toISOString()),
      supabase.from('feed_items').delete().lt('created_at', retentionDate.toISOString()),
      supabase.from('chat_messages').delete().lt('created_at', retentionDate.toISOString())
    ]);

    logger.info('Retention cleanup complete');
  } catch (error) {
    logger.error({ error: getErrorMessage(error) }, 'Retention cleanup failed');
  }
};

const scheduleRetentionCleanup = (): void => {
  cron.schedule('0 3 * * *', cleanup, { timezone: 'UTC' });
};

const scheduleProcessingWatchdog = (): void => {
  cron.schedule(
    '*/5 * * * *',
    async () => {
      if (watchdogInFlight) return;
      watchdogInFlight = true;
      try {
        await resetStuckProcessingLogs();
      } finally {
        watchdogInFlight = false;
      }
    },
    { timezone: 'UTC' }
  );
};

module.exports = {
  scheduleRetentionCleanup,
  scheduleProcessingWatchdog,
  resetStuckProcessingLogs,
  cleanup
};
export {};
