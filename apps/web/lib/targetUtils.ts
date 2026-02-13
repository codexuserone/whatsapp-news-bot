import type { Target } from './types';

const stripInvisibleChars = (value: string) =>
  String(value || '').replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2060\uFEFF]/g, ' ');

export const normalizeDisplayText = (value: unknown) =>
  stripInvisibleChars(String(value || '')).replace(/\s+/g, ' ').trim();

const stripTargetTypeTags = (value: string) =>
  String(value || '')
    .replace(/\((group|channel|status|individual)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasRawJidLabel = (value: string) =>
  /@(g\.us|newsletter(?:_[a-z0-9_-]+)?|s\.whatsapp\.net|lid)\b/i.test(String(value || '').trim());

const isPlaceholderChannelName = (name: string) => /^channel[\s_-]*\d+$/i.test(String(name || '').trim());
const isNumericOnlyLabel = (name: string) => /^\d{6,}$/.test(String(name || '').trim());
const hasOnlyDigitsAndSeparators = (name: string) => /^[\d\s._-]{6,}$/.test(String(name || '').trim());
const isLikelyPlaceholderChannelName = (name: string) => {
  const normalized = normalizeDisplayText(name).toLowerCase();
  if (!normalized) return true;
  if (isPlaceholderChannelName(normalized)) return true;
  if (isNumericOnlyLabel(normalized)) return true;
  if (hasOnlyDigitsAndSeparators(normalized)) return true;
  return false;
};

const cleanupDisplayName = (value: string) => {
  let cleaned = normalizeDisplayText(value);
  if (!cleaned) return '';

  // Heuristic: some malformed rows contain concatenated labels with "target".
  // Prefer the left-most friendly part in that case.
  if (/\btarget\b/i.test(cleaned)) {
    const beforeTarget = normalizeDisplayText(cleaned.split(/\btarget\b/i)[0]);
    if (beforeTarget.length >= 3) {
      const tokens = beforeTarget.split(/\s+/).filter(Boolean);
      const hasLongIdToken = tokens.some((token) => /\d{5,}/.test(token));
      if (hasLongIdToken && tokens.length > 1) {
        cleaned = tokens[0] || beforeTarget;
      } else {
        cleaned = beforeTarget;
      }
    }
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 4) {
    const first = words[0]?.toLowerCase();
    const last = words[words.length - 1]?.toLowerCase();
    if (first && first === last) {
      cleaned = words.slice(0, -1).join(' ');
    }
  }

  if (cleaned.length > 96) {
    cleaned = cleaned.slice(0, 96).trim();
  }

  // Collapse exact duplicate suffixes that can appear after broken merges.
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6) {
    const half = Math.floor(tokens.length / 2);
    const left = tokens.slice(0, half).join(' ').toLowerCase();
    const right = tokens.slice(half).join(' ').toLowerCase();
    if (left && left === right) {
      cleaned = tokens.slice(0, half).join(' ');
    }
  }

  return cleaned;
};

const normalizeGroupJid = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw.toLowerCase().endsWith('@g.us')) return raw.toLowerCase();
  const cleaned = raw.replace(/[^0-9-]/g, '');
  return cleaned ? `${cleaned}@g.us` : raw.toLowerCase();
};

const normalizeChannelJid = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  if (lower.includes('@newsletter')) {
    // Baileys treats newsletters as "...@newsletter". Some UIs expose decorated ids like
    // "true_123@newsletter_ABC..."; canonicalize those to a Baileys-safe jid.
    const match = lower.match(/([a-z0-9._-]+)@newsletter/i);
    const userRaw = String(match?.[1] || '').trim();
    if (!userRaw) return lower;

    const strippedPrefix = userRaw.replace(/^(true|false)_/i, '');
    const digits = strippedPrefix.replace(/[^0-9]/g, '');
    const user = digits || strippedPrefix;
    return user ? `${user}@newsletter` : lower;
  }
  const compact = raw.replace(/\s+/g, '');
  if (/^[a-z0-9._-]{6,}$/i.test(compact)) {
    return `${compact.toLowerCase()}@newsletter`;
  }
  const cleaned = raw.replace(/[^0-9]/g, '');
  return cleaned ? `${cleaned}@newsletter` : raw.toLowerCase();
};

const normalizeIndividualJid = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw.includes('@')) return raw.toLowerCase();
  const cleaned = raw.replace(/[^0-9]/g, '');
  return cleaned ? `${cleaned}@s.whatsapp.net` : raw.toLowerCase();
};

const normalizePhoneByType = (type: Target['type'], value: unknown) => {
  const raw = normalizeDisplayText(value);
  if (!raw) return raw;
  if (type === 'status') return 'status@broadcast';
  if (type === 'group') return normalizeGroupJid(raw);
  if (type === 'channel') return normalizeChannelJid(raw);
  return normalizeIndividualJid(raw);
};

