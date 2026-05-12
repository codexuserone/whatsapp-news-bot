import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { serviceUnavailable } = require('../core/errors');
const { validate, schemas } = require('../middleware/validation');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { encodeManualMessageContent } = require('../utils/manualMeta');
const { sanitizeSendErrorForApi } = require('../utils/sendErrorPresentation');
const { sendQueueLogNow } = require('../services/queueService');

type ManualPostBody = {
  target_id?: string | null;
  target_ids?: string[];
  message?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  audioUrl?: string | null;
  documentUrl?: string | null;
  imageDataUrl?: string | null;
  videoDataUrl?: string | null;
  audioDataUrl?: string | null;
  documentDataUrl?: string | null;
  disableLinkPreview?: boolean;
  includeCaption?: boolean;
  documentFilename?: string | null;
  documentMime?: string | null;
};

type ManualInsertedRow = {
  id: string;
  target_id?: string | null;
  status?: string | null;
  created_at?: string | null;
};

type ManualStoredSendRow = {
  id: string;
  status?: string | null;
  whatsapp_message_id?: string | null;
  media_sent?: boolean | null;
  error_message?: string | null;
  media_error?: string | null;
};

type ManualSendServiceResult = {
  ok?: boolean;
  held?: boolean;
  status?: string | null;
  messageId?: string | null;
  mediaSent?: boolean | null;
  error?: string | null;
};

const SUCCESSFUL_MANUAL_SEND_STATUSES = new Set(['sent', 'delivered', 'read', 'played']);

const normalizeManualStatus = (value: unknown) => String(value || '').trim().toLowerCase();

