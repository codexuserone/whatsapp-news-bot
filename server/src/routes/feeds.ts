import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('../services/feedProcessor');
const { reconcileUpdatedFeedItems } = require('../services/queueService');
const {
  initSchedulers,
  triggerImmediateSchedules,
  queueBatchSchedulesForFeed,
  waitForFeedIdle
} = require('../services/schedulerService');
const { fetchFeedItemsWithMeta } = require('../services/feedFetcher');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { validate, schemas } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const FEED_PAUSED_ERROR = 'Feed paused';

const feedsRoutes = () => {
  const router = express.Router();

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const isRateLimitError = (error: unknown) => {
    const status = (error as { status?: unknown })?.status;
    if (typeof status === 'number' && status === 429) return true;
    const message = String((error as { message?: unknown })?.message || '').toLowerCase();
    return message.includes('too many requests') || message.includes('rate limit');
  };

  const withRateLimitRetry = async <T>(
    operation: () => Promise<T>,
    label: string,
    maxAttempts = 8
  ): Promise<T> => {
    let delayMs = 400;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await operation();
        const operationError = (result as { error?: unknown } | null | undefined)?.error;
        if (!operationError) {
          return result;
        }

        if (!isRateLimitError(operationError) || attempt >= maxAttempts) {
          throw operationError;
        }

        console.warn(`${label} hit rate-limit, retrying`, {
          attempt,
          delayMs,
          message: getErrorMessage(operationError)
        });
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 5000);
      } catch (error) {
        if (!isRateLimitError(error) || attempt >= maxAttempts) {
          throw error;
        }
        console.warn(`${label} hit rate-limit, retrying`, { attempt, delayMs, message: getErrorMessage(error) });
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    }
    throw new Error(`${label} failed after retries`);
  };

  const runAsync = (label: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch((error) => {
        console.warn(`${label} failed:`, error);
      });
    });
  };

  const refreshSchedulers = (whatsappClient: unknown) =>
    runAsync('Scheduler refresh', () => initSchedulers(whatsappClient));

  const pausePendingLogsForFeed = async (feedId: string) => {
    const supabase = getDb();
    const { data: schedules, error: schedulesError } = await supabase
      .from('schedules')
      .select('id')
      .eq('feed_id', feedId);

    if (schedulesError) throw schedulesError;

    const scheduleIds = (schedules || [])
      .map((row: { id?: string }) => String(row.id || ''))
      .filter(Boolean);

    if (!scheduleIds.length) return 0;

    const { data: pausedRows, error: pauseError } = await supabase
      .from('message_logs')
      .update({
        status: 'skipped',
        error_message: FEED_PAUSED_ERROR,
        processing_started_at: null
      })
      .in('schedule_id', scheduleIds)
      .in('status', ['pending', 'processing'])
      .select('id');

    if (pauseError) throw pauseError;
    return pausedRows?.length || 0;
  };

  // Helper to get supabase client
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  // Test a feed URL without saving - returns detected fields and sample item
  router.post('/test', async (req: Request, res: Response) => {
    try {
      const { url, type, parse_config, cleaning } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        await assertSafeOutboundUrl(String(url));
      } catch (error) {
        return res.status(400).json({ error: getErrorMessage(error, 'URL is not allowed') });
      }

      const testFeed = {
        url: String(url),
        ...(type ? { type } : {}),
        ...(parse_config ? { parseConfig: parse_config } : {}),
        ...(cleaning ? { cleaning } : {})
      };

      // Create a temporary feed object for testing (cleaning is optional, uses defaults)
      const { items, meta } = await fetchFeedItemsWithMeta(testFeed);

      if (!items || items.length === 0) {
        return res.status(404).json({ error: 'No items found in feed. Check the URL or feed type.' });
      }

      // Detect all fields from the first item
      const sampleItem = items[0] as Record<string, unknown>;
      const detectedFields = Object.keys(sampleItem).filter((key) => {
        const value = sampleItem[key];
        return value !== null && value !== undefined && value !== '' && !Array.isArray(value);
      });

      // Also check for nested/array fields
      Object.keys(sampleItem).forEach((key) => {
        const value = sampleItem[key];
        if (Array.isArray(value) && value.length > 0) {
          detectedFields.push(key);
        }
      });

      res.json({
        feedTitle: sampleItem.title ? `Feed from ${new URL(url).hostname}` : 'Unknown Feed',
        detectedType: meta?.detectedType || null,
        contentType: meta?.contentType || null,
        sourceUrl: meta?.sourceUrl || String(url),
        discoveredFromUrl: meta?.discoveredFromUrl || null,
        itemCount: items.length,
        detectedFields: [...new Set(detectedFields)],
        sampleItem
      });
    } catch (error) {
      console.error('Error testing feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error, 'Failed to fetch feed') });
    }
  });

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const { data: feeds, error } = await getDb()
        .from('feeds')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(feeds);
    } catch (error) {
      console.error('Error fetching feeds:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/', validate(schemas.feed), async (req: Request, res: Response) => {
    try {
      const payload = { ...req.body } as Record<string, unknown>;
      if (typeof payload.active !== 'boolean') {
        payload.active = true;
      }
      const { data: feed, error } = await getDb()
        .from('feeds')
        .insert(payload)
        .select()
        .single();
      
      if (error) throw error;
      refreshSchedulers(req.app.locals.whatsapp);
      res.json(feed);
    } catch (error) {
      console.error('Error creating feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.feed), async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const payload = { ...req.body } as Record<string, unknown>;
      if (typeof payload.active !== 'boolean') {
        const { data: currentFeed, error: currentFeedError } = await supabase
          .from('feeds')
          .select('id,active')
          .eq('id', req.params.id)
          .single();
        if (currentFeedError || !currentFeed) {
          throw currentFeedError || new Error('Feed not found');
        }
        payload.active = Boolean((currentFeed as { active?: boolean }).active);
      }

      const { data: feed, error } = await getDb()
        .from('feeds')
        .update(payload)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;

      let pausedQueueItems = 0;
      let pausedAutomations = 0;
      if (payload?.active === false) {
        pausedQueueItems = await pausePendingLogsForFeed(String(req.params.id));

        const { data: pausedSchedules, error: pauseScheduleError } = await supabase
          .from('schedules')
          .update({ state: 'paused', active: false, next_run_at: null })
          .eq('feed_id', req.params.id)
          .or('active.eq.true,state.eq.active')
          .select('id');

        if (pauseScheduleError) throw pauseScheduleError;
        pausedAutomations = pausedSchedules?.length || 0;
      }

      refreshSchedulers(req.app.locals.whatsapp);
      res.json({
        ...feed,
        paused_queue_items: pausedQueueItems,
        paused_automations: pausedAutomations
      });
    } catch (error) {
      console.error('Error updating feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const feedId = String(req.params.id || '').trim();
      if (!feedId) {
        return res.status(400).json({ error: 'Feed id is required' });
      }

      // Mark feed inactive first so scheduler refresh can stop polling it.
      const deactivateResponse = await withRateLimitRetry<{ error?: unknown }>(
        () =>
          getDb()
            .from('feeds')
            .update({ active: false })
            .eq('id', feedId),
        'Feed deactivate'
      );
      const deactivateError = deactivateResponse?.error;

      if (deactivateError) throw deactivateError;

      // Trigger a non-blocking scheduler refresh to avoid request timeouts
      // on large instances while still moving this feed out of active polling quickly.
      refreshSchedulers(req.app.locals.whatsapp);

      // Wait briefly for any in-flight feed refresh to finish.
      const idle = await waitForFeedIdle(feedId);
      if (!idle) {
        console.warn('Feed remained in-flight during delete timeout; proceeding with delete', { feedId });
      }

      const deleteResponse = await withRateLimitRetry<{ error?: unknown }>(
        () =>
          getDb()
            .from('feeds')
            .delete()
            .eq('id', feedId),
        'Feed delete'
      );
      const error = deleteResponse?.error;
      
      if (error) throw error;

      // Keep scheduler state in sync after deletion (non-blocking).
      refreshSchedulers(req.app.locals.whatsapp);

      res.json({ ok: true, waitedForIdle: idle });
    } catch (error) {
      if (isRateLimitError(error)) {
        try {
          const { data: feedRow } = await getDb()
            .from('feeds')
            .select('id,active')
            .eq('id', req.params.id)
            .single();
          const deactivated = Boolean(feedRow && (feedRow as { active?: boolean }).active === false);
          return res.json({
            ok: false,
            rateLimited: true,
            deactivated,
            message: deactivated
              ? 'Feed is paused, but full delete is rate-limited right now. Retry shortly to remove it completely.'
              : 'Delete is rate-limited right now. Retry in a few seconds.'
          });
        } catch {
          return res.json({
            ok: false,
            rateLimited: true,
            deactivated: false,
            message: 'Delete is rate-limited right now. Retry in a few seconds.'
          });
        }
      }
      console.error('Error deleting feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/refresh', async (req: Request, res: Response) => {
    try {
      const { data: feed, error } = await getDb()
        .from('feeds')
        .select('*')
        .eq('id', req.params.id)
        .single();
      
      if (error || !feed) {
        res.status(404).json({ error: 'Feed not found' });
        return;
      }
      
      const result = await fetchAndProcessFeed(feed);
      let reconcile: Record<string, unknown> | null = null;
      if (Array.isArray(result.updatedItems) && result.updatedItems.length) {
        reconcile = await reconcileUpdatedFeedItems(result.updatedItems, req.app.locals.whatsapp);
      }
      if (result.items.length) {
        await queueBatchSchedulesForFeed(feed.id, req.app.locals.whatsapp);
        await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
      }
      res.json({
        ok: true,
        items: result.items,
        updatedItems: result.updatedItems || [],
        fetchedCount: result.fetchedCount,
        insertedCount: result.insertedCount,
        updatedCount: result.updatedCount || 0,
        duplicateCount: result.duplicateCount,
        errorCount: result.errorCount,
        queuedCount: 0,
        reconcile
      });
    } catch (error) {
      console.error('Error refreshing feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/refresh-all', async (req: Request, res: Response) => {
    try {
      const { data: feeds, error } = await getDb()
        .from('feeds')
        .select('*')
        .eq('active', true);

      if (error) throw error;

      const results = [] as Array<Record<string, unknown>>;
      let totalFetched = 0;
      let totalInserted = 0;
      let totalUpdated = 0;
      let totalDuplicates = 0;
      let totalErrors = 0;
      let totalQueued = 0;
      let totalReconcileProcessed = 0;
      let totalReconcileEdited = 0;
      let totalReconcileReplaced = 0;
      let totalReconcileSkipped = 0;
      let totalReconcileFailed = 0;

      for (const feed of feeds || []) {
        const result = await fetchAndProcessFeed(feed);
        let reconcile: Record<string, unknown> | null = null;
        if (Array.isArray(result.updatedItems) && result.updatedItems.length) {
          reconcile = await reconcileUpdatedFeedItems(result.updatedItems, req.app.locals.whatsapp);
        }
        if (result.items.length) {
          await queueBatchSchedulesForFeed(feed.id, req.app.locals.whatsapp);
          await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
        }

        totalFetched += result.fetchedCount;
        totalInserted += result.insertedCount;
        totalUpdated += result.updatedCount || 0;
        totalDuplicates += result.duplicateCount;
        totalErrors += result.errorCount;
        totalReconcileProcessed += Number(reconcile?.processed || 0);
        totalReconcileEdited += Number(reconcile?.edited || 0);
        totalReconcileReplaced += Number(reconcile?.replaced || 0);
        totalReconcileSkipped += Number(reconcile?.skipped || 0);
        totalReconcileFailed += Number(reconcile?.failed || 0);

        results.push({
          feedId: feed.id,
          name: feed.name,
          url: feed.url,
          fetchedCount: result.fetchedCount,
          insertedCount: result.insertedCount,
          updatedCount: result.updatedCount || 0,
          duplicateCount: result.duplicateCount,
          errorCount: result.errorCount,
          queuedCount: 0,
          reconcile
        });
      }

      res.json({
        ok: true,
        totals: {
          feeds: results.length,
          fetchedCount: totalFetched,
          insertedCount: totalInserted,
          updatedCount: totalUpdated,
          duplicateCount: totalDuplicates,
          errorCount: totalErrors,
          queuedCount: totalQueued,
          reconcile: {
            processed: totalReconcileProcessed,
            edited: totalReconcileEdited,
            replaced: totalReconcileReplaced,
            skipped: totalReconcileSkipped,
            failed: totalReconcileFailed
          }
        },
        feeds: results
      });
    } catch (error) {
      console.error('Error refreshing all feeds:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = feedsRoutes;
