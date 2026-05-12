const { getSupabaseClient } = require('../db/supabase');
const dns = require('dns');
const { Pool } = require('pg');
const { loadBaileys } = require('./baileys');
const { getErrorMessage } = require('../utils/errorUtils');

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

type AuthStateRow = {
  creds?: unknown;
  keys?: unknown;
  lease_owner?: unknown;
  lease_expires_at?: unknown;
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

let authStatePool: InstanceType<typeof Pool> | null | undefined;
let authStatePoolErrorHandlerBound = false;

const extractSupabaseRef = (databaseUrl: string) => {
  try {
    const parsed = new URL(databaseUrl);
    const hostMatch = parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (hostMatch?.[1]) {
      return hostMatch[1].toLowerCase();
    }

    const userMatch = decodeURIComponent(parsed.username || '').match(/^postgres\.([a-z0-9]+)$/i);
    if (userMatch?.[1]) {
      return userMatch[1].toLowerCase();
    }
  } catch {
    // ignore
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  if (!supabaseUrl) return null;

  try {
    const parsed = new URL(supabaseUrl);
    const ref = String(parsed.hostname.split('.')[0] || '').trim().toLowerCase();
    return ref || null;
  } catch {
    return null;
  }
};

const resolveAuthStateDbUrl = () => {
  const explicitPoolerUrl = String(process.env.SUPABASE_POOLER_URL || '').trim();
  if (explicitPoolerUrl) {
    return explicitPoolerUrl;
  }

  const provider = String(process.env.DB_PROVIDER || '').trim().toLowerCase();
  const configuredUrl =
    provider === 'neon'
      ? String(process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '').trim()
      : provider === 'postgres'
        ? String(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.NEON_DATABASE_URL || process.env.SUPABASE_DB_URL || '').trim()
      : String(process.env.SUPABASE_DB_URL || process.env.NEON_DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
  if (!configuredUrl) return '';

  try {
    const parsed = new URL(configuredUrl);
    if (!/^db\.[a-z0-9]+\.supabase\.co$/i.test(parsed.hostname)) {
      return configuredUrl;
    }

    const ref = extractSupabaseRef(configuredUrl);
    if (!ref) {
      return configuredUrl;
    }

    const poolerHost =
      String(process.env.SUPABASE_POOLER_HOST || '').trim() ||
      (String(process.env.SUPABASE_POOLER_REGION || '').trim()
        ? `aws-0-${String(process.env.SUPABASE_POOLER_REGION || '').trim()}.pooler.supabase.com`
        : 'aws-0-us-west-2.pooler.supabase.com');
    const poolerPort = String(process.env.SUPABASE_POOLER_PORT || '6543').trim() || '6543';
    const poolerUser = String(process.env.SUPABASE_POOLER_USER || '').trim() || `postgres.${ref}`;

    parsed.hostname = poolerHost;
    parsed.port = poolerPort;
    parsed.username = encodeURIComponent(poolerUser);
    return parsed.toString();
  } catch {
    return configuredUrl;
  }
};

const preferIpv4 = () => {
  try {
    const setter = (dns as unknown as { setDefaultResultOrder?: (order: string) => void }).setDefaultResultOrder;
    if (typeof setter === 'function') {
      setter('ipv4first');
    }
  } catch {
    // ignore
  }
};

const getAuthStatePool = (): InstanceType<typeof Pool> | null => {
  if (authStatePool !== undefined) {
    return authStatePool;
  }

  const connectionString = resolveAuthStateDbUrl();
  if (!connectionString) {
    authStatePool = null;
    return authStatePool;
  }

  preferIpv4();

  authStatePool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: getAuthStatePoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true
  });

  if (!authStatePoolErrorHandlerBound) {
    authStatePool.on('error', (error: Error) => {
      console.warn('auth_state pg pool error:', getErrorMessage(error, 'Unknown pool error'));
    });
    authStatePoolErrorHandlerBound = true;
  }

  return authStatePool;
};

const normalizeLeaseTimestamp = (value: unknown) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const isMissingLeaseColumn = (error: unknown) => {
  const msg = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  if (!msg) return false;
  return msg.includes('does not exist') && (msg.includes('lease_owner') || msg.includes('lease_expires_at'));
};

const isMissingAuthKeysTable = (error: unknown) => {
  const code = String((error as { code?: unknown })?.code || '');
  const msg = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  return code === '42P01' || (msg.includes('does not exist') && msg.includes('auth_keys'));
};

const isQuotaLimitError = (error: unknown) => {
  const msg = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  return msg.includes('data transfer quota') || msg.includes('quota exceeded');
};

const isTransientLeaseTransportError = (error: unknown) => {
  const raw = String((error as { message?: unknown; code?: unknown })?.message || error || '');
  const code = String((error as { code?: unknown })?.code || '').toUpperCase();
  const normalized = raw.toLowerCase();

  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) {
    return true;
  }

  return [
    'checkouttimeout',
    'headers timeout',
    'connection terminated unexpectedly',
    'connection closed',
    'fetch failed',
    'timed out',
    'timeout',
    'error code 522',
    'unexpected eof',
    'socket hang up',
    'connection reset',
    'connection refused',
    'network is unreachable',
    'could not connect',
    'data transfer quota',
    'quota exceeded'
  ].some((needle) => normalized.includes(needle));
};

