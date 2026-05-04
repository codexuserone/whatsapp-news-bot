const isInlineMediaDataUrl = (value: unknown) => /^data:[^;,]+;base64,/i.test(String(value || '').trim());

const sanitizeMediaUrlForApi = (value: unknown) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return isInlineMediaDataUrl(normalized) ? null : normalized;
};

module.exports = {
  isInlineMediaDataUrl,
  sanitizeMediaUrlForApi
};

export {};
