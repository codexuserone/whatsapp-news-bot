import type { ScheduledTask } from 'node-cron';
const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('./feedProcessor');
const { sendQueuedForSchedule, reconcileUpdatedFeedItems, sendPendingForAllSchedules } = require('./queueService');
const { computeNextRunAt } = require('../utils/cron');
const { withScheduleLock, cleanupStaleLocks } = require('./scheduleLockService');
const { isScheduleRunning } = require('./scheduleState');
const settingsService = require('./settingsService');
const logger = require('../utils/logger');

type WhatsAppClient = {
  getStatus?: () => {
    status: string;
    instanceId?: string;
    lease?: {
      supported?: boolean;
      held?: boolean;
      ownerId?: string | null;
      expiresAt?: string | null;
    };
  };
};

type ScheduleRow = {
  id: string;
  feed_id?: string | null;
  state?: string | null;
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
let pendingSendCatchupTimer: NodeJS.Timeout | null = null;
const feedInFlight = new Map<string, boolean>();
const scheduleInFlight = new Map<string, boolean>();

const schedulersDisabled = () => process.env.DISABLE_SCHEDULERS === 'true';

const canRunSchedulers = (whatsappClient?: WhatsAppClient) => {
  const status = whatsappClient?.getStatus?.();
  const lease = status?.lease;

  if (lease?.supported && lease.held === false) {
    logger.warn(
      {
        whatsappStatus: status?.status,
        instanceId: status?.instanceId,
        lease
      },
      'Skipping schedulers: WhatsApp lease not held (another instance is active)'
    );
    return false;
  }

  if (status?.status === 'conflict') {
    logger.warn(
      {
        whatsappStatus: status.status,
        instanceId: status?.instanceId,
        lease
      },
      'Skipping schedulers: WhatsApp is currently in conflict state'
    );
    return false;
  }

  return true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForFeedIdle = async (
  feedId: string,
  timeoutMs = 12000,
  pollIntervalMs = 200
): Promise<boolean> => {
  const startedAt = Date.now();
  while (feedInFlight.get(feedId)) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await sleep(pollIntervalMs);
  }
  return true;
};

const isAppPaused = async () => {
  try {
    const settings = await settingsService.getSettings();
    return settings?.app_paused === true;
  } catch {
    return false;
  }
};

const clearAll = () => {
  feedIntervals.forEach((interval) => clearTimeout(interval));
  feedIntervals.clear();
  scheduleJobs.forEach((job) => job.stop());
  scheduleJobs.clear();
  if (pendingSendCatchupTimer) {
    clearInterval(pendingSendCatchupTimer);
    pendingSendCatchupTimer = null;
  }
  feedInFlight.clear();
  scheduleInFlight.clear();
};

const runScheduleOnce = async (
  scheduleId: string,
  whatsappClient?: WhatsAppClient,
  options?: RunScheduleOptions
) => {
  if (await isAppPaused()) {
    logger.info({ scheduleId }, 'Skipping schedule run - app is paused');
    return;
  }

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
          skipFeedRefresh: Boolean(options?.skipFeedRefresh),
          allowOverdueBatchDispatch: true
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

const getLocalMinuteOfDay = (timezone?: string | null, date = new Date()) => {
  const tz = String(timezone || 'UTC').trim() || 'UTC';
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return Number.NaN;
  return hour * 60 + minute;
};

const normalizeBatchGraceMinutes = (value: number) => {
  if (!Number.isFinite(value)) return 8;
  return Math.min(Math.max(Math.floor(value), 1), 30);
};

const isBatchTimestampAligned = (
  timestampMs: number,
  times: string[],
  timezone?: string | null,
  graceMinutes = Math.max(Number(process.env.BATCH_WINDOW_GRACE_MINUTES || 8), 1)
) => {
  if (!Number.isFinite(timestampMs) || !times.length) return false;
  const minuteOfDay = getLocalMinuteOfDay(timezone, new Date(timestampMs));
  if (!Number.isFinite(minuteOfDay)) return false;
  const grace = normalizeBatchGraceMinutes(graceMinutes);
  return times.some((time) => {
    const [hourRaw, minuteRaw] = String(time).split(':');
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const targetMinute = hour * 60 + minute;
    const directDiff = Math.abs(minuteOfDay - targetMinute);
    const wrappedDiff = Math.min(directDiff, 1440 - directDiff);
    return wrappedDiff <= grace;
  });
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

const getOverdueBatchDispatchGraceMs = () => {
  const minutesRaw = Number(process.env.BATCH_OVERDUE_DISPATCH_GRACE_MINUTES || 20);
  const minutes = Number.isFinite(minutesRaw) ? Math.max(Math.floor(minutesRaw), 5) : 20;
  return Math.min(minutes, 180) * 60 * 1000;
};

const queueBatchSchedulesForFeed = async (feedId: string, whatsappClient?: WhatsAppClient) => {
  if (schedulersDisabled()) return;
  if (await isAppPaused()) return;

  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('feed_id', feedId);

    if (error) throw error;

    const batchSchedules = (schedules || []).filter((schedule: ScheduleRow) => {
      return isScheduleRunning(schedule) && getDeliveryMode(schedule) === 'batched';
    });

    if (!batchSchedules.length) return;

    logger.info({ feedId, count: batchSchedules.length }, 'Queueing batch schedules after feed refresh');
    for (const schedule of batchSchedules) {
      await runScheduleOnce(schedule.id, whatsappClient, { skipFeedRefresh: true });
    }
  } catch (error) {
    logger.error({ error, feedId }, 'Failed to queue batch schedules');
  }
};

const triggerImmediateSchedules = async (feedId: string, whatsappClient?: WhatsAppClient) => {
  if (schedulersDisabled()) {
    return;
  }
  if (await isAppPaused()) {
    logger.info({ feedId }, 'Skipping immediate schedules - app is paused');
    return;
  }
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const status = whatsappClient?.getStatus?.();
  const dispatchClient: WhatsAppClient =
    status?.status === 'connected'
      ? (whatsappClient as WhatsAppClient)
      : {
          getStatus: () => ({ status: 'disconnected' })
        };

  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('feed_id', feedId);

    if (error) throw error;

    const immediateSchedules = (schedules || []).filter((schedule: ScheduleRow) => {
      return isScheduleRunning(schedule) && getDeliveryMode(schedule) !== 'batched' && !schedule.cron_expression;
    });
    logger.info(
      {
        feedId,
        count: immediateSchedules.length,
        dispatchMode: status?.status === 'connected' ? 'queue-and-send' : 'queue-only',
        whatsappStatus: status?.status || 'unknown'
      },
      'Triggering immediate schedules'
    );

    for (const schedule of immediateSchedules) {
      await runScheduleOnce(schedule.id, dispatchClient, { skipFeedRefresh: true });
    }
  } catch (error) {
    logger.error({ error, feedId }, 'Failed to trigger immediate schedules');
  }
};

const scheduleFeedPolling = async (whatsappClient?: WhatsAppClient) => {
  if (await isAppPaused()) {
    logger.info('Skipping feed polling setup - app is paused');
    return;
  }

  if (!canRunSchedulers(whatsappClient)) {
    return;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn('Supabase not available, skipping feed polling');
    return;
  }

  try {
    const { data: scheduleRows, error: schedulesError } = await supabase
      .from('schedules')
      .select('feed_id,active,state')
      .not('feed_id', 'is', null);

    if (schedulesError) throw schedulesError;

    const activeFeedIds = new Set(
      (scheduleRows || [])
        .filter((schedule: { state?: string | null; active?: boolean | null }) => isScheduleRunning(schedule))
        .map((schedule: { feed_id?: string | null }) => schedule.feed_id)
        .filter(Boolean) as string[]
    );

    const { data: feeds, error } = await supabase
      .from('feeds')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    const feedsInUse = (feeds || []).filter((feed: { id?: string }) => {
      const id = String(feed.id || '');
      return Boolean(id && activeFeedIds.has(id));
    });

    if (!feedsInUse.length) {
      logger.info('No active feeds linked to active automations; skipping feed polling setup');
      return;
    }

    for (const feed of feedsInUse) {
      const intervalMs = Math.max(feed.fetch_interval || 300, 60) * 1000;

      const scheduleNext = (delayMs: number) => {
        const timeout = setTimeout(() => {
          void handler();
        }, Math.max(delayMs, 1000));
        feedIntervals.set(feed.id, timeout as unknown as NodeJS.Timeout);
      };

      const handler = async () => {
        if (await isAppPaused()) {
          logger.info({ feedId: feed.id }, 'Skipping feed refresh - app is paused');
          scheduleNext(intervalMs);
          return;
        }

        if (feedInFlight.get(feed.id)) {
          logger.info({ feedId: feed.id }, 'Skipping feed refresh - already in progress');
          scheduleNext(intervalMs);
          return;
        }

        feedInFlight.set(feed.id, true);
        let ok = true;
        try {
          const result = await fetchAndProcessFeed(feed);
          if (Array.isArray(result.updatedItems) && result.updatedItems.length) {
            const reconcile = await reconcileUpdatedFeedItems(result.updatedItems, whatsappClient);
            logger.info(
              { feedId: feed.id, reconcile },
              'Applied post-send reconciliation after feed polling update pass'
            );
          }
          if (result.items.length) {
            await queueBatchSchedulesForFeed(feed.id, whatsappClient);
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
  if (await isAppPaused()) {
    logger.info('Skipping schedule sender setup - app is paused');
    return;
  }

  if (!canRunSchedulers(whatsappClient)) {
    return;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn('Supabase not available, skipping scheduled senders');
    return;
  }

  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*');

    if (error) throw error;

    const runningSchedules = (schedules || []).filter((schedule: ScheduleRow) => isScheduleRunning(schedule));

    for (const schedule of runningSchedules) {
      const mode = getDeliveryMode(schedule);
      const timezone = String(schedule.timezone || 'UTC').trim() || 'UTC';

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

        const persistedNextRunAt = String(schedule.next_run_at || '').trim();
        const persistedNextRunMs = Date.parse(persistedNextRunAt);
        const overdueDispatchGraceMs = getOverdueBatchDispatchGraceMs();
        const batchWindowGraceMinutes = Math.max(Number(process.env.BATCH_WINDOW_GRACE_MINUTES || 8), 1);
        const overdueAgeMs = Number.isFinite(persistedNextRunMs) ? Date.now() - persistedNextRunMs : Number.NaN;
        const hasOverdueNextRun =
          Number.isFinite(overdueAgeMs) && overdueAgeMs >= 0;
        const overdueAligned =
          Number.isFinite(persistedNextRunMs) &&
          isBatchTimestampAligned(persistedNextRunMs, batchTimes, timezone, batchWindowGraceMinutes);
        const keepOverdueCursor =
          hasOverdueNextRun && overdueAgeMs <= overdueDispatchGraceMs && overdueAligned;

        if (keepOverdueCursor) {
          logger.info(
            { scheduleId: schedule.id, nextRunAt: persistedNextRunAt },
            'Keeping overdue batch next_run_at to allow catch-up dispatch'
          );
        } else {
          const nextBatchRunAt = computeNextBatchRunAt(batchTimes, timezone);
          if (nextBatchRunAt) {
            await supabase.from('schedules').update({ next_run_at: nextBatchRunAt }).eq('id', schedule.id);
            if (hasOverdueNextRun || !overdueAligned) {
              logger.info(
                {
                  scheduleId: schedule.id,
                  staleNextRunAt: persistedNextRunAt,
                  realignedNextRunAt: nextBatchRunAt,
                  overdueAgeMs,
                  overdueDispatchGraceMs,
                  overdueAligned
                },
                'Realigned stale overdue batch next_run_at'
              );
            }
          }
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

const startPendingSendCatchup = (whatsappClient?: WhatsAppClient) => {
  if (pendingSendCatchupTimer) {
    clearInterval(pendingSendCatchupTimer);
    pendingSendCatchupTimer = null;
  }

  const intervalMs = Math.max(Number(process.env.PENDING_SEND_CATCHUP_MS || 60000), 15000);
  const runCatchupPass = async () => {
    try {
      if (await isAppPaused()) return;
      if (!canRunSchedulers(whatsappClient)) return;
      await sendPendingForAllSchedules(whatsappClient);
    } catch (error) {
      logger.error({ error }, 'Failed pending-send catch-up pass');
    }
  };

  // Do one catch-up pass immediately on startup/reconnect, then continue on interval.
  void runCatchupPass();
  pendingSendCatchupTimer = setInterval(() => {
    void runCatchupPass();
  }, intervalMs);
};

const initSchedulers = async (whatsappClient?: WhatsAppClient) => {
  clearAll();
  if (schedulersDisabled()) {
    logger.warn('Schedulers are disabled via DISABLE_SCHEDULERS');
    return;
  }

  if (await isAppPaused()) {
    logger.warn('Schedulers are paused via app_paused setting');
    return;
  }

  if (!canRunSchedulers(whatsappClient)) {
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
  startPendingSendCatchup(whatsappClient);
};

module.exports = {
  initSchedulers,
  clearAll,
  triggerImmediateSchedules,
  queueBatchSchedulesForFeed,
  waitForFeedIdle
};
