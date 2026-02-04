const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

let keepAliveInterval: NodeJS.Timeout | null = null;

const keepAlive = (): void => {
  if (!env.KEEP_ALIVE) {
    return;
  }

  // Clear existing interval if any
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }

  const url = env.KEEP_ALIVE_URL || `${env.BASE_URL}/ping`;
  const intervalMs = 10 * 60 * 1000;

  const ping = async () => {
    try {
      await axios.get(url);
      logger.debug({ url }, 'Keep-alive ping sent');
    } catch (error) {
      logger.warn({ error: getErrorMessage(error) }, 'Keep-alive ping failed');
    }
  };

  void ping();
  keepAliveInterval = setInterval(ping, intervalMs);
};

const stopKeepAlive = (): void => {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    logger.info('Keep-alive stopped');
  }
};

module.exports = { keepAlive, stopKeepAlive };
export {};
