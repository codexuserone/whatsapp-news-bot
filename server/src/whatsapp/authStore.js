const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { getSupabaseClient } = require('../db/supabase');

const serialize = (data) => {
  try {
    return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
  } catch (e) {
    console.error('Serialize error:', e);
    return data;
  }
};

const serializeForStorage = (data) => {
  try {
    return JSON.stringify(serialize(data));
  } catch (e) {
    console.error('Serialize storage error:', e);
    return JSON.stringify(data);
  }
};

const deserialize = (data) => {
  try {
    if (!data) return data;
    if (typeof data === 'string') {
      return JSON.parse(data, BufferJSON.reviver);
    }
    return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
  } catch (e) {
    console.error('Deserialize error:', e);
    return data;
  }
};

const useSupabaseAuthState = async (sessionId = 'default') => {
  const supabase = getSupabaseClient();
  
  // If Supabase is not available, use in-memory state
  if (!supabase) {
    console.warn('Supabase not available, using in-memory auth state');
    let state = { creds: initAuthCreds(), keys: {} };
    return {
      state: { 
        creds: state.creds, 
        keys: {
          get: async (type, ids) => {
            const data = {};
            const store = state.keys[type] || {};
            for (const id of ids) {
              if (store[id]) data[id] = store[id];
            }
            return data;
          },
          set: async (data) => {
            Object.keys(data).forEach((category) => {
              state.keys[category] = state.keys[category] || {};
              Object.assign(state.keys[category], data[category]);
            });
          }
        }
      },
      saveCreds: async () => {},
      clearState: async () => { state = { creds: initAuthCreds(), keys: {} }; },
      updateStatus: async () => {}
    };
  }

  // Try to get existing auth state
  let { data: doc, error } = await supabase
    .from('auth_state')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  // Create new auth state if not found
  if (error || !doc) {
    const newCreds = serialize(initAuthCreds());
    const { data: newDoc, error: insertError } = await supabase
      .from('auth_state')
      .upsert({ 
        session_id: sessionId, 
        creds: serializeForStorage(newCreds), 
        keys: serializeForStorage({}),
        status: 'disconnected'
      }, { onConflict: 'session_id' })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating auth state:', insertError);
    }
    doc = newDoc || { creds: serializeForStorage(newCreds), keys: serializeForStorage({}) };
  }

  let state = {
    creds: deserialize(doc.creds) || initAuthCreds(),
    keys: deserialize(doc.keys) || {}
  };

  const saveState = async () => {
    try {
      await supabase
        .from('auth_state')
        .upsert({ 
          session_id: sessionId, 
          creds: serializeForStorage(state.creds), 
          keys: serializeForStorage(state.keys)
        }, { onConflict: 'session_id' });
    } catch (error) {
      console.error('Error saving auth state:', error);
    }
  };

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const store = state.keys[type] || {};
      for (const id of ids) {
        if (store[id]) {
          data[id] = deserialize(store[id]);
        }
      }
      return data;
    },
    set: async (data) => {
      state.keys = state.keys || {};
      Object.keys(data).forEach((category) => {
        state.keys[category] = state.keys[category] || {};
        Object.assign(state.keys[category], serialize(data[category]));
      });
      await saveState();
    }
  };

  return {
    state: { creds: state.creds, keys },
    saveCreds: async () => {
      state.creds = serialize(state.creds);
      state.creds = deserialize(state.creds);
      await saveState();
    },
    clearState: async () => {
      // Initialize fresh credentials
      const freshCreds = initAuthCreds();
      state = { creds: freshCreds, keys: {} };
      
      // Delete all existing auth data and create fresh
      await supabase
        .from('auth_state')
        .delete()
        .eq('session_id', sessionId);
      
      await supabase
        .from('auth_state')
        .upsert({ 
          session_id: sessionId, 
          creds: serializeForStorage(freshCreds), 
          keys: serializeForStorage({}),
          status: 'disconnected',
          qr_code: null
        }, { onConflict: 'session_id' });
    },
    updateStatus: async (status, qrCode = null) => {
      const updates = { status };
      if (qrCode !== null) updates.qr_code = qrCode;
      if (status === 'connected') updates.last_connected_at = new Date().toISOString();
      
      await supabase
        .from('auth_state')
        .update(updates)
        .eq('session_id', sessionId);
    }
  };
};

module.exports = useSupabaseAuthState;
