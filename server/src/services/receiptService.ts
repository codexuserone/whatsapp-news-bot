import type { SupabaseClient } from '@supabase/supabase-js';

const { getSupabaseClient } = require('../db/supabase');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

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

  for (const update of Array.isArray(updates) ? updates : []) {
    const id = String(update?.id || '').trim();
    if (!id) continue;
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
    for (const batch of chunk(ids, chunkSize)) {
      try {
        const { data, error } = await supabase
          .from('message_logs')
          .update(patch)
          .in('whatsapp_message_id', batch)
          .in('status', allowedCurrentStatuses)
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
  persistReceiptUpdates
};
export {};

