const dotenv = require('dotenv');
const path = require('path');

// Load .env file for local development (Render injects env vars directly)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// If no MONGO_URI is provided, default to in-memory DB (even in production)
// This allows the app to start and be configured via the UI
const useInMemoryDb = !process.env.MONGO_URI || process.env.USE_IN_MEMORY_DB === 'true';

const env = {
  PORT: process.env.PORT || 10000,
  MONGO_URI: process.env.MONGO_URI,
  USE_IN_MEMORY_DB: useInMemoryDb,
  BASE_URL: process.env.BASE_URL || 'http://localhost:4000',
  KEEP_ALIVE: process.env.KEEP_ALIVE === 'true',
  KEEP_ALIVE_URL: process.env.KEEP_ALIVE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 14),
  DEFAULT_INTER_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTER_TARGET_DELAY_SEC || 8),
  DEFAULT_INTRA_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTRA_TARGET_DELAY_SEC || 3)
};

// Log env status for debugging
console.log('[env] Starting with config:');
console.log('[env] - PORT:', env.PORT);
console.log('[env] - MONGO_URI set:', !!env.MONGO_URI);
console.log('[env] - USE_IN_MEMORY_DB:', env.USE_IN_MEMORY_DB);
console.log('[env] - KEEP_ALIVE:', env.KEEP_ALIVE);

if (env.USE_IN_MEMORY_DB) {
  console.log('[env] WARNING: Using in-memory database. Data will not persist across restarts.');
}

module.exports = env;
