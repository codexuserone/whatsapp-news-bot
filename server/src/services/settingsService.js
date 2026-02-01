const { supabase } = require('../db/supabase');
const env = require('../config/env');

const DEFAULTS = {
  retentionDays: env.RETENTION_DAYS,
  authRetentionDays: Number(process.env.AUTH_RETENTION_DAYS || 60),
  defaultInterTargetDelaySec: env.DEFAULT_INTER_TARGET_DELAY_SEC,
  defaultIntraTargetDelaySec: env.DEFAULT_INTRA_TARGET_DELAY_SEC,
  dedupeThreshold: 0.88
};

const ensureDefaults = async () => {
  try {
    const { data: entries, error } = await supabase
      .from('settings')
      .select('key');
    
    if (error) throw error;
    
    const existing = new Set(entries.map((entry) => entry.key));

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
  try {
    const { data: entries, error } = await supabase
      .from('settings')
      .select('*');
    
    if (error) throw error;
    
    const data = { ...DEFAULTS };
    entries.forEach((entry) => {
      // Parse JSON value if stored as JSON
      try {
        data[entry.key] = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
      } catch {
        data[entry.key] = entry.value;
      }
    });
    return data;
  } catch (error) {
    console.error('Error getting settings:', error);
    return DEFAULTS;
  }
};

const updateSettings = async (updates) => {
  try {
    const keys = Object.keys(updates || {});
    await Promise.all(
      keys.map(async (key) => {
        const { error } = await supabase
          .from('settings')
          .upsert({ 
            key, 
            value: JSON.stringify(updates[key]),
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

module.exports = {
  ensureDefaults,
  getSettings,
  updateSettings
};
