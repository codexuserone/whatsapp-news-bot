// Get API URL from environment or use relative path for same-origin requests
const getApiUrl = () => {
  if (typeof window !== 'undefined' && window.ENV?.API_URL) {
    return window.ENV.API_URL;
  }

  if (typeof import.meta !== 'undefined' && import.meta.env) {
    if (import.meta.env.VITE_API_URL) {
      return import.meta.env.VITE_API_URL;
    }

    if (import.meta.env.DEV) {
      return 'http://localhost:10000';
    }
  }

  return '';
};

const handleResponse = async (response) => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
};

const fetchWithTimeout = (url, options = {}, timeoutMs = 30000) => {
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
  get: (path) => fetchWithTimeout(`${getApiUrl()}${path}`).then(handleResponse),
  post: (path, body) =>
    fetchWithTimeout(`${getApiUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(handleResponse),
  put: (path, body) =>
    fetchWithTimeout(`${getApiUrl()}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(handleResponse),
  delete: (path) =>
    fetchWithTimeout(`${getApiUrl()}${path}`, {
      method: 'DELETE'
    }).then(handleResponse)
};
