import type { SupabaseClient } from '@supabase/supabase-js';

const { createClient } = require('@supabase/supabase-js');

let supabaseClient: SupabaseClient | null = null;

const resolveSupabaseUrl = () =>
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';

const resolveSupabaseKey = () =>
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  '';

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
      persistSession: false
    }
  });

  return supabaseClient;
}

function handleSupabaseError(error: { message?: string } | null, context = ''): void {
  if (error) {
    console.error(`Supabase error${context ? ` in ${context}` : ''}:`, error.message || error);
    throw new Error(error.message || 'Supabase error');
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
    const message = error instanceof Error ? error.message : String(error);
    console.error('Supabase connection failed:', message);
    return false;
  }
}

module.exports = {
  getSupabaseClient,
  handleSupabaseError,
  testConnection
};
