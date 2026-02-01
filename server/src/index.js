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

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled Promise Rejection');
  // Don't exit - let the app continue
});

// Graceful shutdown handlers
const gracefulShutdown = async (signal, whatsappClient) => {
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

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const start = async () => {
  const app = express();
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

  const whatsappClient = createWhatsAppClient();
  await whatsappClient.init();
  app.locals.whatsapp = whatsappClient;

  registerRoutes(app);

  // Set up signal handlers after whatsappClient is initialized
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', whatsappClient));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', whatsappClient));

  // SPA fallback - serve index.html for non-API routes
  app.get('*', (req, res) => {
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
  await initSchedulers(whatsappClient);
};

start().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
