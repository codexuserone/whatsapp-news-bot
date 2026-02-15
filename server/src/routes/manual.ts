import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { serviceUnavailable } = require('../core/errors');
const { validate, schemas } = require('../middleware/validation');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { encodeManualMessageContent } = require('../utils/manualMeta');
const { sendQueueLogNow } = require('../services/queueService');

type ManualPostBody = {
  target_id?: string | null;
  target_ids?: string[];
  message?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  disableLinkPreview?: boolean;
  includeCaption?: boolean;
};

const manualRoutes = () => {
  const router = express.Router();

  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

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
    if (videoUrl) {
      return { media_url: videoUrl, media_type: 'video' as const };
    }
    if (imageUrl) {
      return { media_url: imageUrl, media_type: 'image' as const };
    }
    return { media_url: null, media_type: null };
  };

  const insertManualLogs = async (supabase: ReturnType<typeof getSupabaseClient>, body: ManualPostBody) => {
    const targetIds = buildTargetIds(body);
    if (!targetIds.length) {
      throw new Error('target_id or target_ids is required');
    }

    const messageRaw = typeof body.message === 'string' ? body.message : null;
    const media = buildMediaFields(body);
    const disableLinkPreview = body.disableLinkPreview === true;
    const includeCaption = body.includeCaption !== false;
    const message = encodeManualMessageContent(messageRaw, { disableLinkPreview, includeCaption });

    const rows = targetIds.map((targetId) => ({
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
      media_error: null
    }));

    const { data: inserted, error } = await supabase
      .from('message_logs')
      .insert(rows)
      .select('id,target_id,status,created_at');

    if (error) throw error;
    return (inserted || []) as Array<{ id: string; target_id: string; status: string; created_at: string }>;
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
      const results: Array<{ id: string; ok: boolean; messageId?: string | null; mediaSent?: boolean; error?: string }> = [];

      for (const item of inserted) {
        // eslint-disable-next-line no-await-in-loop
        const sent = await sendQueueLogNow(item.id, whatsappClient as never);
        if (sent && (sent as { ok?: boolean }).ok) {
          results.push({
            id: item.id,
            ok: true,
            messageId: (sent as { messageId?: string | null }).messageId || null,
            mediaSent: Boolean((sent as { mediaSent?: unknown }).mediaSent)
          });
        } else {
          results.push({
            id: item.id,
            ok: false,
            error: (sent as { error?: string | null })?.error || 'Send failed'
          });
        }
      }

      res.json({
        ok: results.every((row) => row.ok),
        queued: inserted.length,
        sent: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok).length,
        results
      });
    } catch (error) {
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = manualRoutes;
