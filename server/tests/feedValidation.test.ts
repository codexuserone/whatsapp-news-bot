import { describe, expect, it } from '@jest/globals';

const { schemas } = require('../src/middleware/validation');

describe('feed validation', () => {
  it('accepts the normal feed form payload when advanced options are empty', () => {
    const result = schemas.feed.safeParse({
      name: 'Anash.org Main Feed',
      url: 'https://anash.org/feed',
      fetch_interval: 900,
      active: true,
      parse_config: null,
      cleaning: null
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      name: 'Anash.org Main Feed',
      url: 'https://anash.org/feed',
      fetch_interval: 900,
      active: true
    });
    expect(result.data.parse_config).toBeUndefined();
    expect(result.data.cleaning).toBeUndefined();
  });

  it('coerces a browser-submitted feed interval', () => {
    const result = schemas.feed.safeParse({
      name: 'Anash.org Main Feed',
      url: 'https://anash.org/feed',
      fetch_interval: '900',
      active: true
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.fetch_interval).toBe(900);
  });

  it('normalizes browser-submitted feed type casing', () => {
    const result = schemas.feed.safeParse({
      name: 'COLlive Mazel Tov',
      url: 'https://collive.com/feed/',
      type: 'Rss',
      fetch_interval: 900,
      active: true
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe('rss');
  });
});
