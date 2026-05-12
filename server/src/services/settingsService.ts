const { getSupabaseClient } = require('../db/supabase');
const env = require('../config/env');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage } = require('../utils/errorUtils');

const WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES = 15;

const isTruthyFlag = (value: unknown) =>
  ['1', 'true', 'yes', 'on', 'unsafe', 'force'].includes(String(value || '').trim().toLowerCase());

const defaultStatusGroupAudienceEnabled = () =>
  isTruthyFlag(process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS) &&
  !['0', 'false', 'no', 'off'].includes(
    String(process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE || 'true').trim().toLowerCase()
  );

const defaultStatusIncludeSender = () =>
  !['0', 'false', 'no', 'off'].includes(String(process.env.WHATSAPP_STATUS_INCLUDE_SENDER ?? 'true').trim().toLowerCase());

const DEFAULTS = {
  retentionDays: env.RETENTION_DAYS,
  log_retention_days: Number(process.env.LOG_RETENTION_DAYS || env.RETENTION_DAYS || 30),
  app_name: 'WhatsApp News Bot',
  default_timezone: 'UTC',
  message_delay_ms: 2000,
  max_retries: Number(process.env.MAX_RETRIES || 3),
  authRetentionDays: Number(process.env.AUTH_RETENTION_DAYS || 60),
  defaultInterTargetDelaySec: env.DEFAULT_INTER_TARGET_DELAY_SEC,
  defaultIntraTargetDelaySec: env.DEFAULT_INTRA_TARGET_DELAY_SEC,
  initial_fetch_limit: Number(process.env.INITIAL_FETCH_LIMIT || 20),
  max_pending_age_hours: Number(process.env.MAX_PENDING_AGE_HOURS || 48),
  send_timeout_ms: Number(process.env.SEND_TIMEOUT_MS || 45000),
  post_send_edit_window_minutes: Math.min(
    Number(process.env.POST_SEND_EDIT_WINDOW_MINUTES || 15),
    WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES
  ),
  post_send_correction_window_minutes: Math.min(
    Number(process.env.POST_SEND_CORRECTION_WINDOW_MINUTES || 15),
    WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES
  ),
  reconcile_queue_lookback_hours: Number(process.env.RECONCILE_QUEUE_LOOKBACK_HOURS || 12),
  status_audience_mode: 'auto',
  status_audience_jids: '',
  status_test_audience_jids: String(process.env.WHATSAPP_STATUS_TEST_AUDIENCE_JIDS || '').trim(),
  status_include_group_participants: defaultStatusGroupAudienceEnabled(),
  status_include_sender: defaultStatusIncludeSender(),
  dedupeThreshold: 0.88,
  processingTimeoutMinutes: Number(process.env.PROCESSING_TIMEOUT_MINUTES || 30),
  app_paused: false,
  whatsapp_paused: false,
  // ISO timestamp for operator visibility. Null when not paused.
  whatsapp_paused_at: null
};

const SETTINGS_CACHE_TTL_MS = Math.max(Number(process.env.SETTINGS_CACHE_TTL_MS || 30_000), 5_000);
let cachedSettings: Record<string, unknown> | null = null;
let cachedSettingsAtMs = 0;

