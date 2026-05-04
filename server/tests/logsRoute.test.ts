import { describe, expect, it } from '@jest/globals';

const logsRoute = require('../src/routes/logs');

describe('logs route response helpers', () => {
  const testUtils = logsRoute.__testUtils;

  it('honors requested limits while keeping the default history cap', () => {
    expect(testUtils.parseLogLimit(undefined)).toBe(200);
    expect(testUtils.parseLogLimit('20')).toBe(20);
    expect(testUtils.parseLogLimit('1')).toBe(1);
    expect(testUtils.parseLogLimit('500')).toBe(200);
    expect(testUtils.parseLogLimit('0')).toBe(200);
  });

  it('does not expose inline attachment payloads in log responses', () => {
    expect(
      testUtils.finalizeLog({
        id: 'log-1',
        media_url: 'data:image/png;base64,AAAA'
      })
    ).toMatchObject({
      id: 'log-1',
      media_url: null,
      media_stored: true
    });

    expect(
      testUtils.finalizeLog({
        id: 'log-2',
        media_url: 'uploaded:image'
      })
    ).toMatchObject({
      id: 'log-2',
      media_url: 'uploaded:image',
      media_stored: true
    });

    expect(
      testUtils.finalizeLog({
        id: 'log-3',
        media_url: 'https://example.com/image.jpg'
      })
    ).toMatchObject({
      id: 'log-3',
      media_url: 'https://example.com/image.jpg',
      media_stored: false
    });
  });
});
