import { describe, expect, it } from '@jest/globals';
import { shouldUseBasicAuthChallenge } from '../src/utils/basicAuthChallenge';

const req = (
  path: string,
  headers: Record<string, string> = { accept: 'text/html' },
  method = 'GET'
) =>
  ({
    method,
    path: path.split('?')[0],
    url: path,
    originalUrl: path,
    headers
  }) as any;

describe('basic auth challenge routing', () => {
  it('challenges direct page navigation so the operator can sign in once', () => {
    expect(shouldUseBasicAuthChallenge(req('/'))).toBe(true);
    expect(shouldUseBasicAuthChallenge(req('/queue'))).toBe(true);
    expect(
      shouldUseBasicAuthChallenge(
        req('/queue', {
          accept: 'text/html,application/xhtml+xml',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document'
        })
      )
    ).toBe(true);
  });

  it('does not challenge API calls because browser fetch loops can spawn repeated sign-in dialogs', () => {
    expect(shouldUseBasicAuthChallenge(req('/api/feeds', { accept: 'application/json' }))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/api/queue/stats', { accept: '*/*' }))).toBe(false);
  });

  it('does not challenge Next.js route/data requests', () => {
    expect(
      shouldUseBasicAuthChallenge(
        req('/queue?_rsc=abc', {
          accept: '*/*',
          'sec-fetch-mode': 'cors'
        })
      )
    ).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/queue?_rsc=abc', { accept: 'text/x-component' }))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/queue', { accept: '*/*' }))).toBe(false);
    expect(
      shouldUseBasicAuthChallenge(
        req('/queue', {
          accept: 'text/html',
          'sec-fetch-mode': 'cors'
        })
      )
    ).toBe(false);
  });

  it('does not challenge static assets or non-navigation writes', () => {
    expect(shouldUseBasicAuthChallenge(req('/_next/static/app.js', { accept: '*/*' }))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/favicon.ico', { accept: 'image/avif,image/webp,*/*' }))).toBe(false);
    expect(shouldUseBasicAuthChallenge(req('/api/feeds', { accept: 'application/json' }, 'POST'))).toBe(false);
  });
});
