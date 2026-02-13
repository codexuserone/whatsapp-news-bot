import type { AxiosRequestConfig, AxiosResponse } from 'axios';

const axios = require('axios');
const { assertSafeOutboundUrl } = require('./outboundUrl');

type SafeRedirectOptions = {
  maxRedirects?: number;
  allowPrivate?: boolean;
};

const DEFAULT_MAX_REDIRECTS = 5;

const isRedirectStatus = (status: number) => status >= 300 && status < 400;

const resolveRedirectUrl = (location: string, baseUrl: string) => {
  // Location may be relative.
  return new URL(location, baseUrl).toString();
};

/**
 * axios wrapper that:
 * - validates each hop with assertSafeOutboundUrl
 * - follows redirects manually (so we can re-validate redirect targets)
 * - disables axios auto-follow to avoid SSRF via redirect-to-private-IP tricks
 */
const safeAxiosRequest = async (
  rawUrl: string,
  config: AxiosRequestConfig,
  options?: SafeRedirectOptions
): Promise<AxiosResponse> => {
  const maxRedirects = Math.max(0, Math.min(Number(options?.maxRedirects ?? DEFAULT_MAX_REDIRECTS), 10));

  let currentUrl = String(rawUrl || '').trim();
  if (!currentUrl) {
    throw new Error('URL is required');
  }

  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    // Validate each hop before requesting it.
    const safeUrl: URL = await assertSafeOutboundUrl(currentUrl, { allowPrivate: options?.allowPrivate === true });

    // Ensure axios never auto-follows redirects; we handle them ourselves.
    const response: AxiosResponse = await axios.request({
      ...config,
      url: safeUrl.toString(),
      maxRedirects: 0,
      // Avoid axios throwing on non-2xx so we can handle redirects consistently.
      validateStatus: () => true
    });

    if (isRedirectStatus(response.status)) {
      const location = String(response.headers?.location || '').trim();
      if (!location) {
        throw new Error(`Redirect response missing Location header (${response.status})`);
      }

      if (attempt >= maxRedirects) {
        throw new Error(`Too many redirects (>${maxRedirects})`);
      }

      currentUrl = resolveRedirectUrl(location, safeUrl.toString());
      continue;
    }

    // Apply caller-provided status validation after redirects are resolved.
    if (typeof config.validateStatus === 'function' && !config.validateStatus(response.status)) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    // Default success criteria: 2xx.
    if (typeof config.validateStatus !== 'function' && (response.status < 200 || response.status >= 300)) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    return response;
  }

  // Should be unreachable.
  throw new Error('Request failed');
};

module.exports = {
  safeAxiosRequest
};

export {};

