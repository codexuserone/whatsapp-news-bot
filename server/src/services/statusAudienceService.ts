import type { SupabaseClient } from '@supabase/supabase-js';

const cron = require('node-cron');
const { getSupabaseClient } = require('../db/supabase');
const settingsService = require('./settingsService');
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

// In-memory cache of the last successful audience snapshot.
// Survives Supabase 522/timeout errors so status sends can continue.
let lastGoodSnapshot: RefreshResult | null = null;
let lastGoodSnapshotAtMs = 0;
const MAX_IN_MEMORY_SNAPSHOT_AGE_MS = 60 * 60 * 1000; // 60 minutes

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

const isTruthyEnvFlag = (value: unknown) =>
  ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const isGroupMetadataStatusAudienceEnabled = () =>
  isTruthyEnvFlag(process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS) &&
  ['unsafe', 'force'].includes(
    String(process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE || '')
      .trim()
      .toLowerCase()
  );

const getExplicitEnvAudienceRecipients = () =>
  Array.from(
    new Set(
      String(process.env.WHATSAPP_STATUS_AUDIENCE_JIDS || process.env.WHATSAPP_STATUS_JID_LIST || '')
        .split(',')
        .map((value) => normalizeRecipientJid(value))
        .filter(Boolean)
    )
  ).sort();

const getExplicitEnvAudienceMode = () =>
  String(process.env.WHATSAPP_STATUS_AUDIENCE_MODE || '')
    .trim()
    .toLowerCase();

const getConfiguredExplicitAudienceRecipients = async () => {
  const envRecipients = getExplicitEnvAudienceRecipients();
  const envMode = getExplicitEnvAudienceMode();
  if (envMode === 'explicit' && envRecipients.length) {
    return {
      recipients: envRecipients,
      source: 'env' as const
    };
  }

  try {
    const settings = await settingsService.getSettings();
    const mode = String(settings?.status_audience_mode || 'auto').trim().toLowerCase();
    if (mode !== 'explicit') {
      return { recipients: [], source: 'auto' as const };
    }

    const configuredRecipients = Array.from(
      new Set(
        String(settings?.status_audience_jids || '')
          .split(/[\n,]+/)
          .map((value) => normalizeRecipientJid(value))
          .filter(Boolean)
      )
    ).sort();

    return {
      recipients: configuredRecipients.length ? configuredRecipients : envRecipients,
      source: configuredRecipients.length ? ('settings' as const) : ('env' as const)
    };
  } catch (error) {
    logger.warn({ error: getErrorMessage(error) }, 'Failed to read Status audience settings');
    return envMode === 'explicit'
      ? { recipients: envRecipients, source: 'env' as const }
      : { recipients: [], source: 'auto' as const };
  }
};

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
  Math.max(0, Math.floor(Number(sources?.activeIndividualTargets || 0))) +
  Math.max(0, Math.floor(Number(sources?.recentSuccessfulDirectRecipients || 0))) +
  (isGroupMetadataStatusAudienceEnabled()
    ? Math.max(0, Math.floor(Number(sources?.groupMetadata || 0)))
    : 0);

const getDirectAudienceSignalCount = (sources: Partial<StatusAudienceSources> | null | undefined) =>
  Math.max(0, Math.floor(Number(sources?.contactsCache || 0))) +
  Math.max(0, Math.floor(Number(sources?.storeContacts || 0))) +
  Math.max(0, Math.floor(Number(sources?.storeChats || 0))) +
  Math.max(0, Math.floor(Number(sources?.env || 0))) +
  Math.max(0, Math.floor(Number(sources?.activeIndividualTargets || 0))) +
  Math.max(0, Math.floor(Number(sources?.recentSuccessfulDirectRecipients || 0)));

const getExplicitAudienceSignalCount = (sources: Partial<StatusAudienceSources> | null | undefined) =>
  Math.max(0, Math.floor(Number(sources?.env || 0))) +
  Math.max(0, Math.floor(Number(sources?.activeIndividualTargets || 0))) +
  Math.max(0, Math.floor(Number(sources?.recentSuccessfulDirectRecipients || 0)));

