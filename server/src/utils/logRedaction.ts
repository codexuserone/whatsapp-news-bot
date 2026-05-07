const REDACTION_INSTALL_KEY = Symbol.for('whatsapp-news-bot.console-redaction-installed');

const redactConsoleArgs = (args: unknown[]): unknown[] => {
  const first = String(args[0] || '');
  if (first.startsWith('Closing session:')) {
    return ['Closing session: [redacted]'];
  }
  return args;
};

const installConsoleRedaction = () => {
  const globalState = globalThis as typeof globalThis & Record<symbol, boolean>;
  if (globalState[REDACTION_INSTALL_KEY]) return;
  globalState[REDACTION_INSTALL_KEY] = true;

  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);

  console.info = (...args: unknown[]) => {
    originalInfo(...redactConsoleArgs(args));
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...redactConsoleArgs(args));
  };
};

module.exports = {
  installConsoleRedaction,
  redactConsoleArgs
};

export {};
