import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('../services/feedProcessor');
const { initSchedulers, triggerImmediateSchedules, queueBatchSchedulesForFeed } = require('../services/schedulerService');
const { fetchFeedItemsWithMeta } = require('../services/feedFetcher');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { validate, schemas } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const feedsRoutes = () => {
  const router = express.Router();

  const normalizeFeedUrl = (value: unknown) => {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    try {
      const parsed = new URL(raw);
      parsed.hash = '';
      if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
        parsed.port = '';
      }
      if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '/');
      }
      return parsed.toString();
    } catch {
      return raw;
    }
  };

  const toFeedTestError = (error: unknown) => {
    const status = getErrorStatus(error);
    const rawMessage = getErrorMessage(error, 'Failed to fetch feed');
    const message = rawMessage.toLowerCase();

    if (status === 403) {
      return {
        status,
        error:
          'Feed host blocked the request (HTTP 403). This feed likely requires browser headers or blocks bot traffic. Try an alternate feed endpoint.'
      };
    }

    if (status === 429 || message.includes('too many requests')) {
      return {
        status,
        error: 'Feed host rate-limited this request (HTTP 429). Wait a bit and retry.'
      };
    }

    if (message.includes('eai_again') || message.includes('eai again') || message.includes('enotfound') || message.includes('getaddrinfo')) {
      return {
        status: 400,
        error: 'DNS resolution failed for this host. The domain may be temporarily unreachable from the server.'
      };
    }

    if (message.includes('etimedout') || message.includes('timeout')) {
      return {
        status: 504,
        error: 'Feed request timed out. The source may be slow or blocking requests from the server.'
      };
    }

    if (message.includes('no items found in feed')) {
      return {
        status: 404,
        error: 'No items were detected in the feed response. Verify the exact RSS/Atom/JSON feed URL.'
      };
    }

    return {
      status,
      error: rawMessage
    };
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
      const { url, type, parse_config, cleaning } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        await assertSafeOutboundUrl(String(url));
      } catch (error) {
        const mapped = toFeedTestError(error);
        return res.status(mapped.status).json({ error: mapped.error });
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
        return res.status(404).json({
          error: 'No items were detected in the feed response. Verify the exact RSS/Atom/JSON feed URL.'
        });
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
      const mapped = toFeedTestError(error);
      res.status(mapped.status).json({ error: mapped.error });
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
      const payload = { ...req.body, url: normalizeFeedUrl(req.body.url) };

      const { data: existing, error: existingError } = await getDb()
        .from('feeds')
        .select('id, name, url')
        .eq('url', payload.url)
        .limit(1);

      if (existingError) throw existingError;
      if (existing && existing.length > 0) {
        return res.status(409).json({
          error: `Feed already exists: ${existing[0]?.name || existing[0]?.url || payload.url}`,
          existing: existing[0]
        });
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
      const payload = { ...req.body, url: normalizeFeedUrl(req.body.url) };

      const { data: existing, error: existingError } = await getDb()
        .from('feeds')
        .select('id, name, url')
        .eq('url', payload.url)
        .neq('id', req.params.id)
        .limit(1);

      if (existingError) throw existingError;
      if (existing && existing.length > 0) {
        return res.status(409).json({
          error: `Feed already exists: ${existing[0]?.name || existing[0]?.url || payload.url}`,
          existing: existing[0]
        });
      }

      const { data: feed, error } = await getDb()
        .from('feeds')
        .update(payload)
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
