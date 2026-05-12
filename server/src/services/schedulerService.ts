import type { ScheduledTask } from 'node-cron';
const cron = require('node-cron');
const { getSupabaseClient, getSupabaseHealthState, isSupabaseCircuitOpen } = require('../db/supabase');
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
  maxQueueLookbackHours?: number;
};

const feedIntervals = new Map<string, NodeJS.Timeout>();
const scheduleJobs = new Map<string, ScheduledTask>();
let pendingSendCatchupTimer: NodeJS.Timeout | null = null;
let recentFeedCorrectionTimer: NodeJS.Timeout | null = null;
let immediateScheduleCatchupTimer: NodeJS.Timeout | null = null;
let pendingSendCatchupInFlight = false;
let recentFeedCorrectionInFlight = false;
let immediateScheduleCatchupInFlight = false;
const feedInFlight = new Map<string, boolean>();
const scheduleInFlight = new Map<string, boolean>();
const SUCCESSFUL_SEND_STATUSES = ['sent', 'delivered', 'read', 'played'];
const DEFAULT_CORRECTION_WINDOW_MINUTES = 15;
const MAX_CORRECTION_WINDOW_MINUTES = 15;
let lastDatabaseOutageLogAt = 0;

const schedulersDisabled = () => process.env.DISABLE_SCHEDULERS === 'true';

const shouldSkipForDatabaseOutage = (context: string) => {
  if (!isSupabaseCircuitOpen?.()) {
    return false;
  }

  const current = Date.now();
  if (current - lastDatabaseOutageLogAt > 60_000) {
    lastDatabaseOutageLogAt = current;
    logger.warn(
      {
        context,
        supabase: getSupabaseHealthState?.()
      },
      'Skipping background automation while Supabase is temporarily unavailable'
    );
  }

  return true;
};

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

const normalizeImmediateCatchupLookbackHours = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(parsed, 0.25), 24);
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

const parseCorrectionWindowMinutes = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CORRECTION_WINDOW_MINUTES;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_CORRECTION_WINDOW_MINUTES);
};

const listRecentlyCorrectableFeedIds = async (supabase: ReturnType<typeof getSupabaseClient>) => {
  const settings = await settingsService.getSettings();
  const correctionWindowMinutes = parseCorrectionWindowMinutes(settings?.post_send_correction_window_minutes);
  const cutoffIso = new Date(Date.now() - correctionWindowMinutes * 60 * 1000).toISOString();

  const { data: logRows, error: logsError } = await supabase
    .from('message_logs')
    .select('feed_item_id')
    .in('status', SUCCESSFUL_SEND_STATUSES)
    .gte('sent_at', cutoffIso)
    .not('feed_item_id', 'is', null)
    .limit(500);

  if (logsError) {
    throw logsError;
  }

  const feedItemIds = Array.from(
    new Set(
      (logRows || [])
        .map((row: { feed_item_id?: string | null }) => String(row?.feed_item_id || '').trim())
        .filter(Boolean)
    )
  );

  if (!feedItemIds.length) {
    return [];
  }

  const { data: feedItems, error: feedItemsError } = await supabase
    .from('feed_items')
    .select('id,feed_id')
    .in('id', feedItemIds);

  if (feedItemsError) {
    throw feedItemsError;
  }

  return Array.from(
    new Set(
      (feedItems || [])
        .map((row: { feed_id?: string | null }) => String(row?.feed_id || '').trim())
        .filter(Boolean)
    )
  );
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
  if (recentFeedCorrectionTimer) {
    clearInterval(recentFeedCorrectionTimer);
    recentFeedCorrectionTimer = null;
  }
  if (immediateScheduleCatchupTimer) {
    clearInterval(immediateScheduleCatchupTimer);
    immediateScheduleCatchupTimer = null;
  }
  pendingSendCatchupInFlight = false;
  recentFeedCorrectionInFlight = false;
  immediateScheduleCatchupInFlight = false;
  feedInFlight.clear();
  scheduleInFlight.clear();
};

const runScheduleOnce = async (
  scheduleId: string,
  whatsappClient?: WhatsAppClient,
  options?: RunScheduleOptions
) => {
  if (shouldSkipForDatabaseOutage('schedule run')) return;

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
          allowOverdueBatchDispatch: true,
          maxQueueLookbackHours: options?.maxQueueLookbackHours
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
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return Number.NaN;
  }
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

const toMinuteOfDay = (time: string): number | null => {
  const [hourRaw, minuteRaw] = String(time).split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
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
  if (shouldSkipForDatabaseOutage('batch schedule queue')) return;
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
  if (shouldSkipForDatabaseOutage('immediate schedule trigger')) {
    return;
  }
  if (await isAppPaused()) {
    logger.info({ feedId }, 'Skipping immediate schedules - app is paused');
    return;
  }
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const status = whatsappClient?.getStatus?.();
  const dispatchClient: WhatsAppClient | undefined = status?.status === 'connected' ? (whatsappClient as WhatsAppClient) : undefined;

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
      await runScheduleOnce(schedule.id, dispatchClient, {
        skipFeedRefresh: true
      });
    }
  } catch (error) {
    logger.error({ error, feedId }, 'Failed to trigger immediate schedules');
  }
};

