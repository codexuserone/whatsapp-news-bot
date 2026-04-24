import { describe, expect, it } from '@jest/globals';

const { normalizeMessageText } = require('../src/utils/messageText');

describe('normalizeMessageText', () => {
  it('normalizes unsafe arrow/control glyphs and whitespace noise', () => {
    expect(normalizeMessageText('  One â†’ Two\r\nThree\u00a0\u200b')).toBe('One \u2192 Two\nThree');
    expect(normalizeMessageText('Read more \u001a \nhttps://example.com')).toBe('Read more \u2192 \nhttps://example.com');
  });
});
