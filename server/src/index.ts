import type { Express, Request, Response } from 'express';
const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const logger = require('./utils/logger');
const { testConnection } = require('./db/supabase');
const createWhatsAppClient = require('./whatsapp/client');
const { keepAlive, stopKeepAlive } = require('./services/keepAlive');
const registerRoutes = require('./routes');
const settingsService = require('./services/settingsService');
const { initSchedulers, clearAll } = require('./services/schedulerService');
const { startTargetAutoSync, stopTargetAutoSync } = require('./services/targetSyncService');
const {
  scheduleRetentionCleanup,
  scheduleProcessingWatchdog,
  resetStuckProcessingLogs
} = require('./services/retentionService');
const { runMigrations } = require('./scripts/migrate');
const errorHandler = require('./middleware/errorHandler');
const notFoundHandler = require('./middleware/notFound');
const requestLogger = require('./middleware/requestLogger');

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  logger.error({ err: reason }, 'Unhandled Promise Rejection');
  // Don't exit - let the app continue
});

// Graceful shutdown handlers
const gracefulShutdown = async (
  signal: string,
  whatsappClient?: { disconnect: () => Promise<void> }
) => {
  logger.info({ signal }, 'Starting graceful shutdown...');
  
  try {
    // Clear all intervals and timeouts
    clearAll();
    stopTargetAutoSync();
    stopKeepAlive();
    
    // Disconnect WhatsApp
    if (whatsappClient) {
      await whatsappClient.disconnect();
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
};

let whatsappClientRef: { disconnect: () => Promise<void> } | null = null;

const handleSignal = (signal: string) => {
  void gracefulShutdown(signal, whatsappClientRef || undefined);
};

process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

const start = async () => {
  const app: Express = express();
  app.set('trust proxy', 1);
  app.use(requestLogger);

  // Render environments can lack IPv6 egress; prefer IPv4 to avoid ENETUNREACH on DNS results.
  try {
    const dns = require('dns');
    const setter = (dns as unknown as { setDefaultResultOrder?: (order: string) => void }).setDefaultResultOrder;
    if (typeof setter === 'function') {
      setter('ipv4first');
    }
  } catch {
    // ignore
  }

  // Optional Basic Auth (recommended for public deployments).
  // Enable by setting BASIC_AUTH_USER and BASIC_AUTH_PASS.
  const basicUser = process.env.BASIC_AUTH_USER;
  const basicPass = process.env.BASIC_AUTH_PASS;
  if (basicUser && basicPass) {
    app.use((req: Request, res: Response, next) => {
      const openPaths = new Set(['/health', '/ping', '/ready']);
      if (openPaths.has(req.path)) return next();

      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp News Bot"');
        return res.status(401).send('Authentication required');
      }
      try {
        const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const idx = raw.indexOf(':');
        const user = idx >= 0 ? raw.slice(0, idx) : raw;
        const pass = idx >= 0 ? raw.slice(idx + 1) : '';
        if (user === basicUser && pass === basicPass) {
          return next();
        }
      } catch {
        // ignore
      }

      res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp News Bot"');
      return res.status(401).send('Invalid credentials');
    });
  }

  // CORS: same-origin deployments don't need it. For separate UI deployments (e.g. Vercel),
  // set CORS_ORIGINS to a comma-separated allowlist of origins.
  const corsOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';
  app.use(
    cors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Non-browser clients (curl, server-to-server) typically omit Origin.
        if (!origin) return callback(null, true);

        // Dev defaults to permissive unless an allowlist is provided.
        if (!isProd && corsOrigins.length === 0) return callback(null, true);

        if (corsOrigins.includes(origin)) return callback(null, true);

        // Disallowed origin: don't error (avoids breaking same-origin), just omit CORS headers.
        return callback(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400
    })
  );
  app.use(express.json({ limit: '2mb' }));

  // Serve static files in production
  const publicPath = path.join(__dirname, '../public');
  const fs = require('fs');
  
  // Create public folder if it doesn't exist
  if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
  }
  
  app.use(express.static(publicPath));

  // Optional: apply SQL migrations before touching tables.
  if (process.env.RUN_MIGRATIONS_ON_START === 'true') {
    try {
      logger.info('Running database migrations');
      await runMigrations();
      logger.info('Database migrations complete');
    } catch (error) {
      logger.error({ error }, 'Database migrations failed');
      const strict = process.env.MIGRATIONS_STRICT === 'true';
      if (strict) {
        throw error;
      }
    }
  }

  // Test Supabase connection
  const connected = await testConnection();
  if (!connected) {
    logger.warn('Failed to connect to Supabase database - some features may not work');
    logger.warn('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables');
  } else {
    await settingsService.ensureDefaults();
  }

  const disableWhatsApp = process.env.DISABLE_WHATSAPP === 'true';
  const disableSchedulers = process.env.DISABLE_SCHEDULERS === 'true';

  const whatsappClient = disableWhatsApp ? null : createWhatsAppClient();
  if (whatsappClient) {
    await whatsappClient.init();
    startTargetAutoSync(whatsappClient);
  } else {
    logger.warn('WhatsApp is disabled via DISABLE_WHATSAPP');
  }
  whatsappClientRef = whatsappClient;
  app.locals.whatsapp = whatsappClient;

  registerRoutes(app);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  // SPA fallback - serve index.html for non-API routes
  app.get('*', (_req: Request, res: Response) => {
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(503).send(`
        <!DOCTYPE html>
        <html>
          <head><title>Building...</title></head>
          <body>
            <h1>Application is building</h1>
            <p>The client-side application is being built. Please wait a moment and refresh.</p>
            <p>If this persists, check that the build command ran successfully.</p>
          </body>
        </html>
      `);
    }
  });

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Server listening');
  });

  keepAlive();
  // Reset any logs left in processing state by a crash/restart.
  void resetStuckProcessingLogs();
  scheduleRetentionCleanup();
  scheduleProcessingWatchdog();
  if (disableSchedulers) {
    logger.warn('Schedulers are disabled via DISABLE_SCHEDULERS');
  } else {
    // If WhatsApp leasing is supported, only the lease-holder should run polling/schedulers.
    // This avoids duplicate feed polling + queue churn during rolling deploys.
    const status = whatsappClient?.getStatus?.();
    const lease = status?.lease;
    const leaseSupported = Boolean(lease && typeof lease.supported === 'boolean' ? lease.supported : false);
    const leaseHeld = Boolean(lease && typeof lease.held === 'boolean' ? lease.held : false);
    if (whatsappClient && leaseSupported && !leaseHeld) {
      logger.warn(
        {
          whatsappStatus: status?.status,
          instanceId: status?.instanceId,
          lease
        },
        'Skipping schedulers: WhatsApp lease not held (another instance is active)'
      );
    } else {
      await initSchedulers(whatsappClient);
    }
  }
};

start().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