const resolveRetryNumber = (specificKey: string, sharedKey: string, fallback: number) => {
  const specific = Number(process.env[specificKey]);
  if (Number.isFinite(specific)) return specific;
  const shared = Number(process.env[sharedKey]);
  if (Number.isFinite(shared)) return shared;
  return fallback;
};

const getAuthStateQueryRetries = () =>
  Math.max(0, Math.floor(resolveRetryNumber('AUTH_STATE_QUERY_RETRIES', 'POSTGRES_QUERY_RETRIES', 6)));

const getAuthStateRetryBaseMs = () =>
  Math.max(0, Math.floor(resolveRetryNumber('AUTH_STATE_QUERY_RETRY_BASE_MS', 'POSTGRES_QUERY_RETRY_BASE_MS', 500)));

const getAuthStateRetryMaxMs = () => {
  const baseMs = getAuthStateRetryBaseMs();
  return Math.max(
    baseMs,
    Math.floor(resolveRetryNumber('AUTH_STATE_QUERY_RETRY_MAX_MS', 'POSTGRES_QUERY_RETRY_MAX_MS', 5000))
  );
};

const getAuthStatePoolMax = () =>
  Math.max(
    1,
    Math.floor(resolveRetryNumber('AUTH_STATE_POOL_MAX', 'AUTH_STATE_MAX_POOL', 2))
  );

