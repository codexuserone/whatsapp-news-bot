import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { resetStuckProcessingLogs } = require('../services/retentionService');
const { sendQueueLogNow } = require('../services/queueService');
const settingsService = require('../services/settingsService');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { normalizeMessageText } = require('../utils/messageText');

const WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES = 15;
const SUCCESSFUL_SEND_STATUSES = new Set(['sent', 'delivered', 'read', 'played']);

const isSuccessfulSendStatus = (status: unknown) => SUCCESSFUL_SEND_STATUSES.has(String(status || '').toLowerCase());

const normalizeTargetJid = (target: { phone_number?: string | null; type?: string | null }) => {
  const raw = String(target?.phone_number || '').trim();
  const type = String(target?.type || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  if (type === 'status') return 'status@broadcast';
  if (type === 'channel') return `${raw}@newsletter`;
  if (type === 'group') return raw.endsWith('@g.us') ? raw : `${raw}@g.us`;
  return `${raw.replace(/[^\d]/g, '')}@s.whatsapp.net`;
};

const resolveEditWindowMinutes = (settings: Record<string, unknown>) => {
  const configured = Number(settings?.post_send_edit_window_minutes);
  if (!Number.isFinite(configured)) return WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES;
  return Math.min(Math.max(Math.floor(configured), 1), WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES);
};

const canEditSentInPlace = (sentAt: unknown, windowMinutes: number) => {
  const sentIso = String(sentAt || '').trim();
  if (!sentIso) return false;
  const sentMs = Date.parse(sentIso);
  if (!Number.isFinite(sentMs)) return false;
  const ageMs = Date.now() - sentMs;
  if (ageMs < 0) return false;
  return ageMs <= windowMinutes * 60 * 1000;
};

const readBasicAuthUser = (req: Request) => {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return null;
  try {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = raw.indexOf(':');
    const user = idx >= 0 ? raw.slice(0, idx) : raw;
    const cleaned = String(user || '').trim();
    return cleaned || null;
  } catch {
    return null;
  }
};

const queueRoutes = () => {
  const router = express.Router();

  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  const resolveResumeStatus = async (
    supabase: ReturnType<typeof getSupabaseClient>,
    row: { schedule_id?: unknown; approved_at?: unknown }
  ) => {
    const approvedAt = String(row?.approved_at || '').trim();
    if (approvedAt) return 'pending';
    const scheduleId = String(row?.schedule_id || '').trim();
    if (!scheduleId) return 'pending';
    try {
      const { data } = await supabase
        .from('schedules')
        .select('approval_required')
        .eq('id', scheduleId)
        .maybeSingle();
      return (data as { approval_required?: boolean } | null)?.approval_required === true ? 'awaiting_approval' : 'pending';
    } catch {
      return 'pending';
    }
  };

  // Get queue items (message_logs) with optional status filter
  // Joins feed_items for title/url, uses message_logs for the queue
  router.get('/', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { status } = req.query;
      const statusFilterRaw = typeof status === 'string' ? status : undefined;
      const statusFilter = statusFilterRaw ? String(statusFilterRaw).toLowerCase() : undefined;
      const shouldFilterByStatus = Boolean(statusFilter && statusFilter !== 'all');
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
          approved_at,
          approved_by,
          processing_started_at,
          sent_at,
          delivered_at,
          read_at,
          played_at,
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
            image_url,
            pub_date,
            raw_data
          )
        `);

      if (shouldFilterByStatus && statusFilter) {
        if (statusFilter === 'sent') {
          query = query.in('status', Array.from(SUCCESSFUL_SEND_STATUSES));
        } else {
          query = query.eq('status', statusFilter);
        }
      }
      if (!includeManual) {
        query = query.not('schedule_id', 'is', null);
      }

      if (statusFilter === 'awaiting_approval' || statusFilter === 'pending' || statusFilter === 'processing') {
        query = query.order('created_at', { ascending: true }).order('id', { ascending: true });
      } else if (statusFilter === 'sent' || statusFilter === 'failed' || statusFilter === 'skipped') {
        query = query
          .order('sent_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
      } else {
        query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
      }

      query = query.limit(100);

      const { data: rows, error } = await query;

      if (error) throw error;

      const items = (rows || []).map((row: Record<string, unknown>) => {
        const feedItems = row.feed_items as {
          title?: string;
          link?: string;
          image_url?: string;
          pub_date?: string;
          raw_data?: Record<string, unknown> | null;
        } | undefined;
        const rawData =
          feedItems?.raw_data && typeof feedItems.raw_data === 'object'
            ? (feedItems.raw_data as Record<string, unknown>)
            : null;
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
          pub_date: feedItems?.pub_date || null,
          pub_precision: rawData ? String(rawData.published_precision || '') || null : null,
          rendered_content: row.message_content,
          status: row.status,
          error_message: row.error_message,
          media_url: row.media_url || null,
          media_type: row.media_type || null,
          media_sent: Boolean(row.media_sent),
          media_error: row.media_error || null,
          approved_at: row.approved_at || null,
          approved_by: row.approved_by || null,
          processing_started_at: row.processing_started_at || null,
          sent_at: row.sent_at,
          delivered_at: row.delivered_at || null,
          read_at: row.read_at || null,
          played_at: row.played_at || null,
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
      const rawWindowHours = Number(req.query.window_hours);
      const windowHours = Number.isFinite(rawWindowHours) && rawWindowHours > 0
        ? Math.min(Math.round(rawWindowHours), 168)
        : 24;
      const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

      const countByStatus = (status: string, recentOnly = false) => {
        let query = supabase.from('message_logs').select('id', { count: 'exact', head: true });
        if (status === 'sent') {
          query = query.in('status', Array.from(SUCCESSFUL_SEND_STATUSES));
        } else {
          query = query.eq('status', status);
        }
        if (!includeManual) {
          query = query.not('schedule_id', 'is', null);
        }
        if (recentOnly) {
          query = query.gte('created_at', windowStartIso);
        }
        return query;
      };

      const [awaitingRes, pendingRes, processingRes, sentRes, failedRes, skippedRes] = await Promise.all([
        countByStatus('awaiting_approval'),
        countByStatus('pending'),
        countByStatus('processing'),
        countByStatus('sent', true),
        countByStatus('failed', true),
        countByStatus('skipped', true)
      ]);

      const [sentAllTimeRes, failedAllTimeRes, skippedAllTimeRes] = await Promise.all([
        countByStatus('sent'),
        countByStatus('failed'),
        countByStatus('skipped')
      ]);

      const awaitingCount = awaitingRes.count ?? 0;
      const pCount = pendingRes.count ?? 0;
      const prCount = processingRes.count ?? 0;
      const sRecentCount = sentRes.count ?? 0;
      const fRecentCount = failedRes.count ?? 0;
      const skRecentCount = skippedRes.count ?? 0;
      const sAllCount = sentAllTimeRes.count ?? 0;
      const fAllCount = failedAllTimeRes.count ?? 0;
      const skAllCount = skippedAllTimeRes.count ?? 0;
      const queuedNow = awaitingCount + pCount + prCount;
      const historyWindowTotal = sRecentCount + fRecentCount + skRecentCount;
      const allTimeTotal = sAllCount + fAllCount + skAllCount;

      res.json({
        awaiting_approval: awaitingCount,
        pending: pCount,
        processing: prCount,
        sent: sRecentCount,
        failed: fRecentCount,
        skipped: skRecentCount,
        total: queuedNow + historyWindowTotal,
        queued_now: queuedNow,
        history_window_total: historyWindowTotal,
        history_all_time_total: allTimeTotal,
        sent_all_time: sAllCount,
        failed_all_time: fAllCount,
        skipped_all_time: skAllCount,
        window_hours: windowHours,
        window_start: windowStartIso
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
        .select('id,status,target_id,whatsapp_message_id,sent_at,approved_at,schedule_id')
        .eq('id', req.params.id)
        .single();

      if (currentError || !current) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const currentStatus = String((current as { status?: string }).status || '');
      if (currentStatus === 'processing') {
        return res.status(400).json({ error: `Cannot edit queue item with status "${currentStatus}"` });
      }

      const body = req.body as { message_content?: unknown; status?: unknown };
      const patch: Record<string, unknown> = {};
      let normalizedMessageContent: string | null = null;

      if (Object.prototype.hasOwnProperty.call(body, 'message_content')) {
        const normalized = normalizeMessageText(String(body.message_content || ''));
        normalizedMessageContent = normalized || null;
        patch.message_content = normalizedMessageContent;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'status')) {
        if (isSuccessfulSendStatus(currentStatus)) {
          return res.status(400).json({ error: 'Cannot change status for a sent message' });
        }
        const status = String(body.status || '').toLowerCase();
        if (status !== 'pending' && status !== 'skipped') {
          return res.status(400).json({ error: 'status must be pending or skipped' });
        }

        patch.status = status;
        patch.processing_started_at = null;
        patch.retry_count = 0;
        patch.error_message = status === 'skipped' ? 'Paused by user' : null;

        if (currentStatus === 'awaiting_approval' && status === 'pending') {
          // Treat status patch as an implicit approval so the audit columns remain consistent.
          patch.approved_at = new Date().toISOString();
          patch.approved_by = readBasicAuthUser(req) || process.env.BASIC_AUTH_USER || 'unknown';
        }
      }

      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'No supported fields provided' });
      }

      if (isSuccessfulSendStatus(currentStatus)) {
        if (!Object.prototype.hasOwnProperty.call(body, 'message_content')) {
          return res.status(400).json({ error: 'Only message_content can be updated for sent messages' });
        }
        if (!normalizedMessageContent) {
          return res.status(400).json({ error: 'message_content cannot be empty for sent message edits' });
        }
        const settings = await settingsService.getSettings();
        const editWindowMinutes = resolveEditWindowMinutes(settings || {});
        if (!canEditSentInPlace((current as { sent_at?: string | null }).sent_at, editWindowMinutes)) {
          return res.status(400).json({
            error: `Sent messages can only be edited in-place within ${editWindowMinutes} minutes`
          });
        }

        const whatsappMessageId = String((current as { whatsapp_message_id?: string | null }).whatsapp_message_id || '').trim();
        if (!whatsappMessageId) {
          return res.status(400).json({ error: 'Cannot edit sent message without WhatsApp message id' });
        }

        const targetId = String((current as { target_id?: string | null }).target_id || '').trim();
        if (!targetId) {
          return res.status(400).json({ error: 'Cannot edit sent message without target id' });
        }

        const { data: targetRow, error: targetError } = await supabase
          .from('targets')
          .select('id,phone_number,type')
          .eq('id', targetId)
          .single();
        if (targetError || !targetRow) {
          return res.status(400).json({ error: 'Could not resolve target for sent message edit' });
        }

        const targetType = String((targetRow as { type?: string | null }).type || '').toLowerCase();
        if (targetType === 'status' || targetType === 'channel') {
          return res.status(400).json({ error: 'In-place edit is only supported for direct/group messages' });
        }

        const jid = normalizeTargetJid(targetRow as { phone_number?: string | null; type?: string | null });
        if (!jid) {
          return res.status(400).json({ error: 'Could not build WhatsApp JID for sent message edit' });
        }

        const whatsapp = req.app.locals.whatsapp as
          | {
              getStatus?: () => { status?: string | null };
              editMessage?: (jid: string, messageId: string, text: string) => Promise<unknown>;
            }
          | undefined;
        const waStatus = String(whatsapp?.getStatus?.().status || '').toLowerCase();
        if (!whatsapp || typeof whatsapp.editMessage !== 'function' || waStatus !== 'connected') {
          return res.status(400).json({ error: 'WhatsApp is not connected; cannot perform in-place edit' });
        }

        try {
          await whatsapp.editMessage(jid, whatsappMessageId, normalizedMessageContent);
        } catch (waError) {
          return res.status(400).json({ error: getErrorMessage(waError) || 'Failed to edit WhatsApp message in-place' });
        }
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

  router.post('/:id/approve', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Queue item id is required' });

      const { data: current, error: currentError } = await supabase
        .from('message_logs')
        .select('id,status')
        .eq('id', id)
        .single();

      if (currentError || !current) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const currentStatus = String((current as { status?: string }).status || '').toLowerCase();
      if (isSuccessfulSendStatus(currentStatus)) {
        return res.status(400).json({ error: 'Queue item is already sent' });
      }
      if (currentStatus === 'processing') {
        return res.status(400).json({ error: 'Queue item is currently being processed' });
      }
      if (currentStatus !== 'awaiting_approval') {
        return res.status(400).json({ error: `Queue item is not awaiting approval (status=${currentStatus || 'unknown'})` });
      }

      const actor = readBasicAuthUser(req) || process.env.BASIC_AUTH_USER || 'unknown';
      const nowIso = new Date().toISOString();
      const { data: updated, error } = await supabase
        .from('message_logs')
        .update({
          status: 'pending',
          approved_at: nowIso,
          approved_by: actor,
          error_message: null,
          processing_started_at: null,
          retry_count: 0
        })
        .eq('id', id)
        .eq('status', 'awaiting_approval')
        .select('*')
        .single();

      if (error || !updated) {
        return res.status(400).json({ error: getErrorMessage(error) || 'Could not approve this queue item' });
      }

      return res.json({ ok: true, item: updated });
    } catch (error) {
      console.error('Error approving queue item:', error);
      return res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/reject', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Queue item id is required' });

      const { data: current, error: currentError } = await supabase
        .from('message_logs')
        .select('id,status')
        .eq('id', id)
        .single();

      if (currentError || !current) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const currentStatus = String((current as { status?: string }).status || '').toLowerCase();
      if (isSuccessfulSendStatus(currentStatus)) {
        return res.status(400).json({ error: 'Queue item is already sent' });
      }
      if (currentStatus === 'processing') {
        return res.status(400).json({ error: 'Queue item is currently being processed' });
      }
      if (currentStatus !== 'awaiting_approval') {
        return res.status(400).json({ error: `Queue item is not awaiting approval (status=${currentStatus || 'unknown'})` });
      }

      const { data: updated, error } = await supabase
        .from('message_logs')
        .update({
          status: 'skipped',
          approved_at: null,
          approved_by: null,
          error_message: 'Rejected',
          processing_started_at: null,
          retry_count: 0
        })
        .eq('id', id)
        .eq('status', 'awaiting_approval')
        .select('*')
        .single();

      if (error || !updated) {
        return res.status(400).json({ error: getErrorMessage(error) || 'Could not reject this queue item' });
      }

      return res.json({ ok: true, item: updated });
    } catch (error) {
      console.error('Error rejecting queue item:', error);
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
        .in('status', ['awaiting_approval', 'pending', 'failed'])
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
      const { data: current, error: currentError } = await supabase
        .from('message_logs')
        .select('id,status,schedule_id,approved_at')
        .eq('id', req.params.id)
        .single();

      if (currentError || !current) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const currentStatus = String((current as { status?: string }).status || '').toLowerCase();
      if (!['failed', 'skipped'].includes(currentStatus)) {
        return res.status(400).json({ error: 'Queue item cannot be resumed from its current status' });
      }

      const nextStatus = await resolveResumeStatus(supabase, current as { schedule_id?: unknown; approved_at?: unknown });
      const { data: updated, error } = await supabase
        .from('message_logs')
        .update({
          status: nextStatus,
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
