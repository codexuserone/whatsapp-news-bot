const express = require('express');
const whatsappRoutes = require('./whatsapp');
const feedsRoutes = require('./feeds');
const templatesRoutes = require('./templates');
const targetsRoutes = require('./targets');
const schedulesRoutes = require('./schedules');
const settingsRoutes = require('./settings');
const logsRoutes = require('./logs');
const feedItemsRoutes = require('./feedItems');
const shabbosRoutes = require('./shabbos');

const registerRoutes = (app) => {
  const router = express.Router();

  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.get('/ping', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  router.use('/api/whatsapp', whatsappRoutes());
  router.use('/api/feeds', feedsRoutes());
  router.use('/api/templates', templatesRoutes());
  router.use('/api/targets', targetsRoutes());
  router.use('/api/schedules', schedulesRoutes());
  router.use('/api/settings', settingsRoutes());
  router.use('/api/logs', logsRoutes());
  router.use('/api/feed-items', feedItemsRoutes());
  router.use('/api/shabbos', shabbosRoutes());

  app.use(router);
};

module.exports = registerRoutes;
