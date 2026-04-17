import { describe, expect, it } from '@jest/globals';

const { normalizeMessageText } = require('../src/utils/messageText');

describe('normalizeMessageText', () => {
  it('normalizes unsafe arrow/control glyphs and whitespace noise', () => {
    expect(normalizeMessageText('  One → Two\r\nThree\u00a0\u200b')).toBe('One -> Two\nThree');
    expect(normalizeMessageText('Read more \u001a \nhttps://example.com')).toBe('Read more -> \nhttps://example.com');
  });
});
