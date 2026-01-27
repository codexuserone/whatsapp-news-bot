const dotenv = require('dotenv');

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';

const env = {
  PORT: process.env.PORT || 4000,
  MONGO_URI: process.env.MONGO_URI,
  USE_IN_MEMORY_DB: process.env.USE_IN_MEMORY_DB ? process.env.USE_IN_MEMORY_DB === 'true' : !isProd,
  BASE_URL: process.env.BASE_URL || 'http://localhost:4000',
  KEEP_ALIVE: process.env.KEEP_ALIVE === 'true',
  KEEP_ALIVE_URL: process.env.KEEP_ALIVE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 14),
  DEFAULT_INTER_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTER_TARGET_DELAY_SEC || 8),
  DEFAULT_INTRA_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTRA_TARGET_DELAY_SEC || 3)
};

if (!env.MONGO_URI && !env.USE_IN_MEMORY_DB) {
  throw new Error('MONGO_URI is required unless USE_IN_MEMORY_DB=true');
}

module.exports = env;
