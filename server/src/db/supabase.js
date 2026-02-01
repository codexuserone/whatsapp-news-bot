const { createClient } = require('@supabase/supabase-js');

// Lazy initialization - client is created on first access
let _supabase = null;

function getSupabaseClient() {
  if (_supabase) return _supabase;
  
  // Support both naming conventions for Supabase env vars
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  console.log('[v0] Supabase URL available:', !!supabaseUrl);
  console.log('[v0] Supabase Key available:', !!supabaseKey);

  if (!supabaseUrl || !supabaseKey) {
    console.error('[v0] Missing Supabase credentials.');
    console.error('[v0] Available env vars with SUPA:', Object.keys(process.env).filter(k => k.includes('SUPA')).join(', '));
    return null;
  }

  console.log('[v0] Creating Supabase client...');
  _supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  console.log('[v0] Supabase client created successfully');
  
  return _supabase;
}

// Proxy object that lazily initializes Supabase
const supabase = new Proxy({}, {
  get(target, prop) {
    const client = getSupabaseClient();
    if (!client) {
      throw new Error('Supabase client not initialized. Check environment variables.');
    }
    return client[prop];
  }
});

// Helper function to handle Supabase errors consistently
function handleSupabaseError(error, context = '') {
  if (error) {
    console.error(`Supabase error${context ? ` in ${context}` : ''}:`, error.message);
    throw new Error(error.message);
  }
}

// Test database connection
async function testConnection() {
  try {
    const client = getSupabaseClient();
    if (!client) {
      console.error('Supabase client not available - missing credentials');
      return false;
    }
    const { data, error } = await client.from('settings').select('key').limit(1);
    if (error) throw error;
    console.log('Supabase connection successful');
    return true;
  } catch (error) {
    console.error('Supabase connection failed:', error.message);
    return false;
  }
}

module.exports = {
  supabase,
  getSupabaseClient,
  handleSupabaseError,
  testConnection
};
