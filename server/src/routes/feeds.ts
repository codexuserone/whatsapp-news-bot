import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('../services/feedProcessor');
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

const feedsRoutes = () => {
  const router = express.Router();

  const runAsync = (label: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch((error) => {
        console.warn(`${label} failed:`, error);
      });
    });
  };

  const refreshSchedulers = (whatsappClient: unknown) =>
    runAsync('Scheduler refresh', () => initSchedulers(whatsappClient));

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
      const { data: feed, error } = await getDb()
        .from('feeds')
        .insert(req.body)
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
      const { data: feed, error } = await getDb()
        .from('feeds')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      refreshSchedulers(req.app.locals.whatsapp);
      res.json(feed);
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
      const { error: deactivateError } = await getDb()
        .from('feeds')
        .update({ active: false })
        .eq('id', feedId);

      if (deactivateError) throw deactivateError;

      // Refresh schedulers synchronously to minimize delete-vs-refresh races.
      await initSchedulers(req.app.locals.whatsapp);

      // Wait briefly for any in-flight feed refresh to finish.
      const idle = await waitForFeedIdle(feedId);
      if (!idle) {
        console.warn('Feed remained in-flight during delete timeout; proceeding with delete', { feedId });
      }

      const { error } = await getDb()
        .from('feeds')
        .delete()
        .eq('id', feedId);
      
      if (error) throw error;

      // Keep scheduler state in sync after deletion.
      await initSchedulers(req.app.locals.whatsapp);

      res.json({ ok: true, waitedForIdle: idle });
    } catch (error) {
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
      if (result.items.length) {
        await queueBatchSchedulesForFeed(feed.id);
        await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
      }
      res.json({
        ok: true,
        items: result.items,
        fetchedCount: result.fetchedCount,
        insertedCount: result.insertedCount,
        duplicateCount: result.duplicateCount,
        errorCount: result.errorCount,
        queuedCount: 0
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
      let totalDuplicates = 0;
      let totalErrors = 0;
      let totalQueued = 0;

      for (const feed of feeds || []) {
        const result = await fetchAndProcessFeed(feed);
        if (result.items.length) {
          await queueBatchSchedulesForFeed(feed.id);
          await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
        }

        totalFetched += result.fetchedCount;
        totalInserted += result.insertedCount;
        totalDuplicates += result.duplicateCount;
        totalErrors += result.errorCount;

        results.push({
          feedId: feed.id,
          name: feed.name,
          url: feed.url,
          fetchedCount: result.fetchedCount,
          insertedCount: result.insertedCount,
          duplicateCount: result.duplicateCount,
          errorCount: result.errorCount,
          queuedCount: 0
        });
      }

      res.json({
        ok: true,
        totals: {
          feeds: results.length,
          fetchedCount: totalFetched,
          insertedCount: totalInserted,
          duplicateCount: totalDuplicates,
          errorCount: totalErrors,
          queuedCount: totalQueued
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
