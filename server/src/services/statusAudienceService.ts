import type { SupabaseClient } from '@supabase/supabase-js';

const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');

type StatusAudienceSnapshot = {
  participantCount: number;
  sample: string[];
  refreshedAt: string | null;
  sources: {
    contactsCache: number;
    storeContacts: number;
    storeChats: number;
    groupMetadata: number;
    env: number;
    me: number;
    recentSuccessfulDirectRecipients: number;
  };
  warnings: string[];
};

type RefreshResult = StatusAudienceSnapshot & {
  recipients: string[];
};

type StatusAudienceClient = {
  getStatus?: () => { status?: string };
  getStatusParticipants?: () => string[] | Promise<string[]>;
  getStatusAudience?: (options?: { sampleSize?: number }) => Promise<{
    participantCount?: number;
    sample?: string[];
    sources?: Record<string, unknown>;
    warnings?: string[];
  } | null> | {
    participantCount?: number;
    sample?: string[];
    sources?: Record<string, unknown>;
    warnings?: string[];
  } | null;
};

const SESSION_ID = 'primary';
const DEFAULT_REFRESH_CRON = '*/15 * * * *';
const SUCCESSFUL_SEND_STATUSES = ['sent', 'delivered', 'read', 'played'];

let refreshJob: { stop?: () => void } | null = null;

const normalizeRecipientJid = (value: unknown) => String(value || '').trim().toLowerCase();

const emptySources = () => ({
  contactsCache: 0,
  storeContacts: 0,
  storeChats: 0,
  groupMetadata: 0,
  env: 0,
  me: 0,
  recentSuccessfulDirectRecipients: 0
});

const buildSample = (recipients: string[], sampleSize = 25) =>
  recipients.slice(0, Math.max(1, Math.min(Math.floor(sampleSize || 25), 200)));

const getRecentSuccessfulDirectRecipients = async (supabase: SupabaseClient): Promise<string[]> => {
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentLogs, error: logError } = await supabase
    .from('message_logs')
    .select('target_id')
    .in('status', SUCCESSFUL_SEND_STATUSES)
    .not('target_id', 'is', null)
    .gte('sent_at', sinceIso)
    .limit(2000);

  if (logError || !Array.isArray(recentLogs) || !recentLogs.length) {
    return [];
  }

  const targetIds = Array.from(
    new Set(
      recentLogs
        .map((row: { target_id?: string | null }) => String(row.target_id || '').trim())
        .filter(Boolean)
    )
  );

  if (!targetIds.length) return [];

  const { data: targets, error: targetError } = await supabase
    .from('targets')
    .select('phone_number,type')
    .in('id', targetIds)
    .eq('type', 'individual')
    .eq('active', true);

  if (targetError || !Array.isArray(targets) || !targets.length) {
    return [];
  }

  return Array.from(
    new Set(
      targets
        .map((row: { phone_number?: string | null }) => normalizeRecipientJid(row.phone_number))
        .filter(Boolean)
    )
  );
};

const getStoredRecipients = async (
  supabase: SupabaseClient,
  sampleSize = 25
): Promise<RefreshResult> => {
  const countQuery = await supabase
    .from('status_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', SESSION_ID);

  const participantCount = Number(countQuery.count || 0);
  const { data: sampleRows } = await supabase
    .from('status_recipients')
    .select('recipient_jid,refreshed_at,sources,warnings')
    .eq('session_id', SESSION_ID)
    .order('recipient_jid', { ascending: true })
    .limit(Math.max(1, Math.min(Math.floor(sampleSize || 25), 200)));

  const { data: allRows } = await supabase
    .from('status_recipients')
    .select('recipient_jid')
    .eq('session_id', SESSION_ID)
    .order('recipient_jid', { ascending: true });

  const firstRow = Array.isArray(sampleRows) && sampleRows.length ? sampleRows[0] as {
    refreshed_at?: string | null;
    sources?: Record<string, unknown>;
    warnings?: string[];
  } : null;

  return {
    participantCount,
    recipients: Array.isArray(allRows)
      ? allRows
        .map((row: { recipient_jid?: string | null }) => normalizeRecipientJid(row.recipient_jid))
        .filter(Boolean)
      : [],
    sample: Array.isArray(sampleRows)
      ? sampleRows
        .map((row: { recipient_jid?: string | null }) => normalizeRecipientJid(row.recipient_jid))
        .filter(Boolean)
      : [],
    refreshedAt: firstRow?.refreshed_at ? String(firstRow.refreshed_at) : null,
    sources: {
      ...emptySources(),
      ...((firstRow?.sources && typeof firstRow.sources === 'object') ? firstRow.sources : {})
    },
    warnings: Array.isArray(firstRow?.warnings) ? firstRow!.warnings : []
  };
};

