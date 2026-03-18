import { describe, it, expect } from '@jest/globals';

const { __testUtils } = require('../src/routes/whatsapp');

describe('whatsapp route test-send logging', () => {
  it('uses longer timeouts for group sends', () => {
    expect(__testUtils.isGroupJid('120363425146275942@g.us')).toBe(true);
    expect(__testUtils.resolveSendTestTimeoutMs('120363425146275942@g.us', null)).toBe(60000);
    expect(__testUtils.resolveSendTestTimeoutMs('120363425146275942@g.us', 'image')).toBe(90000);
  });

  it('keeps direct and channel sends on the default timeout', () => {
    expect(__testUtils.isGroupJid('16465527019@s.whatsapp.net')).toBe(false);
    expect(__testUtils.resolveSendTestTimeoutMs('16465527019@s.whatsapp.net', null)).toBe(15000);
    expect(__testUtils.resolveSendTestTimeoutMs('120363406955649221@newsletter', 'video')).toBe(15000);
  });

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
