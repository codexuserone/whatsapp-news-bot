// Get API URL from environment or use relative path for same-origin requests
const getApiUrl = () => {
  // In browser, check for env var or use relative path
  if (typeof window !== 'undefined') {
    return window.ENV?.API_URL || '';
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

const fetchWithTimeout = (url, options = {}, timeoutMs = 15000) => {
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
