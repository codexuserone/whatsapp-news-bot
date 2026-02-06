import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { resetStuckProcessingLogs } = require('../services/retentionService');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const queueRoutes = () => {
  const router = express.Router();

  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  // Get queue items (message_logs) with optional status filter
  // Joins feed_items for title/url, uses message_logs for the queue
  router.get('/', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { status, schedule_id: scheduleId, target_id: targetId, feed_item_id: feedItemId } = req.query;
      const statusFilter = typeof status === 'string' ? status : undefined;
      const scheduleFilter = typeof scheduleId === 'string' ? scheduleId : undefined;
      const targetFilter = typeof targetId === 'string' ? targetId : undefined;
      const feedItemFilter = typeof feedItemId === 'string' ? feedItemId : undefined;
      const includeManual = String(req.query.include_manual || '').toLowerCase() === 'true';

      let query = supabase
        .from('message_logs')
        .select(`
          id,
          schedule_id,
          target_id,
          feed_item_id,
          template_id,
          message_content,
          status,
          error_message,
          media_url,
          media_type,
          media_sent,
          media_error,
          sent_at,
          created_at,
          schedule:schedules (
            id,
            name
          ),
          target:targets (
            id,
            name,
            type
          ),
          feed_items (
            title,
            link,
            image_url
          )
        `)
        .order('created_at', { ascending: false })
        .limit(100);

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      }
      if (scheduleFilter) {
        query = query.eq('schedule_id', scheduleFilter);
      }
      if (targetFilter) {
        query = query.eq('target_id', targetFilter);
      }
      if (feedItemFilter) {
        query = query.eq('feed_item_id', feedItemFilter);
      }
      if (!includeManual) {
        query = query.not('schedule_id', 'is', null);
      }

      const { data: rows, error } = await query;

      if (error) throw error;

      const items = (rows || []).map((row: Record<string, unknown>) => {
        const feedItems = row.feed_items as { title?: string; link?: string; image_url?: string } | undefined;
        const schedule = row.schedule as { id?: string; name?: string } | undefined;
        const target = row.target as { id?: string; name?: string; type?: string } | undefined;
        return {
          id: row.id,
          schedule_id: row.schedule_id,
          target_id: row.target_id,
          schedule_name: schedule?.name || null,
          target_name: target?.name || null,
          target_type: target?.type || null,
          title: feedItems?.title || 'No title',
          url: feedItems?.link || null,
          image_url: feedItems?.image_url || null,
          rendered_content: row.message_content,
          status: row.status,
          error_message: row.error_message,
          media_url: row.media_url || null,
          media_type: row.media_type || null,
          media_sent: Boolean(row.media_sent),
          media_error: row.media_error || null,
          sent_at: row.sent_at,
          created_at: row.created_at,
          scheduled_for: null
        };
      });

      res.json(items);
    } catch (error) {
      console.error('Error fetching queue:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Clear queue items by status
  router.delete('/clear', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { status } = req.query;
      const statusFilter = typeof status === 'string' ? status : undefined;
      const includeManual = String(req.query.include_manual || '').toLowerCase() === 'true';

      let query = supabase.from('message_logs').delete();

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      } else {
        return res.status(400).json({ error: 'Status parameter required' });
      }

      if (!includeManual) {
        query = query.not('schedule_id', 'is', null);
      }

      const { error } = await query;

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error('Error clearing queue:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Retry failed items
  router.post('/retry-failed', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const includeManual = String(req.query.include_manual || '').toLowerCase() === 'true';

      let retryQuery = supabase
        .from('message_logs')
        .update({ status: 'pending', error_message: null, retry_count: 0, processing_started_at: null })
        .eq('status', 'failed')
        .select();

      if (!includeManual) {
        retryQuery = retryQuery.not('schedule_id', 'is', null);
      }

      const { data, error } = await retryQuery;

      if (error) throw error;
      res.json({ success: true, count: data?.length || 0 });
    } catch (error) {
      console.error('Error retrying failed items:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Reset stuck processing items (e.g. after a crash)
  router.post('/reset-processing', async (_req: Request, res: Response) => {
    try {
      const count = await resetStuckProcessingLogs();
      res.json({ success: true, count });
    } catch (error) {
      console.error('Error resetting processing items:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get queue statistics
  router.get('/stats', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const includeManual = String(req.query.include_manual || '').toLowerCase() === 'true';

      const countByStatus = (status: string) => {
        let query = supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('status', status);
        if (!includeManual) {
          query = query.not('schedule_id', 'is', null);
        }
        return query;
      };

      const [pendingRes, processingRes, sentRes, failedRes, skippedRes] = await Promise.all([
        countByStatus('pending'),
        countByStatus('processing'),
        countByStatus('sent'),
        countByStatus('failed'),
        countByStatus('skipped')
      ]);

      const pCount = pendingRes.count ?? 0;
      const prCount = processingRes.count ?? 0;
      const sCount = sentRes.count ?? 0;
      const fCount = failedRes.count ?? 0;
      const skCount = skippedRes.count ?? 0;

      res.json({
        pending: pCount,
        processing: prCount,
        sent: sCount,
        failed: fCount,
        skipped: skCount,
        total: pCount + prCount + sCount + fCount + skCount
      });
    } catch (error) {
      console.error('Error fetching queue stats:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Delete a queue item
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { error } = await supabase
        .from('message_logs')
        .delete()
        .eq('id', req.params.id);

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting queue item:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = queueRoutes;
