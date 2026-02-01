const express = require('express');
const { supabase } = require('../db/supabase');

const feedItemRoutes = () => {
  const router = express.Router();

  // Get all feed items with feed information
  router.get('/', async (_req, res) => {
    try {
      const { data: items, error } = await supabase
        .from('feed_items')
        .select(`
          *,
          feed:feeds(id, name, url, type)
        `)
        .order('created_at', { ascending: false })
        .limit(200);
      
      if (error) throw error;
      res.json(items);
    } catch (error) {
      console.error('Error fetching feed items:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get feed items by feed ID
  router.get('/by-feed/:feedId', async (req, res) => {
    try {
      const { data: items, error } = await supabase
        .from('feed_items')
        .select('*')
        .eq('feed_id', req.params.feedId)
        .order('pub_date', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      res.json(items);
    } catch (error) {
      console.error('Error fetching feed items by feed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get available fields/variables from feed items for template usage
  router.get('/available-fields', async (_req, res) => {
    try {
      // Get a sample of recent feed items to extract available fields
      const { data: items, error } = await supabase
        .from('feed_items')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (error) throw error;
      
      // Extract all unique fields from items
      const fields = new Set(['title', 'description', 'content', 'link', 'author', 'pub_date', 'image_url']);
      
      items.forEach(item => {
        // Add fields from raw_data if available
        if (item.raw_data && typeof item.raw_data === 'object') {
          Object.keys(item.raw_data).forEach(key => fields.add(key));
        }
        // Add categories if available
        if (item.categories && item.categories.length > 0) {
          fields.add('categories');
        }
      });
      
      res.json(Array.from(fields).sort());
    } catch (error) {
      console.error('Error fetching available fields:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = feedItemRoutes;
