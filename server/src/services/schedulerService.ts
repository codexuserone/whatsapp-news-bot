import type { ScheduledTask } from 'node-cron';
const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('./feedProcessor');
const { sendQueuedForSchedule } = require('./queueService');
const { computeNextRunAt } = require('../utils/cron');
const { withScheduleLock, cleanupStaleLocks } = require('./scheduleLockService');
const logger = require('../utils/logger');

type WhatsAppClient = { getStatus?: () => { status: string } };

type ScheduleRow = {
  id: string;
  feed_id?: string | null;
  active?: boolean;
  cron_expression?: string | null;
  timezone?: string | null;
  delivery_mode?: string | null;
  batch_times?: string[] | null;
};

type RunScheduleOptions = {
  skipFeedRefresh?: boolean;
};

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

const runScheduleOnce = async (
  scheduleId: string,
  whatsappClient?: WhatsAppClient,
  options?: RunScheduleOptions
) => {
  // Check local in-flight first (fast path)
  if (scheduleInFlight.get(scheduleId)) {
    logger.info({ scheduleId }, 'Skipping schedule run - already in progress locally');
    return;
  }
  
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn({ scheduleId }, 'Supabase not available, skipping schedule run');
    return;
  }
  
  scheduleInFlight.set(scheduleId, true);
  
  try {
    // Use distributed lock to prevent multiple instances from running the same schedule
    const lockResult = await withScheduleLock(
      supabase,
      scheduleId,
      async () => {
        logger.info({ scheduleId }, 'Acquired distributed lock, running schedule');
        return await sendQueuedForSchedule(scheduleId, whatsappClient, {
          skipFeedRefresh: Boolean(options?.skipFeedRefresh)
        });
      },
      { timeoutMs: 300000, skipIfLocked: true } // 5 minute lock timeout
    );
    
    if (lockResult.skipped) {
      logger.info({ scheduleId, reason: lockResult.reason }, 'Skipping schedule run - distributed lock held');
    } else if (lockResult.result) {
      logger.info({ scheduleId, result: lockResult.result }, 'Schedule completed');
    }
  } catch (error) {
    logger.error({ scheduleId, error }, 'Error running schedule');
  } finally {
    scheduleInFlight.set(scheduleId, false);
  }
};

const getDeliveryMode = (schedule: { delivery_mode?: string | null }) =>
  schedule?.delivery_mode === 'batch' || schedule?.delivery_mode === 'batched' ? 'batched' : 'immediate';

const parseBatchTimes = (value: unknown): string[] => {
  const seen = new Set<string>();
  const times = Array.isArray(value) ? value : [];
  for (const item of times) {
    const normalized = String(item || '').trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) continue;
    seen.add(normalized);
  }
  return Array.from(seen).sort();
};

const normalizeCronExpression = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, ' ');
  return normalized || null;
};

const toDailyCronExpression = (time: string) => {
  const [hour, minute] = time.split(':').map((part) => Number(part));
  return `${minute} ${hour} * * *`;
};

const computeNextBatchRunAt = (times: string[], timezone?: string | null) => {
  let nextValue: string | null = null;
  for (const time of times) {
    const expression = toDailyCronExpression(time);
    const candidate = computeNextRunAt(expression, timezone || 'UTC');
    if (!candidate) continue;
    if (!nextValue || new Date(candidate).getTime() < new Date(nextValue).getTime()) {
      nextValue = candidate;
    }
  }
  return nextValue;
};

const queueBatchSchedulesForFeed = async (feedId: string) => {
  if (schedulersDisabled()) return;

  const supabase = getSupabaseClient();
  if (!supabase) return;

  const disconnectedClient: WhatsAppClient = {
    getStatus: () => ({ status: 'disconnected' })
  };

  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('active', true)
      .eq('feed_id', feedId);

    if (error) throw error;

    const batchSchedules = (schedules || []).filter(
      (schedule: ScheduleRow) => getDeliveryMode(schedule) === 'batched'
    );

    if (!batchSchedules.length) return;

    logger.info({ feedId, count: batchSchedules.length }, 'Queueing batch schedules after feed refresh');
    for (const schedule of batchSchedules) {
      await runScheduleOnce(schedule.id, disconnectedClient, { skipFeedRefresh: true });
    }
  } catch (error) {
    logger.error({ error, feedId }, 'Failed to queue batch schedules');
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
      (schedule: ScheduleRow) => getDeliveryMode(schedule) !== 'batched'
    );
    logger.info({ feedId, count: immediateSchedules.length }, 'Triggering immediate schedules');
    
    for (const schedule of immediateSchedules) {
      await runScheduleOnce(schedule.id, whatsappClient, { skipFeedRefresh: true });
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
          if (result.items.length) {
            await queueBatchSchedulesForFeed(feed.id);
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
      const mode = getDeliveryMode(schedule);
      const timezone = schedule.timezone || 'UTC';

      if (mode === 'batched') {
        const batchTimes = parseBatchTimes(schedule.batch_times);
        if (!batchTimes.length) {
          logger.warn({ scheduleId: schedule.id }, 'Batch schedule has no valid batch_times');
          continue;
        }

        for (const time of batchTimes) {
          try {
            const expression = toDailyCronExpression(time);
            const job = cron.schedule(
              expression,
              () => runScheduleOnce(schedule.id, whatsappClient),
              { timezone }
            );
            scheduleJobs.set(`${schedule.id}:batch:${time}`, job);
          } catch (cronError) {
            logger.error({ error: cronError, scheduleId: schedule.id, time }, 'Invalid batch dispatch time');
          }
        }

        const nextBatchRunAt = computeNextBatchRunAt(batchTimes, timezone);
        if (nextBatchRunAt) {
          await supabase.from('schedules').update({ next_run_at: nextBatchRunAt }).eq('id', schedule.id);
        }
        continue;
      }

      const cronExpression = normalizeCronExpression(schedule.cron_expression);
      if (cronExpression) {
        if (!cron.validate(cronExpression)) {
          logger.warn({ scheduleId: schedule.id, cronExpression }, 'Invalid cron expression; skipping schedule');
          await supabase.from('schedules').update({ next_run_at: null }).eq('id', schedule.id);
          continue;
        }
        try {
          const job = cron.schedule(
            cronExpression,
            () => runScheduleOnce(schedule.id, whatsappClient),
            { timezone }
          );
          scheduleJobs.set(`${schedule.id}:cron`, job);

          const nextRunAt = computeNextRunAt(cronExpression, timezone);
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
  
  // Cleanup stale locks on startup
  const supabase = getSupabaseClient();
  if (supabase) {
    const cleanedCount = await cleanupStaleLocks(supabase);
    if (cleanedCount > 0) {
      logger.info({ cleanedCount }, 'Cleaned up stale schedule locks');
    }
  }
  
  await scheduleFeedPolling(whatsappClient);
  await scheduleSenders(whatsappClient);
};

module.exports = {
  initSchedulers,
  clearAll,
  triggerImmediateSchedules,
  queueBatchSchedulesForFeed
};
