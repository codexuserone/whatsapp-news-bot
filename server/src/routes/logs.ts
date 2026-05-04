import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { buildQueuedAutomationPreview } = require('../services/queueService');
const { isStoredMediaReference, sanitizeMediaUrlForApi } = require('../utils/mediaUrlPresentation');

const SUCCESSFUL_SEND_STATUSES = ['sent', 'delivered', 'read', 'played'];
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 200;

const parseLogLimit = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LOG_LIMIT);
};

const resolveLogTargetState = (row: Record<string, unknown>) => {
  const target = row.target as { active?: boolean | null } | null | undefined;
  const schedule = row.schedule as { target_ids?: unknown[] | null } | null | undefined;

  const targetActive = target?.active !== false;
  if (row.schedule_id == null || row.target_id == null) {
    return {
      target_active: targetActive,
      target_in_current_schedule: true
    };
  }

  if (!Array.isArray(schedule?.target_ids)) {
    return {
      target_active: targetActive,
      target_in_current_schedule: null
    };
  }

  const targetId = String(row.target_id);
  return {
    target_active: targetActive,
    target_in_current_schedule: schedule.target_ids.some((id) => String(id) === targetId)
  };
};

const finalizeLog = (row: Record<string, unknown>) => {
  const rawMediaUrl = row.media_url || null;
  return {
    ...row,
    ...resolveLogTargetState(row),
    media_url: sanitizeMediaUrlForApi(rawMediaUrl),
    media_stored: isStoredMediaReference(rawMediaUrl)
  };
};

const logRoutes = () => {
  const router = express.Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      if (!supabase) return res.status(503).json({ error: 'Database not available' });
      
      const { status } = req.query;
      const statusFilter = typeof status === 'string' ? status : undefined;
      const includeQueue = String(req.query.include_queue || '').toLowerCase() === 'true';
      
      let query = supabase
        .from('message_logs')
        .select(`
          *,
          schedule:schedules(id, name, target_ids),
          feed_item:feed_items(id, title, link, description, content, author, image_url, media_url, media_kind, media_mime, media_filename, raw_data),
          target:targets(id, name, phone_number, type, active),
          template:templates(id, name, content, send_images, send_mode, media_source, sequence_steps, status_background_color, status_font)
        `)
        .order('created_at', { ascending: false })
        .limit(parseLogLimit(req.query.limit));
      
      if (statusFilter) {
        if (statusFilter === 'sent') {
          query = query.in('status', SUCCESSFUL_SEND_STATUSES);
        } else {
          query = query.eq('status', statusFilter);
        }
      } else if (!includeQueue) {
        // Logs page is delivery history by default. Queue/processing states belong in /api/queue.
        query = query.not('status', 'in', '("awaiting_approval","pending","processing")');
      }
      
      const { data: logs, error } = await query;
      
      if (error) throw error;

      const enrichedLogs = (logs || []).map((log: Record<string, unknown>) => {
        if (log.schedule_id == null) return finalizeLog(log);
        const template = log.template as Record<string, unknown> | null | undefined;
        const feedItem = log.feed_item as Record<string, unknown> | null | undefined;
        if (!template?.content || !feedItem) return finalizeLog(log);

        try {
          const preview = buildQueuedAutomationPreview(log, template, {
            ...feedItem,
            id: log.feed_item_id
          });
          return finalizeLog({
            ...log,
            message_content: log.message_content || preview.text || null,
            media_url: log.media_url || preview.mediaUrl || null,
            media_type: log.media_type || preview.mediaType || null
          });
        } catch {
          return finalizeLog(log);
        }
      });

      res.json(enrichedLogs);
    } catch (error) {
      console.error('Error fetching logs:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = logRoutes;
module.exports.__testUtils = {
  parseLogLimit,
  resolveLogTargetState,
  finalizeLog
};
