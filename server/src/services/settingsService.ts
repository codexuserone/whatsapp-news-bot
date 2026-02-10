const { getSupabaseClient } = require('../db/supabase');
const env = require('../config/env');
const { serviceUnavailable } = require('../core/errors');

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
  initial_fetch_limit: Number(process.env.INITIAL_FETCH_LIMIT || 1),
  max_pending_age_hours: Number(process.env.MAX_PENDING_AGE_HOURS || 48),
  send_timeout_ms: Number(process.env.SEND_TIMEOUT_MS || 45000),
  post_send_edit_window_minutes: Number(process.env.POST_SEND_EDIT_WINDOW_MINUTES || 15),
  post_send_correction_window_minutes: Number(process.env.POST_SEND_CORRECTION_WINDOW_MINUTES || 120),
  reconcile_queue_lookback_hours: Number(process.env.RECONCILE_QUEUE_LOOKBACK_HOURS || 12),
  dedupeThreshold: 0.88,
  processingTimeoutMinutes: Number(process.env.PROCESSING_TIMEOUT_MINUTES || 30),
  app_paused: false
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
};

const normalizeSettingsPatch = (updates: Record<string, unknown>) => {
  const next = { ...updates };

  if (Object.prototype.hasOwnProperty.call(next, 'post_send_edit_window_minutes')) {
    next.post_send_edit_window_minutes = clampNumber(
      next.post_send_edit_window_minutes,
      DEFAULTS.post_send_edit_window_minutes,
      1,
      15
    );
  }

  if (Object.prototype.hasOwnProperty.call(next, 'post_send_correction_window_minutes')) {
    next.post_send_correction_window_minutes = clampNumber(
      next.post_send_correction_window_minutes,
      DEFAULTS.post_send_correction_window_minutes,
      1,
      120
    );
  }

  if (
    typeof next.post_send_edit_window_minutes === 'number' &&
    typeof next.post_send_correction_window_minutes === 'number' &&
    next.post_send_correction_window_minutes < next.post_send_edit_window_minutes
  ) {
    next.post_send_correction_window_minutes = next.post_send_edit_window_minutes;
  }

  if (Object.prototype.hasOwnProperty.call(next, 'app_paused')) {
    next.app_paused = next.app_paused === true;
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
    console.error('Error ensuring default settings:', error);
  }
};

const getSettings = async () => {
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
    if ('send_images' in data) {
      delete data.send_images;
    }
    return data;
  } catch (error) {
    console.error('Error getting settings:', error);
    return DEFAULTS;
  }
};

const updateSettings = async (updates: Record<string, unknown>) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw serviceUnavailable('Database not available');
  const normalizedUpdates = normalizeSettingsPatch(updates || {});
  
  try {
    const keys = Object.keys(normalizedUpdates || {});
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
    return getSettings();
  } catch (error) {
    console.error('Error updating settings:', error);
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
