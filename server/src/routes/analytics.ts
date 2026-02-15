import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const SUCCESSFUL_SEND_STATUSES = ['sent', 'delivered', 'read', 'played'];

const analyticsRoutes = () => {
  const router = express.Router();

  router.get('/delivery', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      if (!supabase) throw serviceUnavailable('Database not available');

      const rawWindowHours = Number(req.query.window_hours);
      const windowHours = Number.isFinite(rawWindowHours) && rawWindowHours > 0
        ? Math.min(Math.round(rawWindowHours), 168)
        : 24;
      const windowStartIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

      const countSince = async (field: 'created_at' | 'sent_at', statuses: string[]) => {
        const query = supabase
          .from('message_logs')
          .select('id', { count: 'exact', head: true })
          .in('status', statuses)
          .gte(field, windowStartIso);
        const { count, error } = await query;
        if (error) throw error;
        return Number(count || 0);
      };

      const countCreatedSince = async (status: string) => {
        const query = supabase
          .from('message_logs')
          .select('id', { count: 'exact', head: true })
          .eq('status', status)
          .gte('created_at', windowStartIso);
        const { count, error } = await query;
        if (error) throw error;
        return Number(count || 0);
      };

      const [sent, delivered, read, played, failed, skipped] = await Promise.all([
        countSince('sent_at', SUCCESSFUL_SEND_STATUSES),
        countSince('sent_at', ['delivered', 'read', 'played']),
        countSince('sent_at', ['read', 'played']),
        countSince('sent_at', ['played']),
        countCreatedSince('failed'),
        countCreatedSince('skipped')
      ]);

      const safeRate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : 0);

      res.json({
        window_hours: windowHours,
        window_start: windowStartIso,
        sent,
        delivered,
        read,
        played,
        failed,
        skipped,
        delivered_rate: safeRate(delivered, sent),
        read_rate: safeRate(read, sent),
        played_rate: safeRate(played, sent)
      });
    } catch (error) {
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = analyticsRoutes;

