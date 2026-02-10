import type { Request } from 'express';

const PUBLIC_PROBE_PATHS = new Set([
  '/health',
  '/ping',
  '/ready',
  '/api/health',
  '/api/ping',
  '/api/ready'
]);

const normalizePath = (pathValue: string) => {
  const trimmed = String(pathValue || '').trim();
  if (!trimmed) return '/';
  const compact = trimmed.replace(/\/{2,}/g, '/');
  if (compact.length > 1 && compact.endsWith('/')) {
    return compact.slice(0, -1);
  }
  return compact;
};

const isPublicProbePath = (pathValue: string) => PUBLIC_PROBE_PATHS.has(normalizePath(pathValue));

const isPublicProbeRequest = (req: Request) => {
  const method = String(req.method || '').trim().toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  return isPublicProbePath(String(req.path || ''));
};

module.exports = {
  PUBLIC_PROBE_PATHS,
  normalizePath,
  isPublicProbePath,
  isPublicProbeRequest
};
export {};
