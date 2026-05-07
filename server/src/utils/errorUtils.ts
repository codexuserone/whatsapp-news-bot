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

const normalizeErrorText = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  const lower = trimmed.toLowerCase();
  if (lower.includes('supabase request timed out')) {
    return 'Supabase database is temporarily unreachable';
  }
  if (lower.includes('supabase temporarily unavailable')) {
    return 'Supabase database is temporarily unreachable';
  }
  if (lower.includes('error code: 522') || lower.includes('522: connection timed out')) {
    return 'Supabase project is temporarily unreachable (Cloudflare 522 connection timeout)';
  }
  if (lower.includes('ecircuitbreaker') || lower.includes('circuit breaker open')) {
    return 'Supabase connection pooler is temporarily blocking new connections (circuit breaker open)';
  }

  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.length > 500 ? `${singleLine.slice(0, 500)}...` : singleLine;
};

const getErrorMessage = (error: unknown, fallback = 'Unknown error'): string => {
  if (error instanceof Error) {
    return normalizeErrorText(readStringValue(error.message) || fallback, fallback);
  }

  const direct = readStringValue(error);
  if (direct) return normalizeErrorText(direct, fallback);

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
      if (value) return normalizeErrorText(value, fallback);
    }

    const cause = record.cause;
    if (cause && cause !== error) {
      const causeMessage = getErrorMessage(cause, '');
      if (causeMessage) return causeMessage;
    }
  }

  return fallback;
};

const isServiceUnavailableErrorText = (value: string) => {
  const lower = value.toLowerCase();
  return (
    lower.includes('supabase database is temporarily unreachable') ||
    lower.includes('supabase request timed out') ||
    lower.includes('supabase temporarily unavailable') ||
    lower.includes('postgres temporarily unavailable') ||
    lower.includes('data transfer quota') ||
    lower.includes('quota exceeded') ||
    lower.includes('cloudflare 522') ||
    lower.includes('522: connection timed out') ||
    lower.includes('circuit breaker open')
  );
};

const getErrorStatus = (error: unknown, fallback = 500): number => {
  const message = getErrorMessage(error, '');
  if (message && isServiceUnavailableErrorText(message)) {
    return 503;
  }

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
