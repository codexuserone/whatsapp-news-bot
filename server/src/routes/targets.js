const express = require('express');
const { supabase } = require('../db/supabase');

const targetRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const { data: targets, error } = await supabase
        .from('targets')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(targets);
    } catch (error) {
      console.error('Error fetching targets:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { data: target, error } = await supabase
        .from('targets')
        .insert(req.body)
        .select()
        .single();
      
      if (error) throw error;
      res.json(target);
    } catch (error) {
      console.error('Error creating target:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { data: target, error } = await supabase
        .from('targets')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      res.json(target);
    } catch (error) {
      console.error('Error updating target:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await supabase
        .from('targets')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting target:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = targetRoutes;
