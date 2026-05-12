import { describe, expect, it } from '@jest/globals';

const { __testUtils } = require('../src/services/receiptService');

describe('receipt service status promotion', () => {
  it('only promotes receipt statuses for destinations with real reader receipts', () => {
    expect(__testUtils.isReceiptPromotableTargetType('individual')).toBe(true);
    expect(__testUtils.isReceiptPromotableTargetType('group')).toBe(true);
    expect(__testUtils.isReceiptPromotableTargetType('status')).toBe(false);
    expect(__testUtils.isReceiptPromotableTargetType('channel')).toBe(false);
    expect(__testUtils.isReceiptPromotableTargetType(null)).toBe(false);
  });

  it('requires the receipt remote jid to match the stored target', () => {
    expect(
      __testUtils.receiptRemoteMatchesTarget(
        '19144477725@s.whatsapp.net',
        '19144477725@s.whatsapp.net',
        'individual'
      )
    ).toBe(true);
    expect(
      __testUtils.receiptRemoteMatchesTarget(
        '120363425146275942@g.us',
        '120363425146275942@g.us',
        'group'
      )
    ).toBe(true);
    expect(
      __testUtils.receiptRemoteMatchesTarget(
        '120363425146275942@g.us',
        '19144477725@s.whatsapp.net',
        'individual'
      )
    ).toBe(false);
    expect(
      __testUtils.receiptRemoteMatchesTarget(
        'status@broadcast',
        'status@broadcast',
        'status'
      )
    ).toBe(false);
  });
});
