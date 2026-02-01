const express = require('express');
const { getClient } = require('../db/supabase');
const whatsappRoutes = require('./whatsapp');
const feedsRoutes = require('./feeds');
const templatesRoutes = require('./templates');
const targetsRoutes = require('./targets');
const schedulesRoutes = require('./schedules');
const settingsRoutes = require('./settings');
const logsRoutes = require('./logs');
const feedItemsRoutes = require('./feedItems');

const registerRoutes = (app) => {
  const router = express.Router();

  router.get('/health', async (_req, res) => {
    try {
      const { error } = await getClient().from('documents').select('id').limit(1);
      if (error) {
        return res.status(503).json({ ok: false, supabase: false, error: 'supabase_unavailable' });
      }
      return res.json({ ok: true, supabase: true });
    } catch (err) {
      return res.status(503).json({ ok: false, supabase: false, error: 'supabase_unavailable' });
    }
  });
  router.get('/ping', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  router.use('/api/whatsapp', whatsappRoutes());
  router.use('/api/feeds', feedsRoutes());
  router.use('/api/templates', templatesRoutes());
  router.use('/api/targets', targetsRoutes());
  router.use('/api/schedules', schedulesRoutes());
  router.use('/api/settings', settingsRoutes());
  router.use('/api/logs', logsRoutes());
  router.use('/api/feed-items', feedItemsRoutes());

  app.use(router);
};

module.exports = registerRoutes;
