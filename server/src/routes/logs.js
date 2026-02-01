const express = require('express');
const { supabase } = require('../db/supabase');

const logRoutes = () => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { status } = req.query;
      
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
      
      if (status) {
        query = query.eq('status', status);
      }
      
      const { data: logs, error } = await query;
      
      if (error) throw error;
      res.json(logs);
    } catch (error) {
      console.error('Error fetching logs:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = logRoutes;
