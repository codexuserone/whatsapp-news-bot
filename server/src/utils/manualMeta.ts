const META_PREFIX = '__WNB_MANUAL_META__=';

type ManualMeta = {
  disableLinkPreview?: boolean;
  includeCaption?: boolean;
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
      : {})
  };
};

const encodeManualMessageContent = (
  message: unknown,
  meta?: { disableLinkPreview?: boolean; includeCaption?: boolean }
): string | null => {
  const text = typeof message === 'string' ? message : '';
  const hasText = Boolean(text.trim());
  if (!hasText) return null;

  const disableLinkPreview = meta?.disableLinkPreview === true;
  const includeCaption = meta?.includeCaption !== false;
  const needsMetaLine = disableLinkPreview || includeCaption === false;
  if (!needsMetaLine) return text;

  const payload = JSON.stringify({ disableLinkPreview, includeCaption });
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

