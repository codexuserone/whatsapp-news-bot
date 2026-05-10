import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export const APP_SESSION_COOKIE = 'wnb_session';

const safeEquals = (left: string, right: string) => {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

const resolveSecret = (basicUser: string, basicPass: string, explicitSecret?: string | null) =>
  String(explicitSecret || `${basicUser}:${basicPass}`).trim();

export const createAppSessionToken = (options: {
  username: string;
  basicUser: string;
  basicPass: string;
  explicitSecret?: string | null;
  nowMs?: number;
  ttlSeconds?: number;
}) => {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const ttlSeconds = Math.max(Number(options.ttlSeconds || DEFAULT_TTL_SECONDS), 60);
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      u: options.username,
      exp: nowMs + ttlSeconds * 1000
    }),
    'utf8'
  ).toString('base64url');
  const signature = sign(payload, resolveSecret(options.basicUser, options.basicPass, options.explicitSecret));
  return `${payload}.${signature}`;
};

export const verifyAppSessionToken = (
  token: string | null | undefined,
  options: {
    basicUser: string;
    basicPass: string;
    explicitSecret?: string | null;
    nowMs?: number;
  }
) => {
  const raw = String(token || '').trim();
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return false;

  const expected = sign(payload, resolveSecret(options.basicUser, options.basicPass, options.explicitSecret));
  if (!safeEquals(signature, expected)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: unknown;
      exp?: unknown;
    };
    const username = String(parsed.u || '');
    const exp = Number(parsed.exp);
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    return username === options.basicUser && Number.isFinite(exp) && exp > nowMs;
  } catch {
    return false;
  }
};

export const readCookie = (req: Request, name: string) => {
  const raw = String(req.headers?.cookie || '');
  const parts = raw.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = decodeURIComponent(part.slice(0, idx).trim());
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
};

export const setAppSessionCookie = (
  res: Response,
  token: string,
  options: {
    secure: boolean;
    ttlSeconds?: number;
  }
) => {
  const ttlSeconds = Math.max(Number(options.ttlSeconds || DEFAULT_TTL_SECONDS), 60);
  const secure = options.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; SameSite=Lax${secure}`
  );
};

export const clearAppSessionCookie = (res: Response, secure: boolean) => {
  const securePart = secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${APP_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${securePart}`
  );
};
