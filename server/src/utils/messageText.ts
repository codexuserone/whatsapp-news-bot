const RIGHT_ARROW_CHARS = /[\u2192\u27A1\u2794\u279C\u279D\u279E\u27A0]/g;
const LEFT_ARROW_CHARS = /[\u2190\u2B05]/g;
const BIDIRECTIONAL_ARROW_CHARS = /[\u2194\u27F7\u27F6]/g;
const SMART_SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
const SMART_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F]/g;
const DASH_VARIANTS = /[\u2012\u2013\u2014\u2015]/g;
const ELLIPSIS = /\u2026/g;
const NBSP = /\u00A0/g;
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

const normalizeMessageText = (input: unknown): string => {
  const text = String(input ?? '');
  return text
    .replace(/\r\n/g, '\n')
    .replace(NBSP, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(DASH_VARIANTS, '-')
    .replace(ELLIPSIS, '...')
    .replace(BIDIRECTIONAL_ARROW_CHARS, '<->')
    .replace(RIGHT_ARROW_CHARS, '->')
    .replace(LEFT_ARROW_CHARS, '<-');
};

module.exports = {
  normalizeMessageText
};
