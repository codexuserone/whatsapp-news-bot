type LoggerLike = {
  info?: (dataOrMessage?: unknown, message?: string) => void;
  warn?: (dataOrMessage?: unknown, message?: string) => void;
};

type DatabaseRecoveryPollerOptions = {
  intervalMs?: number;
  testConnection: () => Promise<boolean> | boolean;
  onRecovered: () => Promise<void> | void;
  setIntervalFn?: (callback: () => Promise<void> | void, intervalMs: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  logger?: LoggerLike;
};

const DEFAULT_DATABASE_RECOVERY_POLL_MS = 60_000;
const MIN_DATABASE_RECOVERY_POLL_MS = 30_000;
const MAX_DATABASE_RECOVERY_POLL_MS = 600_000;

const resolveDatabaseRecoveryPollMs = (rawValue: unknown = process.env.DATABASE_RECOVERY_POLL_MS) => {
  const parsed = Number(rawValue ?? DEFAULT_DATABASE_RECOVERY_POLL_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_DATABASE_RECOVERY_POLL_MS;
  return Math.max(
    MIN_DATABASE_RECOVERY_POLL_MS,
    Math.min(Math.floor(parsed), MAX_DATABASE_RECOVERY_POLL_MS)
  );
};

const startDatabaseRecoveryPoller = (options: DatabaseRecoveryPollerOptions) => {
  const intervalMs = resolveDatabaseRecoveryPollMs(options.intervalMs);
  const setIntervalFn =
    options.setIntervalFn || ((callback: () => Promise<void> | void, ms: number) => setInterval(callback, ms));
  const clearIntervalFn =
    options.clearIntervalFn || ((activeTimer: unknown) => clearInterval(activeTimer as ReturnType<typeof setInterval>));
  const logger = options.logger || {};
  let timer: unknown = null;
  let stopped = false;
  let inFlight = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const connected = await options.testConnection();
      if (!connected || stopped) return;
      logger.info?.('Database connectivity recovered; starting skipped database-backed runtime');
      await options.onRecovered();
      stop();
    } catch (error) {
      logger.warn?.({ error }, 'Database recovery check failed');
    } finally {
      inFlight = false;
    }
  };

  timer = setIntervalFn(tick, intervalMs);

  logger.warn?.({ intervalMs }, 'Database unavailable; polling for recovery');

  return { stop, tick };
};

module.exports = {
  resolveDatabaseRecoveryPollMs,
  startDatabaseRecoveryPoller
};

export {};
