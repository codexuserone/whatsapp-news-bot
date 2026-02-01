const path = require('path');
const dotenv = require('dotenv');

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const isProd = process.env.NODE_ENV === 'production';
const baseUrl =
  process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000';

const supabaseUrl =
  process.env.SUPABASE_URL || 'https://uqtqezwhcgyuyxiucfpm.supabase.co';
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  'sb_secret_ih0nqDTdR4M4jmGSVHLvEA_3KpLvEsx';

const env = {
  PORT: process.env.PORT || 10000,
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
  BASE_URL: baseUrl,
  KEEP_ALIVE: process.env.KEEP_ALIVE === 'true',
  KEEP_ALIVE_URL: process.env.KEEP_ALIVE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 14),
  DEFAULT_INTER_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTER_TARGET_DELAY_SEC || 8),
  DEFAULT_INTRA_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTRA_TARGET_DELAY_SEC || 3)
};

// In production, we require Supabase credentials.
if (isProd && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production');
}

module.exports = env;
