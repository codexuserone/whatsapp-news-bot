import { describe, expect, it } from '@jest/globals';

const targetRoutes = require('../src/routes/targets');

describe('targets route sync safeguards', () => {
  const { resolveSyncTargetsOptions } = targetRoutes.__testUtils;

  it('always skips disconnected WhatsApp sync attempts', () => {
    expect(resolveSyncTargetsOptions(undefined, undefined)).toEqual({
      includeStatus: true,
      strict: false,
      skipIfDisconnected: true
    });

    expect(
      resolveSyncTargetsOptions(
        { includeStatus: false, strict: true },
        undefined
      )
    ).toEqual({
      includeStatus: false,
      strict: true,
      skipIfDisconnected: true
    });
  });
});
