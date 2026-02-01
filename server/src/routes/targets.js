const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { validate, schemas, sanitizePhoneNumber } = require('../middleware/validation');

const targetRoutes = () => {
  const router = express.Router();
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Database not available');
    return supabase;
  };

  router.get('/', async (_req, res) => {
    try {
      const { data: targets, error } = await getDb()
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

  const normalizeTargetPayload = (payload) => {
    const next = { ...payload };
    if (next.type === 'status') {
      next.phone_number = 'status@broadcast';
      return next;
    }
    if (next.type === 'individual' && typeof next.phone_number === 'string') {
      next.phone_number = sanitizePhoneNumber(next.phone_number);
    } else if (typeof next.phone_number === 'string') {
      next.phone_number = next.phone_number.trim();
    }
    return next;
  };

  router.post('/', validate(schemas.target), async (req, res) => {
    try {
      const payload = normalizeTargetPayload(req.body);
      const { data: target, error } = await getDb()
        .from('targets')
        .insert(payload)
        .select()
        .single();
      
      if (error) throw error;
      res.json(target);
    } catch (error) {
      console.error('Error creating target:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', validate(schemas.target), async (req, res) => {
    try {
      const payload = normalizeTargetPayload(req.body);
      const { data: target, error } = await getDb()
        .from('targets')
        .update(payload)
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
      const { error } = await getDb()
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
