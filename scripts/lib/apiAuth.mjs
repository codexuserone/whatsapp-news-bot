const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

export const loadApiAuth = () => {
  const apiUrl = trimTrailingSlash(process.env.API_URL || process.env.BOT_API_URL || '');
  if (!apiUrl) {
    throw new Error('Missing API_URL (or BOT_API_URL)');
  }

  const user = String(process.env.BASIC_AUTH_USER || '').trim();
  const pass = String(process.env.BASIC_AUTH_PASS || '').trim();
  if (!user || !pass) {
    throw new Error('Missing BASIC_AUTH_USER/BASIC_AUTH_PASS');
  }

  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  return {
    apiUrl,
    authHeaders: { Authorization: auth }
  };
};
