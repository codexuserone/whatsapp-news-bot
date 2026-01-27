const path = require('path');

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const isProd = process.env.NODE_ENV === 'production';

// In production, we expect MONGO_URI to be set. 
// If not, we can fall back to in-memory if explicitly requested, but it's not recommended.
// For debugging, let's be permissive but loud.
const useInMemoryDb = process.env.USE_IN_MEMORY_DB === 'true';

// Log all env vars for debugging (keys only to be safe)
console.log('[env] Environment check:');
console.log('[env] NODE_ENV:', process.env.NODE_ENV);
console.log('[env] PORT:', process.env.PORT);
console.log('[env] MONGO_URI present:', !!process.env.MONGO_URI);
console.log('[env] USE_IN_MEMORY_DB:', process.env.USE_IN_MEMORY_DB);

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
if (isProd && !env.MONGO_URI && !env.USE_IN_MEMORY_DB) {
  console.error('[env] FATAL: MONGO_URI is required in production');
  console.error('[env] Please set MONGO_URI environment variable in Render Dashboard');
  // We won't exit here to allow the logs to be flushed/seen, but the DB connection will likely fail later
}

if (env.USE_IN_MEMORY_DB) {
  console.log('[env] Using in-memory database (volatile data)');
}

module.exports = env;
