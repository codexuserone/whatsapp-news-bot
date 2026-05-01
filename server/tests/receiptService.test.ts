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
});
