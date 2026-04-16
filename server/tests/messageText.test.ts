import { describe, expect, it } from '@jest/globals';

const { normalizeMessageText } = require('../src/utils/messageText');

describe('normalizeMessageText', () => {
  it('preserves arrow characters and normalizes whitespace noise', () => {
    expect(normalizeMessageText('  One → Two\r\nThree\u00a0\u200b')).toBe('One → Two\nThree');
  });
});
