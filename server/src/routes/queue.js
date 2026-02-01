const express = require('express');
const { getSupabaseClient } = require('../db/supabase');

const queueRoutes = () => {
  const router = express.Router();

  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Database not available');
    return supabase;
  };

  // Get queue items with optional status filter
  router.get('/', async (req, res) => {
    try {
      const supabase = getDb();
      const { status } = req.query;

      let query = supabase
        .from('message_logs')
        .select(`
          *,
          schedule:schedules(id, name),
          feed_item:feed_items(id, title, link),
          target:targets(id, name, phone_number)
        `)
        .order('created_at', { ascending: false })
        .limit(200);

      if (status) {
        query = query.eq('status', status);
      }

      const { data: items, error } = await query;

      if (error) throw error;
      const normalizedItems = (items || []).map((item) => ({
        ...item,
        title: item.feed_item?.title,
        url: item.feed_item?.link,
        rendered_content: item.message_content,
        schedule_name: item.schedule?.name,
        target_name: item.target?.name
      }));
      res.json(normalizedItems);
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
        // Safety: require a status to clear
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
        .update({ status: 'pending', error_message: null, sent_at: null, whatsapp_message_id: null })
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
      
      const [pending, sent, failed, skipped] = await Promise.all([
        supabase.from('message_logs').select('id', { count: 'exact' }).eq('status', 'pending'),
        supabase.from('message_logs').select('id', { count: 'exact' }).eq('status', 'sent'),
        supabase.from('message_logs').select('id', { count: 'exact' }).eq('status', 'failed'),
        supabase.from('message_logs').select('id', { count: 'exact' }).eq('status', 'skipped')
      ]);

      res.json({
        pending: pending.count || 0,
        sent: sent.count || 0,
        failed: failed.count || 0,
        skipped: skipped.count || 0,
        total: (pending.count || 0) + (sent.count || 0) + (failed.count || 0) + (skipped.count || 0)
      });
    } catch (error) {
      console.error('Error fetching queue stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = queueRoutes;
