import { describe, expect, it } from '@jest/globals';

const whatsappRoutes = require('../src/routes/whatsapp');

describe('whatsapp route test-send logging resolution', () => {
  const testUtils = whatsappRoutes.__testUtils;

  it('marks confirmed sends as sent', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: true, via: 'ack', status: 2, statusLabel: 'server' },
        confirmedAt: '2026-03-18T21:00:00.000Z'
      })
    ).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T21:00:00.000Z'
    });
  });

  it('marks unconfirmed sends as uncertain instead of sent', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: false, via: 'upsert', status: 1, statusLabel: 'pending' }
      })
    ).toMatchObject({
      status: 'uncertain',
      sentAt: null
    });
  });

  it('marks local-upsert confirmations as sent', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: true, via: 'upsert', status: 1, statusLabel: 'pending' },
        confirmedAt: '2026-03-18T21:00:00.000Z'
      })
    ).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T21:00:00.000Z'
    });
  });

  it('marks missing message ids as uncertain', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: null,
        confirmation: null
      })
    ).toMatchObject({
      status: 'uncertain',
      sentAt: null
    });
  });
});
