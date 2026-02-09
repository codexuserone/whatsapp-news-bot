const { getSupabaseClient } = require('../db/supabase');
const { loadBaileys } = require('./baileys');

type AuthData = Record<string, unknown>;
type KeyStoreData = Record<string, Record<string, unknown>>;

type LeaseResult = {
  ok: boolean;
  supported: boolean;
  ownerId: string | null;
  expiresAt: string | null;
  reason?: string;
};

type LeaseInfo = {
  supported: boolean;
  ownerId: string | null;
  expiresAt: string | null;
};

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
  acquireLease: (ownerId: string, ttlMs?: number) => Promise<LeaseResult>;
  renewLease: (ownerId: string, ttlMs?: number) => Promise<LeaseResult>;
  releaseLease: (ownerId: string) => Promise<LeaseResult>;
  forceAcquireLease: (ownerId: string, ttlMs?: number) => Promise<LeaseResult>;
  getLeaseInfo: () => Promise<LeaseInfo>;
};

const useSupabaseAuthState = async (sessionId: string = 'default'): Promise<AuthStore> => {
  const { BufferJSON, initAuthCreds } = await loadBaileys();

  const looksLikeBase64 = (value: string) => {
    const s = value.trim();
    return (
      s.length >= 32 &&
      s.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(s)
    );
  };

  const normalizeStoredString = (value: string, depth = 0): unknown => {
    if (depth > 4) return value;
    const raw = String(value ?? '');
    const trimmed = raw.trim();
    if (!trimmed) return raw;

    // Attempt to parse JSON (handles double-encoded JSONB strings)
    try {
      const parsed = JSON.parse(trimmed, BufferJSON.reviver);
      if (typeof parsed === 'string') {
        if (parsed === raw) return parsed;
        return normalizeStoredString(parsed, depth + 1);
      }
      return deepNormalize(parsed, depth + 1);
    } catch {
      // Not JSON; fall through
    }

    // Attempt to decode base64 (handles legacy base64-encoded key material)
    if (looksLikeBase64(trimmed)) {
      try {
        return Buffer.from(trimmed, 'base64');
      } catch {
        return raw;
      }
    }

    return raw;
  };

  const deepNormalize = (input: unknown, depth = 0): unknown => {
    if (input == null) return input;
    if (depth > 10) return input;
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof Uint8Array) return input;

    if (typeof input === 'string') {
      return normalizeStoredString(input, depth);
    }

    if (Array.isArray(input)) {
      let changed = false;
      const mapped = input.map((value) => {
        const next = deepNormalize(value, depth + 1);
        if (next !== value) changed = true;
        return next;
      });
      return changed ? mapped : input;
    }

    if (typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const next = deepNormalize(value, depth + 1);
        out[key] = next;
        if (next !== value) changed = true;
      }
      return changed ? out : input;
    }

    return input;
  };

  const normalizeKeyValue = (value: unknown): unknown => deepNormalize(value, 0);

  const toStorableJson = (data: unknown): unknown => {
    try {
      return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    } catch (e) {
      console.error('Serialize storage error:', e);
      try {
        return JSON.parse(JSON.stringify(data));
      } catch {
        return data;
      }
    }
  };

  const fromStored = (data: unknown | null): unknown => {
    try {
      if (data == null) return data;
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') {
        return normalizeStoredString(data, 0);
      }
      return deepNormalize(JSON.parse(JSON.stringify(data), BufferJSON.reviver), 0);
    } catch (e) {
      console.error('Deserialize error:', e);
      return deepNormalize(data, 0);
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
      updateStatus: async () => {},
      acquireLease: async () => ({ ok: true, supported: false, ownerId: null, expiresAt: null }),
      renewLease: async () => ({ ok: true, supported: false, ownerId: null, expiresAt: null }),
      releaseLease: async () => ({ ok: true, supported: false, ownerId: null, expiresAt: null }),
      forceAcquireLease: async () => ({ ok: true, supported: false, ownerId: null, expiresAt: null }),
      getLeaseInfo: async () => ({ supported: false, ownerId: null, expiresAt: null })
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
        creds: toStorableJson(newCreds), 
        keys: toStorableJson({}),
        status: 'disconnected'
      }, { onConflict: 'session_id' })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating auth state:', insertError);
    }
    doc = newDoc || { creds: toStorableJson(newCreds), keys: toStorableJson({}) };
  }

  let state: { creds: AuthData; keys: KeyStoreData } = {
    creds: (fromStored(doc.creds) as AuthData) || initAuthCreds(),
    keys: (fromStored(doc.keys) as KeyStoreData) || {}
  };

  let saveChain: Promise<void> = Promise.resolve();

  const withSaveLock = async (fn: () => Promise<void>) => {
    const previous = saveChain;
    let release!: () => void;
    saveChain = new Promise<void>((resolve) => {
      release = () => resolve(undefined);
    });
    await previous;
    try {
      await fn();
    } finally {
      release();
    }
  };

  const saveState = async () => {
    try {
      await withSaveLock(async () => {
        await supabase
          .from('auth_state')
          .upsert({
            session_id: sessionId,
            creds: toStorableJson(state.creds),
            keys: toStorableJson(state.keys)
          }, { onConflict: 'session_id' });
      });
    } catch (error) {
      console.error('Error saving auth state:', error);
    }
  };

  // Lease helpers (avoid WhatsApp conflicts across overlapping deploys/instances).
  let leaseSupported: boolean | null = null;

  const getCurrentLeaseRow = async (): Promise<{ ownerId: string | null; expiresAt: string | null } | null> => {
    try {
      const { data, error } = await supabase
        .from('auth_state')
        .select('lease_owner,lease_expires_at')
        .eq('session_id', sessionId)
        .limit(1);
      if (error) return null;
      const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      if (!row) return { ownerId: null, expiresAt: null };
      return {
        ownerId: row.lease_owner ? String(row.lease_owner) : null,
        expiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null
      };
    } catch {
      return null;
    }
  };

  const isMissingLeaseColumn = (supabaseError: unknown) => {
    const msg = String((supabaseError as { message?: unknown })?.message || supabaseError || '').toLowerCase();
    if (!msg) return false;
    // PostgREST typically returns messages like: "column auth_state.lease_owner does not exist"
    return msg.includes('does not exist') && (msg.includes('lease_owner') || msg.includes('lease_expires_at'));
  };

  const acquireLease = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    if (leaseSupported === false) {
      return { ok: true, supported: false, ownerId: null, expiresAt: null };
    }

    const nowMs = Date.now();
    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    const current = await getCurrentLeaseRow();

    if (current?.ownerId && current.ownerId !== ownerId) {
      const expiryMs = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
      const leaseStillValid = Number.isFinite(expiryMs) && expiryMs > nowMs;
      if (leaseStillValid) {
        leaseSupported = true;
        return {
          ok: false,
          supported: true,
          ownerId: current.ownerId,
          expiresAt: current.expiresAt,
          reason: 'lease_held'
        };
      }
    }

    const { data, error: leaseError } = await supabase
      .from('auth_state')
      .update({ lease_owner: ownerId, lease_expires_at: expiresAt })
      .eq('session_id', sessionId)
      .select('lease_owner,lease_expires_at');

    if (leaseError) {
      if (isMissingLeaseColumn(leaseError)) {
        leaseSupported = false;
        console.warn('Auth lease columns missing; skipping conflict prevention. Run latest SQL migrations.');
        return { ok: true, supported: false, ownerId: null, expiresAt: null };
      }
      leaseSupported = true;
      return {
        ok: false,
        supported: true,
        ownerId: null,
        expiresAt: null,
        reason: String((leaseError as { message?: unknown })?.message || leaseError)
      };
    }

    leaseSupported = true;
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    let currentOwner = row?.lease_owner ? String(row.lease_owner) : current?.ownerId || null;
    let currentExpiry = row?.lease_expires_at ? String(row.lease_expires_at) : current?.expiresAt || null;
    const ok = currentOwner === ownerId;
    if (ok) {
      return { ok: true, supported: true, ownerId: currentOwner, expiresAt: currentExpiry || expiresAt };
    }

    // If we didn't update anything, fetch the current lease holder for better diagnostics.
    if (!currentOwner || !currentExpiry) {
      const current = await getCurrentLeaseRow();
      if (current) {
        currentOwner = current.ownerId;
        currentExpiry = current.expiresAt;
      }
    }

    return {
      ok: false,
      supported: true,
      ownerId: currentOwner,
      expiresAt: currentExpiry,
      reason: 'lease_held'
    };
  };

  const renewLease = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    if (leaseSupported === false) {
      return { ok: true, supported: false, ownerId: null, expiresAt: null };
    }

    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    const { data, error: leaseError } = await supabase
      .from('auth_state')
      .update({ lease_expires_at: expiresAt })
      .eq('session_id', sessionId)
      .eq('lease_owner', ownerId)
      .select('lease_owner,lease_expires_at');

    if (leaseError) {
      if (isMissingLeaseColumn(leaseError)) {
        leaseSupported = false;
        return { ok: true, supported: false, ownerId: null, expiresAt: null };
      }
      leaseSupported = true;
      return {
        ok: false,
        supported: true,
        ownerId: null,
        expiresAt: null,
        reason: String((leaseError as { message?: unknown })?.message || leaseError)
      };
    }

    leaseSupported = true;
    const ok = Array.isArray(data) ? data.length > 0 : false;
    if (ok) {
      return { ok: true, supported: true, ownerId, expiresAt };
    }

    const current = await getCurrentLeaseRow();

    // Some PostgREST/Supabase edge-cases can return 0 updated rows even when
    // the lease row is still owned by this instance. Treat that as success to
    // avoid false "lost lease" conflicts.
    if (current?.ownerId === ownerId) {
      return {
        ok: true,
        supported: true,
        ownerId,
        expiresAt: current.expiresAt || expiresAt
      };
    }

    // If the lease looks free/expired, try to recover ownership in one step.
    const currentExpiryMs = current?.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
    const leaseExpired = Number.isFinite(currentExpiryMs) ? currentExpiryMs <= Date.now() : true;
    if (!current?.ownerId || leaseExpired) {
      const recovered = await forceAcquireLease(ownerId, ttlMs);
      if (recovered.ok || !recovered.supported) {
        return recovered;
      }
    }

    return {
      ok: false,
      supported: true,
      ownerId: current?.ownerId ?? ownerId,
      expiresAt: current?.expiresAt ?? expiresAt,
      reason: 'lost'
    };
  };

  const forceAcquireLease = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    if (leaseSupported === false) {
      return { ok: true, supported: false, ownerId: null, expiresAt: null };
    }

    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    const { data, error: leaseError } = await supabase
      .from('auth_state')
      .update({ lease_owner: ownerId, lease_expires_at: expiresAt })
      .eq('session_id', sessionId)
      .select('lease_owner,lease_expires_at');

    if (leaseError) {
      if (isMissingLeaseColumn(leaseError)) {
        leaseSupported = false;
        return { ok: true, supported: false, ownerId: null, expiresAt: null };
      }
      leaseSupported = true;
      return {
        ok: false,
        supported: true,
        ownerId: null,
        expiresAt: null,
        reason: String((leaseError as { message?: unknown })?.message || leaseError)
      };
    }

    leaseSupported = true;
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    const currentOwner = row?.lease_owner ? String(row.lease_owner) : ownerId;
    const currentExpiry = row?.lease_expires_at ? String(row.lease_expires_at) : expiresAt;
    return { ok: currentOwner === ownerId, supported: true, ownerId: currentOwner, expiresAt: currentExpiry };
  };

  const getLeaseInfo = async (): Promise<LeaseInfo> => {
    if (leaseSupported === false) {
      return { supported: false, ownerId: null, expiresAt: null };
    }
    const current = await getCurrentLeaseRow();
    if (!current) {
      return { supported: Boolean(leaseSupported), ownerId: null, expiresAt: null };
    }
    return { supported: Boolean(leaseSupported ?? true), ownerId: current.ownerId, expiresAt: current.expiresAt };
  };

  const releaseLease = async (ownerId: string): Promise<LeaseResult> => {
    if (leaseSupported === false) {
      return { ok: true, supported: false, ownerId: null, expiresAt: null };
    }

    const { error: leaseError } = await supabase
      .from('auth_state')
      .update({ lease_owner: null, lease_expires_at: null })
      .eq('session_id', sessionId)
      .eq('lease_owner', ownerId);

    if (leaseError) {
      if (isMissingLeaseColumn(leaseError)) {
        leaseSupported = false;
        return { ok: true, supported: false, ownerId: null, expiresAt: null };
      }
      leaseSupported = true;
      return {
        ok: false,
        supported: true,
        ownerId: null,
        expiresAt: null,
        reason: String((leaseError as { message?: unknown })?.message || leaseError)
      };
    }

    leaseSupported = true;
    return { ok: true, supported: true, ownerId: null, expiresAt: null };
  };

  // Opportunistically repair legacy/double-encoded auth values on load.
  try {
    let repaired = false;

    const normalizedCreds = normalizeKeyValue(state.creds);
    if (normalizedCreds && normalizedCreds !== state.creds && typeof normalizedCreds === 'object') {
      state.creds = normalizedCreds as AuthData;
      repaired = true;
    }

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
        const bucket = state.keys[category] || (state.keys[category] = {});
        const entries = data[category] || {};
        Object.entries(entries).forEach(([id, value]) => {
          if (value === null || value === undefined) {
            delete bucket[id];
          } else {
            bucket[id] = value as never;
          }
        });
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
          creds: toStorableJson(freshCreds), 
          keys: toStorableJson({}),
          status: 'disconnected',
          qr_code: null
        }, { onConflict: 'session_id' });
    },
    clearKeys,
    updateStatus: async (status: string, qrCode?: string | null) => {
      const updates: Record<string, unknown> = { status };
      // Only write qr_code when explicitly provided (allow null to clear).
      if (qrCode !== undefined) updates.qr_code = qrCode;
      if (status === 'connected') updates.last_connected_at = new Date().toISOString();
      
      const { error: statusError } = await supabase.from('auth_state').update(updates).eq('session_id', sessionId);
      if (statusError) {
        // Silently ignore constraint violations - they'll be fixed by migration 014
        const msg = String(statusError);
        if (msg.includes('auth_state_status_check') && status === 'conflict') {
          // This is expected until migration runs - don't spam logs
          return;
        }
        console.warn('Failed to update auth_state status:', statusError);
      }
    },
    acquireLease,
    renewLease,
    releaseLease,
    forceAcquireLease,
    getLeaseInfo
  };
};

module.exports = useSupabaseAuthState;
export {};
