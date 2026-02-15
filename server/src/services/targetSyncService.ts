const { getSupabaseClient } = require('../db/supabase');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

type SyncCandidate = {
  name: string;
  phone_number: string;
  type: 'group' | 'channel' | 'status';
  active: boolean;
  notes?: string | null;
};

type ExistingTarget = {
  id: string;
  name: string;
  phone_number: string;
  type: 'individual' | 'group' | 'channel' | 'status';
  active: boolean;
  notes?: string | null;
  created_at?: string | null;
};

type SyncDiagnostics = Record<string, unknown> | null;

type SyncTargetsResult = {
  ok: boolean;
  discovered: {
    groups: number;
    channels: number;
    status: number;
  };
  candidates: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  diagnostics: SyncDiagnostics;
  reason?: string;
};

type WhatsAppSyncClient = {
  getStatus?: () => { status?: string };
  getGroups?: () => Promise<Array<{ jid?: string; name?: string; size?: number }>>;
  getChannels?: (seedJids?: string[]) => Promise<Array<{ jid?: string; name?: string; subscribers?: number }>>;
  getChannelsWithDiagnostics?: (seedJids?: string[]) => Promise<{
    channels: Array<{ jid?: string; name?: string; subscribers?: number }>;
    diagnostics?: Record<string, unknown>;
  }>;
};

const DEFAULT_SYNC_INTERVAL_MS = Math.max(
  Number(process.env.TARGET_AUTO_SYNC_INTERVAL_MS || 60_000),
  15_000
);

const normalizeDisplayText = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();

