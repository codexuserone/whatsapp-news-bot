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
    lidMappings: number;
    activeIndividualTargets: number;
    recentSuccessfulDirectRecipients: number;
  };
  warnings: string[];
  stale?: boolean;
};

type StatusAudienceSources = StatusAudienceSnapshot['sources'];

type RefreshResult = StatusAudienceSnapshot & {
  recipients: string[];
};

type StatusAudienceClient = {
  getStatus?: () => { status?: string };
  getStatusParticipants?: () => string[] | Promise<string[]>;
  getStatusAudience?: (options?: { sampleSize?: number }) => Promise<{
    participantCount?: number;
    sample?: string[];
    selfJid?: string | null;
    sources?: Record<string, unknown>;
    warnings?: string[];
  } | null> | {
    participantCount?: number;
    sample?: string[];
    selfJid?: string | null;
    sources?: Record<string, unknown>;
    warnings?: string[];
  } | null;
};

const SESSION_ID = 'primary';
const DEFAULT_REFRESH_CRON = '*/15 * * * *';
const SUCCESSFUL_SEND_STATUSES = ['sent', 'delivered', 'read', 'played'];
const MAX_PRESERVED_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PRESERVED_SNAPSHOT_PARTICIPANTS = 25;
const MAX_COLD_START_PARTICIPANTS = 10;
const STATUS_RECIPIENTS_UPSERT_CHUNK_SIZE = 200;
const USE_RECENT_DIRECT_RECIPIENTS =
  String(process.env.WHATSAPP_STATUS_USE_RECENT_DIRECT_RECIPIENTS || '').trim().toLowerCase() === 'true';

let refreshJob: { stop?: () => void } | null = null;

const normalizeRecipientJid = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'status@broadcast') return '';
  if (raw.endsWith('@g.us') || raw.includes('@newsletter')) return '';

  const splitUser = (input: string) => String(input.split('@')[0] || '').split(':')[0] || '';

  if (raw.endsWith('@lid')) {
    const user = splitUser(raw).replace(/[^a-z0-9._-]/g, '');
    return user ? `${user}@lid` : '';
  }

  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@c.us')) {
    const digits = splitUser(raw).replace(/[^0-9]/g, '');
    return digits.length >= 6 ? `${digits}@s.whatsapp.net` : '';
  }

  if (raw.includes('@')) return '';

  const digits = raw.replace(/[^0-9]/g, '');
  return digits.length >= 6 ? `${digits}@s.whatsapp.net` : '';
};

const emptySources = () => ({
  contactsCache: 0,
  storeContacts: 0,
  storeChats: 0,
  groupMetadata: 0,
  env: 0,
  me: 0,
  lidMappings: 0,
  activeIndividualTargets: 0,
  recentSuccessfulDirectRecipients: 0
});

const uniqueStrings = (values: unknown[]) =>
  Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

const mergeSources = (...sourceSets: Array<Partial<StatusAudienceSources> | null | undefined>): StatusAudienceSources => {
  const merged = emptySources();
  for (const sourceSet of sourceSets) {
    if (!sourceSet || typeof sourceSet !== 'object') continue;
    for (const key of Object.keys(merged) as Array<keyof StatusAudienceSources>) {
      const value = Number(sourceSet[key]);
      if (!Number.isFinite(value)) continue;
      merged[key] = Math.max(merged[key], Math.max(0, Math.floor(value)));
    }
  }
  return merged;
};

const getTrustedAudienceSignalCount = (sources: Partial<StatusAudienceSources> | null | undefined) =>
  Math.max(0, Math.floor(Number(sources?.contactsCache || 0))) +
  Math.max(0, Math.floor(Number(sources?.storeContacts || 0))) +
  Math.max(0, Math.floor(Number(sources?.storeChats || 0))) +
  Math.max(0, Math.floor(Number(sources?.env || 0))) +
  Math.max(0, Math.floor(Number(sources?.lidMappings || 0))) +
  Math.max(0, Math.floor(Number(sources?.activeIndividualTargets || 0))) +
  Math.max(0, Math.floor(Number(sources?.recentSuccessfulDirectRecipients || 0)));

