import type { Express, Request, Response } from 'express';
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('../openapi');
const { testConnection } = require('../db/supabase');
const { apiRateLimit, feedRateLimit } = require('../middleware/rateLimiter');
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

  router.get('/health', (_req: Request, res: Response) => res.json({ ok: true, type: 'liveness' }));
  router.get('/health/live', (_req: Request, res: Response) => res.json({ ok: true, type: 'liveness' }));
  router.get('/ping', (_req: Request, res: Response) => res.json({ ok: true, uptime: process.uptime() }));

  const readyHandler = async (req: Request, res: Response) => {
    const startup = (req.app.locals.startup || {}) as Record<string, unknown>;
    const migrationsRequired = Boolean(startup.migrationsRequired);
    const migrationsOk = migrationsRequired ? startup.migrationsOk === true : true;
    const migrationsError = startup.migrationsError ? String(startup.migrationsError) : null;
    const bootCompleted = startup.bootCompleted === true;
    const dbOk = await testConnection();

    const whatsappStatus = req.app.locals.whatsapp?.getStatus?.();
    const whatsappEnabled = req.app.locals.whatsapp != null;
    const leaseInfo = whatsappStatus?.lease || { supported: false, held: false, ownerId: null, expiresAt: null };
    const whatsappConnected = whatsappStatus?.status === 'connected';
    const whatsappLeaseOk = !leaseInfo.supported || Boolean(leaseInfo.held);
    const whatsappOk = !whatsappEnabled || (whatsappConnected && whatsappLeaseOk);

    const requireWhatsAppReady = process.env.REQUIRE_WHATSAPP_READY === 'true';
    const requireBootCompleted = process.env.NODE_ENV === 'production';
    const ok =
      (!requireBootCompleted || bootCompleted) &&
      dbOk &&
      migrationsOk &&
      (!requireWhatsAppReady || whatsappOk);

    res.status(ok ? 200 : 503).json({
      ok,
      type: 'readiness',
      bootCompleted,
      db: dbOk,
      migrations: {
        required: migrationsRequired,
        ok: migrationsOk,
        error: migrationsError
      },
      whatsapp: {
        required: requireWhatsAppReady,
        enabled: whatsappEnabled,
        status: whatsappStatus?.status || 'disabled',
        lease: leaseInfo,
        ok: whatsappOk
      }
    });
  };

  router.get('/ready', async (req: Request, res: Response) => {
    await readyHandler(req, res);
  });
  router.get('/health/ready', async (req: Request, res: Response) => {
    await readyHandler(req, res);
  });

  router.get('/version', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null,
      service: process.env.RENDER_SERVICE_NAME || null,
      node: process.version
    });
  });

  router.get('/api/openapi.json', (_req: Request, res: Response) => res.json(openapi));
  router.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));

  // Apply rate limiting to API routes
  // Health and ready endpoints are intentionally excluded
  router.use('/api/whatsapp', apiRateLimit, whatsappRoutes());
  router.use('/api/feeds', feedRateLimit, feedsRoutes());
  router.use('/api/templates', apiRateLimit, templatesRoutes());
  router.use('/api/targets', apiRateLimit, targetsRoutes());
  router.use('/api/schedules', apiRateLimit, schedulesRoutes());
  router.use('/api/settings', apiRateLimit, settingsRoutes());
  router.use('/api/logs', apiRateLimit, logsRoutes());
  router.use('/api/feed-items', apiRateLimit, feedItemsRoutes());
  router.use('/api/shabbos', apiRateLimit, shabbosRoutes());
  router.use('/api/queue', apiRateLimit, queueRoutes());

  app.use(router);
};

module.exports = registerRoutes;