const stripTargetTypeTags = (value: string) =>
  String(value || '')
    .replace(/\((group|channel|status|individual)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasRawJidLabel = (value: string) =>
  /@(g\.us|newsletter(?:_[a-z0-9_-]+)?|s\.whatsapp\.net|lid)\b/i.test(String(value || '').trim());
const isNumericOnlyLabel = (value: string) => /^\d{6,}$/.test(String(value || '').trim());
const hasOnlyDigitsAndSeparators = (value: string) => /^[\d\s._-]{6,}$/.test(String(value || '').trim());
const isPlaceholderChannelName = (value: string) => /^channel[\s_-]*\d+$/i.test(String(value || '').trim());

const normalizeChannelJid = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.includes('@newsletter')) {
    // Baileys treats newsletters as "...@newsletter". Some UIs surface decorated ids like
    // "true_123@newsletter_ABC..."; canonicalize those to a Baileys-safe jid.
    const match = lower.match(/([a-z0-9._-]+)@newsletter/i);
    const userRaw = String(match?.[1] || '').trim();
    if (!userRaw) return trimmed;

    const strippedPrefix = userRaw.replace(/^(true|false)_/i, '');
    const hasLetters = /[a-z]/i.test(strippedPrefix);
    const digits = strippedPrefix.replace(/[^0-9]/g, '');
    const user = hasLetters ? strippedPrefix : (digits || strippedPrefix);
    return user ? `${user}@newsletter` : trimmed;
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (/^[a-z0-9._-]{6,}$/i.test(compact)) {
    return `${compact.toLowerCase()}@newsletter`;
  }
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits ? `${digits}@newsletter` : trimmed;
};

const buildFriendlyChannelName = (name: string, jid: string) => {
  const normalizedJid = normalizeChannelJid(jid);
  let rawName = normalizeDisplayText(name);
  if (!rawName || rawName.toLowerCase() === normalizedJid.toLowerCase()) return '';
  const repeatedTypeMentions = (rawName.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) {
    const firstSegment = normalizeDisplayText(rawName.split(/\((group|channel|status|individual)\)/i)[0]);
    if (firstSegment) rawName = firstSegment;
  }
  rawName = stripTargetTypeTags(rawName);
  if (!rawName || isPlaceholderChannelName(rawName)) return '';
  if (isNumericOnlyLabel(rawName)) return '';
  if (hasOnlyDigitsAndSeparators(rawName)) return '';
  if (hasRawJidLabel(rawName)) return '';
  return rawName;
};

const normalizePhoneByType = (type: string, phone: string) => {
  const normalizedPhone = String(phone || '').trim();
  if (type === 'channel') return normalizeChannelJid(normalizedPhone);
  return normalizedPhone;
};

const buildTargetKey = (type: string, phone: string) => `${String(type || '').trim()}:${normalizePhoneByType(type, phone)}`;

const normalizeGroupName = (name: unknown, jid: string) => {
  const fallback = normalizeDisplayText(jid);
  let cleaned = normalizeDisplayText(name);
  if (!cleaned) return fallback;
  const repeatedTypeMentions = (cleaned.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) {
    const firstSegment = normalizeDisplayText(cleaned.split(/\((group|channel|status|individual)\)/i)[0]);
    if (firstSegment) cleaned = firstSegment;
  }
  cleaned = stripTargetTypeTags(cleaned);
  if (!cleaned) return fallback;
  if (hasRawJidLabel(cleaned) && cleaned.toLowerCase() === fallback.toLowerCase()) return fallback;
  return cleaned;
};

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight = false;

const syncTargetsFromWhatsApp = async (
  whatsapp: WhatsAppSyncClient | null | undefined,
  options?: { includeStatus?: boolean; skipIfDisconnected?: boolean; strict?: boolean }
): Promise<SyncTargetsResult> => {
  const disconnectedResult = {
    ok: false,
    reason: 'WhatsApp is not connected',
    discovered: { groups: 0, channels: 0, status: 0 },
    candidates: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    diagnostics: null
  };

  if (!whatsapp || whatsapp.getStatus?.()?.status !== 'connected') {
    if (options?.skipIfDisconnected) {
      return disconnectedResult;
    }
    throw new Error(disconnectedResult.reason);
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error('Database not available');
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('targets')
    .select('*')
    .order('created_at', { ascending: true });
  if (existingError) throw existingError;

  const existing = (existingRows || []) as ExistingTarget[];
  const seededChannelJids = Array.from(
    new Set(
      existing
        .filter((row) => row.type === 'channel')
        .map((row) => normalizeChannelJid(String(row.phone_number || '').trim()))
        .filter(Boolean)
    )
  );

  const groupsRaw = await (whatsapp.getGroups?.() || []);
  const channelsWithDiagnostics =
    typeof whatsapp.getChannelsWithDiagnostics === 'function'
      ? await whatsapp.getChannelsWithDiagnostics(seededChannelJids)
      : null;
  const channelsRaw = channelsWithDiagnostics?.channels || (await (whatsapp.getChannels?.(seededChannelJids) || []));
  const includeStatus = options?.includeStatus !== false;
  const strict = options?.strict !== false;

  const candidates: SyncCandidate[] = [];
  const usedJids = new Set<string>();

  for (const group of groupsRaw) {
    const jid = String(group?.jid || '').trim();
    if (!jid || usedJids.has(jid)) continue;
    usedJids.add(jid);
    candidates.push({
      name: normalizeGroupName(group?.name, jid),
      phone_number: jid,
      type: 'group',
      active: true,
      notes: Number.isFinite(group?.size) ? `${Number(group?.size || 0)} members` : null
    });
  }

  for (const channel of channelsRaw) {
    const jid = normalizeChannelJid(String(channel?.jid || '').trim());
    if (!jid || usedJids.has(jid)) continue;
    const friendlyName = buildFriendlyChannelName(String(channel?.name || ''), jid);
    if (!friendlyName) continue;
    usedJids.add(jid);
    candidates.push({
      name: friendlyName,
      phone_number: jid,
      type: 'channel',
      active: true,
      notes: Number.isFinite(channel?.subscribers) ? `${Number(channel?.subscribers || 0)} subscribers` : null
    });
  }

  if (includeStatus && !usedJids.has('status@broadcast')) {
    candidates.push({
      name: 'My Status',
      phone_number: 'status@broadcast',
      type: 'status',
      active: true,
      notes: 'Posts to your WhatsApp Status'
    });
  }

  const canonicalByKey = new Map<string, ExistingTarget>();
  const duplicates: ExistingTarget[] = [];
  for (const row of existing) {
    const jid = String(row.phone_number || '').trim();
    if (!jid) continue;
    const key = buildTargetKey(row.type, jid);
    if (!canonicalByKey.has(key)) {
      canonicalByKey.set(key, row);
      continue;
    }
    duplicates.push(row);
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let deactivated = 0;

  for (const duplicate of duplicates) {
    if (!duplicate.active) continue;
    const { error: deactivateError } = await supabase
      .from('targets')
      .update({ active: false })
      .eq('id', duplicate.id);
    if (deactivateError) throw deactivateError;
    deactivated += 1;
  }

  // Clean up channel rows that are clearly placeholders or malformed JIDs.
  // These are usually stale artifacts from previous fake/manual entries.
  for (const row of Array.from(canonicalByKey.values())) {
    if (row.type !== 'channel' || row.active !== true) continue;
    const normalizedJid = normalizeChannelJid(String(row.phone_number || '').trim());
    const friendlyName = buildFriendlyChannelName(String(row.name || ''), normalizedJid);
    if (!normalizedJid || !normalizedJid.toLowerCase().includes('@newsletter') || !friendlyName) {
      const { error: deactivateError } = await supabase
        .from('targets')
        .update({ active: false })
        .eq('id', row.id);
      if (deactivateError) throw deactivateError;
      row.active = false;
      deactivated += 1;
    }
  }

  for (const candidate of candidates) {
    const candidateKey = buildTargetKey(candidate.type, candidate.phone_number);
    const current = canonicalByKey.get(candidateKey);
    if (!current) {
      const { error: insertError } = await supabase.from('targets').insert(candidate);
      if (insertError) throw insertError;
      inserted += 1;
      continue;
    }

    const patch: Partial<SyncCandidate> = {};
    if (current.name !== candidate.name) patch.name = candidate.name;
    if (current.type !== candidate.type) patch.type = candidate.type;
    if (current.active !== true) patch.active = true;
    if (String(current.notes || '') !== String(candidate.notes || '')) patch.notes = candidate.notes || null;

    if (!Object.keys(patch).length) {
      unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabase
      .from('targets')
      .update(patch)
      .eq('id', current.id);
    if (updateError) throw updateError;
    updated += 1;
  }

    if (strict) {
    const discoveredGroups = new Set(
      candidates
        .filter((candidate) => candidate.type === 'group')
        .map((candidate) => String(candidate.phone_number || '').trim())
        .filter(Boolean)
    );
    const discoveredChannels = new Set(
      candidates
        .filter((candidate) => candidate.type === 'channel')
        .map((candidate) => normalizeChannelJid(String(candidate.phone_number || '').trim()))
        .filter(Boolean)
    );
    const failedSeededChannels = new Set(
      (
        Array.isArray(
          (channelsWithDiagnostics?.diagnostics as { seeded?: { failedJids?: unknown[] } } | undefined)?.seeded
            ?.failedJids
        )
          ? (
              (channelsWithDiagnostics?.diagnostics as { seeded?: { failedJids?: unknown[] } } | undefined)?.seeded
                ?.failedJids || []
            )
          : []
      )
        .map((jid) => normalizeChannelJid(String(jid || '').trim()))
        .filter(Boolean)
    );
    const canStrictDeactivateChannels = discoveredChannels.size > 0;
    const discoveredStatus = new Set(
      candidates
        .filter((candidate) => candidate.type === 'status')
        .map((candidate) => String(candidate.phone_number || '').trim())
        .filter(Boolean)
    );

    const canonicalRows = Array.from(canonicalByKey.values());
    for (const row of canonicalRows) {
      if (!row.active) continue;
      const jid = String(row.phone_number || '').trim();
      if (!jid) continue;

      let shouldDeactivate = false;
      if (row.type === 'group') {
        shouldDeactivate = !discoveredGroups.has(jid);
      } else if (row.type === 'channel') {
        const normalizedChannelJid = normalizeChannelJid(jid);
        shouldDeactivate = canStrictDeactivateChannels
          ? !discoveredChannels.has(normalizedChannelJid)
          : failedSeededChannels.has(normalizedChannelJid);
      } else if (row.type === 'status' && includeStatus) {
        shouldDeactivate = !discoveredStatus.has(jid);
      }

      if (!shouldDeactivate) continue;

      const { error: deactivateError } = await supabase
        .from('targets')
        .update({ active: false })
        .eq('id', row.id);
      if (deactivateError) throw deactivateError;
      deactivated += 1;
    }
  }

  return {
    ok: true,
    discovered: {
      groups: groupsRaw.length,
      channels: channelsRaw.length,
      status: includeStatus ? 1 : 0
    },
    candidates: candidates.length,
    inserted,
    updated,
    unchanged,
    deactivated,
    diagnostics: channelsWithDiagnostics?.diagnostics || null
  };
};

const runTargetAutoSyncPass = async (
  whatsapp: WhatsAppSyncClient | null | undefined,
  options?: { silent?: boolean }
) => {
  if (!whatsapp || whatsapp.getStatus?.()?.status !== 'connected') {
    return { ok: false, skipped: true, reason: 'WhatsApp is not connected' };
  }
  if (syncInFlight) {
    return { ok: false, skipped: true, reason: 'Target sync already in progress' };
  }

  syncInFlight = true;
  try {
    const result = await syncTargetsFromWhatsApp(whatsapp, {
      includeStatus: true,
      skipIfDisconnected: true,
      strict: true
    });
    if (!options?.silent && result.ok && (result.inserted > 0 || result.updated > 0)) {
      logger.info(
        { inserted: result.inserted, updated: result.updated, unchanged: result.unchanged },
        'Auto-synced WhatsApp targets'
      );
    }
    return result;
  } catch (error) {
    if (!options?.silent) {
      logger.warn({ error: getErrorMessage(error) }, 'Automatic target sync failed');
    }
    return { ok: false, skipped: false, reason: getErrorMessage(error) };
  } finally {
    syncInFlight = false;
  }
};

const startTargetAutoSync = (whatsapp: WhatsAppSyncClient | null | undefined, intervalMs = DEFAULT_SYNC_INTERVAL_MS) => {
  stopTargetAutoSync();
  if (!whatsapp) return;

  const normalizedInterval = Math.max(Number(intervalMs) || DEFAULT_SYNC_INTERVAL_MS, 15_000);
  syncTimer = setInterval(() => {
    void runTargetAutoSyncPass(whatsapp, { silent: true });
  }, normalizedInterval);

  // Run once right away so newly connected groups/channels appear quickly.
  void runTargetAutoSyncPass(whatsapp, { silent: true });
};

const stopTargetAutoSync = () => {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
};

module.exports = {
  syncTargetsFromWhatsApp,
  runTargetAutoSyncPass,
  startTargetAutoSync,
  stopTargetAutoSync
};

export {};
