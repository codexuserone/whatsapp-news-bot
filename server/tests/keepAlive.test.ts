import { describe, expect, it } from '@jest/globals';

const keepAliveService = require('../src/services/keepAlive');

describe('keepAlive service timing', () => {
  const { resolveKeepAliveIntervalMs, resolveKeepAliveTimeoutMs, resolveKeepAliveUrl } = keepAliveService.__testUtils;

  it('uses a five-minute default with safe lower and upper bounds', () => {
    expect(resolveKeepAliveIntervalMs(undefined)).toBe(5 * 60 * 1000);
    expect(resolveKeepAliveIntervalMs(15_000)).toBe(60_000);
    expect(resolveKeepAliveIntervalMs(20 * 60 * 1000)).toBe(10 * 60 * 1000);
    expect(resolveKeepAliveIntervalMs(4 * 60 * 1000)).toBe(4 * 60 * 1000);
  });

  it('uses an explicit request timeout and clamps unsafe values', () => {
    expect(resolveKeepAliveTimeoutMs(undefined)).toBe(20_000);
    expect(resolveKeepAliveTimeoutMs(500)).toBe(2_000);
    expect(resolveKeepAliveTimeoutMs(120_000)).toBe(60_000);
    expect(resolveKeepAliveTimeoutMs(15_000)).toBe(15_000);
  });

  it('warms the readiness path by default', () => {
    expect(resolveKeepAliveUrl('https://example.com/', undefined)).toBe('https://example.com/ready');
    expect(resolveKeepAliveUrl('https://example.com', 'https://status.example.com/ping')).toBe(
      'https://status.example.com/ping'
    );
  });
});