const refreshStatusRecipients = async (
  whatsappClient?: StatusAudienceClient | null,
  options?: { sampleSize?: number }
): Promise<RefreshResult> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return {
      participantCount: 0,
      recipients: [],
      sample: [],
      refreshedAt: null,
      sources: emptySources(),
      warnings: ['Database not available']
    };
  }

  const connectionStatus = String(whatsappClient?.getStatus?.()?.status || '').trim().toLowerCase();
  if (!whatsappClient || connectionStatus !== 'connected') {
    const stored = await getStoredRecipients(supabase, options?.sampleSize);
    const warnings = [...stored.warnings];
    warnings.push('WhatsApp is not connected, using the last stored status audience snapshot.');
    return { ...stored, warnings };
  }

  const audienceOptions = Number.isFinite(options?.sampleSize)
    ? { sampleSize: Number(options?.sampleSize) }
    : undefined;
  const [participantsRaw, audienceRaw, recentDirectRecipients] = await Promise.all([
    Promise.resolve(whatsappClient.getStatusParticipants?.() || []),
    Promise.resolve(whatsappClient.getStatusAudience?.(audienceOptions) || null),
    getRecentSuccessfulDirectRecipients(supabase)
  ]);

  const participants = Array.from(
    new Set(
      [
        ...(Array.isArray(participantsRaw) ? participantsRaw : []),
        ...recentDirectRecipients
      ]
        .map((value) => normalizeRecipientJid(value))
        .filter(Boolean)
    )
  ).sort();

  const refreshedAt = new Date().toISOString();
  const baseSources =
    audienceRaw && typeof audienceRaw === 'object' && audienceRaw.sources && typeof audienceRaw.sources === 'object'
      ? audienceRaw.sources as Record<string, unknown>
      : {};
  const warnings = Array.isArray(audienceRaw?.warnings) ? audienceRaw!.warnings.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const sources = {
    ...emptySources(),
    ...baseSources,
    recentSuccessfulDirectRecipients: recentDirectRecipients.length
  };

  const upsertRows = participants.map((recipientJid) => ({
    session_id: SESSION_ID,
    recipient_jid: recipientJid,
    display_name: null,
    source_tags: recipientJid && recentDirectRecipients.includes(recipientJid) ? ['recent_success'] : [],
    sources,
    warnings,
    refreshed_at: refreshedAt
  }));

  if (upsertRows.length) {
    const { error: upsertError } = await supabase
      .from('status_recipients')
      .upsert(upsertRows, { onConflict: 'session_id,recipient_jid' });
    if (upsertError) {
      logger.warn({ error: upsertError }, 'Failed to upsert status recipients snapshot');
    }
  }

  if (participants.length) {
    const { error: deleteError } = await supabase
      .from('status_recipients')
      .delete()
      .eq('session_id', SESSION_ID)
      .lt('refreshed_at', refreshedAt);
    if (deleteError) {
      logger.warn({ error: deleteError }, 'Failed to prune stale status recipients');
    }
  } else {
    const { error: clearError } = await supabase
      .from('status_recipients')
      .delete()
      .eq('session_id', SESSION_ID);
    if (clearError) {
      logger.warn({ error: clearError }, 'Failed to clear empty status recipients snapshot');
    }
  }

  return {
    participantCount: participants.length,
    recipients: participants,
    sample: buildSample(participants, options?.sampleSize),
    refreshedAt,
    sources,
    warnings: participants.length ? warnings : [...warnings, 'No status recipients resolved from the current audience sources.']
  };
};

const ensureFreshStatusRecipients = async (
  whatsappClient?: StatusAudienceClient | null,
  options?: { maxAgeMinutes?: number; sampleSize?: number }
): Promise<RefreshResult> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return refreshStatusRecipients(whatsappClient, options);
  }

  const stored = await getStoredRecipients(supabase, options?.sampleSize);
  const maxAgeMinutes = Math.max(1, Math.min(Math.floor(Number(options?.maxAgeMinutes || 10)), 120));
  const refreshedAtMs = stored.refreshedAt ? Date.parse(stored.refreshedAt) : Number.NaN;
  const isFresh = Number.isFinite(refreshedAtMs) && Date.now() - refreshedAtMs <= maxAgeMinutes * 60 * 1000;

  if (stored.participantCount > 0 && isFresh) {
    return stored;
  }

  return refreshStatusRecipients(whatsappClient, options);
};

const getStatusRecipientSnapshot = async (options?: { sampleSize?: number }): Promise<StatusAudienceSnapshot> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return {
      participantCount: 0,
      sample: [],
      refreshedAt: null,
      sources: emptySources(),
      warnings: ['Database not available']
    };
  }

  const stored = await getStoredRecipients(supabase, options?.sampleSize);
  return {
    participantCount: stored.participantCount,
    sample: stored.sample,
    refreshedAt: stored.refreshedAt,
    sources: stored.sources,
    warnings: stored.warnings
  };
};

const scheduleStatusAudienceRefresh = (whatsappClient?: StatusAudienceClient | null) => {
  if (refreshJob) return refreshJob;
  refreshJob = cron.schedule(
    DEFAULT_REFRESH_CRON,
    async () => {
      try {
        await refreshStatusRecipients(whatsappClient, { sampleSize: 25 });
      } catch (error) {
        logger.warn({ error: getErrorMessage(error) }, 'Scheduled status audience refresh failed');
      }
    },
    { timezone: 'UTC' }
  );
  return refreshJob;
};

const stopStatusAudienceRefresh = () => {
  if (refreshJob && typeof refreshJob.stop === 'function') {
    refreshJob.stop();
  }
  refreshJob = null;
};

module.exports = {
  ensureFreshStatusRecipients,
  getStatusRecipientSnapshot,
  refreshStatusRecipients,
  scheduleStatusAudienceRefresh,
  stopStatusAudienceRefresh
};

export {};
