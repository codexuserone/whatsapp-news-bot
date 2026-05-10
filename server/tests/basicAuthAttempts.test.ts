import { describe, expect, it } from '@jest/globals';
import {
  getBasicAuthFailureSignature,
  isBasicAuthBlocked,
  recordBasicAuthFailure
} from '../src/utils/basicAuthAttempts';

describe('basic auth attempt tracking', () => {
  it('does not turn one cached wrong browser credential into many failures', () => {
    const signature = getBasicAuthFailureSignature('Basic wrong');
    let state = recordBasicAuthFailure({
      nowMs: 1_000,
      blockWindowMs: 60_000,
      maxAttempts: 3,
      signature,
      repeatSignatureWindowMs: 30_000
    });

    state = recordBasicAuthFailure({
      currentAttempt: state,
      nowMs: 2_000,
      blockWindowMs: 60_000,
      maxAttempts: 3,
      signature,
      repeatSignatureWindowMs: 30_000
    });

    state = recordBasicAuthFailure({
      currentAttempt: state,
      nowMs: 3_000,
      blockWindowMs: 60_000,
      maxAttempts: 3,
      signature,
      repeatSignatureWindowMs: 30_000
    });

    expect(state.failures).toBe(1);
    expect(isBasicAuthBlocked(state, 3_000)).toBe(false);
  });

  it('still blocks distinct wrong credentials inside the window', () => {
    let state = recordBasicAuthFailure({
      nowMs: 1_000,
      blockWindowMs: 60_000,
      maxAttempts: 3,
      signature: getBasicAuthFailureSignature('Basic wrong-1'),
      repeatSignatureWindowMs: 30_000
    });

    state = recordBasicAuthFailure({
      currentAttempt: state,
      nowMs: 2_000,
      blockWindowMs: 60_000,
      maxAttempts: 3,
      signature: getBasicAuthFailureSignature('Basic wrong-2'),
      repeatSignatureWindowMs: 30_000
    });

    state = recordBasicAuthFailure({
      currentAttempt: state,
      nowMs: 3_000,
      blockWindowMs: 60_000,
      maxAttempts: 3,
      signature: getBasicAuthFailureSignature('Basic wrong-3'),
      repeatSignatureWindowMs: 30_000
    });

    expect(state.failures).toBe(3);
    expect(isBasicAuthBlocked(state, 3_000)).toBe(true);
  });
});
