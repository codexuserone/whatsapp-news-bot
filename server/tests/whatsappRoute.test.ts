import { describe, it, expect } from '@jest/globals';

const { __testUtils } = require('../src/routes/whatsapp');

describe('whatsapp route test-send logging', () => {
  it('uses longer timeouts for group sends', () => {
    expect(__testUtils.isGroupJid('120363425146275942@g.us')).toBe(true);
    expect(__testUtils.resolveSendTestTimeoutMs('120363425146275942@g.us', null)).toBe(60000);
    expect(__testUtils.resolveSendTestTimeoutMs('120363425146275942@g.us', 'image')).toBe(90000);
  });

  it('keeps text sends on the default timeout outside groups', () => {
    expect(__testUtils.isGroupJid('16465527019@s.whatsapp.net')).toBe(false);
    expect(__testUtils.resolveSendTestTimeoutMs('16465527019@s.whatsapp.net', null)).toBe(15000);
    expect(__testUtils.resolveSendTestTimeoutMs('120363406955649221@newsletter', null)).toBe(15000);
  });

  it('uses longer timeouts for media sends outside groups', () => {
    expect(__testUtils.resolveSendTestTimeoutMs('16465527019@s.whatsapp.net', 'image')).toBe(60000);
    expect(__testUtils.resolveSendTestTimeoutMs('120363406955649221@newsletter', 'video')).toBe(90000);
    expect(__testUtils.resolveSendTestTimeoutMs('status@broadcast', 'video')).toBe(90000);
  });

  it('does not require server ACKs for channel test-send confirmation', () => {
    expect(__testUtils.resolveTestSendConfirmationOptions('120363406955649221@newsletter', null)).toEqual({
      upsertTimeoutMs: 5000,
      ackTimeoutMs: 15000,
      requireServerAck: false,
      failureGraceMs: 3000
    });
    expect(__testUtils.resolveTestSendConfirmationOptions('120363406955649221@newsletter', 'image')).toEqual({
      upsertTimeoutMs: 30000,
      ackTimeoutMs: 60000,
      requireServerAck: false,
      failureGraceMs: 3000
    });
  });

  it('requires server ACKs for status test-send confirmation', () => {
    expect(__testUtils.resolveTestSendConfirmationOptions('status@broadcast', 'video')).toEqual({
      upsertTimeoutMs: 30000,
      ackTimeoutMs: 60000,
      requireServerAck: true,
      failureGraceMs: 15000
    });
  });

  it('builds text status styling options for test sends', () => {
    expect(__testUtils.buildTextStatusStyleOptions('#166534', 5)).toEqual({
      backgroundColor: '#166534',
      font: 5
    });
    expect(__testUtils.buildTextStatusStyleOptions('166534', 99)).toEqual({});
    expect(__testUtils.buildTextStatusStyleOptions(null, null)).toEqual({});
    expect(__testUtils.buildTextStatusStyleOptions(undefined, undefined)).toEqual({});
    expect(__testUtils.buildTextStatusStyleOptions('#166534', 0)).toEqual({
      backgroundColor: '#166534',
      font: 0
    });
  });

  it('requires server ACKs for group test-send confirmation', () => {
    expect(__testUtils.resolveTestSendConfirmationOptions('120363425146275942@g.us', null)).toEqual({
      upsertTimeoutMs: 5000,
      ackTimeoutMs: 15000,
      requireServerAck: true,
      failureGraceMs: 0
    });
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

  it('marks WhatsApp ack rejections as failed test sends', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: { ok: false, via: 'none', error: 'WhatsApp server rejected message ack 479' },
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'failed',
      errorMessage: 'WhatsApp server rejected message ack 479',
      sentAt: null
    });
  });

  it('marks held test sends as awaiting approval instead of uncertain', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: { ok: false, via: 'none', error: 'WhatsApp server rejected message ack 479' },
      holdReason: 'Channel image was rejected by WhatsApp; held for review.',
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'awaiting_approval',
      errorMessage: 'Channel image was rejected by WhatsApp; held for review.',
      sentAt: null
    });
  });

  it('marks test sends sent when local upsert was observed', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: { ok: true, via: 'upsert', status: 1, statusLabel: 'pending' },
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T22:00:00.000Z'
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

  it('records send-test ACKs as sent instead of read history', () => {
    const result = __testUtils.resolveTestSendLogResolution({
      messageId: 'abc123',
      confirmRequested: true,
      confirmation: { ok: true, via: 'ack', status: 4, statusLabel: 'read' },
      confirmedAt: '2026-03-18T22:00:00.000Z'
    });

    expect(result).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T22:00:00.000Z'
    });
  });
});
