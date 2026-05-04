import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { resetStuckProcessingLogs } = require('../services/retentionService');
const {
  sendQueueLogNow,
  buildQueuedAutomationPreview,
  buildEditableMessageContent,
  hasEditableQueuePayload
} = require('../services/queueService');
const { isScheduleRunning } = require('../services/scheduleState');
const settingsService = require('../services/settingsService');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { normalizeMessageText } = require('../utils/messageText');
const { stripManualMeta } = require('../utils/manualMeta');
const { normalizeTargetJidForSend } = require('../utils/targetJid');
const { normalizeFeedMedia } = require('../utils/feedMedia');
const { isInlineMediaDataUrl, isStoredMediaReference, sanitizeMediaUrlForApi } = require('../utils/mediaUrlPresentation');

const WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES = 15;
const SUCCESSFUL_SEND_STATUSES = new Set(['sent', 'delivered', 'read', 'played']);
const LIVE_QUEUE_STATUS_VALUES = ['awaiting_approval', 'pending', 'processing'];
const HISTORY_QUEUE_STATUSES = new Set(['sent', 'failed', 'skipped', 'uncertain', 'superseded']);
const DEFAULT_QUEUE_HISTORY_WINDOW_HOURS = 24;
const MAX_QUEUE_HISTORY_WINDOW_HOURS = 168;
const NON_RETRYABLE_FAILURE_PATTERNS = [
  /channel .*rejected by whatsapp/i,
  /whatsapp server rejected message ack 479/i,
  /newsletter ack 479/i
];

const isSuccessfulSendStatus = (status: unknown) => SUCCESSFUL_SEND_STATUSES.has(String(status || '').toLowerCase());

type QueueSendNowResult = {
  ok?: boolean;
  held?: boolean;
  status?: string | null;
  messageId?: string | null;
  mediaSent?: boolean | null;
  error?: string | null;
};

type QueueSendNowStoredRow = {
  id?: string | null;
  status?: string | null;
  whatsapp_message_id?: string | null;
  media_sent?: boolean | null;
  error_message?: string | null;
  media_error?: string | null;
};

const normalizeQueueStatus = (status: unknown) => String(status || '').trim().toLowerCase();

const fallbackSendNowStatus = (result?: QueueSendNowResult | null) => {
  if (result?.status) return normalizeQueueStatus(result.status);
  if (result?.held) return 'awaiting_approval';
  if (result?.ok) return 'sent';
  return 'failed';
};

const buildQueueSendNowResponse = (result: QueueSendNowResult | null | undefined, storedRow?: QueueSendNowStoredRow | null) => {
  const status = normalizeQueueStatus(storedRow?.status) || fallbackSendNowStatus(result);
  const body = {
    ok: isSuccessfulSendStatus(status),
    accepted: status === 'uncertain' || status === 'awaiting_approval' || isSuccessfulSendStatus(status),
    status,
    messageId: storedRow?.whatsapp_message_id || result?.messageId || null,
    mediaSent: typeof storedRow?.media_sent === 'boolean' ? storedRow.media_sent : Boolean(result?.mediaSent),
    error: storedRow?.error_message || storedRow?.media_error || result?.error || null
  };
  const httpStatus =
    isSuccessfulSendStatus(status)
      ? 200
      : status === 'uncertain' || status === 'awaiting_approval'
        ? 202
        : 400;
  return { httpStatus, body };
};

const normalizeTargetJid = (target: { phone_number?: string | null; type?: string | null }) => {
  return normalizeTargetJidForSend(target);
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

type QueueCursorPayload = {
  primary: string;
  createdAt: string;
  id: string;
};

type QueueOrder = {
  primaryColumn: 'created_at' | 'sent_at';
  ascending: boolean;
};

const parsePositiveLimit = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
};

const parseWindowHours = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUEUE_HISTORY_WINDOW_HOURS;
  return Math.min(Math.max(Math.round(parsed), 1), MAX_QUEUE_HISTORY_WINDOW_HOURS);
};

