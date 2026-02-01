const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('../services/feedProcessor');
const { initSchedulers, triggerImmediateSchedules } = require('../services/schedulerService');
const { fetchFeedItems } = require('../services/feedFetcher');

const feedsRoutes = () => {
  const router = express.Router();

  // Helper to get supabase client
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Database not available');
    return supabase;
  };

  // Test a feed URL without saving - returns detected fields and sample item
  router.post('/test', async (req, res) => {
    try {
      const { url, type = 'rss' } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      // Create a temporary feed object for testing (cleaning is optional, uses defaults)
      const testFeed = { url, type };
      const items = await fetchFeedItems(testFeed);

      if (!items || items.length === 0) {
        return res.json({ error: 'No items found in feed. Check the URL or feed type.' });
      }

      // Detect all fields from the first item
      const sampleItem = items[0];
      const detectedFields = Object.keys(sampleItem).filter(key => {
        const value = sampleItem[key];
        return value !== null && value !== undefined && value !== '' && !Array.isArray(value);
      });

      // Also check for nested/array fields
      Object.keys(sampleItem).forEach(key => {
        if (Array.isArray(sampleItem[key]) && sampleItem[key].length > 0) {
          detectedFields.push(key);
        }
      });

      res.json({
        feedTitle: sampleItem.title ? `Feed from ${new URL(url).hostname}` : 'Unknown Feed',
        itemCount: items.length,
        detectedFields: [...new Set(detectedFields)],
        sampleItem
      });
    } catch (error) {
      console.error('Error testing feed:', error);
      res.json({ error: error.message || 'Failed to fetch feed' });
    }
  });

  router.get('/', async (_req, res) => {
    try {
      const { data: feeds, error } = await getDb()
        .from('feeds')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(feeds);
    } catch (error) {
      console.error('Error fetching feeds:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { data: feed, error } = await getDb()
        .from('feeds')
        .insert(req.body)
        .select()
        .single();
      
      if (error) throw error;
      await initSchedulers(req.app.locals.whatsapp);
      res.json(feed);
    } catch (error) {
      console.error('Error creating feed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { data: feed, error } = await getDb()
        .from('feeds')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      await initSchedulers(req.app.locals.whatsapp);
      res.json(feed);
    } catch (error) {
      console.error('Error updating feed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await getDb()
        .from('feeds')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      await initSchedulers(req.app.locals.whatsapp);
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting feed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/:id/refresh', async (req, res) => {
    try {
      const { data: feed, error } = await getDb()
        .from('feeds')
        .select('*')
        .eq('id', req.params.id)
        .single();
      
      if (error || !feed) {
        res.status(404).json({ error: 'Feed not found' });
        return;
      }
      
      const items = await fetchAndProcessFeed(feed);
      await queueFeedItemsForSchedules(feed.id, items);
      if (items.length) {
        await triggerImmediateSchedules(feed.id, req.app.locals.whatsapp);
      }
      res.json({ ok: true, items });
    } catch (error) {
      console.error('Error refreshing feed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = feedsRoutes;
