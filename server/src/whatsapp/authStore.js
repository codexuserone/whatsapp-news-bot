const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { supabase } = require('../db/supabase');

const serialize = (data) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));
const deserialize = (data) => JSON.parse(JSON.stringify(data), BufferJSON.reviver);

const useSupabaseAuthState = async (sessionId = 'default') => {
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
        creds: newCreds, 
        keys: {},
        status: 'disconnected'
      }, { onConflict: 'session_id' })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating auth state:', insertError);
    }
    doc = newDoc || { creds: newCreds, keys: {} };
  }

  let state = {
    creds: deserialize(doc.creds || initAuthCreds()),
    keys: deserialize(doc.keys || {})
  };

  const saveState = async () => {
    try {
      await supabase
        .from('auth_state')
        .upsert({ 
          session_id: sessionId, 
          creds: serialize(state.creds), 
          keys: serialize(state.keys)
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
      await supabase
        .from('auth_state')
        .update({ creds: null, keys: null, status: 'disconnected' })
        .eq('session_id', sessionId);
      state = { creds: initAuthCreds(), keys: {} };
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