const getExplicitAudienceSignalCount = (sources: Partial<StatusAudienceSources> | null | undefined) =>
  Math.max(0, Math.floor(Number(sources?.env || 0))) +
  Math.max(0, Math.floor(Number(sources?.activeIndividualTargets || 0))) +
  Math.max(0, Math.floor(Number(sources?.recentSuccessfulDirectRecipients || 0)));

const ALLOW_UNMAPPED_LID_STATUS_AUDIENCE =
  String(process.env.WHATSAPP_STATUS_ALLOW_UNMAPPED_LID_AUDIENCE || '').trim().toLowerCase() === 'true';

const shouldDropImplicitLidRecipients = (sources: Partial<StatusAudienceSources> | null | undefined) => {
  if (ALLOW_UNMAPPED_LID_STATUS_AUDIENCE) return false;
  const groupSignals = Math.max(0, Math.floor(Number(sources?.groupMetadata || 0)));
  if (groupSignals <= 0) return false;
  return getExplicitAudienceSignalCount(sources) <= 0;
};

const isGroupMetadataOnlySnapshot = (snapshot: RefreshResult) =>
  Math.max(0, Math.floor(Number(snapshot.sources?.groupMetadata || 0))) > 0 &&
  getTrustedAudienceSignalCount(snapshot.sources) === 0;

const isGroupMetadataDominatedSnapshot = (snapshot: RefreshResult) => {
  const groupSignals = Math.max(0, Math.floor(Number(snapshot.sources?.groupMetadata || 0)));
  const trustedSignals = getTrustedAudienceSignalCount(snapshot.sources);
  return groupSignals > 0 && groupSignals > Math.max(trustedSignals * 10, 25);
};

const isLidHeavySnapshot = (snapshot: RefreshResult) => {
  if (!snapshot.recipients.length) return false;
  const lidCount = snapshot.recipients.filter((recipient) => recipient.endsWith('@lid')).length;
  return lidCount / snapshot.recipients.length >= 0.9;
};

const shouldTrustStoredSnapshot = (snapshot: RefreshResult) => {
  if (snapshot.participantCount <= 0) return false;
  if (getTrustedAudienceSignalCount(snapshot.sources) <= 0) return false;
  if (snapshot.participantCount <= 1 && getExplicitAudienceSignalCount(snapshot.sources) <= 0) return false;
  if (isGroupMetadataOnlySnapshot(snapshot)) return false;
  if (isGroupMetadataDominatedSnapshot(snapshot) && isLidHeavySnapshot(snapshot)) return false;
  if (isLidHeavySnapshot(snapshot) && getTrustedAudienceSignalCount(snapshot.sources) === 0) return false;
  return true;
};

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