const getNonEnvTrustedAudienceSignalCount = (sources: Partial<StatusAudienceSources> | null | undefined) =>
  Math.max(0, getTrustedAudienceSignalCount(sources) - Math.max(0, Math.floor(Number(sources?.env || 0))));

const isEnvLimitedSnapshot = (snapshot: RefreshResult) =>
  Math.max(0, Math.floor(Number(snapshot.sources?.env || 0))) > 0 &&
  getNonEnvTrustedAudienceSignalCount(snapshot.sources) <= 0;

const ALLOW_UNMAPPED_LID_STATUS_AUDIENCE =
  String(process.env.WHATSAPP_STATUS_ALLOW_UNMAPPED_LID_AUDIENCE || '').trim().toLowerCase() === 'true';

const shouldDropImplicitLidRecipients = (sources: Partial<StatusAudienceSources> | null | undefined) => {
  if (ALLOW_UNMAPPED_LID_STATUS_AUDIENCE) return false;
  const groupSignals = Math.max(0, Math.floor(Number(sources?.groupMetadata || 0)));
  if (groupSignals <= 0) return false;
  return getExplicitAudienceSignalCount(sources) <= 0;
};

const cleanLidMappingWarningsForFinalAudience = (warnings: string[], recipients: string[]) => {
  const phoneCount = recipients.filter((recipient) => recipient.endsWith('@s.whatsapp.net')).length;
  const lidCount = recipients.filter((recipient) => recipient.endsWith('@lid')).length;
  if (!phoneCount || lidCount > 0) return warnings;
  return warnings.filter(
    (warning) =>
      !/LID recipients (?:but no Baileys phone-number mapping store|without phone-number mappings)/i.test(warning) &&
      !/Dropped \d+ implicit group-participant LID Status recipients/i.test(warning)
  );
};

const isGroupMetadataOnlySnapshot = (snapshot: RefreshResult) =>
  Math.max(0, Math.floor(Number(snapshot.sources?.groupMetadata || 0))) > 0 &&
  getDirectAudienceSignalCount(snapshot.sources) === 0;

const isGroupMetadataDominatedSnapshot = (snapshot: RefreshResult) => {
  const groupSignals = Math.max(0, Math.floor(Number(snapshot.sources?.groupMetadata || 0)));
  const directSignals = getDirectAudienceSignalCount(snapshot.sources);
  return groupSignals > 0 && groupSignals > Math.max(directSignals * 10, 25);
};

const isLidHeavySnapshot = (snapshot: RefreshResult) => {
  if (!snapshot.recipients.length) return false;
  const lidCount = snapshot.recipients.filter((recipient) => recipient.endsWith('@lid')).length;
  return lidCount / snapshot.recipients.length >= 0.9;
};