const getCachedSettings = () => {
  if (!cachedSettings) return null;
  if (Date.now() - cachedSettingsAtMs > SETTINGS_CACHE_TTL_MS) return null;
  return { ...DEFAULTS, ...cachedSettings };
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

const clampFloat = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const normalizeBoolean = (value: unknown, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeTimezone = (value: unknown, fallback: string) => {
  const tz = String(value || '').trim();
  if (!tz) return fallback;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return fallback;
  }
};

const normalizeJidListText = (value: unknown) =>
  Array.from(
    new Set(
      String(value || '')
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ).join(', ');

const normalizeSettingsPatch = (updates: Record<string, unknown>) => {
  const next = { ...updates };

  // Support legacy retention keys but keep one canonical value.
  if (Object.prototype.hasOwnProperty.call(next, 'retention_days')) {
    if (!Object.prototype.hasOwnProperty.call(next, 'log_retention_days')) {
      next.log_retention_days = next.retention_days;
    }
    delete (next as Record<string, unknown>).retention_days;
  }
  if (
    Object.prototype.hasOwnProperty.call(next, 'retentionDays') &&
    !Object.prototype.hasOwnProperty.call(next, 'log_retention_days')
  ) {
    next.log_retention_days = next.retentionDays;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'log_retention_days')) {
    next.log_retention_days = clampNumber(next.log_retention_days, DEFAULTS.log_retention_days, 1, 3650);
    next.retentionDays = next.log_retention_days;
  } else if (Object.prototype.hasOwnProperty.call(next, 'retentionDays')) {
    next.retentionDays = clampNumber(next.retentionDays, DEFAULTS.log_retention_days, 1, 3650);
    next.log_retention_days = next.retentionDays;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'post_send_edit_window_minutes')) {
    next.post_send_edit_window_minutes = clampNumber(
      next.post_send_edit_window_minutes,
      DEFAULTS.post_send_edit_window_minutes,
      1,
      WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'post_send_correction_window_minutes')) {
    next.post_send_correction_window_minutes = clampNumber(
      next.post_send_correction_window_minutes,
      DEFAULTS.post_send_correction_window_minutes,
      1,
      WHATSAPP_IN_PLACE_EDIT_MAX_MINUTES
    );
  }

  if (
    typeof next.post_send_edit_window_minutes === 'number' &&
    typeof next.post_send_correction_window_minutes === 'number' &&
    next.post_send_correction_window_minutes < next.post_send_edit_window_minutes
  ) {
    next.post_send_correction_window_minutes = next.post_send_edit_window_minutes;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'app_name')) {
    const normalizedName = String(next.app_name || '').replace(/\s+/g, ' ').trim();
    next.app_name = normalizedName || DEFAULTS.app_name;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'default_timezone')) {
    next.default_timezone = normalizeTimezone(next.default_timezone, DEFAULTS.default_timezone);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'message_delay_ms')) {
    next.message_delay_ms = clampNumber(next.message_delay_ms, DEFAULTS.message_delay_ms, 0, 60_000);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'max_retries')) {
    next.max_retries = clampNumber(next.max_retries, DEFAULTS.max_retries, 0, 50);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'authRetentionDays')) {
    next.authRetentionDays = clampNumber(next.authRetentionDays, DEFAULTS.authRetentionDays, 1, 3650);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'defaultInterTargetDelaySec')) {
    next.defaultInterTargetDelaySec = clampNumber(
      next.defaultInterTargetDelaySec,
      DEFAULTS.defaultInterTargetDelaySec,
      0,
      600
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'defaultIntraTargetDelaySec')) {
    next.defaultIntraTargetDelaySec = clampNumber(
      next.defaultIntraTargetDelaySec,
      DEFAULTS.defaultIntraTargetDelaySec,
      0,
      600
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'initial_fetch_limit')) {
    next.initial_fetch_limit = clampNumber(next.initial_fetch_limit, DEFAULTS.initial_fetch_limit, 1, 50);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'max_pending_age_hours')) {
    next.max_pending_age_hours = clampNumber(next.max_pending_age_hours, DEFAULTS.max_pending_age_hours, 1, 336);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'send_timeout_ms')) {
    next.send_timeout_ms = clampNumber(next.send_timeout_ms, DEFAULTS.send_timeout_ms, 10_000, 180_000);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'reconcile_queue_lookback_hours')) {
    next.reconcile_queue_lookback_hours = clampNumber(
      next.reconcile_queue_lookback_hours,
      DEFAULTS.reconcile_queue_lookback_hours,
      1,
      168
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'status_audience_mode')) {
    const mode = String(next.status_audience_mode || '').trim().toLowerCase();
    next.status_audience_mode = mode === 'explicit' ? 'explicit' : 'auto';
  }

  if (Object.prototype.hasOwnProperty.call(next, 'status_audience_jids')) {
    next.status_audience_jids = normalizeJidListText(next.status_audience_jids);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'status_test_audience_jids')) {
    next.status_test_audience_jids = normalizeJidListText(next.status_test_audience_jids);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'status_include_group_participants')) {
    next.status_include_group_participants = normalizeBoolean(
      next.status_include_group_participants,
      DEFAULTS.status_include_group_participants
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'status_include_sender')) {
    next.status_include_sender = normalizeBoolean(next.status_include_sender, DEFAULTS.status_include_sender);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'dedupeThreshold')) {
    next.dedupeThreshold = clampFloat(next.dedupeThreshold, DEFAULTS.dedupeThreshold, 0, 1);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'processingTimeoutMinutes')) {
    next.processingTimeoutMinutes = clampNumber(
      next.processingTimeoutMinutes,
      DEFAULTS.processingTimeoutMinutes,
      5,
      240
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'app_paused')) {
    next.app_paused = normalizeBoolean(next.app_paused, false);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'whatsapp_paused')) {
    next.whatsapp_paused = normalizeBoolean(next.whatsapp_paused, false);
  }

  if (Object.prototype.hasOwnProperty.call(next, 'whatsapp_paused_at')) {
    const raw = next.whatsapp_paused_at;
    if (raw == null || String(raw).trim() === '') {
      next.whatsapp_paused_at = null;
    } else {
      const parsed = Date.parse(String(raw));
      next.whatsapp_paused_at = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    }
  }

  for (const key of Object.keys(next)) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }

  return next;
};

