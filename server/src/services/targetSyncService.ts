const { getSupabaseClient } = require('../db/supabase');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

type WhatsAppGroup = {
  id?: string;
  jid?: string;
  name?: string;
  size?: number;
};

type WhatsAppChannel = {
  id?: string;
  jid?: string;
  name?: string;
  subscribers?: number;
  viewerRole?: string | null;
  canSend?: boolean | null;
};

type WhatsAppClient = {
  getStatus?: () => {
    status?: string;
    lease?: {
      supported?: boolean;
      held?: boolean;
    };
  };
  getGroups?: () => Promise<WhatsAppGroup[]>;
  getChannels?: () => Promise<WhatsAppChannel[]>;
  getChannelsWithDiagnostics?: () => Promise<{ channels: WhatsAppChannel[] }>;
};

const AUTO_SYNC_INTERVAL_MS = 120000;
const MIN_SYNC_GAP_MS = 30000;

let syncInFlight = false;
let lastSyncAtMs = 0;
let autoSyncTimer: NodeJS.Timeout | null = null;

const normalizeGroupJid = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.endsWith('@g.us')) return raw;
  const cleaned = raw.replace(/[^0-9-]/g, '');
  return cleaned ? `${cleaned}@g.us` : '';
};

const normalizeChannelJid = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.endsWith('@newsletter')) {
    const cleaned = raw.slice(0, -'@newsletter'.length).replace(/[^0-9]/g, '');
    return cleaned ? `${cleaned}@newsletter` : '';
  }
  const cleaned = raw.replace(/[^0-9]/g, '');
  return cleaned ? `${cleaned}@newsletter` : '';
};

const shouldSyncForStatus = (status: { status?: string; lease?: { supported?: boolean; held?: boolean } } | null | undefined) => {
  if (!status || status.status !== 'connected') return false;
  const leaseSupported = Boolean(status.lease?.supported);
  const leaseHeld = Boolean(status.lease?.held);
  if (leaseSupported && !leaseHeld) return false;
  return true;
};