const buildTargetIds = (body: ManualPostBody) => {
  const ids = Array.isArray(body.target_ids) ? body.target_ids : [];
  const single = String(body.target_id || '').trim();
  const combined = [...ids, ...(single ? [single] : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  return Array.from(new Set(combined));
};

const buildMediaFields = (body: ManualPostBody) => {
  const imageUrl = String(body.imageUrl || '').trim();
  const videoUrl = String(body.videoUrl || '').trim();
  const audioUrl = String(body.audioUrl || '').trim();
  const documentUrl = String(body.documentUrl || '').trim();
  const imageDataUrl = String(body.imageDataUrl || '').trim();
  const videoDataUrl = String(body.videoDataUrl || '').trim();
  const audioDataUrl = String(body.audioDataUrl || '').trim();
  const documentDataUrl = String(body.documentDataUrl || '').trim();
  if (documentDataUrl) {
    return { media_url: documentDataUrl, media_type: 'document' as const };
  }
  if (audioDataUrl) {
    return { media_url: audioDataUrl, media_type: 'audio' as const };
  }
  if (videoDataUrl) {
    return { media_url: videoDataUrl, media_type: 'video' as const };
  }
  if (imageDataUrl) {
    return { media_url: imageDataUrl, media_type: 'image' as const };
  }
  if (documentUrl) {
    return { media_url: documentUrl, media_type: 'document' as const };
  }
  if (audioUrl) {
    return { media_url: audioUrl, media_type: 'audio' as const };
  }
  if (videoUrl) {
    return { media_url: videoUrl, media_type: 'video' as const };
  }
  if (imageUrl) {
    return { media_url: imageUrl, media_type: 'image' as const };
  }
  return { media_url: null, media_type: null };
};

const buildManualLogRows = (body: ManualPostBody) => {
  const targetIds = buildTargetIds(body);
  if (!targetIds.length) {
    throw new Error('target_id or target_ids is required');
  }

  const messageRaw = typeof body.message === 'string' ? body.message : null;
  const media = buildMediaFields(body);
  const disableLinkPreview = body.disableLinkPreview === true;
  const includeCaption = body.includeCaption !== false;
  const message = encodeManualMessageContent(messageRaw, {
    disableLinkPreview,
    includeCaption,
    documentFilename: body.documentFilename || null,
    documentMime: body.documentMime || null
  });

  return targetIds.map((targetId) => ({
    schedule_id: null,
    feed_item_id: null,
    target_id: targetId,
    template_id: null,
    status: 'pending',
    message_content: message,
    error_message: null,
    retry_count: 0,
    processing_started_at: null,
    sent_at: null,
    whatsapp_message_id: null,
    ...media,
    media_sent: false,
    media_error: null,
    disable_link_preview: disableLinkPreview,
    include_caption: includeCaption
  }));
};

const fallbackManualStatus = (result?: ManualSendServiceResult | null) => {
  if (result?.status) return normalizeManualStatus(result.status);
  if (result?.held) return 'awaiting_approval';
  if (result?.ok) return 'sent';
  return 'failed';
};

const buildManualSendResponse = (
  inserted: ManualInsertedRow[],
  storedRows: ManualStoredSendRow[] = [],
  sendResults: Map<string, ManualSendServiceResult> | Record<string, ManualSendServiceResult> = new Map()
) => {
  const storedById = new Map(storedRows.map((row) => [String(row.id), row]));
  const resultForId =
    sendResults instanceof Map
      ? (id: string) => sendResults.get(id)
      : (id: string) => sendResults[id];

  const results = inserted.map((item) => {
    const id = String(item.id);
    const stored = storedById.get(id);
    const sendResult = resultForId(id) || null;
    const rawStatus = normalizeManualStatus(stored?.status) || fallbackManualStatus(sendResult);
    const status = rawStatus === 'uncertain' ? 'failed' : rawStatus;
    const messageId = stored?.whatsapp_message_id || sendResult?.messageId || null;
    const mediaSent = typeof stored?.media_sent === 'boolean' ? stored.media_sent : Boolean(sendResult?.mediaSent);
    const error = sanitizeSendErrorForApi(stored?.error_message || stored?.media_error || sendResult?.error || null);
    return {
      id,
      status,
      ok: SUCCESSFUL_MANUAL_SEND_STATUSES.has(status),
      messageId,
      mediaSent,
      error
    };
  });

  const sent = results.filter((row) => SUCCESSFUL_MANUAL_SEND_STATUSES.has(row.status)).length;
  const held = results.filter((row) => row.status === 'awaiting_approval').length;
  const pending = results.filter((row) => row.status === 'pending').length;
  const processing = results.filter((row) => row.status === 'processing').length;
  const skipped = results.filter((row) => row.status === 'skipped').length;
  const failed = results.filter((row) => row.status === 'failed').length;

  return {
    ok: results.length > 0 && sent === results.length,
    queued: inserted.length,
    sent,
    held,
    pending,
    processing,
    skipped,
    failed,
    results
  };
};

const manualRoutes = () => {
  const router = express.Router();

  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  const insertManualLogs = async (supabase: ReturnType<typeof getSupabaseClient>, body: ManualPostBody) => {
    const rows = buildManualLogRows(body);

    const { data: inserted, error } = await supabase
      .from('message_logs')
      .insert(rows)
      .select('id,target_id,status,created_at');

    if (error) throw error;
    return (inserted || []) as Array<{ id: string; target_id: string; status: string; created_at: string }>;
  };

  const loadManualSendRows = async (supabase: ReturnType<typeof getSupabaseClient>, ids: string[]) => {
    if (!ids.length) return [] as ManualStoredSendRow[];
    const { data, error } = await supabase
      .from('message_logs')
      .select('id,status,whatsapp_message_id,media_sent,error_message,media_error')
      .in('id', ids);

    if (error) throw error;
    return (data || []) as ManualStoredSendRow[];
  };

  router.post('/queue', validate(schemas.manualPost), async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const body = req.body as ManualPostBody;
      const inserted = await insertManualLogs(supabase, body);
      res.json({ ok: true, queued: inserted.length, items: inserted });
    } catch (error) {
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/send', validate(schemas.manualPost), async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const body = req.body as ManualPostBody;
      const inserted = await insertManualLogs(supabase, body);

      const whatsappClient = req.app.locals.whatsapp as unknown;
      const sendResults = new Map<string, ManualSendServiceResult>();

      for (const item of inserted) {
        // eslint-disable-next-line no-await-in-loop
        const sent = await sendQueueLogNow(item.id, whatsappClient as never);
        sendResults.set(item.id, (sent || { ok: false, error: 'Send failed' }) as ManualSendServiceResult);
      }

      const storedRows = await loadManualSendRows(supabase, inserted.map((item) => item.id));
      res.json(buildManualSendResponse(inserted, storedRows, sendResults));
    } catch (error) {
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = manualRoutes;
module.exports.__testUtils = {
  buildManualSendResponse,
  buildMediaFields,
  buildManualLogRows,
  buildTargetIds
};
