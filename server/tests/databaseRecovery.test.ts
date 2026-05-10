import { describe, expect, it, jest } from '@jest/globals';

describe('database recovery poller', () => {
  it('uses a bounded recovery polling interval', () => {
    const { resolveDatabaseRecoveryPollMs } = require('../src/startup/databaseRecovery');

    expect(resolveDatabaseRecoveryPollMs(undefined)).toBe(60000);
    expect(resolveDatabaseRecoveryPollMs('1000')).toBe(30000);
    expect(resolveDatabaseRecoveryPollMs('900000')).toBe(600000);
    expect(resolveDatabaseRecoveryPollMs('45000')).toBe(45000);
  });

  it('starts skipped database runtime once connectivity recovers', async () => {
    const { startDatabaseRecoveryPoller } = require('../src/startup/databaseRecovery');
    const intervalCallbacks: Array<() => Promise<void> | void> = [];
    const testConnection = jest.fn(async () => true);
    const onRecovered = jest.fn(async () => {});
    const clearIntervalFn = jest.fn();

    const poller = startDatabaseRecoveryPoller({
      intervalMs: 60000,
      testConnection,
      onRecovered,
      setIntervalFn: (callback: () => Promise<void> | void, intervalMs: number) => {
        expect(intervalMs).toBe(60000);
        intervalCallbacks.push(callback);
        return 'timer';
      },
      clearIntervalFn,
      logger: { info: jest.fn(), warn: jest.fn() }
    });

    expect(intervalCallbacks).toHaveLength(1);

    const tick = intervalCallbacks[0] as () => Promise<void> | void;
    expect(tick).toBeDefined();

    await tick();
    await tick();

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith('timer');

    poller.stop();
  });

  it('keeps polling when the database is still unavailable', async () => {
    const { startDatabaseRecoveryPoller } = require('../src/startup/databaseRecovery');
    const intervalCallbacks: Array<() => Promise<void> | void> = [];
    const testConnection = jest.fn(async () => false);
    const onRecovered = jest.fn(async () => {});
    const clearIntervalFn = jest.fn();

    startDatabaseRecoveryPoller({
      intervalMs: 60000,
      testConnection,
      onRecovered,
      setIntervalFn: (callback: () => Promise<void> | void) => {
        intervalCallbacks.push(callback);
        return 'timer';
      },
      clearIntervalFn,
      logger: { info: jest.fn(), warn: jest.fn() }
    });

    const tick = intervalCallbacks[0] as () => Promise<void> | void;
    expect(tick).toBeDefined();

    await tick();

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(clearIntervalFn).not.toHaveBeenCalled();
  });

  it('keeps polling when recovery work fails after the database reconnects', async () => {
    const { startDatabaseRecoveryPoller } = require('../src/startup/databaseRecovery');
    const intervalCallbacks: Array<() => Promise<void> | void> = [];
    const testConnection = jest.fn(async () => true);
    let recoveryAttempts = 0;
    const onRecovered = jest.fn(async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) {
        throw new Error('migration failed');
      }
    });
    const clearIntervalFn = jest.fn();

    startDatabaseRecoveryPoller({
      intervalMs: 60000,
      testConnection,
      onRecovered,
      setIntervalFn: (callback: () => Promise<void> | void) => {
        intervalCallbacks.push(callback);
        return 'timer';
      },
      clearIntervalFn,
      logger: { info: jest.fn(), warn: jest.fn() }
    });

    const tick = intervalCallbacks[0] as () => Promise<void> | void;
    expect(tick).toBeDefined();

    await tick();

    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).not.toHaveBeenCalled();

    await tick();

    expect(onRecovered).toHaveBeenCalledTimes(2);
    expect(clearIntervalFn).toHaveBeenCalledWith('timer');
  });
});
