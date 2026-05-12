import { describe, expect, it } from '@jest/globals';

const targetRoutes = require('../src/routes/targets');

describe('targets route sync safeguards', () => {
  const { dedupeTargetsForResponse, resolveSyncTargetsOptions } = targetRoutes.__testUtils;

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

  it('returns valid saved channels even when WhatsApp has not resolved the channel name yet', () => {
    expect(
      dedupeTargetsForResponse([
        {
          id: 'channel-main',
          type: 'channel',
          active: true,
          name: '120363400000000000@newsletter',
          phone_number: '120363400000000000@newsletter',
          created_at: '2026-05-10T00:00:00.000Z'
        }
      ])
    ).toEqual([
      expect.objectContaining({
        id: 'channel-main',
        type: 'channel',
        active: true,
        name: 'WhatsApp Channel 0000',
        phone_number: '120363400000000000@newsletter'
      })
    ]);
  });
});
