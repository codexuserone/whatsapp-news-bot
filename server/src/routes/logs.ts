import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const logRoutes = () => {
  const router = express.Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      if (!supabase) return res.status(503).json({ error: 'Database not available' });
      
      const {
        status,
        schedule_id: scheduleId,
        target_id: targetId,
        feed_item_id: feedItemId,
        verify_delivery: verifyDelivery
      } = req.query;
      const statusFilter = typeof status === 'string' ? status : undefined;
      const scheduleFilter = typeof scheduleId === 'string' ? scheduleId : undefined;
      const targetFilter = typeof targetId === 'string' ? targetId : undefined;
      const feedItemFilter = typeof feedItemId === 'string' ? feedItemId : undefined;
      const shouldVerifyDelivery = String(verifyDelivery || '').toLowerCase() === 'true';
      const includeManual = String(req.query.include_manual || '').toLowerCase() === 'true';
      
      let query = supabase
        .from('message_logs')
        .select(`
          *,
          schedule:schedules(id, name),
          feed_item:feed_items(id, title, link),
          target:targets(id, name, phone_number),
          template:templates(id, name)
        `)
        .order('created_at', { ascending: false })
        .limit(200);
      
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
      
      const { data: logs, error } = await query;
      
      if (error) throw error;

      if (!shouldVerifyDelivery) {
        return res.json(logs);
      }

      const messageIds = (logs || [])
        .map((row: Record<string, unknown>) => String(row?.whatsapp_message_id || '').trim())
        .filter(Boolean);

      if (!messageIds.length) {
        return res.json(logs);
      }

      const { data: seenRows } = await supabase
        .from('chat_messages')
        .select('whatsapp_id,timestamp,remote_jid,from_me')
        .in('whatsapp_id', messageIds)
        .eq('from_me', true);

      const seenByMessageId = new Map(
        (seenRows || [])
          .map((row: Record<string, unknown>) => {
            const messageId = String(row?.whatsapp_id || '').trim();
            if (!messageId) return null;
            return [
              messageId,
              {
                observed_at: row?.timestamp || null,
                observed_remote_jid: row?.remote_jid || null
              }
            ] as const;
          })
          .filter(Boolean) as ReadonlyArray<readonly [string, { observed_at: unknown; observed_remote_jid: unknown }]>
      );

      const verifiedLogs = (logs || []).map((row: Record<string, unknown>) => {
        const messageId = String(row?.whatsapp_message_id || '').trim();
        if (!messageId) {
          return { ...row, delivery_observed: false, observed_at: null, observed_remote_jid: null };
        }
        const observed = seenByMessageId.get(messageId);
        return {
          ...row,
          delivery_observed: Boolean(observed),
          observed_at: observed?.observed_at || null,
          observed_remote_jid: observed?.observed_remote_jid || null
        };
      });

      res.json(verifiedLogs);
    } catch (error) {
      console.error('Error fetching logs:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = logRoutes;
