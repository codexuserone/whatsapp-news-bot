import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const feedItemRoutes = () => {
  const router = express.Router();
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  // Get all feed items with feed information
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { data: items, error } = await supabase
        .from('feed_items')
        .select(`
          *,
          feed:feeds(id, name, url, type)
        `)
        .order('created_at', { ascending: false })
        .limit(200);
      
      if (error) throw error;

      const ids = (items || []).map((item: { id?: string }) => item.id).filter(Boolean) as string[];
      const deliveryByItem = new Map<
        string,
        { pending: number; processing: number; sent: number; failed: number; skipped: number }
      >();

      if (ids.length) {
        const { data: logs, error: logsError } = await supabase
          .from('message_logs')
          .select('feed_item_id,status')
          .in('feed_item_id', ids);

        if (logsError) {
          console.warn('Error fetching message log summaries:', logsError);
        }

        for (const row of (logs || []) as Array<{ feed_item_id?: string; status?: string }>) {
          const feedItemId = row.feed_item_id;
          const status = row.status;
          if (!feedItemId || !status) continue;

          const current = deliveryByItem.get(feedItemId) || {
            pending: 0,
            processing: 0,
            sent: 0,
            failed: 0,
            skipped: 0
          };

          if (status === 'pending') current.pending += 1;
          else if (status === 'processing') current.processing += 1;
          else if (status === 'sent' || status === 'delivered' || status === 'read') current.sent += 1;
          else if (status === 'failed') current.failed += 1;
          else if (status === 'skipped') current.skipped += 1;

          deliveryByItem.set(feedItemId, current);
        }
      }

      const enriched = (items || []).map((item: Record<string, unknown>) => {
        const id = String(item.id || '');
        const delivery = deliveryByItem.get(id) || {
          pending: 0,
          processing: 0,
          sent: 0,
          failed: 0,
          skipped: 0
        };
        const queued = delivery.pending + delivery.processing;
        const total = delivery.pending + delivery.processing + delivery.sent + delivery.failed + delivery.skipped;
        const hasQueued = queued > 0;
        const hasSent = delivery.sent > 0;
        const hasFailed = delivery.failed > 0;
        const delivery_status =
          hasQueued && hasSent && hasFailed
            ? 'mixed'
            : hasQueued && hasSent
              ? 'partially_sent'
              : hasQueued && hasFailed
                ? 'retrying'
                : hasQueued
                  ? 'queued'
                  : hasSent && hasFailed
                    ? 'partially_sent'
                    : hasSent
                      ? 'sent'
                      : hasFailed
                        ? 'failed'
                        : 'not_queued';
        return {
          ...item,
          sent: Boolean(item.sent) || delivery.sent > 0,
          delivery: { ...delivery, total },
          delivery_status
        };
      });

      res.json(enriched);
    } catch (error) {
      console.error('Error fetching feed items:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get feed items by feed ID
  router.get('/by-feed/:feedId', async (req: Request, res: Response) => {
    try {
      const { data: items, error } = await getDb()
        .from('feed_items')
        .select('*')
        .eq('feed_id', req.params.feedId)
        .order('pub_date', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      res.json(items);
    } catch (error) {
      console.error('Error fetching feed items by feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get available fields/variables from feed items for template usage
  router.get('/available-fields', async (_req: Request, res: Response) => {
    try {
      // Get a sample of recent feed items to extract available fields
      const { data: items, error } = await getDb()
        .from('feed_items')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (error) throw error;
      
      // Extract all unique fields from items
      const fields = new Set(['title', 'description', 'content', 'link', 'author', 'pub_date', 'image_url']);
      
      items.forEach((item: Record<string, unknown>) => {
        // Add fields from raw_data if available
        if (item.raw_data && typeof item.raw_data === 'object') {
          Object.keys(item.raw_data).forEach(key => fields.add(key));
        }
        // Add categories if available
        const categories = item.categories as unknown;
        if (Array.isArray(categories) && categories.length > 0) {
          fields.add('categories');
        }
      });
      
      res.json(Array.from(fields).sort());
    } catch (error) {
      console.error('Error fetching available fields:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = feedItemRoutes;
