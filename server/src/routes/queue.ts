import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { resetStuckProcessingLogs } = require('../services/retentionService');
const { sendQueueLogNow } = require('../services/queueService');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { normalizeMessageText } = require('../utils/messageText');

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
      const { status } = req.query;
      const statusFilter = typeof status === 'string' ? status : undefined;
      const includeManual = String(req.query.include_manual || '').toLowerCase() === 'true';

      let query = supabase
        .from('message_logs')
        .select(`
          id,
          schedule_id,
          target_id,
          feed_item_id,
          whatsapp_message_id,
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
            name,
            delivery_mode,
            batch_times
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
      if (!includeManual) {
        query = query.not('schedule_id', 'is', null);
      }

      const { data: rows, error } = await query;

      if (error) throw error;

      const items = (rows || []).map((row: Record<string, unknown>) => {
        const feedItems = row.feed_items as { title?: string; link?: string; image_url?: string } | undefined;
        const schedule = row.schedule as {
          id?: string;
          name?: string;
          delivery_mode?: string;
          batch_times?: string[];
        } | undefined;
        const target = row.target as { id?: string; name?: string; type?: string } | undefined;
        return {
          id: row.id,
          schedule_id: row.schedule_id,
          target_id: row.target_id,
          feed_item_id: row.feed_item_id,
          whatsapp_message_id: row.whatsapp_message_id || null,
          schedule_name: schedule?.name || null,
          delivery_mode: schedule?.delivery_mode || null,
          batch_times: schedule?.batch_times || null,
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
  router.patch('/:id', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { data: current, error: currentError } = await supabase
        .from('message_logs')
        .select('id,status')
        .eq('id', req.params.id)
        .single();

      if (currentError || !current) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const currentStatus = String((current as { status?: string }).status || '');
      if (currentStatus === 'sent' || currentStatus === 'processing') {
        return res.status(400).json({ error: `Cannot edit queue item with status "${currentStatus}"` });
      }

      const body = req.body as { message_content?: unknown; status?: unknown };
      const patch: Record<string, unknown> = {};

      if (Object.prototype.hasOwnProperty.call(body, 'message_content')) {
        const normalized = normalizeMessageText(String(body.message_content || ''));
        patch.message_content = normalized || null;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'status')) {
        const status = String(body.status || '').toLowerCase();
        if (status !== 'pending' && status !== 'skipped') {
          return res.status(400).json({ error: 'status must be pending or skipped' });
        }

        patch.status = status;
        patch.processing_started_at = null;
        patch.retry_count = 0;
        patch.error_message = status === 'skipped' ? 'Paused by user' : null;
      }

      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No supported fields provided' });
      }

      const { data: updated, error: updateError } = await supabase
        .from('message_logs')
        .update(patch)
        .eq('id', req.params.id)
        .select('*')
        .single();

      if (updateError) throw updateError;
      return res.json(updated);
    } catch (error) {
      console.error('Error updating queue item:', error);
      return res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/pause', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { data: updated, error } = await supabase
        .from('message_logs')
        .update({
          status: 'skipped',
          processing_started_at: null,
          error_message: 'Paused by user'
        })
        .eq('id', req.params.id)
        .in('status', ['pending', 'failed'])
        .select('id,status,error_message')
        .single();

      if (error || !updated) {
        return res.status(400).json({ error: 'Queue item cannot be paused from its current status' });
      }

      return res.json({ ok: true, item: updated });
    } catch (error) {
      console.error('Error pausing queue item:', error);
      return res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/resume', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { data: updated, error } = await supabase
        .from('message_logs')
        .update({
          status: 'pending',
          processing_started_at: null,
          retry_count: 0,
          error_message: null
        })
        .eq('id', req.params.id)
        .in('status', ['failed', 'skipped'])
        .select('id,status,error_message')
        .single();

      if (error || !updated) {
        return res.status(400).json({ error: 'Queue item cannot be resumed from its current status' });
      }

      return res.json({ ok: true, item: updated });
    } catch (error) {
      console.error('Error resuming queue item:', error);
      return res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/send-now', async (req: Request, res: Response) => {
    try {
      const result = await sendQueueLogNow(req.params.id, req.app.locals.whatsapp);
      if (!result?.ok) {
        return res.status(400).json({ error: result?.error || 'Failed to send queue item now' });
      }
      return res.json(result);
    } catch (error) {
      console.error('Error sending queue item now:', error);
      return res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

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
