const getErrorMessage = (error: unknown, fallback = 'Unknown error'): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown })?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return fallback;
};

const getErrorStatus = (error: unknown, fallback = 500): number => {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : fallback;
};

module.exports = {
  getErrorMessage,
  getErrorStatus
};
export {};
