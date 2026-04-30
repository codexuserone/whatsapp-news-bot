import { describe, expect, it } from '@jest/globals';

const { isMediaDataUrl, parseMediaDataUrl } = require('../src/utils/mediaDataUrl');

const tinyPngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

describe('mediaDataUrl', () => {
  it('accepts a valid image upload data URL', () => {
    const parsed = parseMediaDataUrl(tinyPngDataUrl, { expectedKind: 'image', filename: 'story.png' });

    expect(isMediaDataUrl(tinyPngDataUrl)).toBe(true);
    expect(parsed.kind).toBe('image');
    expect(parsed.mimetype).toBe('image/png');
    expect(parsed.filename).toBe('story.png');
    expect(Buffer.isBuffer(parsed.buffer)).toBe(true);
  });

  it('rejects mismatched media types', () => {
    expect(() => parseMediaDataUrl(tinyPngDataUrl, { expectedKind: 'video' })).toThrow('Attachment type mismatch');
  });

  it('rejects fake image payloads', () => {
    const fake = `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`;
    expect(() => parseMediaDataUrl(fake, { expectedKind: 'image' })).toThrow('valid jpeg, png, or webp');
  });
});
