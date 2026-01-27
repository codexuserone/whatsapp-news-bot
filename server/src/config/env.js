const dotenv = require('dotenv');
const path = require('path');

// Load .env file for local development (Render injects env vars directly)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isProd = process.env.NODE_ENV === 'production';

// Parse USE_IN_MEMORY_DB - default to true only in non-production without MONGO_URI
const useInMemoryDb = process.env.USE_IN_MEMORY_DB === 'true' || 
  (process.env.USE_IN_MEMORY_DB !== 'false' && !isProd && !process.env.MONGO_URI);

const env = {
  PORT: process.env.PORT || 4000,
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

// Log env status for debugging (only key presence, not values)
console.log('[env] NODE_ENV:', process.env.NODE_ENV);
console.log('[env] MONGO_URI set:', !!process.env.MONGO_URI);
console.log('[env] USE_IN_MEMORY_DB:', env.USE_IN_MEMORY_DB);

if (!env.MONGO_URI && !env.USE_IN_MEMORY_DB) {
  console.error('[env] Missing MONGO_URI and USE_IN_MEMORY_DB is false');
  console.error('[env] Available env vars:', Object.keys(process.env).filter(k => !k.includes('SECRET') && !k.includes('KEY') && !k.includes('URI')).join(', '));
  throw new Error('MONGO_URI is required unless USE_IN_MEMORY_DB=true');
}

module.exports = env;
