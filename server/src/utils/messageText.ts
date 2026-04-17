// Used to break WhatsApp markdown delimiters inside variable values (e.g. titles with underscores).
// WhatsApp has no true escaping; inserting an invisible joiner prevents accidental formatting.
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
    .replace(/\u001a/g, '->')
    .replace(/[→➡➔➜➝➞➠]/g, '->')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u0019\u001b-\u001f\u007f]/g, '');

  return normalized.trim();
};

module.exports = {
  normalizeMessageText,
  escapeWhatsAppFormatting
};

export {};