const getAuthStateRetryDelayMs = (attempt: number) => {
  const baseMs = getAuthStateRetryBaseMs();
  if (baseMs <= 0) return 0;
  const exponentialDelay = baseMs * (2 ** Math.max(attempt - 1, 0));
  return Math.min(exponentialDelay, getAuthStateRetryMaxMs());
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

  const normalizeKeyValue = (value: unknown): unknown => {
    try {
      if (value == null) return value;
      if (Buffer.isBuffer(value)) return value;
      if (typeof value === 'string') return normalizeStoredString(value, 0);
      return deepNormalize(JSON.parse(JSON.stringify(value), BufferJSON.reviver), 0);
    } catch {
      return deepNormalize(value, 0);
    }
  };

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

  const fromStoredKeys = (data: unknown | null): KeyStoreData => {
    if (data == null) return {};
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data, BufferJSON.reviver);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as KeyStoreData : {};
      } catch {
        return {};
      }
    }
    return data && typeof data === 'object' && !Array.isArray(data) ? data as KeyStoreData : {};
  };

  const supabase = getSupabaseClient();
  const authStatePool = getAuthStatePool();

  const runPgQuery = async <T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params: unknown[] = []
  ) => {
    const maxAttempts = getAuthStateQueryRetries() + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const pool = getAuthStatePool();
      if (!pool) throw new Error('auth_state postgres pool is not configured');
      try {
        const result = await pool.query(query, params);
        return result.rows as T[];
      } catch (error) {
        const transient = isTransientLeaseTransportError(error);
        if (isQuotaLimitError(error) || !transient || attempt >= maxAttempts) {
          throw error;
        }
        console.warn(
          `Transient auth_state Postgres query failure; retrying ${attempt}/${maxAttempts - 1}:`,
          getErrorMessage(error)
        );
        const delayMs = getAuthStateRetryDelayMs(attempt);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    return [];
  };

  const getAuthStateRowViaPg = async (): Promise<AuthStateRow | null> => {
    const rows = await runPgQuery<AuthStateRow>(
      `select creds, lease_owner, lease_expires_at
         from auth_state
        where session_id = $1
        limit 1`,
      [sessionId]
    );
    return rows[0] || null;
  };

  const getAuthLeaseRowViaPg = async (): Promise<AuthStateRow | null> => {
    const rows = await runPgQuery<AuthStateRow>(
      `select lease_owner, lease_expires_at
         from auth_state
        where session_id = $1
        limit 1`,
      [sessionId]
    );
    return rows[0] || null;
  };

  const upsertAuthStateViaPg = async (payload: {
    creds?: unknown;
    keys?: unknown;
    status?: string | null;
    qrCode?: string | null;
    includeQrCode?: boolean;
    lastConnectedAt?: string | null;
  }) => {
    const updates: string[] = [];
    const params: unknown[] = [sessionId];
    const insertColumns = ['session_id'];
    const insertValues = ['$1'];

    if (payload.creds !== undefined) {
      insertColumns.push('creds');
      params.push(JSON.stringify(payload.creds));
      insertValues.push(`$${params.length}::jsonb`);
      updates.push(`creds = excluded.creds`);
    }

    if (payload.keys !== undefined) {
      insertColumns.push('keys');
      params.push(JSON.stringify(payload.keys));
      insertValues.push(`$${params.length}::jsonb`);
      updates.push(`keys = excluded.keys`);
    }

    if (payload.status !== undefined) {
      insertColumns.push('status');
      params.push(payload.status);
      insertValues.push(`$${params.length}`);
      updates.push(`status = excluded.status`);
    }

    if (payload.includeQrCode) {
      insertColumns.push('qr_code');
      params.push(payload.qrCode ?? null);
      insertValues.push(`$${params.length}`);
      updates.push(`qr_code = excluded.qr_code`);
    }

    if (payload.lastConnectedAt) {
      insertColumns.push('last_connected_at');
      params.push(payload.lastConnectedAt);
      insertValues.push(`$${params.length}::timestamptz`);
      updates.push(`last_connected_at = excluded.last_connected_at`);
    }

    if (!updates.length) {
      insertColumns.push('status');
      params.push('disconnected');
      insertValues.push(`$${params.length}`);
      updates.push('session_id = excluded.session_id');
    }

    await runPgQuery(
      `insert into auth_state (${insertColumns.join(', ')})
       values (${insertValues.join(', ')})
       on conflict (session_id) do update
         set ${updates.join(', ')}`,
      params
    );
  };

  const patchAuthKeysViaPg = async (data: KeyStoreData) => {
    const upserts: Array<[string, string, unknown]> = [];
    const deletes: Array<[string, string]> = [];

    for (const [category, entries] of Object.entries(data || {})) {
      if (!entries || typeof entries !== 'object') continue;
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) {
          deletes.push([category, id]);
        } else {
          upserts.push([category, id, value]);
        }
      }
    }

    try {
      if (deletes.length) {
        await runPgQuery(
          `delete from auth_keys
            where session_id = $1
              and (category, key_id) in (
                select category, key_id
                from jsonb_to_recordset($2::jsonb) as x(category text, key_id text)
              )`,
          [sessionId, JSON.stringify(deletes.map(([category, id]) => ({ category, key_id: id })))]
        );
      }

      if (upserts.length) {
        await runPgQuery(
          `insert into auth_keys (session_id, category, key_id, value, updated_at)
           select $1, category, key_id, value, now()
           from jsonb_to_recordset($2::jsonb) as x(category text, key_id text, value jsonb)
           on conflict (session_id, category, key_id)
           do update set value = excluded.value, updated_at = now()`,
          [
            sessionId,
            JSON.stringify(upserts.map(([category, id, value]) => ({ category, key_id: id, value })))
          ]
        );
      }

      return;
    } catch (error) {
      if (!isMissingAuthKeysTable(error)) {
        throw error;
      }
    }

    for (const [category, entries] of Object.entries(data || {})) {
      if (!entries || typeof entries !== 'object') continue;
      for (const [id, value] of Object.entries(entries)) {
        if (value === null || value === undefined) {
          await runPgQuery(
            `update auth_state
                set keys = coalesce(keys, '{}'::jsonb) #- ARRAY[$2, $3]::text[]
              where session_id = $1`,
            [sessionId, category, id]
          );
          continue;
        }

        await runPgQuery(
          `update auth_state
              set keys = jsonb_set(coalesce(keys, '{}'::jsonb), ARRAY[$2, $3]::text[], $4::jsonb, true)
            where session_id = $1`,
          [sessionId, category, id, JSON.stringify(value)]
        );
      }
    }
  };

  const getAuthKeysViaPg = async (type: string, ids: string[]) => {
    const values: Record<string, unknown> = {};
    const category = String(type || '').trim();
    const requestedIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
    if (!category || !requestedIds.length) return values;

    let authKeysTableMissing = false;
    try {
      const rows = await runPgQuery<{ key_id?: string; value?: unknown }>(
        `select key_id, value
           from auth_keys
          where session_id = $1
            and category = $2
            and key_id = any($3::text[])`,
        [sessionId, category, requestedIds]
      );
      for (const row of rows) {
        const id = String(row.key_id || '').trim();
        if (id && row.value !== null && row.value !== undefined) {
          values[id] = row.value;
        }
      }
    } catch (error) {
      if (!isMissingAuthKeysTable(error)) {
        throw error;
      }
      authKeysTableMissing = true;
    }

    if (!authKeysTableMissing) return values;

    const missingLegacyIds = requestedIds.filter((id) => values[id] === undefined);
    if (!missingLegacyIds.length) return values;

    const legacyRows = await runPgQuery<{ key_id?: string; value?: unknown }>(
      `select requested.key_id, auth_state.keys #> ARRAY[$2, requested.key_id]::text[] as value
         from auth_state
         cross join unnest($3::text[]) as requested(key_id)
        where auth_state.session_id = $1`,
      [sessionId, category, missingLegacyIds]
    );
    for (const row of legacyRows) {
      const id = String(row.key_id || '').trim();
      if (id && row.value !== null && row.value !== undefined) {
        values[id] = row.value;
      }
    }

    return values;
  };

  const clearLegacyKeysViaPg = async (types?: string[]) => {
    if (!types?.length) {
      await runPgQuery(
        `update auth_state
            set keys = '{}'::jsonb
          where session_id = $1`,
        [sessionId]
      );
      return;
    }

    for (const type of types) {
      const category = String(type || '').trim();
      if (!category) continue;
      await runPgQuery(
        `update auth_state
            set keys = coalesce(keys, '{}'::jsonb) - $2
          where session_id = $1`,
        [sessionId, category]
      );
    }
  };

  const clearKeysViaPg = async (types?: string[]) => {
    try {
      if (!types?.length) {
        await runPgQuery(`delete from auth_keys where session_id = $1`, [sessionId]);
      } else {
        const categories = Array.from(new Set(types.map((type) => String(type || '').trim()).filter(Boolean)));
        if (categories.length) {
          await runPgQuery(
            `delete from auth_keys
              where session_id = $1
                and category = any($2::text[])`,
            [sessionId, categories]
          );
        }
      }
    } catch (error) {
      if (!isMissingAuthKeysTable(error)) {
        throw error;
      }
    }

    await clearLegacyKeysViaPg(types);
  };

  const clearAuthStateViaPg = async (freshCreds: unknown) => {
    try {
      await runPgQuery(`delete from auth_keys where session_id = $1`, [sessionId]);
    } catch (error) {
      if (!isMissingAuthKeysTable(error)) {
        throw error;
      }
    }
    await runPgQuery(`delete from auth_state where session_id = $1`, [sessionId]);
    await upsertAuthStateViaPg({
      creds: freshCreds,
      keys: {},
      status: 'disconnected',
      qrCode: null,
      includeQrCode: true
    });
  };

  const getCurrentLeaseRowViaPg = async (): Promise<{ ownerId: string | null; expiresAt: string | null }> => {
    const row = await getAuthLeaseRowViaPg();
    return {
      ownerId: row?.lease_owner ? String(row.lease_owner) : null,
      expiresAt: normalizeLeaseTimestamp(row?.lease_expires_at)
    };
  };

  const acquireLeaseViaPg = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    const rows = await runPgQuery<AuthStateRow>(
      `update auth_state
          set lease_owner = $2,
              lease_expires_at = $3::timestamptz
        where session_id = $1
          and (
            lease_owner is null
            or lease_owner = $2
            or lease_expires_at is null
            or lease_expires_at < $4::timestamptz
          )
      returning lease_owner, lease_expires_at`,
      [sessionId, ownerId, expiresAt, new Date().toISOString()]
    );

    const row = rows[0];
    if (row?.lease_owner && String(row.lease_owner) === ownerId) {
      return {
        ok: true,
        supported: true,
        ownerId,
        expiresAt: normalizeLeaseTimestamp(row.lease_expires_at) || expiresAt
      };
    }

    const current = await getCurrentLeaseRowViaPg();
    return {
      ok: false,
      supported: true,
      ownerId: current.ownerId,
      expiresAt: current.expiresAt,
      reason: 'lease_held'
    };
  };

  const renewLeaseViaPg = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    const rows = await runPgQuery<AuthStateRow>(
      `update auth_state
          set lease_expires_at = $3::timestamptz
        where session_id = $1
          and lease_owner = $2
      returning lease_owner, lease_expires_at`,
      [sessionId, ownerId, expiresAt]
    );

    const row = rows[0];
    if (row?.lease_owner && String(row.lease_owner) === ownerId) {
      return {
        ok: true,
        supported: true,
        ownerId,
        expiresAt: normalizeLeaseTimestamp(row.lease_expires_at) || expiresAt
      };
    }

    const current = await getCurrentLeaseRowViaPg();
    if (current.ownerId === ownerId) {
      return {
        ok: true,
        supported: true,
        ownerId,
        expiresAt: current.expiresAt || expiresAt
      };
    }

    const currentExpiryMs = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
    const leaseExpired = Number.isFinite(currentExpiryMs) ? currentExpiryMs <= Date.now() : true;
    if (!current.ownerId || leaseExpired) {
      return forceAcquireLeaseViaPg(ownerId, ttlMs);
    }

    return {
      ok: false,
      supported: true,
      ownerId: current.ownerId,
      expiresAt: current.expiresAt,
      reason: 'lost'
    };
  };

  const forceAcquireLeaseViaPg = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    const rows = await runPgQuery<AuthStateRow>(
      `update auth_state
          set lease_owner = $2,
              lease_expires_at = $3::timestamptz
        where session_id = $1
      returning lease_owner, lease_expires_at`,
      [sessionId, ownerId, expiresAt]
    );

    const row = rows[0];
    const currentOwner = row?.lease_owner ? String(row.lease_owner) : ownerId;
    return {
      ok: currentOwner === ownerId,
      supported: true,
      ownerId: currentOwner,
      expiresAt: normalizeLeaseTimestamp(row?.lease_expires_at) || expiresAt
    };
  };

  const releaseLeaseViaPg = async (ownerId: string): Promise<LeaseResult> => {
    await runPgQuery(
      `update auth_state
          set lease_owner = null,
              lease_expires_at = null
        where session_id = $1
          and lease_owner = $2`,
      [sessionId, ownerId]
    );

    return { ok: true, supported: true, ownerId: null, expiresAt: null };
  };

  // If neither Postgres nor Supabase is available, use in-memory state
  if (!supabase && !authStatePool) {
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
  let doc: AuthStateRow | null = null;
  let error: unknown = null;

  if (authStatePool) {
    try {
      doc = await getAuthStateRowViaPg();
    } catch (pgError) {
      error = pgError;
      console.warn('Error loading auth state via Postgres:', getErrorMessage(pgError, 'Unknown auth_state load failure'));
    }
  }

  if (!doc && supabase) {
    const response = await supabase
      .from('auth_state')
      .select('*')
      .eq('session_id', sessionId)
      .single();
    doc = (response.data as AuthStateRow | null) || null;
    error = response.error || error;
  }

  if (!doc && error && isTransientLeaseTransportError(error)) {
    throw new Error(`Auth state temporarily unavailable: ${getErrorMessage(error)}`);
  }

  // Create new auth state only when storage is reachable and the session row is genuinely absent.
  if (error || !doc) {
    const newCreds = initAuthCreds();
    let created = false;

    if (authStatePool) {
      try {
        await upsertAuthStateViaPg({
          creds: toStorableJson(newCreds),
          keys: toStorableJson({}),
          status: 'disconnected'
        });
        doc = (await getAuthStateRowViaPg()) || { creds: toStorableJson(newCreds), keys: toStorableJson({}) };
        created = true;
      } catch (pgError) {
        console.error('Error creating auth state via Postgres:', pgError);
      }
    }

    if (!created && supabase) {
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
      doc = (newDoc as AuthStateRow | null) || { creds: toStorableJson(newCreds), keys: toStorableJson({}) };
    } else if (!doc) {
      doc = { creds: toStorableJson(newCreds), keys: toStorableJson({}) };
    }
  }

  let state: { creds: AuthData; keys: KeyStoreData } = {
    creds: (fromStored(doc.creds) as AuthData) || initAuthCreds(),
    keys: fromStoredKeys(doc.keys)
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
        const storedCreds = toStorableJson(state.creds);

        if (authStatePool) {
          try {
            await upsertAuthStateViaPg({
              creds: storedCreds
            });
            return;
          } catch (pgError) {
            console.error('Error saving auth state via Postgres:', pgError);
            if (!supabase) throw pgError;
          }
        }

        if (supabase) {
          await supabase
            .from('auth_state')
            .upsert({
              session_id: sessionId,
              creds: storedCreds,
              keys: toStorableJson(state.keys)
            }, { onConflict: 'session_id' });
        }
      });
    } catch (error) {
      console.error('Error saving auth state:', error);
    }
  };

  // Lease helpers (avoid WhatsApp conflicts across overlapping deploys/instances).
  let leaseSupported: boolean | null = null;

  const getCurrentLeaseRow = async (): Promise<{ ownerId: string | null; expiresAt: string | null } | null> => {
    if (authStatePool) {
      try {
        return await getCurrentLeaseRowViaPg();
      } catch (error) {
        if (isMissingLeaseColumn(error)) {
          return null;
        }
        if (!supabase) {
          throw error;
        }
      }
    }

    try {
      if (!supabase) return null;
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

  const acquireLease = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    if (leaseSupported === false) {
      return { ok: true, supported: false, ownerId: null, expiresAt: null };
    }

    if (authStatePool) {
      try {
        leaseSupported = true;
        return await acquireLeaseViaPg(ownerId, ttlMs);
      } catch (leaseError) {
        if (isMissingLeaseColumn(leaseError)) {
          leaseSupported = false;
          console.warn('Auth lease columns missing; skipping conflict prevention. Run latest SQL migrations.');
          return { ok: true, supported: false, ownerId: null, expiresAt: null };
        }
        if (isTransientLeaseTransportError(leaseError)) {
          leaseSupported = true;
          return {
            ok: false,
            supported: true,
            ownerId: null,
            expiresAt: null,
            reason: 'transient_error'
          };
        }
        if (!supabase) {
          throw leaseError;
        }
      }
    }

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();

    if (!supabase) {
      return { ok: false, supported: true, ownerId: null, expiresAt: null, reason: 'transient_error' };
    }

    const { data, error: leaseError } = await supabase
      .from('auth_state')
      .update({ lease_owner: ownerId, lease_expires_at: expiresAt })
      .eq('session_id', sessionId)
      // Only acquire when the lease is free/expired, or already owned by this instance.
      .or(`lease_owner.is.null,lease_owner.eq.${ownerId},lease_expires_at.lt.${nowIso}`)
      .select('lease_owner,lease_expires_at');

    if (leaseError) {
      if (isMissingLeaseColumn(leaseError)) {
        leaseSupported = false;
        console.warn('Auth lease columns missing; skipping conflict prevention. Run latest SQL migrations.');
        return { ok: true, supported: false, ownerId: null, expiresAt: null };
      }
      leaseSupported = true;
      if (isTransientLeaseTransportError(leaseError)) {
        return {
          ok: false,
          supported: true,
          ownerId: null,
          expiresAt: null,
          reason: 'transient_error'
        };
      }
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
    if (row?.lease_owner && String(row.lease_owner) === ownerId) {
      return {
        ok: true,
        supported: true,
        ownerId,
        expiresAt: row?.lease_expires_at ? String(row.lease_expires_at) : expiresAt
      };
    }

    // Lease not acquired (likely held by another instance). Fetch holder for diagnostics.
    const current = await getCurrentLeaseRow();

    return {
      ok: false,
      supported: true,
      ownerId: current?.ownerId || null,
      expiresAt: current?.expiresAt || null,
      reason: 'lease_held'
    };
  };

  const renewLease = async (ownerId: string, ttlMs = 90_000): Promise<LeaseResult> => {
    if (leaseSupported === false) {
      return { ok: true, supported: false, ownerId: null, expiresAt: null };
    }

    if (authStatePool) {
      try {
        leaseSupported = true;
        return await renewLeaseViaPg(ownerId, ttlMs);
      } catch (leaseError) {
        if (isMissingLeaseColumn(leaseError)) {
          leaseSupported = false;
          return { ok: true, supported: false, ownerId: null, expiresAt: null };
        }
        if (isTransientLeaseTransportError(leaseError)) {
          leaseSupported = true;
          return {
            ok: false,
            supported: true,
            ownerId: null,
            expiresAt: null,
            reason: 'transient_error'
          };
        }
        if (!supabase) {
          throw leaseError;
        }
      }
    }

    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    if (!supabase) {
      return { ok: false, supported: true, ownerId: null, expiresAt: null, reason: 'transient_error' };
    }
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
      if (isTransientLeaseTransportError(leaseError)) {
        return {
          ok: false,
          supported: true,
          ownerId: null,
          expiresAt: null,
          reason: 'transient_error'
        };
      }
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

    if (authStatePool) {
      try {
        leaseSupported = true;
        return await forceAcquireLeaseViaPg(ownerId, ttlMs);
      } catch (leaseError) {
        if (isMissingLeaseColumn(leaseError)) {
          leaseSupported = false;
          return { ok: true, supported: false, ownerId: null, expiresAt: null };
        }
        if (isTransientLeaseTransportError(leaseError)) {
          leaseSupported = true;
          return {
            ok: false,
            supported: true,
            ownerId: null,
            expiresAt: null,
            reason: 'transient_error'
          };
        }
        if (!supabase) {
          throw leaseError;
        }
      }
    }

    const expiresAt = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 0)).toISOString();
    if (!supabase) {
      return { ok: false, supported: true, ownerId: null, expiresAt: null, reason: 'transient_error' };
    }
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
      if (isTransientLeaseTransportError(leaseError)) {
        return {
          ok: false,
          supported: true,
          ownerId: null,
          expiresAt: null,
          reason: 'transient_error'
        };
      }
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

    if (authStatePool) {
      try {
        leaseSupported = true;
        return await releaseLeaseViaPg(ownerId);
      } catch (leaseError) {
        if (isMissingLeaseColumn(leaseError)) {
          leaseSupported = false;
          return { ok: true, supported: false, ownerId: null, expiresAt: null };
        }
        if (isTransientLeaseTransportError(leaseError)) {
          leaseSupported = true;
          return {
            ok: false,
            supported: true,
            ownerId: null,
            expiresAt: null,
            reason: 'transient_error'
          };
        }
        if (!supabase) {
          throw leaseError;
        }
      }
    }

    if (!supabase) {
      return { ok: false, supported: true, ownerId: null, expiresAt: null, reason: 'transient_error' };
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
      if (isTransientLeaseTransportError(leaseError)) {
        return {
          ok: false,
          supported: true,
          ownerId: null,
          expiresAt: null,
          reason: 'transient_error'
        };
      }
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

  const keys = {
    get: async (type: string, ids: string[]) => {
      const data: Record<string, unknown> = {};
      const store = state.keys[type] || {};
      const missing: string[] = [];
      for (const id of ids) {
        if (store[id] !== undefined) {
          data[id] = normalizeKeyValue(store[id]);
        } else {
          missing.push(id);
        }
      }

      if (missing.length && authStatePool) {
        try {
          const loaded = await getAuthKeysViaPg(type, missing);
          const bucket = state.keys[type] || (state.keys[type] = {});
          for (const [id, value] of Object.entries(loaded)) {
            bucket[id] = value as never;
            data[id] = normalizeKeyValue(value);
          }
        } catch (pgError) {
          console.error('Error loading auth keys via Postgres:', pgError);
          if (!supabase) throw pgError;
        }
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
      if (authStatePool) {
        try {
          await patchAuthKeysViaPg(toStorableJson(data) as KeyStoreData);
          return;
        } catch (pgError) {
          console.error('Error patching auth keys via Postgres:', pgError);
          if (!supabase) throw pgError;
        }
      }
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
    if (authStatePool) {
      try {
        await clearKeysViaPg(types);
        return;
      } catch (pgError) {
        console.error('Failed to clear auth keys via Postgres:', pgError);
        if (!supabase) throw pgError;
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

      if (authStatePool) {
        try {
          await clearAuthStateViaPg(toStorableJson(freshCreds));
          return;
        } catch (pgError) {
          console.error('Failed to clear auth state via Postgres:', pgError);
          if (!supabase) throw pgError;
        }
      }

      if (!supabase) {
        return;
      }

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

      if (authStatePool) {
        try {
          await upsertAuthStateViaPg({
            status,
            qrCode: qrCode ?? null,
            includeQrCode: qrCode !== undefined,
            lastConnectedAt: status === 'connected' ? String(updates.last_connected_at || '') : null
          });
          return;
        } catch (pgError) {
          console.warn(
            'Failed to update auth_state status via Postgres:',
            getErrorMessage(pgError, 'Unknown auth_state status update failure')
          );
          if (!supabase) return;
        }
      }

      if (!supabase) {
        return;
      }

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