const shouldLimitQueueStatusToRecentHistory = (statusFilter?: string) => {
  if (!statusFilter) return false;
  return statusFilter === 'sent' || HISTORY_QUEUE_STATUSES.has(statusFilter);
};

const buildCombinedQueueFilter = (windowStartIso: string) =>
  [...LIVE_QUEUE_STATUS_VALUES.map((status) => `status.eq.${status}`), `updated_at.gte.${windowStartIso}`].join(',');

type RetryableQueueRow = {
  id?: string | null;
  schedule_id?: string | null;
  target_id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  error_message?: string | null;
  media_error?: string | null;
  schedule?: {
    state?: string | null;
    active?: boolean | null;
  } | null;
  target?: {
    active?: boolean | null;
  } | null;
};

const isTerminalChannelMediaFailure = (row: RetryableQueueRow) => {
  const combined = [row?.error_message, row?.media_error]
    .map((message) => String(message || '').trim())
    .filter(Boolean)
    .join(' ');
  return Boolean(combined && NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(combined)));
};

const isRetryableQueueRow = (row: RetryableQueueRow, windowStartIso: string) => {
  const id = String(row?.id || '').trim();
  if (!id) return false;
  if (isTerminalChannelMediaFailure(row)) return false;

  const targetId = String(row?.target_id || '').trim();
  if (targetId && (!row?.target || row.target.active === false)) {
    return false;
  }

  const comparisonIso = String(row?.updated_at || row?.created_at || '').trim();
  if (!comparisonIso || comparisonIso < windowStartIso) {
    return false;
  }

  const scheduleId = String(row?.schedule_id || '').trim();
  if (!scheduleId) {
    return true;
  }

  return isScheduleRunning(row?.schedule || null);
};

const loadRetryableQueueLogIds = async (
  supabase: ReturnType<typeof getSupabaseClient>,
  options: { includeManual: boolean; windowHours: number }
) => {
  const windowStartIso = new Date(Date.now() - options.windowHours * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('message_logs')
    .select(`
      id,
      schedule_id,
      target_id,
      updated_at,
      created_at,
      error_message,
      media_error,
      schedule:schedules (
        state,
        active
      ),
      target:targets (
        active
      )
    `)
    .in('status', ['failed', 'uncertain'])
    .gte('updated_at', windowStartIso);

  if (!options.includeManual) {
    query = query.not('schedule_id', 'is', null);
  }

  const { data, error } = await query;
  if (error) throw error;

  const ids = (data || [])
    .filter((row: RetryableQueueRow) => isRetryableQueueRow(row, windowStartIso))
    .map((row: RetryableQueueRow) => String(row.id || '').trim())
    .filter(Boolean);

  return [...new Set(ids)];
};

const resolveQueueOrder = (statusFilter?: string): QueueOrder => {
  if (statusFilter === 'awaiting_approval' || statusFilter === 'pending' || statusFilter === 'processing') {
    return { primaryColumn: 'created_at', ascending: true };
  }
  if (statusFilter && HISTORY_QUEUE_STATUSES.has(statusFilter)) {
    return { primaryColumn: 'sent_at', ascending: false };
  }
  return { primaryColumn: 'created_at', ascending: false };
};

const compareLiveQueueItemsForDisplay = (
  left: { pub_date?: unknown; created_at?: unknown; id?: unknown },
  right: { pub_date?: unknown; created_at?: unknown; id?: unknown }
) => {
  const toMs = (value: unknown) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };
  const leftPrimary = toMs(left.pub_date);
  const rightPrimary = toMs(right.pub_date);
  if (Number.isFinite(leftPrimary) && Number.isFinite(rightPrimary) && leftPrimary !== rightPrimary) {
    return leftPrimary - rightPrimary;
  }
  if (Number.isFinite(leftPrimary) !== Number.isFinite(rightPrimary)) {
    return Number.isFinite(leftPrimary) ? -1 : 1;
  }

  const leftCreated = toMs(left.created_at);
  const rightCreated = toMs(right.created_at);
  if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  return String(left.id || '').localeCompare(String(right.id || ''));
};

