const WORD_JOINER = '\u2060';

const escapeWhatsAppFormatting = (value: unknown): string => {
  const text = String(value ?? '');
  if (!text) return '';
  return text.replace(/([*_~`])(?!\u2060)/g, `$1${WORD_JOINER}`);
};

const normalizeMessageText = (value: unknown): string => {
  const normalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u001a/g, '\u2192')
    .replace(/(?:â†’|âž¡|âž”|âžœ|âž|âžž|âž )/g, '\u2192')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u0019\u001b-\u001f\u007f]/g, '');

  return normalized.trim();
};

module.exports = {
  normalizeMessageText,
  escapeWhatsAppFormatting
};

export {};
