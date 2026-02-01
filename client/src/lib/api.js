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

export const api = {
  get: (path) => fetch(`${getApiUrl()}${path}`).then(handleResponse),
  post: (path, body) =>
    fetch(`${getApiUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(handleResponse),
  put: (path, body) =>
    fetch(`${getApiUrl()}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(handleResponse),
  delete: (path) =>
    fetch(`${getApiUrl()}${path}`, {
      method: 'DELETE'
    }).then(handleResponse)
};
