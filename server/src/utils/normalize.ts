import { createHash } from 'crypto';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'igshid',
  'mc_cid',
  'mc_eid'
]);

const normalizeText = (value: string = '') => {
  return value
    .toString()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
};

const normalizeUrl = (value: string = '') => {
  const raw = value?.toString().trim();
  if (!raw) return '';

  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/$/, '').toLowerCase();

    const entries = Array.from(url.searchParams.entries())
      .filter(([key, val]) => key && val && !TRACKING_PARAMS.has(key.toLowerCase()));

    const search = entries.length
      ? `?${entries.map(([key, val]) => `${key}=${val}`).sort().join('&')}`
      : '';

    return `${host}${pathname}${search}`.trim();
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .trim();
  }
};

const hashContent = (title: string, url: string) => {
  const normalizedTitle = normalizeText(title || '');
  const normalizedUrlValue = normalizeUrl(url || '');
  const input = `${normalizedTitle}|${normalizedUrlValue}`;
  return createHash('sha256').update(input).digest('hex');
};

module.exports = {
  normalizeText,
  normalizeUrl,
  hashContent
};
export {};
