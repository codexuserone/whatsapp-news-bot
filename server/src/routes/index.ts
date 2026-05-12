import type { Express, Request, Response } from 'express';
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const openapi = require('../openapi');
const { getSupabaseHealthState, testConnection } = require('../db/supabase');
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
const analyticsRoutes = require('./analytics');
const manualRoutes = require('./manual');

const READY_DB_CACHE_TTL_MS = Math.max(Number(process.env.READY_DB_CACHE_TTL_MS || 30_000), 5_000);
let readyDbCache: { checkedAtMs: number; ok: boolean; state: unknown } | null = null;

const getReadyDbState = async () => {
  const now = Date.now();
  if (readyDbCache && now - readyDbCache.checkedAtMs < READY_DB_CACHE_TTL_MS) {
    return readyDbCache;
  }

  const ok = await testConnection();
  readyDbCache = {
    checkedAtMs: now,
    ok,
    state: getSupabaseHealthState?.()
  };
  return readyDbCache;
};

const registerRoutes = (app: Express) => {
  const router = express.Router();

  router.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));
  router.get('/ping', (_req: Request, res: Response) => res.json({ ok: true, uptime: process.uptime() }));

  // Keep these probe endpoints in sync with middleware/publicProbePaths.ts
  router.get('/api/health', (_req: Request, res: Response) => res.json({ ok: true }));
  router.get('/api/ping', (_req: Request, res: Response) => res.json({ ok: true, uptime: process.uptime() }));
  router.get('/ready', async (req: Request, res: Response) => {
    const dbReady = await getReadyDbState();
    const dbOk = dbReady.ok;
    const whatsappStatus = req.app.locals.whatsapp?.getStatus?.();
    const whatsappOk = whatsappStatus?.status === 'connected';
    res.json({
      ok: dbOk && whatsappOk,
      db: dbOk,
      dbState: dbReady.state,
      whatsapp: whatsappStatus?.status || 'unknown'
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
  router.use('/api/analytics', apiRateLimit, analyticsRoutes());
  router.use('/api/manual', apiRateLimit, manualRoutes());

  app.use(router);
};

module.exports = registerRoutes;
