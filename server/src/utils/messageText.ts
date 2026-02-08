const ARROW_REPLACEMENTS: Array<[RegExp, string]> = [
  [/↔/g, '<->'],
  [/←/g, '<-'],
  [/⬅/g, '<-'],
  [/→/g, '->'],
  [/➡/g, '->'],
  [/➔/g, '->'],
  [/➜/g, '->'],
  [/➝/g, '->'],
  [/➞/g, '->'],
  [/➠/g, '->']
];

const normalizeMessageText = (value: unknown): string => {
  let normalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '');

  for (const [pattern, replacement] of ARROW_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.trim();
};

module.exports = {
  normalizeMessageText
};

export {};