const shouldTrustStoredSnapshot = (
  snapshot: RefreshResult,
  options?: { allowEnvLimited?: boolean }
) => {
  if (snapshot.participantCount <= 0) return false;
  if (options?.allowEnvLimited === false && isEnvLimitedSnapshot(snapshot)) return false;
  if (getTrustedAudienceSignalCount(snapshot.sources) <= 0) return false;
  if (snapshot.participantCount <= 1 && getExplicitAudienceSignalCount(snapshot.sources) <= 0) return false;
  if (
    !isGroupMetadataStatusAudienceEnabled() &&
    Math.max(0, Math.floor(Number(snapshot.sources?.groupMetadata || 0))) > 0 &&
    getDirectAudienceSignalCount(snapshot.sources) <= 0
  ) {
    return false;
  }
  if (
    !isGroupMetadataStatusAudienceEnabled() &&
    Math.max(0, Math.floor(Number(snapshot.sources?.groupMetadata || 0))) > 0 &&
    getExplicitAudienceSignalCount(snapshot.sources) <= 0
  ) {
    return false;
  }
  if (!isGroupMetadataStatusAudienceEnabled() && isGroupMetadataOnlySnapshot(snapshot)) return false;
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
  freshSources: Partial<StatusAudienceSources> | null | undefined,
  options?: { allowEnvLimited?: boolean }
) => {
  if (!stored.recipients.length) return false;
  if (!shouldTrustStoredSnapshot(stored, options)) return false;
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
  const explicitAudience = await getConfiguredExplicitAudienceRecipients();
  const explicitAudienceRecipients = explicitAudience.recipients;
  if (!supabase) {
    if (explicitAudienceRecipients.length) {
      const result = {
        participantCount: explicitAudienceRecipients.length,
        recipients: explicitAudienceRecipients,
        sample: buildSample(explicitAudienceRecipients, options?.sampleSize),
        refreshedAt: new Date().toISOString(),
        sources: {
          ...emptySources(),
          env: explicitAudienceRecipients.length
        },
        warnings: [`Status audience is limited by ${explicitAudience.source}.`]
      };
      cacheSnapshot(result);
      return result;
    }
    // No database — fall back to in-memory snapshot if available
    if (lastGoodSnapshot && lastGoodSnapshot.recipients.length) {
      return {
        ...lastGoodSnapshot,
        warnings: [...lastGoodSnapshot.warnings, 'Database not available; using in-memory cached audience snapshot.'],
        stale: true
      };
    }
    return {
      participantCount: 0,
      recipients: [],
      sample: [],
      refreshedAt: null,
      sources: emptySources(),
      warnings: ['Database not available']
    };
  }

  if (explicitAudienceRecipients.length) {
    const refreshedAt = new Date().toISOString();
    const sources = {
      ...emptySources(),
      env: explicitAudienceRecipients.length
    };
    const warnings = [`Status audience is limited by ${explicitAudience.source}.`];

    try {
      await persistStatusRecipientsSnapshot(supabase, explicitAudienceRecipients, {
        refreshedAt,
        sources,
        warnings
      });
    } catch (persistError) {
      logger.warn({ error: getErrorMessage(persistError) }, 'Failed to persist explicit status recipients snapshot');
    }

    const result: RefreshResult = {
      participantCount: explicitAudienceRecipients.length,
      recipients: explicitAudienceRecipients,
      sample: buildSample(explicitAudienceRecipients, options?.sampleSize),
      refreshedAt,
      sources,
      warnings
    };
    cacheSnapshot(result);
    return result;
  }

  let stored: RefreshResult;
  try {
    stored = await getStoredRecipients(supabase, options?.sampleSize, { includeRecipients: true });
  } catch (dbError) {
    logger.warn(
      { error: getErrorMessage(dbError) },
      'Failed to read stored status recipients from database; using in-memory cache if available'
    );
    if (lastGoodSnapshot && lastGoodSnapshot.recipients.length) {
      return {
        ...lastGoodSnapshot,
        warnings: [...lastGoodSnapshot.warnings, `Database read failed (${getErrorMessage(dbError)}); using in-memory cached audience snapshot.`],
        stale: true
      };
    }
    stored = {
      participantCount: 0,
      recipients: [],
      sample: [],
      refreshedAt: null,
      sources: emptySources(),
      warnings: [`Database read failed: ${getErrorMessage(dbError)}`]
    };
  }

  const connectionStatus = String(whatsappClient?.getStatus?.()?.status || '').trim().toLowerCase();
  if (!whatsappClient || connectionStatus !== 'connected') {
    const warnings = [...stored.warnings];
    if (!shouldTrustStoredSnapshot(stored, { allowEnvLimited: explicitAudience.source !== 'auto' })) {
      return {
        participantCount: 0,
        recipients: [],
        sample: [],
        refreshedAt: stored.refreshedAt,
        sources: stored.sources,
        warnings: uniqueStrings([
          ...warnings,
          'WhatsApp is not connected and the stored Status audience is not safe to use.'
        ]),
        stale: true
      };
    }
    warnings.push('WhatsApp is not connected, using the last stored status audience snapshot.');
    const result = { ...stored, warnings };
    if (result.recipients.length) {
      cacheSnapshot(result);
    }
    return result;
  }

  const audienceOptions = Number.isFinite(options?.sampleSize)
    ? { sampleSize: Number(options?.sampleSize) }
    : undefined;
  const [participantsRaw, audienceRaw, recentDirectRecipients, activeIndividualTargetRecipients] = await Promise.all([
    Promise.resolve(whatsappClient.getStatusParticipants?.() || []),
    Promise.resolve(whatsappClient.getStatusAudience?.(audienceOptions) || null),
    USE_RECENT_DIRECT_RECIPIENTS ? getRecentSuccessfulDirectRecipients(supabase).catch(() => []) : Promise.resolve([]),
    getActiveIndividualTargetRecipients(supabase).catch(() => [])
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
        .filter((value) => Boolean(value) && value !== selfJid)
    )
  ).sort();

  const refreshedAt = new Date().toISOString();
  const baseSources =
    audienceRaw && typeof audienceRaw === 'object' && audienceRaw.sources && typeof audienceRaw.sources === 'object'
      ? audienceRaw.sources as Record<string, unknown>
      : {};
  const warnings = Array.isArray(audienceRaw?.warnings) ? audienceRaw!.warnings.map((value) => String(value || '').trim()).filter(Boolean) : [];
  const activeIndividualTargetAudienceCount = activeIndividualTargetRecipients
    .map((recipient) => normalizeRecipientJid(recipient))
    .filter((recipient) => Boolean(recipient) && recipient !== selfJid).length;
  const recentDirectAudienceCount = recentDirectRecipients
    .map((recipient) => normalizeRecipientJid(recipient))
    .filter((recipient) => Boolean(recipient) && recipient !== selfJid).length;
  const sources = mergeSources(baseSources as Partial<StatusAudienceSources>, {
    activeIndividualTargets: activeIndividualTargetAudienceCount,
    recentSuccessfulDirectRecipients: recentDirectAudienceCount
  });
  if (activeIndividualTargetRecipients.length && !warnings.some((warning) => warning.includes('active private targets'))) {
    warnings.push('Status audience includes active private targets saved in this app.');
  }
  if (!USE_RECENT_DIRECT_RECIPIENTS && recentDirectRecipients.length) {
    warnings.push('Recent direct recipients are ignored unless WHATSAPP_STATUS_USE_RECENT_DIRECT_RECIPIENTS=true.');
  }
  if (
    !isGroupMetadataStatusAudienceEnabled() &&
    Math.max(0, Math.floor(Number(sources.groupMetadata || 0))) > 0 &&
    getDirectAudienceSignalCount(sources) <= 0
  ) {
    const dropped = participants.length;
    participants = [];
    if (dropped > 0) {
      warnings.push(
        `Dropped ${dropped} Status recipients resolved only from group participants. WhatsApp Status requires explicit/private recipients, not a scraped group audience.`
      );
    }
  }
  if (shouldDropImplicitLidRecipients(sources)) {
    const beforeDrop = participants.length;
    participants = participants.filter((recipient) => !recipient.endsWith('@lid'));
    const dropped = beforeDrop - participants.length;
    if (dropped > 0) {
      const phoneCount = participants.filter((recipient) => recipient.endsWith('@s.whatsapp.net')).length;
      warnings.push(
        phoneCount > 0
          ? `Ignored ${dropped} unresolved group-participant LID Status recipients; ${phoneCount} phone-number Status recipients are available.`
          : `Dropped ${dropped} implicit group-participant LID Status recipients because no phone-number mappings or explicit private recipients were available.`
      );
    }
  }
  const finalWarnings = cleanLidMappingWarningsForFinalAudience(warnings, participants);

  if (shouldPreserveStoredSnapshot(stored, participants.length, sources, { allowEnvLimited: explicitAudience.source !== 'auto' })) {
    const preservedRecipients = Array.from(new Set([...stored.recipients, ...participants])).sort();
    const preservedSources = mergeSources(stored.sources, sources);
    const preservedWarnings = uniqueStrings([
      ...stored.warnings,
      ...finalWarnings,
      `Preserved the previous status audience snapshot because the current WhatsApp audience is still warming up (${participants.length} resolved, ${stored.participantCount} stored).`
    ]);

    try {
      await persistStatusRecipientsSnapshot(supabase, preservedRecipients, {
        refreshedAt,
        sources: preservedSources,
        warnings: preservedWarnings,
        recentDirectRecipients,
        preservedFromStored: true
      });
    } catch (persistError) {
      logger.warn({ error: getErrorMessage(persistError) }, 'Failed to persist preserved status recipients snapshot');
    }

    const result: RefreshResult = {
      participantCount: preservedRecipients.length,
      recipients: preservedRecipients,
      sample: buildSample(preservedRecipients, options?.sampleSize),
      refreshedAt,
      sources: preservedSources,
      warnings: preservedWarnings
    };
    cacheSnapshot(result);
    return result;
  }

  try {
    await persistStatusRecipientsSnapshot(supabase, participants, {
      refreshedAt,
      sources,
      warnings: finalWarnings,
      recentDirectRecipients
    });
  } catch (persistError) {
    logger.warn({ error: getErrorMessage(persistError) }, 'Failed to persist status recipients snapshot');
  }

  const result: RefreshResult = {
    participantCount: participants.length,
    recipients: participants,
    sample: buildSample(participants, options?.sampleSize),
    refreshedAt,
    sources,
    warnings: participants.length ? finalWarnings : [...finalWarnings, 'No status recipients resolved from the current audience sources.']
  };
  if (result.recipients.length) {
    cacheSnapshot(result);
  }
  return result;
};

