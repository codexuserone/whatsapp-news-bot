import type { Express, Request, Response } from 'express';
import type { AuthAttemptState } from './utils/basicAuthAttempts';
require('./utils/logRedaction').installConsoleRedaction();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { timingSafeEqual } = require('crypto');
const {
  getBasicAuthFailureSignature,
  isBasicAuthAttemptStale,
  isBasicAuthBlocked,
  recordBasicAuthFailure
} = require('./utils/basicAuthAttempts');
const { sendBasicAuthFailure } = require('./utils/basicAuthChallenge');
const env = require('./config/env');
const logger = require('./utils/logger');
const { getSupabaseHealthState, testConnection } = require('./db/supabase');
const createWhatsAppClient = require('./whatsapp/client');
const { keepAlive, stopKeepAlive } = require('./services/keepAlive');
const registerRoutes = require('./routes');
const settingsService = require('./services/settingsService');
const { initSchedulers, clearAll } = require('./services/schedulerService');
const { startTargetAutoSync, stopTargetAutoSync } = require('./services/targetSyncService');
const { scheduleStatusAudienceRefresh, stopStatusAudienceRefresh } = require('./services/statusAudienceService');
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
const {
  shouldInitializeWhatsAppImmediately,
  shouldStartDatabaseBackedWorkers
} = require('./startup/databaseWorkers');
const { startDatabaseRecoveryPoller } = require('./startup/databaseRecovery');

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
    stopStatusAudienceRefresh();
    stopKeepAlive();
    databaseRecoveryPollerRef?.stop();
    
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
let databaseRecoveryPollerRef: { stop: () => void } | null = null;

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

const authAttemptsByIp = new Map<string, AuthAttemptState>();
let authAttemptCleanupAtMs = 0;

const normalizeClientIp = (req: Request) => {
  const ip = String(req.ip || req.socket?.remoteAddress || '').trim() || 'unknown';
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

const toIpv4Int = (value: string): number | null => {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    acc = (acc << 8) | octet;
  }
  return acc >>> 0;
};

const ipMatchesAllowlistEntry = (clientIp: string, rawEntry: string) => {
  const entry = String(rawEntry || '').trim().toLowerCase();
  if (!entry) return false;

  const cidrParts = entry.split('/');
  if (cidrParts.length === 2) {
    const cidrBase = cidrParts[0] || '';
    const cidrBits = cidrParts[1] || '';
    const baseInt = toIpv4Int(cidrBase);
    const clientInt = toIpv4Int(clientIp);
    const bits = Number(cidrBits);
    if (
      baseInt === null ||
      clientInt === null ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > 32
    ) {
      return false;
    }
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    return (baseInt & mask) === (clientInt & mask);
  }

  return entry === clientIp;
};

const ipMatchesAllowlist = (clientIp: string, allowlist: string[]) =>
  allowlist.some((entry) => ipMatchesAllowlistEntry(clientIp, entry));

const cleanupAuthAttempts = (nowMs: number) => {
  if (nowMs - authAttemptCleanupAtMs < 5 * 60 * 1000) return;
  authAttemptCleanupAtMs = nowMs;
  for (const [ip, state] of authAttemptsByIp.entries()) {
    if (isBasicAuthAttemptStale(state, nowMs)) {
      authAttemptsByIp.delete(ip);
    }
  }
};

const runStartupTask = (label: string, task: () => Promise<void> | void) => {
  void Promise.resolve()
    .then(async () => {
      await task();
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'Startup task failed');
      logger.warn({ task: label }, 'Startup task will be retried by background flows or next interval');
    });
};

const isTransientStartupMigrationError = (error: unknown) => {
  const message = String((error as { message?: unknown })?.message || error || '');
  return (
    message.includes('ECHECKOUTTIMEOUT') ||
    message.includes('UND_ERR_HEADERS_TIMEOUT') ||
    message.includes('Headers Timeout Error') ||
    message.includes('fetch failed') ||
    message.includes('Connection timed out') ||
    message.includes('Error code 522') ||
    message.includes('ENETUNREACH')
  );
};

const shouldFailStartupForMigrationError = (error: unknown) => {
  if (process.env.MIGRATIONS_STRICT !== 'true') {
    return false;
  }

  if (process.env.NODE_ENV === 'production' && isTransientStartupMigrationError(error)) {
    return false;
  }

  return true;
};

