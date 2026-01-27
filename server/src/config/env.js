const dotenv = require('dotenv');
const path = require('path');

// Load .env file for local development (Render injects env vars directly)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isProd = process.env.NODE_ENV === 'production';

// In production, require MONGO_URI. In development, allow in-memory DB.
const useInMemoryDb = !isProd && (process.env.USE_IN_MEMORY_DB === 'true' || !process.env.MONGO_URI);

// Log all env vars for debugging (keys only, no secrets)
console.log('[env] Environment check:');
console.log('[env] NODE_ENV:', process.env.NODE_ENV);
console.log('[env] PORT:', process.env.PORT);
console.log('[env] MONGO_URI present:', !!process.env.MONGO_URI);
console.log('[env] USE_IN_MEMORY_DB:', process.env.USE_IN_MEMORY_DB);
console.log('[env] All env keys:', Object.keys(process.env).sort().join(', '));

const env = {
  PORT: process.env.PORT || 10000,
  MONGO_URI: process.env.MONGO_URI,
  USE_IN_MEMORY_DB: useInMemoryDb,
  BASE_URL: process.env.BASE_URL || 'http://localhost:10000',
  KEEP_ALIVE: process.env.KEEP_ALIVE === 'true',
  KEEP_ALIVE_URL: process.env.KEEP_ALIVE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 14),
  DEFAULT_INTER_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTER_TARGET_DELAY_SEC || 8),
  DEFAULT_INTRA_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTRA_TARGET_DELAY_SEC || 3)
};

// Validate required env vars in production
if (isProd && !env.MONGO_URI) {
  console.error('[env] FATAL: MONGO_URI is required in production');
  console.error('[env] Set MONGO_URI environment variable on Render');
  process.exit(1);
}

if (env.USE_IN_MEMORY_DB) {
  console.log('[env] Using in-memory database (development only)');
}

module.exports = env;
