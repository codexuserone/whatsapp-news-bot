const path = require('path');
const dotenv = require('dotenv');

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const env = {
  PORT: process.env.PORT || 10000,
  MONGO_URI: process.env.MONGO_URI,
  USE_IN_MEMORY_DB: process.env.USE_IN_MEMORY_DB === 'true',
  BASE_URL: process.env.BASE_URL || 'http://localhost:10000',
  KEEP_ALIVE: process.env.KEEP_ALIVE === 'true',
  KEEP_ALIVE_URL: process.env.KEEP_ALIVE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 14),
  DEFAULT_INTER_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTER_TARGET_DELAY_SEC || 8),
  DEFAULT_INTRA_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTRA_TARGET_DELAY_SEC || 3)
};

// In production, we require MONGO_URI unless explicitly using in-memory DB
if (process.env.NODE_ENV === 'production' && !env.MONGO_URI && !env.USE_IN_MEMORY_DB) {
  throw new Error('MONGO_URI is required in production');
}

module.exports = env;
