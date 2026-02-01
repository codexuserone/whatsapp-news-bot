const express = require('express');
const { supabase } = require('../db/supabase');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('../services/feedProcessor');
const { initSchedulers, triggerImmediateSchedules } = require('../services/schedulerService');

const feedsRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const { data: feeds, error } = await supabase
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
      const { data: feed, error } = await supabase
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
      const { data: feed, error } = await supabase
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
      const { error } = await supabase
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
      const { data: feed, error } = await supabase
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
