import type { ScheduledTask } from 'node-cron';
const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('./feedProcessor');
const { sendQueuedForSchedule } = require('./queueService');
const { computeNextRunAt } = require('../utils/cron');
const logger = require('../utils/logger');

type WhatsAppClient = { getStatus?: () => { status: string } };

const feedIntervals = new Map<string, NodeJS.Timeout>();
const scheduleJobs = new Map<string, ScheduledTask>();
const feedInFlight = new Map<string, boolean>();
const scheduleInFlight = new Map<string, boolean>();

const schedulersDisabled = () => process.env.DISABLE_SCHEDULERS === 'true';

const clearAll = () => {
  feedIntervals.forEach((interval) => clearInterval(interval));
  feedIntervals.clear();
  scheduleJobs.forEach((job) => job.stop());
  scheduleJobs.clear();
  feedInFlight.clear();
  scheduleInFlight.clear();
};

const runScheduleOnce = async (scheduleId: string, whatsappClient?: WhatsAppClient) => {
  if (scheduleInFlight.get(scheduleId)) {
    logger.info({ scheduleId }, 'Skipping schedule run - already in progress');
    return;
  }
  scheduleInFlight.set(scheduleId, true);
  try {
    await sendQueuedForSchedule(scheduleId, whatsappClient);
  } finally {
    scheduleInFlight.set(scheduleId, false);
  }
};

const triggerImmediateSchedules = async (feedId: string, whatsappClient?: WhatsAppClient) => {
  if (schedulersDisabled()) {
    return;
  }
  const supabase = getSupabaseClient();
  if (!supabase) return;
  
  // Check WhatsApp connection before triggering
  const status = whatsappClient?.getStatus?.();
  if (!status || status.status !== 'connected') {
    logger.warn({ feedId, whatsappStatus: status?.status || 'unknown' }, 
      'Skipping immediate schedules - WhatsApp not connected');
    return;
  }
  
  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('active', true)
      .eq('feed_id', feedId);

    if (error) throw error;

    const immediateSchedules = (schedules || []).filter(
      (s: { cron_expression?: string | null }) => !s.cron_expression
    );
    logger.info({ feedId, count: immediateSchedules.length }, 'Triggering immediate schedules');
    
    for (const schedule of immediateSchedules) {
      await runScheduleOnce(schedule.id, whatsappClient);
    }
  } catch (error) {
    logger.error({ error, feedId }, 'Failed to trigger immediate schedules');
  }
};

const scheduleFeedPolling = async (whatsappClient?: WhatsAppClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn('Supabase not available, skipping feed polling');
    return;
  }
  
  try {
    const { data: feeds, error } = await supabase
      .from('feeds')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    for (const feed of feeds || []) {
      const intervalMs = Math.max(feed.fetch_interval || 300, 60) * 1000;

      const scheduleNext = (delayMs: number) => {
        const timeout = setTimeout(() => {
          void handler();
        }, Math.max(delayMs, 1000));
        feedIntervals.set(feed.id, timeout);
      };

      const handler = async () => {
        if (feedInFlight.get(feed.id)) {
          logger.info({ feedId: feed.id }, 'Skipping feed refresh - already in progress');
          scheduleNext(intervalMs);
          return;
        }

        feedInFlight.set(feed.id, true);
        let ok = true;
        try {
          const result = await fetchAndProcessFeed(feed);
          await queueFeedItemsForSchedules(feed.id, result.items);
          if (result.items.length) {
            await triggerImmediateSchedules(feed.id, whatsappClient);
          }
        } catch (error) {
          ok = false;
          logger.error({ error, feedId: feed.id }, 'Failed to fetch feed');
        } finally {
          feedInFlight.set(feed.id, false);
        }

        // If a feed fails, retry sooner (but never faster than 60s)
        const retryMs = Math.min(intervalMs, 60 * 1000);
        scheduleNext(ok ? intervalMs : retryMs);
      };

      await handler();
    }
  } catch (error) {
    logger.error({ error }, 'Failed to schedule feed polling');
  }
};

const scheduleSenders = async (whatsappClient?: WhatsAppClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn('Supabase not available, skipping scheduled senders');
    return;
  }
  
  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    for (const schedule of schedules || []) {
      if (schedule.cron_expression) {
        try {
          const job = cron.schedule(
            schedule.cron_expression,
            () => runScheduleOnce(schedule.id, whatsappClient),
            { timezone: schedule.timezone || 'UTC' }
          );
          scheduleJobs.set(schedule.id, job);

          const nextRunAt = computeNextRunAt(schedule.cron_expression, schedule.timezone);
          if (nextRunAt) {
            await supabase
              .from('schedules')
              .update({ next_run_at: nextRunAt })
              .eq('id', schedule.id);
          }
        } catch (cronError) {
          logger.error({ error: cronError, scheduleId: schedule.id }, 'Invalid cron expression');
        }
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed to schedule senders');
  }
};

const initSchedulers = async (whatsappClient?: WhatsAppClient) => {
  clearAll();
  if (schedulersDisabled()) {
    logger.warn('Schedulers are disabled via DISABLE_SCHEDULERS');
    return;
  }
  await scheduleFeedPolling(whatsappClient);
  await scheduleSenders(whatsappClient);
};

module.exports = {
  initSchedulers,
  clearAll,
  triggerImmediateSchedules
};
