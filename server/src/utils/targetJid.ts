type TargetType = 'individual' | 'group' | 'channel' | 'status';

type NormalizeOptions = {
  allowNumericFallback?: boolean;
  returnEmptyOnInvalid?: boolean;
};

const CHANNEL_JID_PATTERN = /^[a-z0-9._-]+@newsletter$/i;

const normalizeOrFallback = (fallback: string, options?: NormalizeOptions) => {
  return options?.returnEmptyOnInvalid ? '' : fallback;
};

const normalizeChannelJid = (value: unknown, options?: NormalizeOptions): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  if (lower.includes('@newsletter')) {
    const match = lower.match(/([a-z0-9._-]+)@newsletter/i);
    const userRaw = String(match?.[1] || '').trim();
    if (!userRaw) return normalizeOrFallback(lower, options);

    const strippedPrefix = userRaw.replace(/^(true|false)_/i, '');
    const hasLetters = /[a-z]/i.test(strippedPrefix);
    const digits = strippedPrefix.replace(/[^0-9]/g, '');
    const user = hasLetters ? strippedPrefix : (digits || strippedPrefix);
    return user ? `${user}@newsletter` : normalizeOrFallback(lower, options);
  }

  if (raw.includes('@')) {
    return normalizeOrFallback(lower, options);
  }

  const compact = raw.replace(/\s+/g, '');
  if (/^[a-z0-9._-]{6,}$/i.test(compact)) {
    return `${compact.toLowerCase()}@newsletter`;
  }

  if (options?.allowNumericFallback === false) {
    return normalizeOrFallback(lower, options);
  }

  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? `${digits}@newsletter` : normalizeOrFallback(lower, options);
};

const normalizeGroupJid = (value: unknown, options?: NormalizeOptions): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  if (lower.endsWith('@g.us')) return lower;
  if (raw.includes('@')) return normalizeOrFallback(lower, options);

  const cleaned = raw.replace(/[^0-9-]/g, '');
  return cleaned ? `${cleaned}@g.us` : normalizeOrFallback(lower, options);
};

const normalizeIndividualJid = (value: unknown, options?: NormalizeOptions): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  if (lower === 'status@broadcast') return lower;
  if (lower.endsWith('@s.whatsapp.net') || lower.endsWith('@lid')) return lower;
  if (raw.includes('@')) return normalizeOrFallback(lower, options);

  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : normalizeOrFallback(lower, options);
};

const inferTargetType = (type: unknown, phoneNumber: unknown): TargetType => {
  const rawType = String(type || '').trim().toLowerCase();
  const rawPhone = String(phoneNumber || '').trim().toLowerCase();

  if (rawPhone === 'status@broadcast') return 'status';
  if (rawPhone.includes('@newsletter')) return 'channel';
  if (rawPhone.endsWith('@g.us')) return 'group';
  if (rawPhone.endsWith('@s.whatsapp.net') || rawPhone.endsWith('@lid')) return 'individual';

  if (rawType === 'status' || rawType === 'channel' || rawType === 'group' || rawType === 'individual') {
    return rawType as TargetType;
  }

  return 'individual';
};

const normalizePhoneForType = (type: unknown, phoneNumber: unknown): string => {
  const normalizedType = String(type || '').trim().toLowerCase();
  const explicitType =
    normalizedType === 'status' ||
    normalizedType === 'group' ||
    normalizedType === 'channel' ||
    normalizedType === 'individual'
      ? (normalizedType as TargetType)
      : null;
  const resolvedType = explicitType || inferTargetType(type, phoneNumber);

  if (resolvedType === 'status') return 'status@broadcast';
  if (resolvedType === 'group') {
    return normalizeGroupJid(phoneNumber, { returnEmptyOnInvalid: true });
  }
  if (resolvedType === 'channel') {
    return normalizeChannelJid(phoneNumber, {
      allowNumericFallback: true,
      returnEmptyOnInvalid: true
    });
  }
  return normalizeIndividualJid(phoneNumber, { returnEmptyOnInvalid: true });
};

const normalizeTargetJidForSend = (target: { phone_number?: unknown; type?: unknown }): string => {
  const rawPhone = String(target?.phone_number || '').trim();
  if (!rawPhone) return '';

  const resolvedType = inferTargetType(target?.type, rawPhone);
  return normalizePhoneForType(resolvedType, rawPhone);
};

const isValidChannelJid = (value: unknown): boolean => {
  const normalized = normalizeChannelJid(value, { allowNumericFallback: true, returnEmptyOnInvalid: true });
  return CHANNEL_JID_PATTERN.test(normalized);
};

module.exports = {
  normalizeChannelJid,
  normalizeGroupJid,
  normalizeIndividualJid,
  inferTargetType,
  normalizePhoneForType,
  normalizeTargetJidForSend,
  isValidChannelJid
};

export {};
