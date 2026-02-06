const RIGHT_ARROW_CHARS = /[\u2192\u27A1\u2794\u279C\u279D\u279E\u27A0]/g;
const LEFT_ARROW_CHARS = /[\u2190\u2B05]/g;
const BIDIRECTIONAL_ARROW_CHARS = /[\u2194\u27F7\u27F6]/g;

const normalizeMessageText = (input: unknown): string => {
  const text = String(input ?? '');
  return text
    .replace(/\r\n/g, '\n')
    .replace(BIDIRECTIONAL_ARROW_CHARS, '<->')
    .replace(RIGHT_ARROW_CHARS, '->')
    .replace(LEFT_ARROW_CHARS, '<-');
};

module.exports = {
  normalizeMessageText
};
