const normalizePublicUrl = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

const resolvePublicBaseUrl = (): string | null => {
  return (
    normalizePublicUrl(process.env.BOT_PUBLIC_URL) ||
    normalizePublicUrl(process.env.PUBLIC_APP_URL) ||
    normalizePublicUrl(process.env.BASE_URL) ||
    normalizePublicUrl(process.env.RENDER_EXTERNAL_URL)
  );
};

const buildDefaultUserAgent = (): string => {
  const explicit =
    String(process.env.MEDIA_FETCH_USER_AGENT || '').trim() ||
    String(process.env.FEED_USER_AGENT || '').trim();

  if (explicit) {
    return explicit;
  }

  const appNameRaw = String(process.env.BOT_USER_AGENT_NAME || 'WhatsAppNewsBot').trim();
  const appName = appNameRaw.replace(/\s+/g, '');
  const appVersion = String(process.env.BOT_USER_AGENT_VERSION || process.env.npm_package_version || '1.0').trim();
  const publicUrl = resolvePublicBaseUrl();

  return publicUrl
    ? `Mozilla/5.0 (compatible; ${appName}/${appVersion}; +${publicUrl})`
    : `Mozilla/5.0 (compatible; ${appName}/${appVersion})`;
};

module.exports = {
  buildDefaultUserAgent,
  resolvePublicBaseUrl
};

export {};
