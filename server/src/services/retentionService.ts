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
    const retentionIso = retentionDate.toISOString();
    await resetStuckProcessingLogs();

    // Delete message logs first so we never orphan active logs from their feed items.
    await supabase.from('message_logs').delete().lt('created_at', retentionIso);

    // Chat history is only used for dedupe heuristics; safe to prune independently.
    await supabase.from('chat_messages').delete().lt('created_at', retentionIso);

    // Feed items are required to render queued messages. Only delete items that are:
    // - old (based on sent_at)
    // - marked sent
    // - not referenced by any remaining message logs
    const deleteOldFeedItemsSafely = async () => {
      const chunk = <T>(arr: T[], size: number) => {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
          out.push(arr.slice(i, i + size));
        }
        return out;
      };

      const { data: candidates, error: candidatesError } = await supabase
        .from('feed_items')
        .select('id')
        .eq('sent', true)
        .lt('sent_at', retentionIso)
        .limit(5000);

      if (candidatesError) {
        logger.warn({ error: candidatesError }, 'Failed to load feed item retention candidates');
        return;
      }

      const ids = (candidates || [])
        .map((row: { id?: string }) => row.id)
        .filter(Boolean) as string[];

      if (!ids.length) return;

      const deletable: string[] = [];
      const batches = chunk(ids, 500);
      for (const batch of batches) {
        const { data: refs, error: refsError } = await supabase
          .from('message_logs')
          .select('feed_item_id')
          .in('feed_item_id', batch);

        if (refsError) {
          logger.warn({ error: refsError }, 'Failed to check feed item references for retention');
          continue;
        }

        const referenced = new Set(
          (refs || [])
            .map((row: { feed_item_id?: string | null }) => row.feed_item_id)
            .filter(Boolean) as string[]
        );

        for (const id of batch) {
          if (!referenced.has(id)) {
            deletable.push(id);
          }
        }
      }

      if (!deletable.length) return;

      for (const batch of chunk(deletable, 500)) {
        const { error: deleteError } = await supabase.from('feed_items').delete().in('id', batch);
        if (deleteError) {
          logger.warn({ error: deleteError }, 'Failed to delete old feed items');
        }
      }
    };

    await deleteOldFeedItemsSafely();

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
