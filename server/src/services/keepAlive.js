const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

let keepAliveInterval = null;

const keepAlive = () => {
  if (!env.KEEP_ALIVE) {
    return;
  }

  // Clear existing interval if any
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }

  const url = env.KEEP_ALIVE_URL || `${env.BASE_URL}/ping`;
  const intervalMs = 10 * 60 * 1000;

  keepAliveInterval = setInterval(async () => {
    try {
      await axios.get(url);
      logger.debug({ url }, 'Keep-alive ping sent');
    } catch (error) {
      logger.warn({ error: error.message }, 'Keep-alive ping failed');
    }
  }, intervalMs);
};

const stopKeepAlive = () => {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    logger.info('Keep-alive stopped');
  }
};

module.exports = { keepAlive, stopKeepAlive };
