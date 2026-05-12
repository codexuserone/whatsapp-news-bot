import type { Request } from 'express';
import { describe, expect, it } from '@jest/globals';
import { resolveClientIp } from '../src/middleware/rateLimiter';

const requestWith = (overrides: Partial<Request>): Request => overrides as Request;

describe('rate limiter client IP resolution', () => {
  it('uses Express trusted proxy resolution before spoofable headers', () => {
    const req = requestWith({
      ip: '203.0.113.10',
      headers: {
        'x-forwarded-for': '198.51.100.1',
        'cf-connecting-ip': '198.51.100.2',
        'x-real-ip': '198.51.100.3'
      },
      socket: { remoteAddress: '10.0.0.5' } as Request['socket'],
      connection: { remoteAddress: '10.0.0.6' } as Request['connection']
    });

    expect(resolveClientIp(req)).toBe('203.0.113.10');
  });

  it('normalizes IPv4-mapped Express IPs', () => {
    const req = requestWith({
      ip: '::ffff:203.0.113.20',
      headers: {}
    });

    expect(resolveClientIp(req)).toBe('203.0.113.20');
  });

  it('falls back to proxy headers only when Express did not resolve an IP', () => {
    const req = requestWith({
      ip: '',
      headers: {
        'x-forwarded-for': '198.51.100.7, 198.51.100.8'
      }
    });

    expect(resolveClientIp(req)).toBe('198.51.100.7');
  });
});
