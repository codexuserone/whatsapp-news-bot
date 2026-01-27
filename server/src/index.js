const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const logger = require('./utils/logger');
const connectDb = require('./db/mongoose');
const createWhatsAppClient = require('./whatsapp/client');
const keepAlive = require('./services/keepAlive');
const registerRoutes = require('./routes');
const settingsService = require('./services/settingsService');
const { initSchedulers } = require('./services/schedulerService');
const { scheduleRetentionCleanup } = require('./services/retentionService');

const start = async () => {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Serve static files in production
  const publicPath = path.join(__dirname, '../public');
  app.use(express.static(publicPath));

  await connectDb();
  await settingsService.ensureDefaults();

  const whatsappClient = createWhatsAppClient();
  await whatsappClient.init();
  app.locals.whatsapp = whatsappClient;

  registerRoutes(app);

  // SPA fallback - serve index.html for non-API routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
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
