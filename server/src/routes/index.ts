import type { Express, Request, Response } from 'express';
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('../openapi');
const { testConnection } = require('../db/supabase');
const whatsappRoutes = require('./whatsapp');
const feedsRoutes = require('./feeds');
const templatesRoutes = require('./templates');
const targetsRoutes = require('./targets');
const schedulesRoutes = require('./schedules');
const settingsRoutes = require('./settings');
const logsRoutes = require('./logs');
const feedItemsRoutes = require('./feedItems');
const shabbosRoutes = require('./shabbos');
const queueRoutes = require('./queue');

const registerRoutes = (app: Express) => {
  const router = express.Router();

  router.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));
  router.get('/ping', (_req: Request, res: Response) => res.json({ ok: true, uptime: process.uptime() }));
  router.get('/ready', async (req: Request, res: Response) => {
    const dbOk = await testConnection();
    const whatsappStatus = req.app.locals.whatsapp?.getStatus?.();
    const whatsappOk = whatsappStatus?.status === 'connected';
    res.json({ ok: dbOk && whatsappOk, db: dbOk, whatsapp: whatsappStatus?.status || 'unknown' });
  });

  router.get('/api/openapi.json', (_req: Request, res: Response) => res.json(openapi));
  router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));

  router.use('/api/whatsapp', whatsappRoutes());
  router.use('/api/feeds', feedsRoutes());
  router.use('/api/templates', templatesRoutes());
  router.use('/api/targets', targetsRoutes());
  router.use('/api/schedules', schedulesRoutes());
  router.use('/api/settings', settingsRoutes());
  router.use('/api/logs', logsRoutes());
  router.use('/api/feed-items', feedItemsRoutes());
  router.use('/api/shabbos', shabbosRoutes());
  router.use('/api/queue', queueRoutes());

  app.use(router);
};

module.exports = registerRoutes;
