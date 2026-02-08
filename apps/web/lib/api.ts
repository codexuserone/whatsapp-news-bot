const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    return (window as { ENV?: { API_URL?: string } }).ENV?.API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      '';
  }
  return process.env.NEXT_PUBLIC_API_URL || '';
};

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
};

const fetchWithTimeout = (url: string, options: RequestInit = {}, timeoutMs = 30000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId))
    .catch((error) => {
      if (error.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    });
};

export const api = {
  get: <T = unknown>(path: string) => fetchWithTimeout(`${getApiUrl()}${path}`).then((res) => handleResponse<T>(res)),
  post: <T = unknown>(path: string, body?: unknown) =>
    (() => {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return fetchWithTimeout(`${getApiUrl()}${path}`, init).then((res) => handleResponse<T>(res));
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
      return fetchWithTimeout(`${getApiUrl()}${path}`, init).then((res) => handleResponse<T>(res));
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
      return fetchWithTimeout(`${getApiUrl()}${path}`, init).then((res) => handleResponse<T>(res));
    })(),
  delete: <T = unknown>(path: string) =>
    fetchWithTimeout(`${getApiUrl()}${path}`, {
      method: 'DELETE'
    }).then((res) => handleResponse<T>(res))
};