const start = async () => {
  const app: Express = express();
  app.disable('x-powered-by');
  const defaultTrustProxyHops = process.env.NODE_ENV === 'production' ? 1 : 0;
  const parsedTrustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? defaultTrustProxyHops);
  const trustProxyHops =
    Number.isFinite(parsedTrustProxyHops) && parsedTrustProxyHops >= 0
      ? Math.floor(parsedTrustProxyHops)
      : defaultTrustProxyHops;
  app.set('trust proxy', trustProxyHops);
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
  let basicAuthConfigError: string | null = null;
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
  const authRepeatFailureWindowMs =
    Math.max(Number(process.env.BASIC_AUTH_REPEAT_FAILURE_WINDOW_SECONDS || 60), 5) * 1000;
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
    basicAuthConfigError = 'Basic auth is enabled but BASIC_AUTH_USER or BASIC_AUTH_PASS is missing';
    logger.error({ requireBasicAuth }, basicAuthConfigError);
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
      basicAuthConfigError =
        'BASIC_AUTH_PASS is too weak for production. Use 12+ chars or set ALLOW_WEAK_BASIC_AUTH=true.';
      logger.error({ allowWeakBasicAuth }, basicAuthConfigError);
    }
  }
  if (requireBasicAuth) {
    app.use((req: Request, res: Response, next) => {
      if (isPublicProbeRequest(req)) return next();
      if (req.method === 'OPTIONS') return next();

      res.setHeader('Vary', 'Authorization');
      res.setHeader('Cache-Control', 'no-store');
      if (basicAuthConfigError || !basicUser || !basicPass) {
        return res.status(503).send('Authentication is not configured');
      }

      if (requireHttpsForAuth && !isSecureRequest(req)) {
        return res.status(403).send('HTTPS is required');
      }

      const clientIp = normalizeClientIp(req);
      if (accessAllowlist.length > 0 && !ipMatchesAllowlist(clientIp, accessAllowlist)) {
        return res.status(403).send('Access denied');
      }

      const nowMs = Date.now();
      cleanupAuthAttempts(nowMs);
      const currentAttempt = authAttemptsByIp.get(clientIp);

      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Basic ')) {
        return sendBasicAuthFailure(req, res, {
          status: 401,
          message: 'Authentication required',
          realm: basicAuthRealm
        });
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

      if (isBasicAuthBlocked(currentAttempt, nowMs)) {
        const retryAfterSec = Math.max(Math.ceil(((currentAttempt?.blockedUntilMs || nowMs) - nowMs) / 1000), 1);
        res.setHeader('Retry-After', String(retryAfterSec));
        return sendBasicAuthFailure(req, res, {
          status: 429,
          message: 'Too many authentication attempts',
          realm: basicAuthRealm
        });
      }
      const nextAttempt = recordBasicAuthFailure({
        currentAttempt,
        nowMs,
        blockWindowMs: authBlockWindowMs,
        maxAttempts: authMaxAttempts,
        signature: getBasicAuthFailureSignature(header),
        repeatSignatureWindowMs: authRepeatFailureWindowMs
      });
      authAttemptsByIp.set(clientIp, nextAttempt);

      if (nextAttempt.blockedUntilMs > nowMs) {
        const retryAfterSec = Math.max(Math.ceil((nextAttempt.blockedUntilMs - nowMs) / 1000), 1);
        res.setHeader('Retry-After', String(retryAfterSec));
      }
      return sendBasicAuthFailure(req, res, {
        status: 401,
        message: 'Invalid credentials',
        realm: basicAuthRealm
      });
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

  // Most API routes should not accept large JSON bodies. Only routes that accept base64
  // media payloads need the higher limit.
  const defaultJsonLimit = process.env.JSON_BODY_LIMIT_DEFAULT || process.env.JSON_BODY_LIMIT || '2mb';
  const largeJsonLimit = process.env.JSON_BODY_LIMIT_LARGE || process.env.JSON_BODY_LIMIT || '50mb';
  const defaultJson = express.json({ limit: defaultJsonLimit });
  const largeJson = express.json({ limit: largeJsonLimit });
  app.use((req: any, res: any, next: any) => {
    const path = String(req?.path || '');
    const wantsLargeJson =
      path === '/api/whatsapp/send-test' ||
      path === '/api/whatsapp/send-test/' ||
      path === '/api/whatsapp/send-status' ||
      path === '/api/whatsapp/send-status/' ||
      path === '/api/manual/queue' ||
      path === '/api/manual/queue/' ||
      path === '/api/manual/send' ||
      path === '/api/manual/send/';
    return (wantsLargeJson ? largeJson : defaultJson)(req, res, next);
  });

  // Serve static files in production
  const publicPath = path.join(__dirname, '../public');
  const fs = require('fs');
  
  // Create public folder if it doesn't exist
  if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
  }
  
  app.use(express.static(publicPath));

  const disableWhatsApp = process.env.DISABLE_WHATSAPP === 'true';
  const disableSchedulers = process.env.DISABLE_SCHEDULERS === 'true';

  const whatsappClient = disableWhatsApp ? null : createWhatsAppClient();
  if (!whatsappClient) {
    logger.warn('WhatsApp is disabled via DISABLE_WHATSAPP');
  }
  whatsappClientRef = whatsappClient;
  app.locals.whatsapp = whatsappClient;

  registerRoutes(app);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  // SPA fallback - serve index.html for non-API routes
  app.get('*', (req: Request, res: Response) => {
    const requestPath = String(req.path || '/').trim();
    const normalizedRoute = requestPath === '/' ? 'index' : requestPath.replace(/^\/+|\/+$/g, '');
    const candidates = [
      path.join(publicPath, `${normalizedRoute}.html`),
      path.join(publicPath, normalizedRoute, 'index.html'),
      path.join(publicPath, 'index.html')
    ];
    const pagePath = candidates.find((candidate) => fs.existsSync(candidate));

    if (pagePath) {
      res.sendFile(pagePath);
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

  let startupMigrationsComplete = process.env.RUN_MIGRATIONS_ON_START !== 'true';

  // Keep Render health probes responsive even when database startup work is slow.
  if (process.env.RUN_MIGRATIONS_ON_START === 'true') {
    try {
      logger.info('Running database migrations');
      await runMigrations();
      startupMigrationsComplete = true;
      logger.info('Database migrations complete');
    } catch (error) {
      logger.error({ error }, 'Database migrations failed');
      if (shouldFailStartupForMigrationError(error)) {
        throw error;
      }
      logger.warn('Continuing startup after a non-fatal migration failure');
    }
  }

  const connected = await testConnection();
  if (!connected) {
    logger.warn(
      { supabase: getSupabaseHealthState?.() },
      'Failed to connect to Supabase database; database-backed features are temporarily unavailable'
    );
  }

  keepAlive();
  const startDatabaseWorkers = shouldStartDatabaseBackedWorkers(connected);
  let databaseBackedRuntimeStarted = false;
  let databaseBackedRuntimeStarting = false;

  const ensureStartupMigrationsComplete = async () => {
    if (startupMigrationsComplete) return;
    logger.info('Retrying database migrations after database connectivity recovered');
    await runMigrations();
    startupMigrationsComplete = true;
    logger.info('Database migrations complete after database recovery');
  };

  const startDatabaseBackedRuntime = async () => {
    if (databaseBackedRuntimeStarted || databaseBackedRuntimeStarting) return;
    databaseBackedRuntimeStarting = true;
    try {
      await ensureStartupMigrationsComplete();

      runStartupTask('reset stuck processing logs', async () => {
        await resetStuckProcessingLogs();
      });

      runStartupTask('ensure default settings', async () => {
        await settingsService.ensureDefaults();
      });

      if (whatsappClient) {
        startTargetAutoSync(whatsappClient);
      }

      if (whatsappClient && shouldInitializeWhatsAppImmediately(true)) {
        runStartupTask('initialize WhatsApp client', async () => {
          await whatsappClient.init();
        });
      }

      if (disableSchedulers) {
        logger.warn('Schedulers are disabled via DISABLE_SCHEDULERS');
      } else {
        scheduleRetentionCleanup();
        scheduleProcessingWatchdog();
        scheduleStatusAudienceRefresh(whatsappClient);
        runStartupTask('initialize schedulers', async () => {
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
            return;
          }

          await initSchedulers(whatsappClient);
        });
      }

      databaseBackedRuntimeStarted = true;
    } finally {
      databaseBackedRuntimeStarting = false;
    }
  };

  if (startDatabaseWorkers) {
    runStartupTask('start database-backed runtime', startDatabaseBackedRuntime);
  } else {
    logger.warn('Skipping database-backed startup workers until database connectivity recovers');
  }

  if (!startDatabaseWorkers) {
    if (whatsappClient) {
      whatsappClient.markDatabaseUnavailable?.('Database temporarily unavailable. Retrying WhatsApp connection...');
    }
    if (!databaseRecoveryPollerRef) {
      databaseRecoveryPollerRef = startDatabaseRecoveryPoller({
        testConnection,
        onRecovered: startDatabaseBackedRuntime,
        logger
      });
    }
  }

};

start().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
