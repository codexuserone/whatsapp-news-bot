const Setting = require('../models/Setting');
const env = require('../config/env');

const DEFAULTS = {
  retentionDays: env.RETENTION_DAYS,
  authRetentionDays: Number(process.env.AUTH_RETENTION_DAYS || 60),
  defaultInterTargetDelaySec: env.DEFAULT_INTER_TARGET_DELAY_SEC,
  defaultIntraTargetDelaySec: env.DEFAULT_INTRA_TARGET_DELAY_SEC,
  dedupeThreshold: 0.88
};

const ensureDefaults = async () => {
  const entries = await Setting.find();
  const existing = new Set(entries.map((entry) => entry.key));

  await Promise.all(
    Object.entries(DEFAULTS).map(async ([key, value]) => {
      if (!existing.has(key)) {
        await Setting.create({ key, value });
      }
    })
  );
};

const getSettings = async () => {
  const entries = await Setting.find();
  const data = { ...DEFAULTS };
  entries.forEach((entry) => {
    data[entry.key] = entry.value;
  });
  return data;
};

const updateSettings = async (updates) => {
  const keys = Object.keys(updates || {});
  await Promise.all(
    keys.map((key) => Setting.findOneAndUpdate({ key }, { value: updates[key] }, { upsert: true }))
  );
  return getSettings();
};

module.exports = {
  ensureDefaults,
  getSettings,
  updateSettings
};
