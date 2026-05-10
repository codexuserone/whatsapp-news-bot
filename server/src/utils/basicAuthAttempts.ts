import { createHash } from 'crypto';

export type AuthAttemptState = {
  failures: number;
  firstFailureAtMs: number;
  blockedUntilMs: number;
  lastFailureSignature?: string;
  lastFailureSignatureAtMs?: number;
};

export const getBasicAuthFailureSignature = (authorizationHeader: string) =>
  createHash('sha256')
    .update(String(authorizationHeader || ''), 'utf8')
    .digest('hex');

export const isBasicAuthBlocked = (state: AuthAttemptState | undefined, nowMs: number) =>
  Boolean(state && state.blockedUntilMs > nowMs);

export const isBasicAuthAttemptStale = (
  state: AuthAttemptState,
  nowMs: number,
  staleAfterMs = 60 * 60 * 1000
) =>
  state.blockedUntilMs <= nowMs &&
  (state.failures <= 0 || nowMs - state.firstFailureAtMs > staleAfterMs);

export const recordBasicAuthFailure = (options: {
  currentAttempt?: AuthAttemptState;
  nowMs: number;
  blockWindowMs: number;
  maxAttempts: number;
  signature: string;
  repeatSignatureWindowMs: number;
}): AuthAttemptState => {
  const nowMs = options.nowMs;
  const blockWindowMs = Math.max(options.blockWindowMs, 1);
  const maxAttempts = Math.max(Math.floor(options.maxAttempts), 1);
  const repeatSignatureWindowMs = Math.max(options.repeatSignatureWindowMs, 0);
  const signature = String(options.signature || '').trim();
  const currentAttempt = options.currentAttempt;

  const nextAttempt: AuthAttemptState = currentAttempt
    ? { ...currentAttempt }
    : { failures: 0, firstFailureAtMs: nowMs, blockedUntilMs: 0 };

  if (nowMs - nextAttempt.firstFailureAtMs > blockWindowMs) {
    nextAttempt.failures = 0;
    nextAttempt.firstFailureAtMs = nowMs;
    nextAttempt.blockedUntilMs = 0;
    delete nextAttempt.lastFailureSignature;
    delete nextAttempt.lastFailureSignatureAtMs;
  }

  const repeatedCachedCredential =
    signature &&
    nextAttempt.lastFailureSignature === signature &&
    typeof nextAttempt.lastFailureSignatureAtMs === 'number' &&
    nowMs - nextAttempt.lastFailureSignatureAtMs <= repeatSignatureWindowMs;

  if (!repeatedCachedCredential) {
    nextAttempt.failures += 1;
    nextAttempt.lastFailureSignature = signature;
  }
  nextAttempt.lastFailureSignatureAtMs = nowMs;

  if (nextAttempt.failures >= maxAttempts) {
    nextAttempt.blockedUntilMs = nowMs + blockWindowMs;
  }

  return nextAttempt;
};
