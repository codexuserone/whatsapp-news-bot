import type { SupabaseClient } from '@supabase/supabase-js';

const { getSupabaseClient } = require('../db/supabase');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');
const { normalizePhoneForType } = require('../utils/targetJid');

type ReceiptUpdate = {
  id?: unknown;
  status?: unknown;
  statusLabel?: unknown;
  remoteJid?: unknown;
  updatedAtMs?: unknown;
};

const toFiniteNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const chunk = <T>(items: T[], size: number) => {
  const safeSize = Math.max(Math.floor(size), 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    out.push(items.slice(i, i + safeSize));
  }
  return out;
};

const uniq = (items: string[]) => Array.from(new Set(items));

const isReceiptPromotableTargetType = (value: unknown) => {
  const type = String(value || '').trim().toLowerCase();
  return type === 'individual' || type === 'group';
};

const normalizeReceiptJidForType = (type: unknown, value: unknown) => {
  const targetType = String(type || '').trim().toLowerCase();
  const raw = String(value || '').trim();
  if (!raw) return '';
  return String(normalizePhoneForType(targetType, raw) || raw).trim().toLowerCase();
};

const receiptRemoteMatchesTarget = (remoteJid: unknown, targetPhoneNumber: unknown, targetType: unknown) => {
  const type = String(targetType || '').trim().toLowerCase();
  if (!isReceiptPromotableTargetType(type)) return false;
  const remote = normalizeReceiptJidForType(type, remoteJid);
  const target = normalizeReceiptJidForType(type, targetPhoneNumber);
  return Boolean(remote && target && remote === target);
};

const loadPromotableMessageLogIds = async (
  supabase: SupabaseClient,
  whatsappMessageIds: string[],
  allowedCurrentStatuses: string[],
  chunkSize: number,
  remoteJidByMessageId: Map<string, string>
) => {
  const promotableIds: string[] = [];

  for (const batch of chunk(whatsappMessageIds, chunkSize)) {
    const { data: logRows, error: logError } = await supabase
      .from('message_logs')
      .select('id,target_id,whatsapp_message_id')
      .in('whatsapp_message_id', batch)
      .in('status', allowedCurrentStatuses);
    if (logError) {
      throw logError;
    }

    const rows = Array.isArray(logRows) ? logRows : [];
    const targetIds = uniq(
      rows
        .map((row: { target_id?: unknown }) => String(row?.target_id || '').trim())
        .filter(Boolean)
    );
    if (!targetIds.length) {
      continue;
    }

    const { data: targetRows, error: targetError } = await supabase
      .from('targets')
      .select('id,type,phone_number')
      .in('id', targetIds);
    if (targetError) {
      throw targetError;
    }

    const targetById = new Map(
      (targetRows || []).map((row: { id?: unknown; type?: unknown; phone_number?: unknown }) => [
        String(row?.id || '').trim(),
        {
          type: String(row?.type || '').trim().toLowerCase(),
          phoneNumber: String(row?.phone_number || '').trim()
        }
      ])
    );

    for (const row of rows as Array<{ id?: unknown; target_id?: unknown; whatsapp_message_id?: unknown }>) {
      const id = String(row?.id || '').trim();
      const targetId = String(row?.target_id || '').trim();
      const whatsappMessageId = String(row?.whatsapp_message_id || '').trim();
      const target = targetById.get(targetId);
      const remoteJid = remoteJidByMessageId.get(whatsappMessageId);
      if (id && target && receiptRemoteMatchesTarget(remoteJid, target.phoneNumber, target.type)) {
        promotableIds.push(id);
      }
    }
  }

  return uniq(promotableIds);
};

const persistReceiptUpdates = async (
  updates: ReceiptUpdate[] = [],
  options?: { nowIso?: string; chunkSize?: number }
): Promise<{ ok: boolean; delivered: number; read: number; played: number; skipped: boolean; error?: string }> => {
  const supabase: SupabaseClient | null = getSupabaseClient();
  if (!supabase) {
    return { ok: false, delivered: 0, read: 0, played: 0, skipped: true, error: 'Database unavailable' };
  }

  const deliveredIds: string[] = [];
  const readIds: string[] = [];
  const playedIds: string[] = [];
  const remoteJidByMessageId = new Map<string, string>();

  for (const update of Array.isArray(updates) ? updates : []) {
    const id = String(update?.id || '').trim();
    if (!id) continue;
    const remoteJid = String(update?.remoteJid || '').trim();
    if (remoteJid) remoteJidByMessageId.set(id, remoteJid);
    const status = toFiniteNumberOrNull(update?.status);
    if (status === null) continue;

    if (status >= 3) deliveredIds.push(id);
    if (status >= 4) readIds.push(id);
    if (status >= 5) playedIds.push(id);
  }

  const delivered = uniq(deliveredIds);
  const read = uniq(readIds);
  const played = uniq(playedIds);
  if (!delivered.length && !read.length && !played.length) {
    return { ok: true, delivered: 0, read: 0, played: 0, skipped: true };
  }

  const nowIso = String(options?.nowIso || new Date().toISOString());
  const chunkSize = Math.min(Math.max(Number(options?.chunkSize || 150), 25), 500);

  const updateBatch = async (
    ids: string[],
    patch: Record<string, unknown>,
    allowedCurrentStatuses: string[]
  ): Promise<number> => {
    if (!ids.length) return 0;
    let updated = 0;
    const promotableIds = await loadPromotableMessageLogIds(
      supabase,
      ids,
      allowedCurrentStatuses,
      chunkSize,
      remoteJidByMessageId
    );
    if (!promotableIds.length) {
      return 0;
    }

    for (const batch of chunk(promotableIds, chunkSize)) {
      try {
        const { data, error } = await supabase
          .from('message_logs')
          .update(patch)
          .in('id', batch)
          .select('id');
        if (error) {
          throw error;
        }
        updated += Array.isArray(data) ? data.length : 0;
      } catch (error) {
        const message = getErrorMessage(error);
        const missingColumns =
          /column .*delivered_at.* does not exist|column .*read_at.* does not exist|column .*played_at.* does not exist/i.test(
            message
          );
        logger.warn(
          { error: message, missingColumns, patchKeys: Object.keys(patch), statuses: allowedCurrentStatuses },
          'Failed to persist WhatsApp receipt updates'
        );
        if (missingColumns) {
          // If the DB migration has not been applied yet, avoid spamming logs on every receipt tick.
          return updated;
        }
      }
    }
    return updated;
  };

  try {
    // Step 1: mark delivered when we were previously only "sent".
    const deliveredCount = await updateBatch(
      delivered,
      { status: 'delivered', delivered_at: nowIso },
      ['sent']
    );

    // Step 2: mark read (and stamp read_at) when we were sent/delivered.
    const readCount = await updateBatch(
      read,
      { status: 'read', read_at: nowIso },
      ['sent', 'delivered']
    );

    // Step 3: mark played (video playback) when we were sent/delivered/read.
    const playedCount = await updateBatch(
      played,
      { status: 'played', played_at: nowIso },
      ['sent', 'delivered', 'read']
    );

    return {
      ok: true,
      delivered: deliveredCount,
      read: readCount,
      played: playedCount,
      skipped: false
    };
  } catch (error) {
    return {
      ok: false,
      delivered: 0,
      read: 0,
      played: 0,
      skipped: false,
      error: getErrorMessage(error)
    };
  }
};

module.exports = {
  persistReceiptUpdates,
  __testUtils: {
    isReceiptPromotableTargetType,
    receiptRemoteMatchesTarget
  }
};
export {};

