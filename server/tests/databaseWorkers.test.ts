import { describe, expect, it } from '@jest/globals';

describe('database-backed startup workers', () => {
  it('does not start database-backed workers when the startup database check failed', () => {
    const { shouldStartDatabaseBackedWorkers } = require('../src/startup/databaseWorkers');

    expect(shouldStartDatabaseBackedWorkers(false)).toBe(false);
  });

  it('starts database-backed workers after a successful startup database check', () => {
    const { shouldStartDatabaseBackedWorkers } = require('../src/startup/databaseWorkers');

    expect(shouldStartDatabaseBackedWorkers(true)).toBe(true);
  });

  it('does not initialize WhatsApp immediately when the startup database check failed', () => {
    const { shouldInitializeWhatsAppImmediately } = require('../src/startup/databaseWorkers');

    expect(shouldInitializeWhatsAppImmediately(false)).toBe(false);
  });

  it('initializes WhatsApp immediately after a successful startup database check', () => {
    const { shouldInitializeWhatsAppImmediately } = require('../src/startup/databaseWorkers');

    expect(shouldInitializeWhatsAppImmediately(true)).toBe(true);
  });
});
