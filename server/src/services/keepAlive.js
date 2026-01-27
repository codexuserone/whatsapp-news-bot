const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

const keepAlive = () => {
  if (!env.KEEP_ALIVE) {
    return;
  }

  const url = env.KEEP_ALIVE_URL || `${env.BASE_URL}/ping`;
  const intervalMs = 10 * 60 * 1000;

  setInterval(async () => {
    try {
      await axios.get(url);
      logger.debug({ url }, 'Keep-alive ping sent');
    } catch (error) {
      logger.warn({ error: error.message }, 'Keep-alive ping failed');
    }
  }, intervalMs);
};

module.exports = keepAlive;
