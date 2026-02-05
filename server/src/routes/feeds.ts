import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('../services/feedProcessor');
const { initSchedulers, triggerImmediateSchedules } = require('../services/schedulerService');
const { fetchFeedItemsWithMeta } = require('../services/feedFetcher');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { validate, schemas } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const feedsRoutes = () => {
  const router = express.Router();

  const normalizeCleaningWithParseConfig = (
    existingCleaning: unknown,
    incomingCleaning: unknown,
    parseConfig: unknown
  ): Record<string, unknown> | undefined => {
    const shouldWrite =
      (incomingCleaning !== null && incomingCleaning !== undefined) ||
      (parseConfig !== null && parseConfig !== undefined);
    if (!shouldWrite) return undefined;

    const base =
      existingCleaning && typeof existingCleaning === 'object'
        ? { ...(existingCleaning as Record<string, unknown>) }
        : {};

    if (incomingCleaning && typeof incomingCleaning === 'object') {
      Object.assign(base, incomingCleaning as Record<string, unknown>);
    }
    if (parseConfig !== null && parseConfig !== undefined) {
      base.parse_config = parseConfig;
    }
    return Object.keys(base).length ? base : undefined;
  };

  const projectFeedForResponse = (feed: Record<string, unknown>) => {
    if (!feed || typeof feed !== 'object') return feed;
    if (feed.parse_config !== null && feed.parse_config !== undefined) return feed;
    const cleaning = feed.cleaning;
    if (!cleaning || typeof cleaning !== 'object') return feed;
    const fallback = (cleaning as Record<string, unknown>).parse_config;
    if (fallback === null || fallback === undefined) return feed;
    return {
      ...feed,
      parse_config: fallback
    };
  };

  const isMissingParseConfigColumnError = (error: unknown) => {
    const msg = String((error as { message?: unknown })?.message || error || '');
    const msgLower = msg.toLowerCase();
    return (
      msgLower.includes('parse_config') &&
      (msgLower.includes('does not exist') ||
        msgLower.includes('schema cache') ||
        msgLower.includes('could not find') ||
        msgLower.includes('unknown field'))
    );
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

  // Helper to get supabase client
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  // Test a feed URL without saving - returns detected fields and sample item
  router.post('/test', async (req: Request, res: Response) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        await assertSafeOutboundUrl(String(url));
      } catch (error) {
        return res.status(400).json({ error: getErrorMessage(error, 'URL is not allowed') });
      }

      // Create a temporary feed object for testing (cleaning is optional, uses defaults)
      const { items, meta } = await fetchFeedItemsWithMeta({ url });

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
      const projected = (feeds || []).map((feed: Record<string, unknown>) => projectFeedForResponse(feed));
      res.json(projected);
    } catch (error) {
      console.error('Error fetching feeds:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/', validate(schemas.feed), async (req: Request, res: Response) => {
    try {
      const incomingBody = req.body as Record<string, unknown>;
      const incomingParseConfig = incomingBody.parse_config;
      const incomingCleaning = incomingBody.cleaning;

      let { data: feed, error } = await getDb()
        .from('feeds')
        .insert(req.body)
        .select()
        .single();

      if (error && isMissingParseConfigColumnError(error)) {
        const { parse_config: parseConfig, cleaning, ...rest } = incomingBody;
        const fallbackBody = {
          ...rest,
          cleaning: normalizeCleaningWithParseConfig(undefined, cleaning, parseConfig)
        };

        const retry = await getDb().from('feeds').insert(fallbackBody).select().single();
        feed = retry.data;
        error = retry.error;
      }

      if (error) throw error;

      if (
        incomingParseConfig !== null &&
        incomingParseConfig !== undefined &&
        feed &&
        typeof feed === 'object' &&
        (feed as Record<string, unknown>).parse_config === undefined &&
        ((feed as Record<string, unknown>).cleaning === null ||
          (feed as Record<string, unknown>).cleaning === undefined ||
          typeof (feed as Record<string, unknown>).cleaning !== 'object' ||
          ((feed as Record<string, unknown>).cleaning as Record<string, unknown>).parse_config === undefined)
      ) {
        const updatedCleaning = normalizeCleaningWithParseConfig(
          (feed as Record<string, unknown>).cleaning,
          incomingCleaning,
          incomingParseConfig
        );

        const patch = await getDb()
          .from('feeds')
          .update({ cleaning: updatedCleaning })
          .eq('id', (feed as Record<string, unknown>).id)
          .select()
          .single();

        if (!patch.error && patch.data) {
          feed = patch.data;
        }
      }

      refreshSchedulers(req.app.locals.whatsapp);
      res.json(feed ? projectFeedForResponse(feed as Record<string, unknown>) : feed);
    } catch (error) {
      console.error('Error creating feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.feed), async (req: Request, res: Response) => {
    try {
      const incomingBody = req.body as Record<string, unknown>;
      const incomingParseConfig = incomingBody.parse_config;
      const incomingCleaning = incomingBody.cleaning;

      let { data: feed, error } = await getDb()
        .from('feeds')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error && isMissingParseConfigColumnError(error)) {
        const { parse_config: parseConfig, cleaning, ...rest } = incomingBody;
        const { data: existingFeed, error: existingError } = await getDb()
          .from('feeds')
          .select('cleaning')
          .eq('id', req.params.id)
          .single();

        if (existingError) throw existingError;

        const fallbackBody = {
          ...rest,
          cleaning: normalizeCleaningWithParseConfig(existingFeed?.cleaning, cleaning, parseConfig)
        };

        const retry = await getDb()
          .from('feeds')
          .update(fallbackBody)
          .eq('id', req.params.id)
          .select()
          .single();
        feed = retry.data;
        error = retry.error;
      }

      if (error) throw error;

      if (
        incomingParseConfig !== null &&
        incomingParseConfig !== undefined &&
        feed &&
        typeof feed === 'object' &&
        (feed as Record<string, unknown>).parse_config === undefined &&
        ((feed as Record<string, unknown>).cleaning === null ||
          (feed as Record<string, unknown>).cleaning === undefined ||
          typeof (feed as Record<string, unknown>).cleaning !== 'object' ||
          ((feed as Record<string, unknown>).cleaning as Record<string, unknown>).parse_config === undefined)
      ) {
        const updatedCleaning = normalizeCleaningWithParseConfig(
          (feed as Record<string, unknown>).cleaning,
          incomingCleaning,
          incomingParseConfig
        );

        const patch = await getDb()
          .from('feeds')
          .update({ cleaning: updatedCleaning })
          .eq('id', (feed as Record<string, unknown>).id)
          .select()
          .single();

        if (!patch.error && patch.data) {
          feed = patch.data;
        }
      }

      refreshSchedulers(req.app.locals.whatsapp);
      res.json(feed ? projectFeedForResponse(feed as Record<string, unknown>) : feed);
    } catch (error) {
      console.error('Error updating feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { error } = await getDb()
        .from('feeds')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      refreshSchedulers(req.app.locals.whatsapp);
      res.json({ ok: true });
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
      const queuedLogs = await queueFeedItemsForSchedules(feed.id, result.items);
      if (result.items.length) {
        await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
      }
      res.json({
        ok: true,
        items: result.items,
        fetchedCount: result.fetchedCount,
        insertedCount: result.insertedCount,
        duplicateCount: result.duplicateCount,
        errorCount: result.errorCount,
        queuedCount: queuedLogs.length
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
        const queuedLogs = await queueFeedItemsForSchedules(feed.id, result.items);
        if (result.items.length) {
          await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
        }

        totalFetched += result.fetchedCount;
        totalInserted += result.insertedCount;
        totalDuplicates += result.duplicateCount;
        totalErrors += result.errorCount;
        totalQueued += queuedLogs.length;

        results.push({
          feedId: feed.id,
          name: feed.name,
          url: feed.url,
          fetchedCount: result.fetchedCount,
          insertedCount: result.insertedCount,
          duplicateCount: result.duplicateCount,
          errorCount: result.errorCount,
          queuedCount: queuedLogs.length
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
