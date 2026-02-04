const cronParser = require('cron-parser');

const computeNextRunAt = (cronExpression: string, timezone?: string | null): string | null => {
  if (!cronExpression) return null;
  try {
    const interval = cronParser.parseExpression(cronExpression, {
      tz: timezone || 'UTC'
    });
    const next = interval.next().toDate();
    return next.toISOString();
  } catch {
    return null;
  }
};

module.exports = {
  computeNextRunAt
};

export {};
