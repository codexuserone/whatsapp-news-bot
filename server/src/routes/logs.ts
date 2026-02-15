import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const SUCCESSFUL_SEND_STATUSES = ['sent', 'delivered', 'read', 'played'];

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
          schedule:schedules(id, name),
          feed_item:feed_items(id, title, link),
          target:targets(id, name, phone_number),
          template:templates(id, name)
        `)
        .order('created_at', { ascending: false })
        .limit(200);
      
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
      res.json(logs);
    } catch (error) {
      console.error('Error fetching logs:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = logRoutes;