const cacheSnapshot = (snapshot: RefreshResult) => {
  lastGoodSnapshot = snapshot;
  lastGoodSnapshotAtMs = Date.now();
};

const getInMemoryFallback = (reason: string): RefreshResult | null => {
  if (!lastGoodSnapshot || !lastGoodSnapshot.recipients.length) return null;
  const ageMs = Date.now() - lastGoodSnapshotAtMs;
  if (ageMs > MAX_IN_MEMORY_SNAPSHOT_AGE_MS) {
    logger.warn(
      { snapshotAgeMs: ageMs, maxAgeMs: MAX_IN_MEMORY_SNAPSHOT_AGE_MS },
      'In-memory audience snapshot is too old to use as fallback'
    );
    return null;
  }
  return {
    ...lastGoodSnapshot,
    warnings: [...lastGoodSnapshot.warnings, `${reason}; using in-memory cached audience snapshot (${Math.round(ageMs / 1000)}s old).`],
    stale: true
  };
};

const ensureFreshStatusRecipients = async (
  whatsappClient?: StatusAudienceClient | null,
  options?: { maxAgeMinutes?: number; sampleSize?: number }
): Promise<RefreshResult> => {
  const explicitAudience = await getConfiguredExplicitAudienceRecipients();
  if (explicitAudience.recipients.length) {
    return refreshStatusRecipients(whatsappClient, options);
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return refreshStatusRecipients(whatsappClient, options);
  }

  let stored: RefreshResult;
  try {
    stored = await getStoredRecipients(supabase, options?.sampleSize, { includeRecipients: true });
  } catch (dbError) {
    logger.warn(
      { error: getErrorMessage(dbError) },
      'Failed to read stored status recipients; falling back to in-memory cache or live refresh'
    );
    const fallback = getInMemoryFallback(`Database read failed (${getErrorMessage(dbError)})`);
    if (fallback) return fallback;
    return refreshStatusRecipients(whatsappClient, options);
  }

  const maxAgeMinutes = Math.max(1, Math.min(Math.floor(Number(options?.maxAgeMinutes || 10)), 120));
  const refreshedAtMs = stored.refreshedAt ? Date.parse(stored.refreshedAt) : Number.NaN;
  const isFresh = Number.isFinite(refreshedAtMs) && Date.now() - refreshedAtMs <= maxAgeMinutes * 60 * 1000;

  if (isFresh && shouldTrustStoredSnapshot(stored, { allowEnvLimited: explicitAudience.source !== 'auto' })) {
    cacheSnapshot(stored);
    return stored;
  }

  // If stored snapshot is stale but Supabase was reachable for the read,
  // try a full refresh. If that fails, accept a broader staleness window.
  try {
    return await refreshStatusRecipients(whatsappClient, options);
  } catch (refreshError) {
    logger.warn(
      { error: getErrorMessage(refreshError) },
      'Status audience refresh failed; checking for usable fallback'
    );

    // Accept stale DB snapshot (up to 60 min) when refresh fails
    const extendedMaxAgeMs = MAX_IN_MEMORY_SNAPSHOT_AGE_MS;
    const isExtendedFresh = Number.isFinite(refreshedAtMs) && Date.now() - refreshedAtMs <= extendedMaxAgeMs;
    if (isExtendedFresh && stored.recipients.length && shouldTrustStoredSnapshot(stored)) {
      logger.info(
        { snapshotAgeMinutes: Math.round((Date.now() - refreshedAtMs) / 60000), recipientCount: stored.recipients.length },
        'Using stale database audience snapshot after refresh failure'
      );
      return {
        ...stored,
        warnings: [...stored.warnings, `Audience refresh failed (${getErrorMessage(refreshError)}); using stale database snapshot.`],
        stale: true
      };
    }

    const fallback = getInMemoryFallback(`Audience refresh failed (${getErrorMessage(refreshError)})`);
    if (fallback) return fallback;

    throw refreshError;
  }
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

  try {
    const explicitAudience = await getConfiguredExplicitAudienceRecipients();
    const stored = await getStoredRecipients(supabase, options?.sampleSize, { includeRecipients: false });
    if (!shouldTrustStoredSnapshot(stored as RefreshResult, { allowEnvLimited: explicitAudience.source !== 'auto' })) {
      return {
        participantCount: 0,
        sample: [],
        refreshedAt: stored.refreshedAt,
        sources: stored.sources,
        warnings: uniqueStrings([
          ...stored.warnings,
          'Stored Status audience is not safe to use. Reconnect WhatsApp or configure explicit/private Status recipients.'
        ]),
        stale: true
      };
    }
    return {
      participantCount: stored.participantCount,
      sample: stored.sample,
      refreshedAt: stored.refreshedAt,
      sources: stored.sources,
      warnings: stored.warnings
    };
  } catch (error) {
    const fallback = getInMemoryFallback(`Database read failed (${getErrorMessage(error)})`);
    if (fallback) {
      return {
        participantCount: fallback.participantCount,
        sample: fallback.sample,
        refreshedAt: fallback.refreshedAt,
        sources: fallback.sources,
        warnings: fallback.warnings,
        stale: true
      };
    }
    return {
      participantCount: 0,
      sample: [],
      refreshedAt: null,
      sources: emptySources(),
      warnings: [`Database read failed: ${getErrorMessage(error)}`],
      stale: true
    };
  }
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

const clearInMemoryStatusAudienceCache = () => {
  lastGoodSnapshot = null;
  lastGoodSnapshotAtMs = 0;
};

module.exports = {
  ensureFreshStatusRecipients,
  getStatusRecipientSnapshot,
  refreshStatusRecipients,
  scheduleStatusAudienceRefresh,
  stopStatusAudienceRefresh,
  __testUtils: {
    clearInMemoryStatusAudienceCache,
    getConfiguredExplicitAudienceRecipients
  }
};

export {};
