import type { Express, Request, Response } from 'express';
const express = require('express');
const cors = require('cors');
const path = require('path');
const { timingSafeEqual } = require('crypto');
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
const securityHeaders = require('./middleware/securityHeaders');
const { isPublicProbeRequest } = require('./middleware/publicProbePaths');

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

const safeEquals = (left: string, right: string) => {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

type AuthAttemptState = {
  failures: number;
  firstFailureAtMs: number;
  blockedUntilMs: number;
};

const authAttemptsByIp = new Map<string, AuthAttemptState>();
let authAttemptCleanupAtMs = 0;

const normalizeClientIp = (req: Request) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').trim();
  const firstForwarded = forwarded.split(',')[0]?.trim();
  const ip = firstForwarded || String(req.ip || '').trim() || 'unknown';
  return ip.replace(/^::ffff:/, '').trim().toLowerCase();
};

const isSecureRequest = (req: Request) => {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  return proto === 'https';
};

const toBoolean = (rawValue: unknown, defaultValue: boolean) => {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
};

const cleanupAuthAttempts = (nowMs: number) => {
  if (nowMs - authAttemptCleanupAtMs < 5 * 60 * 1000) return;
  authAttemptCleanupAtMs = nowMs;
  for (const [ip, state] of authAttemptsByIp.entries()) {
    const stale =
      state.blockedUntilMs <= nowMs &&
      (state.failures <= 0 || nowMs - state.firstFailureAtMs > 60 * 60 * 1000);
    if (stale) {
      authAttemptsByIp.delete(ip);
    }
  }
};

const start = async () => {
  const app: Express = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestLogger);
  app.use(securityHeaders);

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

  // Basic Auth gate for all app/API routes except health probes.
  // Defaults:
  // - production: required unless REQUIRE_BASIC_AUTH=false
  // - non-production: disabled unless REQUIRE_BASIC_AUTH=true
  const requireBasicAuth =
    String(process.env.REQUIRE_BASIC_AUTH || '').toLowerCase() === 'true' ||
    (process.env.NODE_ENV === 'production' &&
      String(process.env.REQUIRE_BASIC_AUTH || '').toLowerCase() !== 'false');
  const basicUser = process.env.BASIC_AUTH_USER;
  const basicPass = process.env.BASIC_AUTH_PASS;
  const basicAuthRealm = String(process.env.BASIC_AUTH_REALM || 'WhatsApp News Bot')
    .replace(/"/g, '')
    .trim() || 'WhatsApp News Bot';
  const requireHttpsForAuth = toBoolean(
    process.env.BASIC_AUTH_REQUIRE_HTTPS,
    process.env.NODE_ENV === 'production'
  );
  const allowWeakBasicAuth = toBoolean(process.env.ALLOW_WEAK_BASIC_AUTH, false);
  const accessAllowlist = String(process.env.ACCESS_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const authMaxAttempts = Math.max(Number(process.env.BASIC_AUTH_MAX_ATTEMPTS || 20), 1);
  const authBlockWindowMs = Math.max(Number(process.env.BASIC_AUTH_BLOCK_MINUTES || 15), 1) * 60 * 1000;
  const weakPasswords = new Set([
    'change-me',
    'changeme',
    'password',
    'password123',
    '123456',
    '12345678',
    'qwerty',
    'letmein',
    'admin'
  ]);
  if (requireBasicAuth && (!basicUser || !basicPass)) {
    throw new Error('BASIC_AUTH_USER and BASIC_AUTH_PASS are required when basic auth is enabled');
  }
  if (
    requireBasicAuth &&
    basicPass &&
    process.env.NODE_ENV === 'production' &&
    !allowWeakBasicAuth
  ) {
    const normalizedPass = String(basicPass).trim().toLowerCase();
    const looksWeak = normalizedPass.length < 12 || weakPasswords.has(normalizedPass);
    if (looksWeak) {
      throw new Error(
        'BASIC_AUTH_PASS is too weak for production. Use 12+ chars or set ALLOW_WEAK_BASIC_AUTH=true (not recommended).'
      );
    }
  }
  if (requireBasicAuth && basicUser && basicPass) {
    app.use((req: Request, res: Response, next) => {
      if (isPublicProbeRequest(req)) return next();

      res.setHeader('Vary', 'Authorization');
      res.setHeader('Cache-Control', 'no-store');
      if (requireHttpsForAuth && !isSecureRequest(req)) {
        return res.status(403).send('HTTPS is required');
      }

      const clientIp = normalizeClientIp(req);
      if (accessAllowlist.length > 0 && !accessAllowlist.includes(clientIp)) {
        return res.status(403).send('Access denied');
      }

      const nowMs = Date.now();
      cleanupAuthAttempts(nowMs);
      const currentAttempt = authAttemptsByIp.get(clientIp);
      if (currentAttempt && currentAttempt.blockedUntilMs > nowMs) {
        const retryAfterSec = Math.max(Math.ceil((currentAttempt.blockedUntilMs - nowMs) / 1000), 1);
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).send('Too many authentication attempts');
      }

      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', `Basic realm="${basicAuthRealm}"`);
        return res.status(401).send('Authentication required');
      }
      try {
        const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const idx = raw.indexOf(':');
        const user = idx >= 0 ? raw.slice(0, idx) : raw;
        const pass = idx >= 0 ? raw.slice(idx + 1) : '';
        if (safeEquals(user, String(basicUser)) && safeEquals(pass, String(basicPass))) {
          authAttemptsByIp.delete(clientIp);
          return next();
        }
      } catch {
        // ignore
      }

      const nextAttempt: AuthAttemptState = currentAttempt
        ? { ...currentAttempt }
        : { failures: 0, firstFailureAtMs: nowMs, blockedUntilMs: 0 };
      if (nowMs - nextAttempt.firstFailureAtMs > authBlockWindowMs) {
        nextAttempt.failures = 0;
        nextAttempt.firstFailureAtMs = nowMs;
        nextAttempt.blockedUntilMs = 0;
      }
      nextAttempt.failures += 1;
      if (nextAttempt.failures >= authMaxAttempts) {
        nextAttempt.blockedUntilMs = nowMs + authBlockWindowMs;
      }
      authAttemptsByIp.set(clientIp, nextAttempt);

      res.setHeader('WWW-Authenticate', `Basic realm="${basicAuthRealm}"`);
      if (nextAttempt.blockedUntilMs > nowMs) {
        const retryAfterSec = Math.max(Math.ceil((nextAttempt.blockedUntilMs - nowMs) / 1000), 1);
        res.setHeader('Retry-After', String(retryAfterSec));
      }
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