export const inferTargetType = (type: unknown, phoneNumber: unknown): Target['type'] => {
  const rawType = String(type || '').trim().toLowerCase();
  const phone = String(phoneNumber || '').trim().toLowerCase();
  if (phone === 'status@broadcast') return 'status';
  if (phone.includes('@newsletter')) return 'channel';
  if (phone.endsWith('@g.us')) return 'group';
  if (phone.endsWith('@s.whatsapp.net') || phone.endsWith('@lid')) return 'individual';
  if (rawType === 'status' || rawType === 'channel' || rawType === 'group' || rawType === 'individual') {
    return rawType as Target['type'];
  }
  return 'individual';
};

export const normalizeTargetName = (name: unknown, type: Target['type'], phoneNumber: unknown) => {
  const fallback = normalizeDisplayText(phoneNumber);
  let cleaned = normalizeDisplayText(name);
  if (!cleaned) return type === 'status' ? 'My Status' : fallback;

  const repeatedTypeMentions = (cleaned.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) {
    const firstSegment = normalizeDisplayText(cleaned.split(/\((group|channel|status|individual)\)/i)[0]);
    if (firstSegment) cleaned = firstSegment;
  }

  cleaned = stripTargetTypeTags(cleaned);
  cleaned = cleanupDisplayName(cleaned);
  if (!cleaned) return type === 'status' ? 'My Status' : fallback;

  if (type === 'channel') {
    if (isLikelyPlaceholderChannelName(cleaned)) return '';
    if (hasRawJidLabel(cleaned)) return '';
  } else if (hasRawJidLabel(cleaned) && cleaned.toLowerCase() === fallback.toLowerCase()) {
    return type === 'status' ? 'My Status' : fallback;
  }

  return cleaned;
};

const scoreTargetName = (name: string, type: Target['type'], phoneNumber: string) => {
  const normalized = normalizeDisplayText(name);
  if (!normalized) return -1000;
  let score = normalized.length;
  if (type === 'channel' && isLikelyPlaceholderChannelName(normalized)) score -= 500;
  if (hasRawJidLabel(normalized)) score -= 300;
  if (normalized.toLowerCase() === String(phoneNumber || '').trim().toLowerCase()) score -= 250;
  const repeatedTypeMentions = (normalized.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) score -= 160;
  return score;
};

export const dedupeTargets = (targets: Array<Partial<Target>>, options?: { activeOnly?: boolean }) => {
  const activeOnly = options?.activeOnly !== false;
  const uniqueByDestination = new Map<string, Target>();

  for (const target of targets || []) {
    if (!target) continue;
    if (activeOnly && target.active !== true) continue;

    const rawPhone = normalizeDisplayText(target.phone_number);
    const type = inferTargetType(target.type, rawPhone);
    const phone = normalizePhoneByType(type, rawPhone).toLowerCase();
    if (!phone) continue;
    const name = normalizeTargetName(target.name, type, phone);
    if (type === 'channel' && !name) continue;

    const key = `${type}:${phone}`;
    const normalized: Target = {
      id: String(target.id || key),
      name: name || (type === 'status' ? 'My Status' : phone),
      phone_number: phone,
      type,
      active: target.active === true,
      notes: target.notes || null
    };

    const existing = uniqueByDestination.get(key);
    if (!existing) {
      uniqueByDestination.set(key, normalized);
      continue;
    }

    if (scoreTargetName(normalized.name, normalized.type, normalized.phone_number) > scoreTargetName(existing.name, existing.type, existing.phone_number)) {
      uniqueByDestination.set(key, normalized);
    }
  }

  return Array.from(uniqueByDestination.values()).sort((a, b) => {
    const aKey = `${String(a.type || '')}:${String(a.name || '')}:${String(a.phone_number || '')}`.toLowerCase();
    const bKey = `${String(b.type || '')}:${String(b.name || '')}:${String(b.phone_number || '')}`.toLowerCase();
    return aKey.localeCompare(bKey);
  });
};

export const formatTargetLabel = (target: Pick<Target, 'name' | 'type'>) => {
  const type = (target?.type || 'individual') as Target['type'];
  const rawName = normalizeDisplayText(target?.name);
  const normalizedName = normalizeTargetName(rawName, type, '');
  const stripped = stripTargetTypeTags(rawName);
  const useStripped = stripped && !hasRawJidLabel(stripped);
  const baseName =
    normalizedName ||
    (useStripped ? stripped : '') ||
    (type === 'channel' ? 'Channel' : '') ||
    (type === 'status' ? 'My Status' : 'Destination');
  return `${baseName} (${type})`;
};
