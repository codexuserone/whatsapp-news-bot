const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { sendQueuedForSchedule } = require('../services/queueService');
const { initSchedulers } = require('../services/schedulerService');

const scheduleRoutes = () => {
  const router = express.Router();
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Database not available');
    return supabase;
  };

  router.get('/', async (_req, res) => {
    try {
      const supabase = getDb();
      const { data: schedules, error } = await supabase
        .from('schedules')
        .select(`
          *,
          feed:feeds(id, name, url),
          template:templates(id, name, content)
        `)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      // Fetch targets for each schedule
      const schedulesWithTargets = await Promise.all(
        schedules.map(async (schedule) => {
          if (schedule.target_ids && schedule.target_ids.length > 0) {
            const { data: targets } = await getDb()
              .from('targets')
              .select('id, name, phone_number, type')
              .in('id', schedule.target_ids);
            return { ...schedule, targets: targets || [] };
          }
          return { ...schedule, targets: [] };
        })
      );
      
      res.json(schedulesWithTargets);
    } catch (error) {
      console.error('Error fetching schedules:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { data: schedule, error } = await getDb()
        .from('schedules')
        .insert(req.body)
        .select()
        .single();
      
      if (error) throw error;
      await initSchedulers(req.app.locals.whatsapp);
      res.json(schedule);
    } catch (error) {
      console.error('Error creating schedule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const { data: schedule, error } = await getDb()
        .from('schedules')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      await initSchedulers(req.app.locals.whatsapp);
      res.json(schedule);
    } catch (error) {
      console.error('Error updating schedule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const { error } = await getDb()
        .from('schedules')
        .delete()
        .eq('id', req.params.id);
      
      if (error) throw error;
      await initSchedulers(req.app.locals.whatsapp);
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting schedule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/:id/dispatch', async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const result = await sendQueuedForSchedule(req.params.id, whatsapp);
      res.json(result);
    } catch (error) {
      console.error('Error dispatching schedule:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = scheduleRoutes;
