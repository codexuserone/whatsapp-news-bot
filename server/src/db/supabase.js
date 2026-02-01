const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');
const logger = require('../utils/logger');

let client;

const getClient = () => {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      },
      global: {
        headers: { 'X-Client-Info': 'whatsapp-news-bot' }
      }
    });
  }
  return client;
};

const connectDb = async () => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const { error } = await getClient().from('documents').select('id').limit(1);
  if (error) {
    logger.error({ error }, 'Failed to connect to Supabase documents table');
    throw new Error('Supabase documents table is unavailable; apply supabase/schema.sql');
  }

  logger.info('Supabase connected');
};

module.exports = {
  connectDb,
  getClient
};
