const isInlineMediaDataUrl = (value: unknown) => /^data:[^;,]+;base64,/i.test(String(value || '').trim());

const isStoredMediaReference = (value: unknown) => {
  const normalized = String(value || '').trim();
  return isInlineMediaDataUrl(normalized) || normalized.startsWith('uploaded:');
};

const sanitizeMediaUrlForApi = (value: unknown) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return isInlineMediaDataUrl(normalized) ? null : normalized;
};

module.exports = {
  isInlineMediaDataUrl,
  isStoredMediaReference,
  sanitizeMediaUrlForApi
};

export {};
