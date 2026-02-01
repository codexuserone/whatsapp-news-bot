const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const handleResponse = async (response) => {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
};

export const api = {
  get: (path) => fetch(`${API_URL}${path}`).then(handleResponse),
  post: (path, body) =>
    fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(handleResponse),
  put: (path, body) =>
    fetch(`${API_URL}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(handleResponse),
  delete: (path) =>
    fetch(`${API_URL}${path}`, {
      method: 'DELETE'
    }).then(handleResponse)
};
