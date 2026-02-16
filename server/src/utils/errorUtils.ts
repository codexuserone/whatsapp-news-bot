const readStringValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readNumericStatus = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  if (!/^\d{3}$/.test(value.trim())) return null;
  return Number(value);
};

const getErrorMessage = (error: unknown, fallback = 'Unknown error'): string => {
  if (error instanceof Error) {
    return readStringValue(error.message) || fallback;
  }

  const direct = readStringValue(error);
  if (direct) return direct;

  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidates = [
      record.message,
      record.error,
      record.reason,
      record.error_description,
      record.title
    ];

    for (const candidate of candidates) {
      const value = readStringValue(candidate);
      if (value) return value;
    }

    const cause = record.cause;
    if (cause && cause !== error) {
      const causeMessage = getErrorMessage(cause, '');
      if (causeMessage) return causeMessage;
    }
  }

  return fallback;
};

const getErrorStatus = (error: unknown, fallback = 500): number => {
  if (!error || typeof error !== 'object') return fallback;

  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };

  const candidates = [
    readNumericStatus(record.status),
    readNumericStatus(record.statusCode),
    readNumericStatus(record.response?.status)
  ];

  for (const value of candidates) {
    if (value !== null && value >= 100 && value <= 599) {
      return value;
    }
  }

  return fallback;
};

module.exports = {
  getErrorMessage,
  getErrorStatus
};
export {};
