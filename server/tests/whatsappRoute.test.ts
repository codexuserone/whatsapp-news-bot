import { describe, it, expect } from '@jest/globals';

const { __testUtils } = require('../src/routes/whatsapp');

describe('whatsapp route test-send logging', () => {
  it('marks test sends uncertain when no message id is present', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: null,
      confirmRequested: true,
      confirmation: null,
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'uncertain',
      errorMessage: 'Send result is uncertain. Verifying delivery before retrying. Missing WhatsApp message id',
      sentAt: null
    });
  });

  it('marks test sends uncertain when confirmation is absent', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: null,
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'uncertain',
      errorMessage: 'Send result is uncertain. Verifying delivery before retrying. No confirmation yet',
      sentAt: null
    });
  });

  it('marks test sends uncertain when confirmation was skipped', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: false,
      confirmation: null,
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'uncertain',
      errorMessage: 'Send result is uncertain. Verifying delivery before retrying. Confirmation check was skipped',
      sentAt: null
    });
  });

  it('marks test sends sent only after confirmation', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: { ok: true, via: 'ack', status: 2, statusLabel: 'server' },
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T22:00:00.000Z'
    });
  });

  it('preserves delivered/read confirmations when available', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: { ok: true, via: 'ack', status: 4, statusLabel: 'read' },
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'read',
      errorMessage: null,
      sentAt: '2026-03-18T22:00:00.000Z'
    });
  });
});
