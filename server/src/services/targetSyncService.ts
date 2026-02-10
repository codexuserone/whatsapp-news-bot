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
  diagnostics: SyncDiagnostics;
  reason?: string;
};

type WhatsAppSyncClient = {
  getStatus?: () => { status?: string };
  getGroups?: () => Promise<Array<{ jid?: string; name?: string; size?: number }>>;
  getChannels?: () => Promise<Array<{ jid?: string; name?: string; subscribers?: number }>>;
  getChannelsWithDiagnostics?: () => Promise<{
    channels: Array<{ jid?: string; name?: string; subscribers?: number }>;
    diagnostics?: Record<string, unknown>;
  }>;
};

const DEFAULT_SYNC_INTERVAL_MS = Math.max(
  Number(process.env.TARGET_AUTO_SYNC_INTERVAL_MS || 60_000),
  15_000
);

const normalizeChannelJid = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase().includes('@newsletter')) {
    return trimmed;
  }
  const cleaned = trimmed.replace(/[^0-9]/g, '');
  return cleaned ? `${cleaned}@newsletter` : trimmed;
};

const buildFriendlyChannelName = (name: string, jid: string) => {
  const normalizedJid = normalizeChannelJid(jid);
  const rawName = String(name || '').trim();
  if (rawName && rawName !== normalizedJid) return rawName;

  const [firstPart = ''] = String(normalizedJid || '').split('@');
  const localPart = firstPart
    .replace(/^true_/i, '')
    .replace(/_[A-F0-9]{8,}$/i, '')
    .trim();

  if (!localPart) return normalizedJid || 'Channel';
  if (/^\d{6,}$/.test(localPart)) return `Channel ${localPart.slice(-6)}`;
  return localPart.replace(/[_-]+/g, ' ').trim() || normalizedJid || 'Channel';
};

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight = false;

const syncTargetsFromWhatsApp = async (
  whatsapp: WhatsAppSyncClient | null | undefined,
  options?: { includeStatus?: boolean; skipIfDisconnected?: boolean }
): Promise<SyncTargetsResult> => {
  const disconnectedResult = {
    ok: false,
    reason: 'WhatsApp is not connected',
    discovered: { groups: 0, channels: 0, status: 0 },
    candidates: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
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

  const groupsRaw = await (whatsapp.getGroups?.() || []);
  const channelsWithDiagnostics =
    typeof whatsapp.getChannelsWithDiagnostics === 'function'
      ? await whatsapp.getChannelsWithDiagnostics()
      : null;
  const channelsRaw = channelsWithDiagnostics?.channels || (await (whatsapp.getChannels?.() || []));
  const includeStatus = options?.includeStatus !== false;

  const candidates: SyncCandidate[] = [];
  const usedJids = new Set<string>();

  for (const group of groupsRaw) {
    const jid = String(group?.jid || '').trim();
    if (!jid || usedJids.has(jid)) continue;
    usedJids.add(jid);
    candidates.push({
      name: String(group?.name || jid).trim() || jid,
      phone_number: jid,
      type: 'group',
      active: true,
      notes: Number.isFinite(group?.size) ? `${Number(group?.size || 0)} members` : null
    });
  }

  for (const channel of channelsRaw) {
    const jid = normalizeChannelJid(String(channel?.jid || '').trim());
    if (!jid || usedJids.has(jid)) continue;
    usedJids.add(jid);
    const friendlyName = buildFriendlyChannelName(String(channel?.name || ''), jid);
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

  const { data: existingRows, error: existingError } = await supabase.from('targets').select('*');
  if (existingError) throw existingError;

  const existing = (existingRows || []) as ExistingTarget[];
  const existingByJid = new Map<string, ExistingTarget>();
  for (const row of existing) {
    const jid = String(row.phone_number || '').trim();
    if (!jid) continue;
    existingByJid.set(jid, row);
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const candidate of candidates) {
    const current = existingByJid.get(candidate.phone_number);
    if (!current) {
      const { error: insertError } = await supabase.from('targets').insert(candidate);
      if (insertError) throw insertError;
      inserted += 1;
      continue;
    }

    const patch: Partial<SyncCandidate> = {};
    if (current.name !== candidate.name) patch.name = candidate.name;
    if (current.type !== candidate.type) patch.type = candidate.type;
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
    const result = await syncTargetsFromWhatsApp(whatsapp, { includeStatus: true, skipIfDisconnected: true });
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
