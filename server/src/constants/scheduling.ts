const BATCH_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FALLBACK_BATCH_TIMES = ['07:00', '15:00', '22:00'];

const parseBatchTimesFromEnv = (value: unknown): string[] => {
  const raw = String(value || '').trim();
  if (!raw) return FALLBACK_BATCH_TIMES;

  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const normalized = String(part || '').trim();
    if (!BATCH_TIME_PATTERN.test(normalized)) continue;
    seen.add(normalized);
  }

  const parsed = Array.from(seen).sort();
  return parsed.length ? parsed : FALLBACK_BATCH_TIMES;
};

const DEFAULT_BATCH_TIMES = parseBatchTimesFromEnv(process.env.DEFAULT_BATCH_TIMES);

module.exports = {
  DEFAULT_BATCH_TIMES
};

export {};
