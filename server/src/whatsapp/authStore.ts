const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { getSupabaseClient } = require('../db/supabase');
const { loadBaileys } = require('./baileys');

type AuthData = Record<string, unknown>;
type KeyStoreData = Record<string, Record<string, unknown>>;
type AuthStore = {
  state: {
    creds: AuthData;
    keys: {
      get: (type: string, ids: string[]) => Promise<Record<string, unknown>>;
      set: (data: KeyStoreData) => Promise<void>;
    };
  };
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
  clearKeys: (types?: string[]) => Promise<void>;
  updateStatus: (status: string, qrCode?: string | null) => Promise<void>;
};

const useSupabaseAuthState = async (sessionId: string = 'default'): Promise<AuthStore> => {
  const { BufferJSON, initAuthCreds } = await loadBaileys();

  const normalizeKeyValue = (value: unknown): unknown => {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value !== 'string') return value;

    // Some older auth-state rows may contain double-encoded JSON or base64 strings.
    try {
      return JSON.parse(value, BufferJSON.reviver);
    } catch {
      // Not JSON; fall through
    }

    const s = value.trim();
    const looksLikeBase64 =
      s.length >= 32 &&
      s.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(s);

    if (looksLikeBase64) {
      try {
        return Buffer.from(s, 'base64');
      } catch {
        return value;
      }
    }

    return value;
  };

  const serializeForStorage = (data: unknown): string => {
    try {
      return JSON.stringify(data, BufferJSON.replacer);
    } catch (e) {
      console.error('Serialize storage error:', e);
      return JSON.stringify(data);
    }
  };

  const deserialize = (data: unknown | string | null): unknown => {
    try {
      if (data == null) return data;
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') {
        return JSON.parse(data, BufferJSON.reviver);
      }
      return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
    } catch (e) {
      console.error('Deserialize error:', e);
      return data;
    }
  };

  const supabase = getSupabaseClient();
  
  // If Supabase is not available, use in-memory state
  if (!supabase) {
    console.warn('Supabase not available, using in-memory auth state');
    let state: { creds: AuthData; keys: KeyStoreData } = { creds: initAuthCreds(), keys: {} };

    const stateRef = {
      get creds() {
        return state.creds;
      },
      set creds(value) {
        state.creds = value;
      },
      keys: {
        get: async (type: string, ids: string[]) => {
          const data: Record<string, unknown> = {};
          const store = state.keys[type] || {};
          for (const id of ids) {
            if (store[id]) data[id] = store[id];
          }
          return data;
        },
        set: async (data: KeyStoreData) => {
          Object.keys(data).forEach((category) => {
            state.keys[category] = state.keys[category] || {};
            Object.assign(state.keys[category], data[category]);
          });
        }
      }
    };

    return {
      state: stateRef,
      saveCreds: async () => {},
      clearState: async () => { state = { creds: initAuthCreds(), keys: {} }; },
      clearKeys: async (types?: string[]) => {
        if (!types?.length) {
          state.keys = {};
          return;
        }
        for (const type of types) delete state.keys[type];
      },
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
    const newCreds = initAuthCreds();
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

  let state: { creds: AuthData; keys: KeyStoreData } = {
    creds: (deserialize(doc.creds) as AuthData) || initAuthCreds(),
    keys: (deserialize(doc.keys) as KeyStoreData) || {}
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

  // Opportunistically repair legacy/double-encoded key values on load.
  try {
    let repaired = false;
    for (const type of Object.keys(state.keys || {})) {
      const typeStore = state.keys[type] || {};
      for (const id of Object.keys(typeStore)) {
        const current = typeStore[id];
        const normalized = normalizeKeyValue(current);
        if (normalized !== current) {
          typeStore[id] = normalized as never;
          repaired = true;
        }
      }
      state.keys[type] = typeStore;
    }
    if (repaired) {
      await saveState();
    }
  } catch (e) {
    console.warn('Auth key repair skipped:', e);
  }

  const keys = {
    get: async (type: string, ids: string[]) => {
      const data: Record<string, unknown> = {};
      const store = state.keys[type] || {};
      for (const id of ids) {
        if (store[id] !== undefined) data[id] = normalizeKeyValue(store[id]);
      }
      return data;
    },
    set: async (data: KeyStoreData) => {
      state.keys = state.keys || {};
      Object.keys(data).forEach((category) => {
        state.keys[category] = state.keys[category] || {};
        Object.assign(state.keys[category], data[category]);
      });
      await saveState();
    }
  };

  const clearKeys = async (types?: string[]) => {
    if (!types?.length) {
      state.keys = {};
    } else {
      for (const type of types) {
        if (state.keys?.[type]) delete state.keys[type];
      }
    }
    await saveState();
  };

  const stateRef = {
    get creds() {
      return state.creds;
    },
    set creds(value) {
      state.creds = value;
    },
    keys
  };

  return {
    state: stateRef,
    saveCreds: async () => {
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
    clearKeys,
    updateStatus: async (status: string, qrCode: string | null = null) => {
      const updates: Record<string, unknown> = { status };
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
export {};
