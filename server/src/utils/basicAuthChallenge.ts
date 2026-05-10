import type { Request, Response } from 'express';

const STATIC_ASSET_PATH = /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webmanifest|woff2?)$/i;

const header = (req: Request, name: string) => {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(',').toLowerCase() : String(value || '').toLowerCase();
};

const hasRscQuery = (req: Request) => {
  const rawUrl = String(req.originalUrl || req.url || '');

  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    return parsed.searchParams.has('_rsc');
  } catch {
    return rawUrl.includes('_rsc=');
  }
};

export const shouldUseBasicAuthChallenge = (req: Request) => {
  const method = String(req.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  const path = String(req.path || req.url || '').split('?')[0] || '/';
  if (path === '/ready' || path === '/ping' || path === '/health') return false;
  if (path.startsWith('/api/')) return false;
  if (path.startsWith('/_next/') || path.startsWith('/assets/')) return false;
  if (STATIC_ASSET_PATH.test(path)) return false;
  if (hasRscQuery(req)) return false;

  const requestedWith = header(req, 'x-requested-with');
  if (requestedWith === 'xmlhttprequest') return false;

  const accept = header(req, 'accept');
  if (!accept.includes('text/html')) return false;

  const secFetchMode = header(req, 'sec-fetch-mode');
  if (secFetchMode && secFetchMode !== 'navigate') return false;

  const secFetchDest = header(req, 'sec-fetch-dest');
  if (secFetchDest && secFetchDest !== 'document') return false;

  return true;
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
