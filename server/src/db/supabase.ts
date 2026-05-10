import type { SupabaseClient } from '@supabase/supabase-js';

const { createClient } = require('@supabase/supabase-js');
const {
  createPostgresCompatClient,
  getPostgresHealthState,
  resolvePostgresConnectionString,
  testPostgresConnection
} = require('./postgresCompat');
const { getErrorMessage } = require('../utils/errorUtils');

let supabaseClient: SupabaseClient | null = null;
let postgresCompatClient: any = null;
const isProd = process.env.NODE_ENV === 'production';
const SUPABASE_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Math.floor(Number(process.env.SUPABASE_FETCH_TIMEOUT_MS || 8000))
);
const SUPABASE_CIRCUIT_BREAKER_MS = Math.max(
  5000,
  Math.floor(Number(process.env.SUPABASE_CIRCUIT_BREAKER_MS || 45000))
);

let circuitOpenUntil = 0;
let lastFailureAt = 0;
let lastFailureMessage: string | null = null;

const resolveSupabaseUrl = () => process.env.SUPABASE_URL || '';
const resolveDbProvider = () => {
  const explicit = String(process.env.DB_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'postgres' || explicit === 'pg' || explicit === 'neon') return 'postgres';
  if (explicit === 'supabase') return 'supabase';

  if (resolvePostgresConnectionString()) return 'postgres';
  return 'supabase';
};

const resolveSupabaseKey = () => {
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';
  if (serviceRoleKey) {
    return serviceRoleKey;
  }

  if (!isProd) {
    return process.env.SUPABASE_ANON_KEY || '';
  }

  return '';
};

const now = () => Date.now();

const getCircuitRetryAfterMs = () => Math.max(circuitOpenUntil - now(), 0);

const isSupabaseCircuitOpen = () => getCircuitRetryAfterMs() > 0;

const getSupabaseHealthState = () => ({
  provider: resolveDbProvider(),
  circuitOpen: isSupabaseCircuitOpen(),
  retryAfterMs: getCircuitRetryAfterMs(),
  lastFailureAt: lastFailureAt ? new Date(lastFailureAt).toISOString() : null,
  lastFailureMessage
});

const markSupabaseSuccess = () => {
  circuitOpenUntil = 0;
  lastFailureAt = 0;
  lastFailureMessage = null;
};

const markSupabaseFailure = (error: unknown) => {
  lastFailureAt = now();
  lastFailureMessage = getErrorMessage(error, 'Supabase request failed');
  circuitOpenUntil = Math.max(circuitOpenUntil, lastFailureAt + SUPABASE_CIRCUIT_BREAKER_MS);
};

const fetchWithTimeout = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (isSupabaseCircuitOpen()) {
    throw new Error(
      `Supabase temporarily unavailable: ${lastFailureMessage || 'recent connection failure'}; retry in ${Math.ceil(
        getCircuitRetryAfterMs() / 1000
      )}s`
    );
  }

  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  let timeoutTriggered = false;
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, SUPABASE_FETCH_TIMEOUT_MS);

  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  }

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (response.ok) {
      markSupabaseSuccess();
    } else if (response.status >= 500) {
      markSupabaseFailure(new Error(`Supabase HTTP ${response.status}`));
    }
    return response;
  } catch (error) {
    if (timeoutTriggered) {
      const timeoutError = new Error(`Supabase request timed out after ${SUPABASE_FETCH_TIMEOUT_MS}ms`);
      markSupabaseFailure(timeoutError);
      throw timeoutError;
    }
    markSupabaseFailure(error);
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
};

function getSupabaseClient(): SupabaseClient | null {
  if (resolveDbProvider() === 'postgres') {
    if (postgresCompatClient) return postgresCompatClient;

    postgresCompatClient = createPostgresCompatClient();
    if (!postgresCompatClient) {
      console.error('Missing Postgres credentials. Please set DATABASE_URL or DB_PROVIDER-compatible connection settings.');
      return null;
    }
    return postgresCompatClient;
  }

  if (supabaseClient) return supabaseClient;

  const supabaseUrl = resolveSupabaseUrl();
  const supabaseKey = resolveSupabaseKey();

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    return null;
  }

  supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    global: {
      fetch: fetchWithTimeout
    }
  });

  return supabaseClient;
}

function handleSupabaseError(error: { message?: string } | null, context = ''): void {
  if (error) {
    const message = getErrorMessage(error, 'Supabase error');
    console.error(`Supabase error${context ? ` in ${context}` : ''}:`, message);
    throw new Error(message);
  }
}

async function testConnection(): Promise<boolean> {
  try {
    if (resolveDbProvider() === 'postgres') {
      if (isSupabaseCircuitOpen()) {
        console.error(
          'Postgres connection skipped:',
          `circuit open for ${Math.ceil(getCircuitRetryAfterMs() / 1000)}s`
        );
        return false;
      }

      const connected = await testPostgresConnection();
      if (connected) {
        markSupabaseSuccess();
      } else {
        const postgresState = typeof getPostgresHealthState === 'function' ? getPostgresHealthState() : null;
        markSupabaseFailure(new Error(postgresState?.lastFailureMessage || 'Postgres connection failed'));
      }
      return connected;
    }

    if (isSupabaseCircuitOpen()) {
      console.error(
        'Supabase connection skipped:',
        `circuit open for ${Math.ceil(getCircuitRetryAfterMs() / 1000)}s`
      );
      return false;
    }

    const client = getSupabaseClient();
    if (!client) {
      console.error('Supabase client not available - missing credentials');
      return false;
    }
    const { error } = await client.from('settings').select('key').limit(1);
    if (error) throw error;
    console.log('Supabase connection successful');
    return true;
  } catch (error) {
    const message = getErrorMessage(error, 'Unknown Supabase connection error');
    console.error('Supabase connection failed:', message);
    return false;
  }
}

module.exports = {
  getSupabaseClient,
  handleSupabaseError,
  getSupabaseHealthState,
  isSupabaseCircuitOpen,
  testConnection
};