const syncWhatsAppTargets = async (
  whatsappClient?: WhatsAppClient,
  options?: { force?: boolean; reason?: string }
) => {
  const nowMs = Date.now();
  if (syncInFlight) {
    return { ok: false, skipped: true, reason: 'in_flight' };
  }

  if (!options?.force && nowMs - lastSyncAtMs < MIN_SYNC_GAP_MS) {
    return { ok: false, skipped: true, reason: 'throttled' };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, skipped: true, reason: 'db_unavailable' };
  }

  const status = whatsappClient?.getStatus?.();
  if (!shouldSyncForStatus(status)) {
    return { ok: false, skipped: true, reason: `whatsapp_${status?.status || 'unavailable'}` };
  }

  syncInFlight = true;
  try {
    const groups = typeof whatsappClient?.getGroups === 'function' ? await whatsappClient.getGroups() : [];

    let channels: WhatsAppChannel[] = [];
    if (typeof whatsappClient?.getChannelsWithDiagnostics === 'function') {
      const diagnostics = await whatsappClient.getChannelsWithDiagnostics();
      channels = Array.isArray(diagnostics?.channels) ? diagnostics.channels : [];
    } else if (typeof whatsappClient?.getChannels === 'function') {
      channels = await whatsappClient.getChannels();
    }

    const discoveredGroups = (groups || [])
      .map((group) => {
        const jid = normalizeGroupJid(group?.jid || group?.id);
        if (!jid) return null;
        return {
          type: 'group' as const,
          jid,
          name: String(group?.name || jid),
          notes: Number(group?.size || 0) > 0 ? `${Number(group?.size)} members` : null
        };
      })
      .filter((row): row is { type: 'group'; jid: string; name: string; notes: string | null } => Boolean(row));

    const discoveredChannels = (channels || [])
      .filter((channel) => channel?.canSend !== false)
      .map((channel) => {
        const jid = normalizeChannelJid(channel?.jid || channel?.id);
        if (!jid) return null;
        const role = String(channel?.viewerRole || '').trim();
        const subscribers = Number(channel?.subscribers || 0);
        const notesParts: string[] = [];
        if (subscribers > 0) notesParts.push(`${Math.round(subscribers)} subscribers`);
        if (role) notesParts.push(`role ${role}`);
        return {
          type: 'channel' as const,
          jid,
          name: String(channel?.name || jid),
          notes: notesParts.length ? notesParts.join(' · ') : null
        };
      })
      .filter((row): row is { type: 'channel'; jid: string; name: string; notes: string | null } => Boolean(row));

    const discovered = [...discoveredGroups, ...discoveredChannels];
    if (!discovered.length) {
      lastSyncAtMs = Date.now();
      return { ok: true, inserted: 0, updated: 0, discovered: 0, reason: options?.reason || 'auto' };
    }

    const { data: existingRows, error: existingError } = await supabase
      .from('targets')
      .select('id,type,phone_number,name,notes,active')
      .in('type', ['group', 'channel']);

    if (existingError) throw existingError;

    const existingByKey = new Map<string, Record<string, unknown>>();
    for (const row of (existingRows || []) as Array<Record<string, unknown>>) {
      const rowType = String(row.type || '').trim();
      if (rowType !== 'group' && rowType !== 'channel') continue;
      const rowJid =
        rowType === 'group'
          ? normalizeGroupJid(row.phone_number)
          : normalizeChannelJid(row.phone_number);
      if (!rowJid) continue;
      existingByKey.set(`${rowType}:${rowJid}`, row);
    }

    const inserts: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];

    for (const row of discovered) {
      const key = `${row.type}:${row.jid}`;
      const existing = existingByKey.get(key);
      if (!existing) {
        inserts.push({
          name: row.name,
          phone_number: row.jid,
          type: row.type,
          active: true,
          notes: row.notes
        });
        continue;
      }

      const existingId = String(existing.id || '').trim();
      if (!existingId) continue;

      const payload: Record<string, unknown> = {};
      if (String(existing.name || '') !== row.name) {
        payload.name = row.name;
      }
      if (String(existing.notes || '') !== String(row.notes || '')) {
        payload.notes = row.notes;
      }

      if (Object.keys(payload).length > 0) {
        updates.push({ id: existingId, payload });
      }
    }

    if (inserts.length > 0) {
      const { error: insertError } = await supabase.from('targets').insert(inserts);
      if (insertError) throw insertError;
    }

    for (const item of updates) {
      const { error: updateError } = await supabase
        .from('targets')
        .update(item.payload)
        .eq('id', item.id);
      if (updateError) throw updateError;
    }

    lastSyncAtMs = Date.now();
    return {
      ok: true,
      inserted: inserts.length,
      updated: updates.length,
      discovered: discovered.length,
      reason: options?.reason || 'auto'
    };
  } catch (error) {
    logger.warn(
      { reason: options?.reason || 'auto', error: getErrorMessage(error) },
      'Automatic WhatsApp target sync failed'
    );
    return { ok: false, skipped: true, reason: 'error', error: getErrorMessage(error) };
  } finally {
    syncInFlight = false;
  }
};

const stopTargetAutoSync = () => {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
};

const startTargetAutoSync = (whatsappClient?: WhatsAppClient) => {
  stopTargetAutoSync();
  if (process.env.DISABLE_TARGET_AUTO_SYNC === 'true') {
    logger.warn('Automatic target sync disabled via DISABLE_TARGET_AUTO_SYNC');
    return;
  }

  void syncWhatsAppTargets(whatsappClient, { force: true, reason: 'startup' });
  autoSyncTimer = setInterval(() => {
    void syncWhatsAppTargets(whatsappClient, { reason: 'interval' });
  }, AUTO_SYNC_INTERVAL_MS);
};

module.exports = {
  startTargetAutoSync,
  stopTargetAutoSync,
  syncWhatsAppTargets
};
