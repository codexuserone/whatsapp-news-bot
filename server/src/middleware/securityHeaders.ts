import type { NextFunction, Request, Response } from 'express';
const { isPublicProbePath } = require('./publicProbePaths');

const hasStaticFileExtension = (pathValue: string) => /\.[a-z0-9]{2,8}$/i.test(pathValue);

const isSecureRequest = (req: Request) => {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  return proto === 'https';
};

const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  const pathValue = String(req.path || '').trim();
  const isHealthPath = isPublicProbePath(pathValue);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  if (process.env.NODE_ENV === 'production' && isSecureRequest(req)) {
    const hstsMaxAgeSeconds = Math.max(Number(process.env.HSTS_MAX_AGE_SECONDS || 15552000), 0);
    if (hstsMaxAgeSeconds > 0) {
      res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAgeSeconds}; includeSubDomains`);
    }
  }

  const isApiPath = pathValue.startsWith('/api');
  const isStaticPath =
    pathValue.startsWith('/_next/') ||
    pathValue.startsWith('/static/') ||
    hasStaticFileExtension(pathValue);

  if (!isHealthPath && ((isApiPath && !isStaticPath) || (!isStaticPath && req.method === 'GET'))) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
};

module.exports = securityHeaders;
export {};
