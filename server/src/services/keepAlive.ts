const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

let keepAliveInterval: NodeJS.Timeout | null = null;

const resolveKeepAliveIntervalMs = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5 * 60 * 1000;
  return Math.min(Math.max(Math.floor(parsed), 60_000), 10 * 60 * 1000);
};

const resolveKeepAliveTimeoutMs = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20_000;
  return Math.min(Math.max(Math.floor(parsed), 2_000), 60_000);
};

const resolveKeepAliveUrl = (baseUrl: string, explicitUrl?: string | null) => {
  const explicit = String(explicitUrl || '').trim();
  if (explicit) return explicit;
  return `${String(baseUrl || '').replace(/\/+$/, '')}/ready`;
};

const keepAlive = (): void => {
  if (!env.KEEP_ALIVE) {
    return;
  }

  // Clear existing interval if any
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }

  const url = resolveKeepAliveUrl(env.BASE_URL, env.KEEP_ALIVE_URL);
  const intervalMs = resolveKeepAliveIntervalMs(env.KEEP_ALIVE_INTERVAL_MS);
  const timeoutMs = resolveKeepAliveTimeoutMs(env.KEEP_ALIVE_TIMEOUT_MS);

  const ping = async () => {
    try {
      await axios.get(url, { timeout: timeoutMs });
      logger.debug({ url }, 'Keep-alive ping sent');
    } catch (error) {
      logger.warn({ error: getErrorMessage(error), url, timeoutMs }, 'Keep-alive ping failed');
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

module.exports = {
  keepAlive,
  stopKeepAlive,
  __testUtils: {
    resolveKeepAliveIntervalMs,
    resolveKeepAliveTimeoutMs,
    resolveKeepAliveUrl
  }
};
export {};
