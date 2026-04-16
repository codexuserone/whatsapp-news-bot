import type { SupabaseClient } from '@supabase/supabase-js';

const { createClient } = require('@supabase/supabase-js');
const { getErrorMessage } = require('../utils/errorUtils');

let supabaseClient: SupabaseClient | null = null;
const isProd = process.env.NODE_ENV === 'production';

const resolveSupabaseUrl = () => process.env.SUPABASE_URL || '';

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

function getSupabaseClient(): SupabaseClient | null {
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
  testConnection
};