const encodeQueueCursor = (cursor: QueueCursorPayload) =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeQueueCursor = (value: unknown): QueueCursorPayload | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<QueueCursorPayload>;
    const primary = String(parsed.primary || '').trim();
    const createdAt = String(parsed.createdAt || '').trim();
    const id = String(parsed.id || '').trim();
    if (!primary || !createdAt || !id) return null;
    return { primary, createdAt, id };
  } catch {
    return null;
  }
};

const buildQueueCursorFilter = (order: QueueOrder, cursor: QueueCursorPayload) => {
  const primaryOperator = order.ascending ? 'gt' : 'lt';
  const idOperator = order.ascending ? 'gt' : 'lt';
  if (order.primaryColumn === 'created_at') {
    return [
      `created_at.${primaryOperator}.${cursor.primary}`,
      `and(created_at.eq.${cursor.primary},id.${idOperator}.${cursor.id})`
    ].join(',');
  }

  return [
    `sent_at.${primaryOperator}.${cursor.primary}`,
    `and(sent_at.eq.${cursor.primary},created_at.${primaryOperator}.${cursor.createdAt})`,
    `and(sent_at.eq.${cursor.primary},created_at.eq.${cursor.createdAt},id.${idOperator}.${cursor.id})`
  ].join(',');
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
      const windowHours = parseWindowHours(req.query.window_hours);
      const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
      const useCursorPagination =
        String(req.query.mode || '').toLowerCase() === 'cursor' ||
        Object.prototype.hasOwnProperty.call(req.query, 'limit') ||
        Object.prototype.hasOwnProperty.call(req.query, 'cursor');
      const limit = parsePositiveLimit(req.query.limit, 100, 250);
      const cursor = decodeQueueCursor(req.query.cursor);
      const order = resolveQueueOrder(statusFilter);

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
          disable_link_preview,
          include_caption,
          sequence_step_index,
          sequence_step_label,
          scheduled_for,
          approved_at,
          approved_by,
          processing_started_at,
          sent_at,
          delivered_at,
          read_at,
          played_at,
          corrected_at,
          correction_kind,
          correction_error,
          created_at,
          schedule:schedules (
            id,
            name,
            delivery_mode,
            batch_times,
            target_ids
          ),
          template:templates (
            id,
            name,
            content,
            send_images,
            send_mode,
            sequence_steps,
            status_background_color,
            status_font
          ),
          target:targets (
            id,
            name,
            type,
            active
          ),
          feed_items (
            title,
            link,
            image_url,
            media_url,
            media_kind,
            media_mime,
            media_filename,
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
        if (shouldLimitQueueStatusToRecentHistory(statusFilter)) {
          query = query.gte('updated_at', windowStartIso);
        }
      } else {
        query = query.or(buildCombinedQueueFilter(windowStartIso));
      }
      if (!includeManual) {
        query = query.not('schedule_id', 'is', null);
      }

      if (cursor) {
        const cursorFilter = buildQueueCursorFilter(order, cursor);
        if (cursorFilter) {
          query = query.or(cursorFilter);
        }
      }

      if (order.primaryColumn === 'sent_at') {
        query = query.order('sent_at', { ascending: order.ascending, nullsFirst: false });
      }
      query = query
        .order('created_at', { ascending: order.ascending })
        .order('id', { ascending: order.ascending })
        .limit(useCursorPagination ? limit + 1 : limit);

      const { data: rows, error } = await query;

      if (error) throw error;

      const items = (rows || []).map((row: Record<string, unknown>) => {
        const feedItems = row.feed_items as {
          title?: string;
          link?: string;
          image_url?: string;
          media_url?: string | null;
          media_kind?: string | null;
          media_mime?: string | null;
          media_filename?: string | null;
          pub_date?: string;
          raw_data?: Record<string, unknown> | null;
        } | undefined;
        const rawData =
          feedItems?.raw_data && typeof feedItems.raw_data === 'object'
            ? (feedItems.raw_data as Record<string, unknown>)
            : null;
        const normalizedMedia = normalizeFeedMedia({
          mediaUrl: feedItems?.media_url,
          mediaKind: feedItems?.media_kind,
          mediaMime: feedItems?.media_mime,
          mediaFilename: feedItems?.media_filename,
          imageUrl: feedItems?.image_url,
          rawData
        });
        const schedule = row.schedule as {
          id?: string;
          name?: string;
          delivery_mode?: string;
          batch_times?: string[];
          target_ids?: string[];
        } | undefined;
        const template = row.template as {
          id?: string;
          name?: string;
          content?: string;
          send_images?: boolean | null;
          send_mode?: string | null;
          sequence_steps?: Array<Record<string, unknown>> | null;
          status_background_color?: string | null;
          status_font?: number | null;
        } | undefined;
        const target = row.target as { id?: string; name?: string; type?: string; active?: boolean | null } | undefined;
        const isManual = row.schedule_id == null;
        const targetInCurrentSchedule = (() => {
          if (isManual || !row.schedule_id || !row.target_id) return true;
          if (!Array.isArray(schedule?.target_ids)) return null;
          return schedule.target_ids.map((id) => String(id)).includes(String(row.target_id));
        })();
        const rawMessageContent = typeof row.message_content === 'string' ? String(row.message_content) : '';
        const displayMessageContent = String(isManual ? stripManualMeta(rawMessageContent) : rawMessageContent).trim();
        let automationPreview: {
          text?: string | null;
          mediaUrl?: string | null;
          mediaType?: string | null;
        } | null = null;
        if (!isManual && template?.content && feedItems) {
          try {
            automationPreview = buildQueuedAutomationPreview(row, template, {
              ...feedItems,
              id: row.feed_item_id
            });
          } catch {
            automationPreview = null;
          }
        }
        const manualTitleCandidate = displayMessageContent
          ? (displayMessageContent.split('\n').find((line) => String(line || '').trim()) || '').trim()
          : '';
        const title = feedItems?.title || manualTitleCandidate || (isManual ? 'Manual message' : 'No title');
        const rawMediaUrl = row.media_url || automationPreview?.mediaUrl || normalizedMedia.mediaUrl || null;
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
          target_active: target?.active !== false,
          target_in_current_schedule: targetInCurrentSchedule,
          sequence_step_index: row.sequence_step_index ?? 0,
          sequence_step_label: row.sequence_step_label || null,
          title,
          url: feedItems?.link || null,
          image_url: normalizedMedia.imageUrl || null,
          media_kind: normalizedMedia.mediaKind || null,
          pub_date: feedItems?.pub_date || null,
          pub_precision: rawData ? String(rawData.published_precision || '') || null : null,
          rendered_content: isManual ? displayMessageContent : displayMessageContent || automationPreview?.text || null,
          status: row.status,
          error_message: row.error_message,
          media_url: sanitizeMediaUrlForApi(rawMediaUrl),
          media_stored: isStoredMediaReference(rawMediaUrl),
          media_type: row.media_type || automationPreview?.mediaType || normalizedMedia.mediaKind || null,
          media_sent: Boolean(row.media_sent),
          media_error: row.media_error || null,
          disable_link_preview: row.disable_link_preview === true,
          include_caption: row.include_caption !== false,
          approved_at: row.approved_at || null,
          approved_by: row.approved_by || null,
          processing_started_at: row.processing_started_at || null,
          sent_at: row.sent_at,
          delivered_at: row.delivered_at || null,
          read_at: row.read_at || null,
          played_at: row.played_at || null,
          corrected_at: row.corrected_at || null,
          correction_kind: row.correction_kind || null,
          correction_error: row.correction_error || null,
          created_at: row.created_at,
          is_manual: isManual,
          scheduled_for: row.scheduled_for || null
        };
      });

      const visibleItems =
        !useCursorPagination && statusFilter && LIVE_QUEUE_STATUS_VALUES.includes(statusFilter)
          ? [...items].sort(compareLiveQueueItemsForDisplay)
          : items;

      if (!useCursorPagination) {
        return res.json(visibleItems);
      }

      const hasMore = visibleItems.length > limit;
      const pagedItems = hasMore ? visibleItems.slice(0, limit) : visibleItems;
      const lastVisible = hasMore ? (rows || [])[limit - 1] as Record<string, unknown> | undefined : (rows || [])[items.length - 1] as Record<string, unknown> | undefined;
      const nextCursor =
        hasMore && lastVisible
          ? encodeQueueCursor({
              primary: String(lastVisible[order.primaryColumn] || lastVisible.created_at || '').trim(),
              createdAt: String(lastVisible.created_at || '').trim(),
              id: String(lastVisible.id || '').trim()
            })
          : null;

      return res.json({
        items: pagedItems,
        next_cursor: nextCursor,
        limit
      });
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
      const windowHours = parseWindowHours(req.query.window_hours);
      const retryableIds = await loadRetryableQueueLogIds(supabase, { includeManual, windowHours });

      if (!retryableIds.length) {
        return res.json({ success: true, count: 0, window_hours: windowHours });
      }

      const { data, error } = await supabase
        .from('message_logs')
        .update({ status: 'pending', error_message: null, retry_count: 0, processing_started_at: null })
        .in('id', retryableIds)
        .in('status', ['failed', 'uncertain'])
        .select('id');

      if (error) throw error;
      res.json({ success: true, count: data?.length || 0, window_hours: windowHours });
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
      const windowHours = parseWindowHours(req.query.window_hours);
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
          query = query.gte('updated_at', windowStartIso);
        }
        return query;
      };

      const [awaitingRes, pendingRes, processingRes, sentRes, failedRes, skippedRes, uncertainRes, supersededRes] = await Promise.all([
        countByStatus('awaiting_approval'),
        countByStatus('pending'),
        countByStatus('processing'),
        countByStatus('sent', true),
        countByStatus('failed', true),
        countByStatus('skipped', true),
        countByStatus('uncertain', true),
        countByStatus('superseded', true)
      ]);

      const [sentAllTimeRes, failedAllTimeRes, skippedAllTimeRes, uncertainAllTimeRes, supersededAllTimeRes] = await Promise.all([
        countByStatus('sent'),
        countByStatus('failed'),
        countByStatus('skipped'),
        countByStatus('uncertain'),
        countByStatus('superseded')
      ]);

      const awaitingCount = awaitingRes.count ?? 0;
      const pCount = pendingRes.count ?? 0;
      const prCount = processingRes.count ?? 0;
      const sRecentCount = sentRes.count ?? 0;
      const fRecentCount = failedRes.count ?? 0;
      const skRecentCount = skippedRes.count ?? 0;
      const uRecentCount = uncertainRes.count ?? 0;
      const suRecentCount = supersededRes.count ?? 0;
      const sAllCount = sentAllTimeRes.count ?? 0;
      const fAllCount = failedAllTimeRes.count ?? 0;
      const skAllCount = skippedAllTimeRes.count ?? 0;
      const uAllCount = uncertainAllTimeRes.count ?? 0;
      const suAllCount = supersededAllTimeRes.count ?? 0;
      const queuedNow = awaitingCount + pCount + prCount;
      const historyWindowTotal = sRecentCount + fRecentCount + skRecentCount + uRecentCount + suRecentCount;
      const allTimeTotal = sAllCount + fAllCount + skAllCount + uAllCount + suAllCount;

      res.json({
        awaiting_approval: awaitingCount,
        pending: pCount,
        processing: prCount,
        sent: sRecentCount,
        failed: fRecentCount,
        skipped: skRecentCount,
        uncertain: uRecentCount,
        superseded: suRecentCount,
        total: queuedNow + historyWindowTotal,
        queued_now: queuedNow,
        history_window_total: historyWindowTotal,
        history_all_time_total: allTimeTotal,
        sent_all_time: sAllCount,
        failed_all_time: fAllCount,
        skipped_all_time: skAllCount,
        uncertain_all_time: uAllCount,
        superseded_all_time: suAllCount,
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
        .select('id,status,target_id,whatsapp_message_id,sent_at,approved_at,schedule_id,media_type,media_url,media_sent')
        .eq('id', req.params.id)
        .single();

      if (currentError || !current) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const currentStatus = String((current as { status?: string }).status || '');
      if (currentStatus === 'processing') {
        return res.status(400).json({ error: `Cannot edit queue item with status "${currentStatus}"` });
      }

      const body = req.body as { message_content?: unknown; status?: unknown; scheduled_for?: unknown };
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

      if (Object.prototype.hasOwnProperty.call(body, 'scheduled_for')) {
        if (isSuccessfulSendStatus(currentStatus)) {
          return res.status(400).json({ error: 'Cannot reschedule a sent message' });
        }
        if (!['awaiting_approval', 'pending', 'failed', 'uncertain', 'skipped'].includes(currentStatus)) {
          return res.status(400).json({ error: `Cannot reschedule queue item with status "${currentStatus}"` });
        }
        const rawScheduledFor = body.scheduled_for;
        if (rawScheduledFor == null || String(rawScheduledFor).trim() === '') {
          patch.scheduled_for = null;
        } else {
          const parsedMs = Date.parse(String(rawScheduledFor));
          if (!Number.isFinite(parsedMs)) {
            return res.status(400).json({ error: 'scheduled_for must be a valid ISO date or null' });
          }
          patch.scheduled_for = new Date(parsedMs).toISOString();
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

        if (!hasEditableQueuePayload(current as { media_type?: unknown; media_url?: unknown })) {
          return res.status(400).json({ error: 'In-place edit currently supports only text-only messages' });
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
        if (targetType === 'status') {
          return res.status(400).json({ error: 'In-place edit is not supported for status messages' });
        }

        const jid = normalizeTargetJid(targetRow as { phone_number?: string | null; type?: string | null });
        if (!jid) {
          return res.status(400).json({ error: 'Could not build WhatsApp JID for sent message edit' });
        }

        const whatsapp = req.app.locals.whatsapp as
          | {
              getStatus?: () => { status?: string | null };
              editMessage?: (jid: string, messageId: string, content: string | Record<string, unknown>) => Promise<unknown>;
            }
          | undefined;
        const waStatus = String(whatsapp?.getStatus?.().status || '').toLowerCase();
        if (!whatsapp || typeof whatsapp.editMessage !== 'function' || waStatus !== 'connected') {
          return res.status(400).json({ error: 'WhatsApp is not connected; cannot perform in-place edit' });
        }

        try {
          const editableContent = await buildEditableMessageContent({
            jid,
            text: normalizedMessageContent,
            mediaUrl: String((current as { media_url?: string | null }).media_url || '').trim() || null,
            mediaType: String((current as { media_type?: string | null }).media_type || '').trim() || null
          });
          await whatsapp.editMessage(jid, whatsappMessageId, editableContent);
        } catch (waError) {
          return res.status(400).json({ error: getErrorMessage(waError) || 'Failed to edit WhatsApp message in-place' });
        }

        patch.corrected_at = new Date().toISOString();
        patch.correction_kind = 'manual_edit';
        patch.correction_error = null;
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
        .in('status', ['awaiting_approval', 'pending', 'failed', 'uncertain'])
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
      if (!['failed', 'skipped', 'uncertain'].includes(currentStatus)) {
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
        .in('status', ['failed', 'skipped', 'uncertain'])
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
      const supabase = getDb();
      const result = await sendQueueLogNow(req.params.id, req.app.locals.whatsapp);
      const { data: storedRow, error: storedRowError } = await supabase
        .from('message_logs')
        .select('id,status,whatsapp_message_id,media_sent,error_message,media_error')
        .eq('id', req.params.id)
        .maybeSingle();
      if (storedRowError) throw storedRowError;
      const response = buildQueueSendNowResponse(result as QueueSendNowResult, storedRow as QueueSendNowStoredRow | null);
      return res.status(response.httpStatus).json(response.body);
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
module.exports.__testUtils = {
  parseWindowHours,
  isRetryableQueueRow,
  shouldLimitQueueStatusToRecentHistory,
  buildCombinedQueueFilter,
  buildQueueSendNowResponse,
  hasEditableQueuePayload,
  isInlineMediaDataUrl,
  isStoredMediaReference,
  sanitizeMediaUrlForApi
};
