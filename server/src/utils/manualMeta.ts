const META_PREFIX = '__WNB_MANUAL_META__=';

type ManualMeta = {
  disableLinkPreview?: boolean;
  includeCaption?: boolean;
  documentFilename?: string;
  documentMime?: string;
};

const toBoolean = (value: unknown) => value === true;

const normalizeMeta = (input: unknown): ManualMeta => {
  if (!input || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  return {
    ...(Object.prototype.hasOwnProperty.call(obj, 'disableLinkPreview')
      ? { disableLinkPreview: toBoolean(obj.disableLinkPreview) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(obj, 'includeCaption')
      ? { includeCaption: obj.includeCaption !== false }
      : {}),
    ...(typeof obj.documentFilename === 'string' && obj.documentFilename.trim()
      ? { documentFilename: obj.documentFilename.trim() }
      : {}),
    ...(typeof obj.documentMime === 'string' && obj.documentMime.trim()
      ? { documentMime: obj.documentMime.trim() }
      : {})
  };
};

const encodeManualMessageContent = (
  message: unknown,
  meta?: { disableLinkPreview?: boolean; includeCaption?: boolean; documentFilename?: string | null; documentMime?: string | null }
): string | null => {
  const text = typeof message === 'string' ? message : '';
  const hasText = Boolean(text.trim());
  const documentFilename = typeof meta?.documentFilename === 'string' ? meta.documentFilename.trim() : '';
  const documentMime = typeof meta?.documentMime === 'string' ? meta.documentMime.trim() : '';

  const disableLinkPreview = meta?.disableLinkPreview === true;
  const includeCaption = meta?.includeCaption !== false;
  const needsMetaLine = disableLinkPreview || includeCaption === false || Boolean(documentFilename) || Boolean(documentMime);
  if (!hasText && !needsMetaLine) return null;
  if (!needsMetaLine) return text;

  const payload = JSON.stringify({ disableLinkPreview, includeCaption, documentFilename, documentMime });
  return `${META_PREFIX}${payload}\n${text}`;
};

const parseManualMessageContent = (
  raw: unknown
): { text: string; meta: ManualMeta } => {
  const value = typeof raw === 'string' ? raw : '';
  if (!value.startsWith(META_PREFIX)) {
    return { text: value, meta: {} };
  }

  const newlineIdx = value.indexOf('\n');
  if (newlineIdx === -1) {
    return { text: '', meta: {} };
  }

  const metaRaw = value.slice(META_PREFIX.length, newlineIdx).trim();
  const body = value.slice(newlineIdx + 1);
  try {
    const parsed = JSON.parse(metaRaw);
    return { text: body, meta: normalizeMeta(parsed) };
  } catch {
    return { text: body, meta: {} };
  }
};

const stripManualMeta = (raw: unknown) => parseManualMessageContent(raw).text;

module.exports = {
  META_PREFIX,
  encodeManualMessageContent,
  parseManualMessageContent,
  stripManualMeta
};

export {};
