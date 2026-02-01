const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

const supabase = createClient(supabaseUrl || '', supabaseKey || '', {
  auth: {
    autoRefreshToken: false,
    persistSession: false
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
    const { data, error } = await supabase.from('settings').select('key').limit(1);
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
  handleSupabaseError,
  testConnection
};
