const path = require('path');
const dotenv = require('dotenv');

// Only load .env file in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

const isProd = process.env.NODE_ENV === 'production';
const defaultPort = process.env.PORT || 10000;
const baseUrl =
  process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${defaultPort}`;
const isPostgresConnectionString = (value: unknown) => /^postgres(?:ql)?:\/\//i.test(String(value || '').trim());
const dbProviderRaw = String(process.env.DB_PROVIDER || '').trim();
const dbProvider = isPostgresConnectionString(dbProviderRaw) ? 'postgres' : dbProviderRaw.toLowerCase();
const hasPostgresUrl = Boolean(
  String(
    (isPostgresConnectionString(dbProviderRaw) ? dbProviderRaw : '') ||
    process.env.DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.SUPABASE_POOLER_URL ||
    process.env.SUPABASE_DB_URL ||
    ''
  ).trim()
);
const hasSupabaseCredentials = Boolean(
  String(process.env.SUPABASE_URL || '').trim() &&
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
);

const resolveActiveDatabaseUrl = () => {
  const providerUrl = isPostgresConnectionString(dbProviderRaw) ? dbProviderRaw : '';
  if (dbProvider === 'neon') {
    return providerUrl || process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  }
  if (dbProvider === 'postgres') {
    return providerUrl || process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || process.env.SUPABASE_DB_URL;
  }
  return providerUrl || process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || process.env.SUPABASE_DB_URL;
};

const env = {
  PORT: process.env.PORT || 10000,
  DB_PROVIDER: dbProvider || (hasPostgresUrl ? 'postgres' : 'supabase'),
  DATABASE_URL: resolveActiveDatabaseUrl(),
  // Supabase configuration
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY,
  BASE_URL: baseUrl,
  KEEP_ALIVE: process.env.KEEP_ALIVE !== 'false', // Default to true unless explicitly disabled
  KEEP_ALIVE_URL: process.env.KEEP_ALIVE_URL,
  KEEP_ALIVE_INTERVAL_MS: Number(process.env.KEEP_ALIVE_INTERVAL_MS || 5 * 60 * 1000),
  KEEP_ALIVE_TIMEOUT_MS: Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 20_000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 14),
  DEFAULT_INTER_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTER_TARGET_DELAY_SEC || 8),
  DEFAULT_INTRA_TARGET_DELAY_SEC: Number(process.env.DEFAULT_INTRA_TARGET_DELAY_SEC || 3)
};

// In production, require either direct Postgres credentials or Supabase REST credentials.
if (isProd && !hasPostgresUrl && !hasSupabaseCredentials) {
  throw new Error('Either DATABASE_URL or SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production');
}

module.exports = env;
export { };