const getActiveIndividualTargetRecipients = async (supabase: SupabaseClient): Promise<string[]> => {
  const { data: targets, error: targetError } = await supabase
    .from('targets')
    .select('phone_number,type,active')
    .eq('type', 'individual')
    .eq('active', true)
    .limit(2000);

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

const shouldPreserveStoredSnapshot = (
  stored: RefreshResult,
  freshParticipantCount: number,
  freshSources: Partial<StatusAudienceSources> | null | undefined
) => {
  if (!stored.recipients.length) return false;
  if (!shouldTrustStoredSnapshot(stored)) return false;
  if (
    stored.participantCount < MIN_PRESERVED_SNAPSHOT_PARTICIPANTS &&
    getTrustedAudienceSignalCount(stored.sources) <= 0
  ) {
    return false;
  }
  const storedRefreshedAtMs = stored.refreshedAt ? Date.parse(stored.refreshedAt) : Number.NaN;
  if (!Number.isFinite(storedRefreshedAtMs)) return false;
  const snapshotAgeMs = Date.now() - storedRefreshedAtMs;
  if (snapshotAgeMs < 0 || snapshotAgeMs > MAX_PRESERVED_SNAPSHOT_AGE_MS) return false;

  const warmSignals = getTrustedAudienceSignalCount(freshSources);
  if (warmSignals > 0) return false;

  const maxColdStartParticipants = Math.max(
    MAX_COLD_START_PARTICIPANTS,
    Math.floor(stored.participantCount * 0.1)
  );

  return freshParticipantCount <= maxColdStartParticipants;
};

const persistStatusRecipientsSnapshot = async (
  supabase: SupabaseClient,
  recipients: string[],
  options: {
    refreshedAt: string;
    sources: StatusAudienceSources;
    warnings: string[];
    recentDirectRecipients?: string[];
    preservedFromStored?: boolean;
  }
) => {
  const normalizedRecipients = Array.from(
    new Set(recipients.map((recipient) => normalizeRecipientJid(recipient)).filter(Boolean))
  ).sort();
  const recentDirectRecipientSet = new Set(
    Array.isArray(options.recentDirectRecipients)
      ? options.recentDirectRecipients.map((recipient) => normalizeRecipientJid(recipient)).filter(Boolean)
      : []
  );

  const upsertRows = normalizedRecipients.map((recipientJid) => ({
    session_id: SESSION_ID,
    recipient_jid: recipientJid,
    display_name: null,
    source_tags: uniqueStrings([
      options.preservedFromStored ? 'preserved_snapshot' : '',
      recentDirectRecipientSet.has(recipientJid) ? 'recent_success' : ''
    ]),
    sources: options.sources,
    warnings: options.warnings,
    refreshed_at: options.refreshedAt
  }));

  let persistedAllChunks = true;

  if (upsertRows.length) {
    for (let index = 0; index < upsertRows.length; index += STATUS_RECIPIENTS_UPSERT_CHUNK_SIZE) {
      const batch = upsertRows.slice(index, index + STATUS_RECIPIENTS_UPSERT_CHUNK_SIZE);
      const { error: upsertError } = await supabase
        .from('status_recipients')
        .upsert(batch, { onConflict: 'session_id,recipient_jid' });
      if (upsertError) {
        persistedAllChunks = false;
        logger.warn(
          {
            error: upsertError,
            batchStart: index,
            batchSize: batch.length,
            totalRecipients: upsertRows.length
          },
          'Failed to upsert status recipients snapshot batch'
        );
        break;
      }
    }
  }

  if (!persistedAllChunks) {
    return;
  }

  if (normalizedRecipients.length) {
    const { error: deleteError } = await supabase
      .from('status_recipients')
      .delete()
      .eq('session_id', SESSION_ID)
      .lt('refreshed_at', options.refreshedAt);
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
};

const getStoredRecipients = async (
  supabase: SupabaseClient,
  sampleSize = 25,
  options?: { includeRecipients?: boolean }
): Promise<RefreshResult> => {
  const includeRecipients = options?.includeRecipients !== false;
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

  let allRows: Array<{ recipient_jid?: string | null }> = [];
  if (includeRecipients) {
    const allRowsResult = await supabase
      .from('status_recipients')
      .select('recipient_jid')
      .eq('session_id', SESSION_ID)
      .order('recipient_jid', { ascending: true });
    allRows = Array.isArray(allRowsResult.data) ? allRowsResult.data : [];
  }

  const firstRow = Array.isArray(sampleRows) && sampleRows.length ? sampleRows[0] as {
    refreshed_at?: string | null;
    sources?: Record<string, unknown>;
    warnings?: string[];
  } : null;

  return {
    participantCount,
    recipients: allRows
      .map((row: { recipient_jid?: string | null }) => normalizeRecipientJid(row.recipient_jid))
      .filter(Boolean),
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

  const stored = await getStoredRecipients(supabase, options?.sampleSize, { includeRecipients: true });

  const connectionStatus = String(whatsappClient?.getStatus?.()?.status || '').trim().toLowerCase();
  if (!whatsappClient || connectionStatus !== 'connected') {
    const warnings = [...stored.warnings];
    warnings.push('WhatsApp is not connected, using the last stored status audience snapshot.');
    return { ...stored, warnings };
  }

  const audienceOptions = Number.isFinite(options?.sampleSize)
    ? { sampleSize: Number(options?.sampleSize) }
    : undefined;
  const [participantsRaw, audienceRaw, recentDirectRecipients, activeIndividualTargetRecipients] = await Promise.all([
    Promise.resolve(whatsappClient.getStatusParticipants?.() || []),
    Promise.resolve(whatsappClient.getStatusAudience?.(audienceOptions) || null),
    USE_RECENT_DIRECT_RECIPIENTS ? getRecentSuccessfulDirectRecipients(supabase) : Promise.resolve([]),
    getActiveIndividualTargetRecipients(supabase)
  ]);
  const selfJid = normalizeRecipientJid(
    audienceRaw && typeof audienceRaw === 'object'
      ? (audienceRaw as { selfJid?: string | null }).selfJid
      : null
  );

  let participants = Array.from(
    new Set(
      [
        ...(Array.isArray(participantsRaw) ? participantsRaw : []),
        ...activeIndividualTargetRecipients,
        ...recentDirectRecipients
      ]
        .map((value) => normalizeRecipientJid(value))
        .filter((value) => !selfJid || value !== selfJid)
        .filter(Boolean)
    )
  ).sort();

  const refreshedAt = new Date().toISOString();
  const baseSources =
    audienceRaw && typeof audienceRaw === 'object' && audienceRaw.sources && typeof audienceRaw.sources === 'object'
      ? audienceRaw.sources as Record<string, unknown>
      : {};
  const warnings = Array.isArray(audienceRaw?.warnings) ? audienceRaw!.warnings.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const sources = mergeSources(baseSources as Partial<StatusAudienceSources>, {
    activeIndividualTargets: activeIndividualTargetRecipients.filter((recipient) => !selfJid || recipient !== selfJid).length,
    recentSuccessfulDirectRecipients: recentDirectRecipients.length
  });
  if (activeIndividualTargetRecipients.length && !warnings.some((warning) => warning.includes('active private targets'))) {
    warnings.push('Status audience includes active private targets saved in this app.');
  }
  if (!USE_RECENT_DIRECT_RECIPIENTS && recentDirectRecipients.length) {
    warnings.push('Recent direct recipients are ignored unless WHATSAPP_STATUS_USE_RECENT_DIRECT_RECIPIENTS=true.');
  }
  if (shouldDropImplicitLidRecipients(sources)) {
    const beforeDrop = participants.length;
    participants = participants.filter((recipient) => !recipient.endsWith('@lid'));
    const dropped = beforeDrop - participants.length;
    if (dropped > 0) {
      warnings.push(
        `Dropped ${dropped} implicit group-participant LID Status recipients because no phone-number mappings or explicit private recipients were available.`
      );
    }
  }

  if (shouldPreserveStoredSnapshot(stored, participants.length, sources)) {
    const preservedRecipients = Array.from(new Set([...stored.recipients, ...participants])).sort();
    const preservedSources = mergeSources(stored.sources, sources);
    const preservedWarnings = uniqueStrings([
      ...stored.warnings,
      ...warnings,
      `Preserved the previous status audience snapshot because the current WhatsApp audience is still warming up (${participants.length} resolved, ${stored.participantCount} stored).`
    ]);

    await persistStatusRecipientsSnapshot(supabase, preservedRecipients, {
      refreshedAt,
      sources: preservedSources,
      warnings: preservedWarnings,
      recentDirectRecipients,
      preservedFromStored: true
    });

    return {
      participantCount: preservedRecipients.length,
      recipients: preservedRecipients,
      sample: buildSample(preservedRecipients, options?.sampleSize),
      refreshedAt,
      sources: preservedSources,
      warnings: preservedWarnings
    };
  }

  await persistStatusRecipientsSnapshot(supabase, participants, {
    refreshedAt,
    sources,
    warnings,
    recentDirectRecipients
  });

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

  const stored = await getStoredRecipients(supabase, options?.sampleSize, { includeRecipients: true });
  const maxAgeMinutes = Math.max(1, Math.min(Math.floor(Number(options?.maxAgeMinutes || 10)), 120));
  const refreshedAtMs = stored.refreshedAt ? Date.parse(stored.refreshedAt) : Number.NaN;
  const isFresh = Number.isFinite(refreshedAtMs) && Date.now() - refreshedAtMs <= maxAgeMinutes * 60 * 1000;

  if (isFresh && shouldTrustStoredSnapshot(stored)) {
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

  const stored = await getStoredRecipients(supabase, options?.sampleSize, { includeRecipients: false });
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
