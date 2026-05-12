const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const normalizeApiBase = (value: string) => {
  const raw = value.trim();
  if (!raw) return '';

  try {
    const base =
      typeof window !== 'undefined'
        ? new URL(raw, window.location.origin)
        : new URL(raw);

    base.username = '';
    base.password = '';
    return trimTrailingSlash(base.toString());
  } catch {
    return trimTrailingSlash(raw);
  }
};

const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    const runtimeApiUrl =
      (window as { ENV?: { API_URL?: string } }).ENV?.API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      window.location.origin;
    return normalizeApiBase(runtimeApiUrl);
  }
  return normalizeApiBase(process.env.NEXT_PUBLIC_API_URL || '');
};

const resolveApiUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const base = getApiUrl();
  if (!base) {
    return path;
  }

  return new URL(path, `${base}/`).toString();
};

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const rawBody = await response.text().catch(() => '');
    const trimmedBody = rawBody.trim();
    const looksLikeHtml =
      /^<!doctype\s+html/i.test(trimmedBody) ||
      /^<html[\s>]/i.test(trimmedBody) ||
      trimmedBody.includes('<body') ||
      trimmedBody.includes('__next');
    let parsedBody: Record<string, unknown> | null = null;
    if (rawBody && !looksLikeHtml) {
      try {
        parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        parsedBody = null;
      }
    }

    const details = Array.isArray(parsedBody?.details)
      ? parsedBody.details
          .map((detail) => {
            if (!detail || typeof detail !== 'object') return '';
            const field = String((detail as { field?: unknown }).field || '').trim();
            const detailMessage = String((detail as { message?: unknown }).message || '').trim();
            if (!field && !detailMessage) return '';
            return field ? `${field}: ${detailMessage || 'Invalid value'}` : detailMessage;
          })
          .filter(Boolean)
          .join('; ')
      : '';

    const message =
      String(parsedBody?.error || '').trim() ||
      String(parsedBody?.message || '').trim() ||
      (looksLikeHtml ? '' : String(rawBody || '').trim()) ||
      `Request failed (${response.status})`;

    const error = new Error(details ? `${message}: ${details}` : message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json();
};

export const isTransientDatabaseError = (error: unknown) => {
  const status = typeof error === 'object' && error ? Number((error as { status?: unknown }).status) : 0;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  const looksLikeDatabaseWakeup =
    message.includes('database is temporarily unavailable') ||
    message.includes('postgres temporarily unavailable') ||
    message.includes('connect econnrefused') ||
    message.includes('connection refused') ||
    message.includes('getaddrinfo enotfound') ||
    message.includes('connection terminated unexpectedly');
  return looksLikeDatabaseWakeup && (status === 0 || status === 503 || status >= 500);
};

export const getTransientDatabaseMessage = (error: unknown) => (
  isTransientDatabaseError(error)
    ? 'Database is waking up. Your changes are still on screen; try Save again in a few seconds.'
    : null
  );

export const formatApiErrorMessage = (error: unknown, fallback = 'Request failed') => {
  const transientMessage = getTransientDatabaseMessage(error);
  if (transientMessage) return transientMessage;
  return error instanceof Error && error.message ? error.message : fallback;
};

const mergeHeaders = (base?: HeadersInit, extra?: HeadersInit): HeadersInit | undefined => {
  if (!base && !extra) return undefined;
  const headers = new Headers(base || undefined);
  if (extra) {
    const next = new Headers(extra);
    next.forEach((value, key) => headers.set(key, value));
  }
  return headers;
};

const fetchWithTimeout = (url: string, options: RequestInit = {}, timeoutMs = 30000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const headers = mergeHeaders(options.headers, { 'Cache-Control': 'no-cache' });
  const requestInit: RequestInit = {
    cache: 'no-store',
    credentials: 'include',
    ...options,
    signal: controller.signal
  };

  if (headers) {
    requestInit.headers = headers;
  }

  return fetch(url, requestInit)
    .finally(() => clearTimeout(timeoutId))
    .catch((error) => {
      if (error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    });
};

export const api = {
  get: <T = unknown>(path: string) => fetchWithTimeout(resolveApiUrl(path)).then((res) => handleResponse<T>(res)),
  post: <T = unknown>(path: string, body?: unknown) =>
    (() => {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return fetchWithTimeout(resolveApiUrl(path), init).then((res) => handleResponse<T>(res));
    })(),
  put: <T = unknown>(path: string, body?: unknown) =>
    (() => {
      const init: RequestInit = {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return fetchWithTimeout(resolveApiUrl(path), init).then((res) => handleResponse<T>(res));
    })(),
  patch: <T = unknown>(path: string, body?: unknown) =>
    (() => {
      const init: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return fetchWithTimeout(resolveApiUrl(path), init).then((res) => handleResponse<T>(res));
    })(),
  delete: <T = unknown>(path: string) =>
    fetchWithTimeout(resolveApiUrl(path), {
      method: 'DELETE'
    }).then((res) => handleResponse<T>(res))
};