const ensureDefaults = async () => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  
  try {
    const { data: entries, error } = await supabase
      .from('settings')
      .select('key');
    
    if (error) throw error;
    
    const rows = (entries || []) as Array<{ key: string }>;
    const existing = new Set(rows.map((entry) => entry.key));

    await Promise.all(
      Object.entries(DEFAULTS).map(async ([key, value]) => {
        if (!existing.has(key)) {
          await supabase
            .from('settings')
            .insert({ key, value: JSON.stringify(value), description: `Default setting for ${key}` });
        }
      })
    );
  } catch (error) {
    console.error('Error ensuring default settings:', getErrorMessage(error));
  }
};

const getSettings = async (options?: { force?: boolean }) => {
  if (!options?.force) {
    const cached = getCachedSettings();
    if (cached) return cached;
  }

  const supabase = getSupabaseClient();
  if (!supabase) return DEFAULTS;
  
  try {
    const { data: entries, error } = await supabase
      .from('settings')
      .select('*');
    
    if (error) throw error;
    
    const data: Record<string, unknown> = { ...DEFAULTS };
    const rows = (entries || []) as Array<{ key: string; value: unknown }>;
    rows.forEach((entry) => {
      try {
        data[entry.key] = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
      } catch {
        data[entry.key] = entry.value;
      }
    });

    if (data.log_retention_days == null && data.retentionDays != null) {
      data.log_retention_days = data.retentionDays;
    }
    if (data.retentionDays == null && data.log_retention_days != null) {
      data.retentionDays = data.log_retention_days;
    }
    if (data.log_retention_days == null && data.retention_days != null) {
      data.log_retention_days = data.retention_days;
      data.retentionDays = data.retention_days;
    }
    if ('retention_days' in data) {
      delete data.retention_days;
    }
    if ('send_images' in data) {
      delete data.send_images;
    }

    Object.assign(data, normalizeSettingsPatch({ ...data }));

    cachedSettings = { ...data };
    cachedSettingsAtMs = Date.now();
    return data;
  } catch (error) {
    console.error('Error getting settings:', getErrorMessage(error));
    return cachedSettings ? { ...DEFAULTS, ...cachedSettings } : DEFAULTS;
  }
};

const updateSettings = async (updates: Record<string, unknown>) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw serviceUnavailable('Database not available');
  const normalizedUpdates = normalizeSettingsPatch(updates || {});
  
  try {
    const keys = Object.keys(normalizedUpdates || {}).filter((key) => normalizedUpdates[key] !== undefined);
    await Promise.all(
      keys.map(async (key) => {
        const { error } = await supabase
          .from('settings')
          .upsert({ 
            key, 
            value: JSON.stringify(normalizedUpdates[key]),
            description: `Setting for ${key}`
          }, { 
            onConflict: 'key' 
          });
        if (error) throw error;
      })
    );
    cachedSettings = null;
    cachedSettingsAtMs = 0;
    return getSettings({ force: true });
  } catch (error) {
    console.error('Error updating settings:', getErrorMessage(error));
    throw error;
  }
};

const isAppPaused = async () => {
  try {
    const settings = await getSettings();
    return settings?.app_paused === true;
  } catch {
    return false;
  }
};

module.exports = {
  ensureDefaults,
  getSettings,
  updateSettings,
  isAppPaused
};
export {};
