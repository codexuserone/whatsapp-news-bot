import { describe, expect, it } from '@jest/globals';
import {
  createAppSessionToken,
  readCookie,
  verifyAppSessionToken
} from '../src/utils/appSessionAuth';

describe('app session auth', () => {
  it('creates signed tokens that verify until expiry', () => {
    const token = createAppSessionToken({
      username: 'operator',
      basicUser: 'operator',
      basicPass: 'correct-password',
      nowMs: 1000,
      ttlSeconds: 120
    });

    expect(
      verifyAppSessionToken(token, {
        basicUser: 'operator',
        basicPass: 'correct-password',
        nowMs: 2000
      })
    ).toBe(true);
    expect(
      verifyAppSessionToken(token, {
        basicUser: 'operator',
        basicPass: 'correct-password',
        nowMs: 122000
      })
    ).toBe(false);
  });

  it('rejects tokens signed with a different password', () => {
    const token = createAppSessionToken({
      username: 'operator',
      basicUser: 'operator',
      basicPass: 'correct-password',
      nowMs: 1000
    });

    expect(
      verifyAppSessionToken(token, {
        basicUser: 'operator',
        basicPass: 'wrong-password',
        nowMs: 2000
      })
    ).toBe(false);
  });

  it('reads cookies without depending on Express cookie middleware', () => {
    const req = {
      headers: {
        cookie: 'theme=dark; wnb_session=abc.def; other=value'
      }
    } as any;

    expect(readCookie(req, 'wnb_session')).toBe('abc.def');
    expect(readCookie(req, 'missing')).toBeNull();
  });
});