const scheduleFeedPolling = async (whatsappClient?: WhatsAppClient) => {
  if (shouldSkipForDatabaseOutage('feed polling setup')) {
    return;
  }

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

const processFeedResultForSchedules = async (
  feedId: string,
  result: { items?: unknown[]; updatedItems?: unknown[] },
  whatsappClient?: WhatsAppClient,
  source = 'feed polling'
) => {
  if (Array.isArray(result.updatedItems) && result.updatedItems.length) {
    const reconcile = await reconcileUpdatedFeedItems(result.updatedItems, whatsappClient);
    logger.info(
      { feedId, reconcile, source },
      'Applied post-send reconciliation after feed refresh'
    );
  }

  if (Array.isArray(result.items) && result.items.length) {
    logger.info(
      { feedId, count: result.items.length, source },
      'Queueing schedules after feed refresh discovered new items'
    );
    await queueBatchSchedulesForFeed(feedId, whatsappClient);
    await triggerImmediateSchedules(feedId, whatsappClient);
  }
};

const runRecentFeedCorrectionPass = async (whatsappClient?: WhatsAppClient) => {
  if (recentFeedCorrectionInFlight) {
    logger.info('Skipping recent-feed correction watcher pass - previous pass still running');
    return;
  }

  recentFeedCorrectionInFlight = true;
  try {
    if (shouldSkipForDatabaseOutage('recent feed correction')) return;
    if (await isAppPaused()) return;
    if (!canRunSchedulers(whatsappClient)) return;
    const supabase = getSupabaseClient();
    if (!supabase) return;

    const feedIds = await listRecentlyCorrectableFeedIds(supabase);
    if (!feedIds.length) return;

    const { data: feeds, error } = await supabase
      .from('feeds')
      .select('*')
      .in('id', feedIds)
      .eq('active', true);

    if (error) throw error;

    for (const feed of feeds || []) {
      if (!feed?.id) continue;
      if (feedInFlight.get(feed.id)) {
        continue;
      }

      feedInFlight.set(feed.id, true);
      try {
        const result = await fetchAndProcessFeed(feed);
        await processFeedResultForSchedules(feed.id, result, whatsappClient, 'recent-send correction watcher');
      } catch (error) {
        logger.error({ error, feedId: feed.id }, 'Failed recent-send correction watcher pass');
      } finally {
        feedInFlight.set(feed.id, false);
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed recent-feed correction watcher');
  } finally {
    recentFeedCorrectionInFlight = false;
  }
};

const startRecentFeedCorrectionWatcher = (whatsappClient?: WhatsAppClient) => {
  if (recentFeedCorrectionTimer) {
    clearInterval(recentFeedCorrectionTimer);
    recentFeedCorrectionTimer = null;
  }

  const intervalMs = Math.max(Number(process.env.FEED_CORRECTION_POLL_MS || 120000), 60000);
  void runRecentFeedCorrectionPass(whatsappClient);
  recentFeedCorrectionTimer = setInterval(() => {
    void runRecentFeedCorrectionPass(whatsappClient);
  }, intervalMs);
};

const scheduleSenders = async (whatsappClient?: WhatsAppClient) => {
  if (shouldSkipForDatabaseOutage('schedule sender setup')) {
    return;
  }

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
        const batchMinuteSet = new Set<number>();
        for (const time of batchTimes) {
          const minute = toMinuteOfDay(time);
          if (minute == null) continue;
          batchMinuteSet.add(minute);
        }
        if (!batchMinuteSet.size) {
          logger.warn({ scheduleId: schedule.id, batchTimes }, 'Batch schedule has no parsable minute marks');
          continue;
        }

        try {
          // Run every minute and evaluate the batch window using Intl timezone conversion.
          // This avoids node-cron timezone drift/compatibility issues in container runtimes.
          const job = cron.schedule(
            '* * * * *',
            () => {
              const minuteOfDay = getLocalMinuteOfDay(timezone);
              if (!Number.isFinite(minuteOfDay) || !batchMinuteSet.has(minuteOfDay)) return;
              void runScheduleOnce(schedule.id, whatsappClient);
            },
            { timezone: 'UTC' }
          );
          scheduleJobs.set(`${schedule.id}:batch:tick`, job);
        } catch (cronError) {
          logger.error({ error: cronError, scheduleId: schedule.id }, 'Invalid batch dispatch schedule');
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

  const intervalMs = Math.max(Number(process.env.PENDING_SEND_CATCHUP_MS || 120000), 30000);
  const runCatchupPass = async () => {
    if (pendingSendCatchupInFlight) {
      logger.info('Skipping pending-send catch-up pass - previous pass still running');
      return;
    }

    pendingSendCatchupInFlight = true;
    try {
      if (shouldSkipForDatabaseOutage('pending send catch-up')) return;
      if (await isAppPaused()) return;
      if (!canRunSchedulers(whatsappClient)) return;
      await sendPendingForAllSchedules(whatsappClient);
    } catch (error) {
      logger.error({ error }, 'Failed pending-send catch-up pass');
    } finally {
      pendingSendCatchupInFlight = false;
    }
  };

  // Do one catch-up pass immediately on startup/reconnect, then continue on interval.
  void runCatchupPass();
  pendingSendCatchupTimer = setInterval(() => {
    void runCatchupPass();
  }, intervalMs);
};

const runImmediateScheduleCatchupPass = async (whatsappClient?: WhatsAppClient) => {
  if (immediateScheduleCatchupInFlight) {
    logger.info('Skipping immediate feed catch-up pass - previous pass still running');
    return { schedules: 0, skipped: true, reason: 'in_flight' };
  }

  immediateScheduleCatchupInFlight = true;
  try {
    if (shouldSkipForDatabaseOutage('immediate schedule catch-up')) return { schedules: 0, skipped: true };
    if (await isAppPaused()) return { schedules: 0 };
    if (!canRunSchedulers(whatsappClient)) return { schedules: 0, skipped: true };

    const supabase = getSupabaseClient();
    if (!supabase) return { schedules: 0 };

    const status = whatsappClient?.getStatus?.();
    const dispatchClient: WhatsAppClient | undefined = status?.status === 'connected' ? whatsappClient : undefined;
    const maxQueueLookbackHours = normalizeImmediateCatchupLookbackHours(
      process.env.IMMEDIATE_FEED_CATCHUP_LOOKBACK_HOURS
    );

    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('id,feed_id,state,active,delivery_mode,cron_expression')
      .not('feed_id', 'is', null);

    if (error) throw error;

    const immediateSchedules = (schedules || []).filter((schedule: ScheduleRow) => {
      return isScheduleRunning(schedule) && getDeliveryMode(schedule) !== 'batched' && !schedule.cron_expression;
    });

    for (const schedule of immediateSchedules) {
      await runScheduleOnce(schedule.id, dispatchClient, {
        skipFeedRefresh: true,
        maxQueueLookbackHours
      });
    }

    if (immediateSchedules.length) {
      logger.info(
        {
          scheduleCount: immediateSchedules.length,
          maxQueueLookbackHours,
          dispatchMode: dispatchClient ? 'queue-and-send' : 'queue-only',
          whatsappStatus: status?.status || 'unknown'
        },
        'Processed immediate feed catch-up schedules'
      );
    }

    return { schedules: immediateSchedules.length };
  } finally {
    immediateScheduleCatchupInFlight = false;
  }
};

const startImmediateScheduleCatchup = (whatsappClient?: WhatsAppClient) => {
  if (immediateScheduleCatchupTimer) {
    clearInterval(immediateScheduleCatchupTimer);
    immediateScheduleCatchupTimer = null;
  }

  const intervalMs = Math.max(Number(process.env.IMMEDIATE_FEED_CATCHUP_MS || 120000), 60000);
  void runImmediateScheduleCatchupPass(whatsappClient).catch((error) => {
    logger.error({ error }, 'Failed immediate feed catch-up pass');
  });
  immediateScheduleCatchupTimer = setInterval(() => {
    void runImmediateScheduleCatchupPass(whatsappClient).catch((error) => {
      logger.error({ error }, 'Failed immediate feed catch-up pass');
    });
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

  const whatsappStatus = whatsappClient?.getStatus?.();
  if (whatsappClient && whatsappStatus?.status !== 'connected') {
    logger.warn(
      {
        whatsappStatus: whatsappStatus?.status || 'unknown',
        instanceId: whatsappStatus?.instanceId,
        lease: whatsappStatus?.lease
      },
      'Skipping scheduler initialization until WhatsApp is connected'
    );
    return;
  }

  if (!canRunSchedulers(whatsappClient)) {
    return;
  }

  if (shouldSkipForDatabaseOutage('scheduler initialization')) {
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
  startRecentFeedCorrectionWatcher(whatsappClient);
  await scheduleSenders(whatsappClient);
  startImmediateScheduleCatchup(whatsappClient);
  startPendingSendCatchup(whatsappClient);
};

module.exports = {
  initSchedulers,
  clearAll,
  triggerImmediateSchedules,
  queueBatchSchedulesForFeed,
  waitForFeedIdle,
  __testUtils: {
    parseCorrectionWindowMinutes,
    normalizeImmediateCatchupLookbackHours,
    processFeedResultForSchedules,
    runRecentFeedCorrectionPass,
    runImmediateScheduleCatchupPass
  }
};
