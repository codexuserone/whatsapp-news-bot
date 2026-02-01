const express = require('express');
const { getSupabaseClient } = require('../db/supabase');

const queueRoutes = () => {
  const router = express.Router();

  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Database not available');
    return supabase;
  };

  // Get queue items (message_logs) with optional status filter
  // Joins feed_items for title/url, uses message_logs for the queue
  router.get('/', async (req, res) => {
    try {
      const supabase = getDb();
      const { status } = req.query;

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
          sent_at,
          created_at,
          feed_items (
            title,
            link
          )
        `)
        .order('created_at', { ascending: false })
        .limit(100);

      if (status) {
        query = query.eq('status', status);
      }

      const { data: rows, error } = await query;

      if (error) throw error;

      const items = (rows || []).map((row) => ({
        id: row.id,
        schedule_id: row.schedule_id,
        target_id: row.target_id,
        title: row.feed_items?.title || 'No title',
        url: row.feed_items?.link || null,
        rendered_content: row.message_content,
        status: row.status,
        error_message: row.error_message,
        sent_at: row.sent_at,
        created_at: row.created_at,
        scheduled_for: null
      }));

      res.json(items);
    } catch (error) {
      console.error('Error fetching queue:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete a queue item
  router.delete('/:id', async (req, res) => {
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
      res.status(500).json({ error: error.message });
    }
  });

  // Clear queue items by status
  router.delete('/clear', async (req, res) => {
    try {
      const supabase = getDb();
      const { status } = req.query;

      let query = supabase.from('message_logs').delete();

      if (status) {
        query = query.eq('status', status);
      } else {
        return res.status(400).json({ error: 'Status parameter required' });
      }

      const { error } = await query;

      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      console.error('Error clearing queue:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Retry failed items
  router.post('/retry-failed', async (req, res) => {
    try {
      const supabase = getDb();

      const { data, error } = await supabase
        .from('message_logs')
        .update({ status: 'pending', error_message: null, retry_count: 0 })
        .eq('status', 'failed')
        .select();

      if (error) throw error;
      res.json({ success: true, count: data?.length || 0 });
    } catch (error) {
      console.error('Error retrying failed items:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get queue statistics
  router.get('/stats', async (req, res) => {
    try {
      const supabase = getDb();

      const [pendingRes, sentRes, failedRes, skippedRes] = await Promise.all([
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('status', 'sent'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
        supabase.from('message_logs').select('*', { count: 'exact', head: true }).eq('status', 'skipped')
      ]);

      const pCount = pendingRes.count ?? 0;
      const sCount = sentRes.count ?? 0;
      const fCount = failedRes.count ?? 0;
      const skCount = skippedRes.count ?? 0;

      res.json({
        pending: pCount,
        sent: sCount,
        failed: fCount,
        skipped: skCount,
        total: pCount + sCount + fCount + skCount
      });
    } catch (error) {
      console.error('Error fetching queue stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = queueRoutes;
