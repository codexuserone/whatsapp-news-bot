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
const { scheduleRetentionCleanup } = require('./services/retentionService');
const errorHandler = require('./middleware/errorHandler');
const notFoundHandler = require('./middleware/notFound');
const requestLogger = require('./middleware/requestLogger');

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  logger.error({ reason }, 'Unhandled Promise Rejection');
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
  app.use(requestLogger);
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Serve static files in production
  const publicPath = path.join(__dirname, '../public');
  const fs = require('fs');
  
  // Create public folder if it doesn't exist
  if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
  }
  
  app.use(express.static(publicPath));

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
  scheduleRetentionCleanup();
  if (disableSchedulers) {
    logger.warn('Schedulers are disabled via DISABLE_SCHEDULERS');
  } else {
    await initSchedulers(whatsappClient);
  }
};

start().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
