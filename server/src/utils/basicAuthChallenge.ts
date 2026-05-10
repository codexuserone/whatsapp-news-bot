import type { Request, Response } from 'express';

const STATIC_ASSET_PATH = /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webmanifest|woff2?)$/i;

export const shouldUseBasicAuthChallenge = (req: Request) => {
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  const path = String(req.path || req.url || '').split('?')[0] || '/';
  if (path === '/ready' || path === '/ping' || path === '/health') return false;
  if (path.startsWith('/api/')) return false;
  if (path.startsWith('/_next/') || path.startsWith('/assets/')) return false;
  if (STATIC_ASSET_PATH.test(path)) return false;

  const accept = String(req.headers?.accept || '').toLowerCase();
  return !accept || accept.includes('text/html') || accept.includes('*/*');
};

export const sendBasicAuthFailure = (
  req: Request,
  res: Response,
  options: {
    status: number;
    message: string;
    realm: string;
  }
) => {
  if (shouldUseBasicAuthChallenge(req)) {
    res.setHeader('WWW-Authenticate', `Basic realm="${options.realm}"`);
    return res.status(options.status).send(options.message);
  }

  return res.status(options.status).json({ error: options.message });
};
