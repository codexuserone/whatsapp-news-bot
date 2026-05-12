import { describe, expect, it } from '@jest/globals';

const { __testUtils } = require('../src/services/receiptService');

describe('receipt service status promotion', () => {
  it('only promotes receipt statuses for destinations with real reader receipts', () => {
    expect(__testUtils.isReceiptDeliveredPromotableTargetType('individual')).toBe(true);
    expect(__testUtils.isReceiptDeliveredPromotableTargetType('group')).toBe(true);
    expect(__testUtils.isReceiptDeliveredPromotableTargetType('status')).toBe(false);
    expect(__testUtils.isReceiptDeliveredPromotableTargetType('channel')).toBe(false);
    expect(__testUtils.isReceiptDeliveredPromotableTargetType(null)).toBe(false);

    expect(__testUtils.isReceiptReadPromotableTargetType('individual')).toBe(true);
    expect(__testUtils.isReceiptReadPromotableTargetType('group')).toBe(false);
    expect(__testUtils.isReceiptReadPromotableTargetType('status')).toBe(false);
    expect(__testUtils.isReceiptReadPromotableTargetType('channel')).toBe(false);
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
        'group',
        { receiptLevel: 'delivered' }
      )
    ).toBe(true);
    expect(
      __testUtils.receiptRemoteMatchesTarget(
        '120363425146275942@g.us',
        '120363425146275942@g.us',
        'group',
        { receiptLevel: 'read' }
      )
    ).toBe(false);
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
