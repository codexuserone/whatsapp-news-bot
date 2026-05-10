import { describe, expect, it } from '@jest/globals';
import { shouldUseBasicAuthChallenge } from '../src/utils/basicAuthChallenge';

const req = (path: string, accept = 'text/html', method = 'GET') =>
  ({
    method,
    path,
    url: path,
    headers: { accept }
  }) as any;

describe('basic auth challenge routing', () => {
  it('challenges direct page navigation so the operator can sign in once', () => {
    expect(shouldUseBasicAuthChallenge(req('/'))).toBe(true);
    expect(shouldUseBasicAuthChallenge(req('/queue'))).toBe(true);
  });

  it('does not challenge API calls because browser fetch loops can spawn repeated sign-in dialogs', () => {
    expect(shouldUseBasicAuthChallenge(req('/api/feeds', 'application/json'))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/api/queue/stats', '*/*'))).toBe(false);
  });

  it('does not challenge static assets or non-navigation writes', () => {
    expect(shouldUseBasicAuthChallenge(req('/_next/static/app.js', '*/*'))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/favicon.ico', 'image/avif,image/webp,*/*'))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/api/feeds', 'application/json', 'POST'))).toBe(false);
  });
});
