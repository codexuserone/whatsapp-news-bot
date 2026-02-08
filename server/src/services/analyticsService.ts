import type { SupabaseClient } from '@supabase/supabase-js';

const { getSupabaseClient } = require('../db/supabase');
const settingsService = require('./settingsService');
const { serviceUnavailable } = require('../core/errors');
const logger = require('../utils/logger');

const SLOT_COUNT = 7 * 24;
const MS_IN_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 90;
const MAX_LOOKBACK_DAYS = 365;
const MAX_LOG_ROWS = 20000;
const MAX_INBOUND_ROWS = 50000;
const CACHE_TTL_MS = 45 * 1000;

const SUCCESS_STATUSES = new Set(['sent', 'delivered', 'read']);
const ATTEMPT_STATUSES = new Set(['sent', 'delivered', 'read', 'failed', 'skipped']);

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type TargetRef = {
  id: string;
  name: string;
  phone_number: string;
  type: string;
  active: boolean;
};

type FeedItemRef = {
  id: string;
  title: string | null;
  categories: string[];
};

type MessageLogRow = {
  id: string;
  schedule_id: string | null;
  target_id: string | null;
  template_id: string | null;
  feed_item_id: string | null;
  status: string;
  whatsapp_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  message_content: string | null;
  media_type: string | null;
  media_sent: boolean;
  error_message: string | null;
  target: TargetRef | null;
  feed_item: FeedItemRef | null;
};

type SeenMessage = {
  observedAtMs: number;
  remoteJid: string | null;
};

type Observation = {
  id: string;
  targetId: string | null;
  targetName: string;
  targetJid: string | null;
  targetType: string;
  status: string;
  contentType: string;
  timeMs: number;
  day: number;
  hour: number;
  slot: number;
  observed: boolean;
  latencySec: number | null;
  responseCount24h: number;
  score: number;
  weight: number;
};

type SlotInsight = {
  slot: number;
  day: number;
  dayLabel: string;
  hour: number;
  label: string;
  sentCount: number;
  failedCount: number;
  weightedSamples: number;
  posteriorMean: number;
  objective: number;
  confidence: number;
  expectedObservedRate: number;
  expectedResponses24h: number;
  fatiguePenalty: number;
  pressureRatio: number;
  avgLatencySec: number | null;
  primaryContentType: string;
};

type Recommendation = {
  label: string;
  day: number;
  dayLabel: string;
  hour: number;
  time: string;
  objective: number;
  confidence: number;
  expectedObservedRate: number;
  expectedResponses24h: number;
  reason: string;
};

type TimelinePoint = {
  date: string;
  sent: number;
  failed: number;
  observed: number;
  responses24h: number;
  avgLatencySec: number | null;
  avgScore: number;
  observedRate: number;
  failureRate: number;
};

type TargetRisk = {
  target_id: string;
  target_name: string;
  target_type: string;
  sent: number;
  failed: number;
  observedRate: number;
  failureRate: number;
  avgResponses24h: number;
  inactivityDays: number;
  trendDrop: number;
  fatigueSignal: number;
  riskScore: number;
};

type AudienceSnapshot = {
  id: string;
  target_id: string;
  target_name: string;
  target_type: string;
  source: string;
  audience_size: number;
  captured_at: string;
};

type AnalyticsReport = {
  generatedAt: string;
  lookbackDays: number;
  filters: {
    target_id: string | null;
    content_type: string | null;
    tz_offset_min: number;
  };
  totals: {
    messages: number;
    attempted: number;
    sent: number;
    failed: number;
    skipped: number;
    pending: number;
    processing: number;
    observed: number;
    responses24h: number;
  };
  rates: {
    observedRate: number;
    failureRate: number;
    responseRate24h: number;
    avgLatencySec: number | null;
    avgEngagementScore: number;
  };
  dataQuality: {
    observedIdCoverage: number;
    inboundRowsScanned: number;
    inboundSignalAvailable: boolean;
    inboundRowsTruncated: boolean;
    notes: string[];
  };
  model: {
    halfLifeDays: number;
    priorAlpha: number;
    priorBeta: number;
    confidenceTarget: number;
    objectiveScore: number;
    confidence: number;
  };
  windows: SlotInsight[];
  recommendations: {
    windows: Recommendation[];
    suggestedBatchTimes: string[];
    suggestedCron: string | null;
  };
  timeline: TimelinePoint[];
  contentTypeStats: Array<{
    contentType: string;
    sent: number;
    observedRate: number;
    responseRate24h: number;
    avgScore: number;
  }>;
  targetRisks: TargetRisk[];
  audience: {
    snapshots: AudienceSnapshot[];
    latestByTarget: Array<{
      target_id: string;
      target_name: string;
      target_type: string;
      audience_size: number;
      growth7d: number | null;
      captured_at: string;
    }>;
    totalAudienceLatest: number;
  };
};

type ScheduleRecommendationReport = {
  generatedAt: string;
  lookbackDays: number;
  schedules: Array<{
    schedule_id: string;
    schedule_name: string;
    timezone: string;
    delivery_mode: string;
    current_cron_expression: string | null;
    current_batch_times: string[];
    primary_target_id: string | null;
    primary_target_name: string | null;
    recommended_cron: string | null;
    recommended_batch_times: string[];
    objective_score: number;
    confidence: number;
    rationale: string;
  }>;
};

type ReportOptions = {
  targetId?: string;
  lookbackDays?: number;
  contentType?: string;
  tzOffsetMinutes?: number;
  forceRefresh?: boolean;
};

type CaptureAudienceResult = {
  capturedAt: string;
  inserted: number;
  matchedGroups: number;
  matchedChannels: number;
  unmatchedTargets: Array<{ target_id: string; target_name: string; target_type: string }>;
};

type WhatsAppClientLike = {
  getStatus?: () => { status?: string };
  getGroups?: () => Promise<Array<{ id?: string; jid?: string; name?: string; size?: number }>>;
  getChannelsWithDiagnostics?: () => Promise<{
    channels: Array<{ id?: string; jid?: string; name?: string; subscribers?: number }>;
  }>;
  getChannels?: () => Promise<Array<{ id?: string; jid?: string; name?: string; subscribers?: number }>>;
};

const reportCache = new Map<string, { expiresAt: number; report: AnalyticsReport }>();

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const toFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeLookbackDays = (value: unknown) => {
  const parsed = Math.round(toFiniteNumber(value, DEFAULT_LOOKBACK_DAYS));
  return clamp(parsed, 7, MAX_LOOKBACK_DAYS);
};

const normalizeTimezoneOffset = (value: unknown) => {
  const parsed = Math.round(toFiniteNumber(value, 0));
  return clamp(parsed, -12 * 60, 14 * 60);
};

const normalizeContentType = (value: unknown) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
};

const normalizeText = (value: unknown) => {
  const text = String(value || '').trim();
  return text || null;
};

const parseDateMs = (value: unknown) => {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};

const toIso = (value: number) => new Date(value).toISOString();

const getLocalDate = (timeMs: number, tzOffsetMinutes: number) => new Date(timeMs + tzOffsetMinutes * 60 * 1000);

const getHourOfWeek = (timeMs: number, tzOffsetMinutes: number) => {
  const local = getLocalDate(timeMs, tzOffsetMinutes);
  const day = local.getUTCDay();
  const hour = local.getUTCHours();
  const slot = day * 24 + hour;
  return { day, hour, slot };
};

const formatTime = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

const normalizeComparableJid = (value: unknown) => String(value || '').trim().toLowerCase();

const toArray = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) return [];
  return value as T[];
};

const chunkArray = <T>(values: T[], size: number) => {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
};

const uniqueStrings = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
};

const lowerBound = (sorted: number[], target: number) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const value = sorted[mid] ?? 0;
    if (value < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

const countBetween = (sorted: number[], startInclusive: number, endExclusive: number) => {
  if (!sorted.length) return 0;
  const start = lowerBound(sorted, startInclusive);
  const end = lowerBound(sorted, endExclusive);
  return Math.max(0, end - start);
};

const fetchPagedRows = async <T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: unknown }>,
  maxRows: number,
  pageSize = 1000
) => {
  const output: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await fetchPage(offset, offset + pageSize - 1);
    if (error) {
      throw error;
    }
    const rows = data || [];
    output.push(...rows);
    if (rows.length < pageSize) {
      break;
    }
  }
  return output;
};

const asTargetRef = (value: unknown): TargetRef | null => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const row = candidate as Record<string, unknown>;
  const id = normalizeText(row.id);
  if (!id) return null;
  return {
    id,
    name: String(row.name || id),
    phone_number: String(row.phone_number || ''),
    type: String(row.type || 'unknown'),
    active: row.active !== false
  };
};

const asFeedItemRef = (value: unknown): FeedItemRef | null => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object') return null;
  const row = candidate as Record<string, unknown>;
  const id = normalizeText(row.id);
  if (!id) return null;
  return {
    id,
    title: normalizeText(row.title),
    categories: toArray<string>(row.categories).map((item) => String(item || '').trim()).filter(Boolean)
  };
};

const asMessageLogRow = (value: Record<string, unknown>): MessageLogRow => ({
  id: String(value.id || ''),
  schedule_id: normalizeText(value.schedule_id),
  target_id: normalizeText(value.target_id),
  template_id: normalizeText(value.template_id),
  feed_item_id: normalizeText(value.feed_item_id),
  status: String(value.status || 'pending').toLowerCase(),
  whatsapp_message_id: normalizeText(value.whatsapp_message_id),
  sent_at: normalizeText(value.sent_at),
  created_at: String(value.created_at || new Date().toISOString()),
  message_content: normalizeText(value.message_content),
  media_type: normalizeText(value.media_type),
  media_sent: value.media_sent === true,
  error_message: normalizeText(value.error_message),
  target: asTargetRef(value.target),
  feed_item: asFeedItemRef(value.feed_item)
});

const inferContentType = (row: MessageLogRow) => {
  if (row.target?.type === 'status') return 'status';
  const mediaType = String(row.media_type || '').trim().toLowerCase();
  if (mediaType) {
    if (mediaType.includes('image')) return 'image';
    if (mediaType.includes('video')) return 'video';
    if (mediaType.includes('audio')) return 'audio';
    if (mediaType.includes('document')) return 'document';
    return mediaType;
  }

  const content = String(row.message_content || '');
  if (/https?:\/\//i.test(content)) return 'link';
  return 'text';
};

const computeObservationScore = (params: {
  status: string;
  observed: boolean;
  responseCount24h: number;
  latencySec: number | null;
}) => {
  const normalizedStatus = String(params.status || '').toLowerCase();
  const statusPenalty = normalizedStatus === 'failed' ? 0.55 : normalizedStatus === 'skipped' ? 0.2 : 0;
  const base = params.observed ? 0.55 : SUCCESS_STATUSES.has(normalizedStatus) ? 0.18 : 0.08;
  const responseComponent = clamp(params.responseCount24h / 8, 0, 1) * 0.30;
  const latencyComponent = params.latencySec == null
    ? 0
    : clamp(1 - clamp(params.latencySec / (12 * 3600), 0, 1), 0, 1) * 0.15;

  return clamp(base + responseComponent + latencyComponent - statusPenalty, 0, 1);
};

const getSupabase = () => {
  const supabase: SupabaseClient | null = getSupabaseClient();
  if (!supabase) {
    throw serviceUnavailable('Database not available');
  }
  return supabase;
};

const getAnalyticsSettings = async () => {
  const settings = await settingsService.getSettings();
  return {
    halfLifeDays: clamp(toFiniteNumber(settings.analytics_half_life_days, 21), 1, 120),
    priorAlpha: clamp(toFiniteNumber(settings.analytics_prior_alpha, 2), 0.1, 50),
    priorBeta: clamp(toFiniteNumber(settings.analytics_prior_beta, 2), 0.1, 50),
    confidenceTarget: clamp(toFiniteNumber(settings.analytics_confidence_sample_target, 12), 1, 250)
  };
};

const loadMessageLogs = async (
  supabase: SupabaseClient,
  params: { targetId: string | null; lookbackDays: number }
) => {
  const cutoffIso = toIso(Date.now() - params.lookbackDays * MS_IN_DAY);

  const rows = await fetchPagedRows<Record<string, unknown>>(
    async (from, to) => {
      let query = supabase
        .from('message_logs')
        .select(`
          id,
          schedule_id,
          target_id,
          template_id,
          feed_item_id,
          status,
          whatsapp_message_id,
          sent_at,
          created_at,
          message_content,
          media_type,
          media_sent,
          error_message,
          target:targets(id,name,phone_number,type,active),
          feed_item:feed_items(id,title,categories)
        `)
        .gte('created_at', cutoffIso)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (params.targetId) {
        query = query.eq('target_id', params.targetId);
      }

      return await query;
    },
    MAX_LOG_ROWS
  );

  return rows.map(asMessageLogRow).filter((row) => Boolean(row.id));
};

const loadSeenMessages = async (supabase: SupabaseClient, messageIds: string[]) => {
  const seenById = new Map<string, SeenMessage>();
  const chunks = chunkArray(messageIds, 400);

  for (const chunk of chunks) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('whatsapp_id,timestamp,remote_jid,from_me')
      .in('whatsapp_id', chunk)
      .eq('from_me', true);
    if (error) throw error;

    for (const raw of (data || []) as Array<Record<string, unknown>>) {
      const messageId = normalizeText(raw.whatsapp_id);
      if (!messageId) continue;
      const observedAtMs = parseDateMs(raw.timestamp);
      if (observedAtMs == null) continue;

      const existing = seenById.get(messageId);
      if (!existing || observedAtMs < existing.observedAtMs) {
        seenById.set(messageId, {
          observedAtMs,
          remoteJid: normalizeText(raw.remote_jid)
        });
      }
    }
  }

  return seenById;
};

const loadInboundByJid = async (
  supabase: SupabaseClient,
  jids: string[],
  minSentAtMs: number,
  maxSentAtMs: number
) => {
  const inboundByJid = new Map<string, number[]>();
  if (!jids.length) {
    return {
      byJid: inboundByJid,
      totalFetched: 0,
      truncated: false
    };
  }

  const startIso = toIso(minSentAtMs);
  const endIso = toIso(maxSentAtMs + MS_IN_DAY);
  let totalFetched = 0;

  for (const jidChunk of chunkArray(jids, 80)) {
    for (let offset = 0; totalFetched < MAX_INBOUND_ROWS; offset += 1000) {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('remote_jid,timestamp,from_me')
        .eq('from_me', false)
        .in('remote_jid', jidChunk)
        .gte('timestamp', startIso)
        .lte('timestamp', endIso)
        .order('timestamp', { ascending: true })
        .range(offset, offset + 999);

      if (error) throw error;
      const rows = (data || []) as Array<Record<string, unknown>>;
      totalFetched += rows.length;

      for (const row of rows) {
        const jid = normalizeText(row.remote_jid);
        const timestampMs = parseDateMs(row.timestamp);
        if (!jid || timestampMs == null) continue;
        const list = inboundByJid.get(jid) || [];
        list.push(timestampMs);
        inboundByJid.set(jid, list);
      }

      if (rows.length < 1000 || totalFetched >= MAX_INBOUND_ROWS) {
        break;
      }
    }
  }

  for (const [jid, list] of inboundByJid.entries()) {
    list.sort((a, b) => a - b);
    inboundByJid.set(jid, list);
  }

  const truncated = totalFetched >= MAX_INBOUND_ROWS;
  if (truncated) {
    logger.warn({ totalFetched }, 'Inbound analytics rows were truncated to protect query latency');
  }

  return {
    byJid: inboundByJid,
    totalFetched,
    truncated
  };
};

const loadAudienceSnapshots = async (
  supabase: SupabaseClient,
  params: { targetId: string | null; lookbackDays: number }
) => {
  const cutoffIso = toIso(Date.now() - params.lookbackDays * MS_IN_DAY);
  let query = supabase
    .from('audience_snapshots')
    .select('id,target_id,source,audience_size,captured_at,target:targets(id,name,type)')
    .gte('captured_at', cutoffIso)
    .order('captured_at', { ascending: false })
    .limit(5000);

  if (params.targetId) {
    query = query.eq('target_id', params.targetId);
  }

  const { data, error } = await query;
  if (error) {
    const message = String((error as { message?: unknown })?.message || error);
    if (message.toLowerCase().includes('audience_snapshots')) {
      return [] as AudienceSnapshot[];
    }
    throw error;
  }

  return (data || [])
    .map((row: Record<string, unknown>) => {
      const target = asTargetRef(row.target);
      return {
        id: String(row.id || ''),
        target_id: normalizeText(row.target_id) || target?.id || '',
        target_name: target?.name || String((row.target as Record<string, unknown> | null)?.name || 'Unknown target'),
        target_type: target?.type || String((row.target as Record<string, unknown> | null)?.type || 'unknown'),
        source: String(row.source || 'unknown'),
        audience_size: Math.max(0, Math.round(toFiniteNumber(row.audience_size, 0))),
        captured_at: String(row.captured_at || new Date().toISOString())
      } as AudienceSnapshot;
    })
    .filter((row) => Boolean(row.id && row.target_id));
};

const computeAudienceSummary = (snapshots: AudienceSnapshot[]) => {
  const byTarget = new Map<string, AudienceSnapshot[]>();

  for (const snapshot of snapshots) {
    const list = byTarget.get(snapshot.target_id) || [];
    list.push(snapshot);
    byTarget.set(snapshot.target_id, list);
  }

  const sevenDaysAgo = Date.now() - 7 * MS_IN_DAY;
  const latestByTarget: Array<{
    target_id: string;
    target_name: string;
    target_type: string;
    audience_size: number;
    growth7d: number | null;
    captured_at: string;
  }> = [];

  let totalAudienceLatest = 0;

  for (const [targetId, list] of byTarget.entries()) {
    const sorted = [...list].sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    const latest = sorted[sorted.length - 1];
    if (!latest) continue;

    const older = sorted.find((item) => Date.parse(item.captured_at) >= sevenDaysAgo) || sorted[0];
    const growth7d = older ? latest.audience_size - older.audience_size : null;

    totalAudienceLatest += latest.audience_size;
    latestByTarget.push({
      target_id: targetId,
      target_name: latest.target_name,
      target_type: latest.target_type,
      audience_size: latest.audience_size,
      growth7d,
      captured_at: latest.captured_at
    });
  }

  latestByTarget.sort((a, b) => b.audience_size - a.audience_size);

  return {
    snapshots,
    latestByTarget,
    totalAudienceLatest
  };
};

const buildAnalyticsReport = async (options: ReportOptions = {}): Promise<AnalyticsReport> => {
  const lookbackDays = normalizeLookbackDays(options.lookbackDays);
  const targetId = normalizeText(options.targetId);
  const contentTypeFilter = normalizeContentType(options.contentType);
  const tzOffsetMinutes = normalizeTimezoneOffset(options.tzOffsetMinutes);

  const cacheKey = `${targetId || 'all'}|${lookbackDays}|${contentTypeFilter || 'all'}|${tzOffsetMinutes}`;
  const nowMs = Date.now();
  const cached = reportCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > nowMs) {
    return cached.report;
  }

  const supabase = getSupabase();
  const modelSettings = await getAnalyticsSettings();
  const logs = await loadMessageLogs(supabase, { targetId, lookbackDays });

  const scopedRows = logs
    .map((row) => ({
      row,
      contentType: inferContentType(row)
    }))
    .filter((entry) => !contentTypeFilter || entry.contentType === contentTypeFilter);

  const statusCounters = {
    sent: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    processing: 0
  };

  for (const { row } of scopedRows) {
    if (SUCCESS_STATUSES.has(row.status)) statusCounters.sent += 1;
    else if (row.status === 'failed') statusCounters.failed += 1;
    else if (row.status === 'skipped') statusCounters.skipped += 1;
    else if (row.status === 'processing') statusCounters.processing += 1;
    else statusCounters.pending += 1;
  }

  const messageIds = uniqueStrings(
    scopedRows
      .filter(({ row }) => SUCCESS_STATUSES.has(row.status))
      .map(({ row }) => row.whatsapp_message_id)
  );
  const seenById = await loadSeenMessages(supabase, messageIds);

  const sentTimeValues = scopedRows
    .map(({ row }) => parseDateMs(row.sent_at || row.created_at))
    .filter((value): value is number => value != null);
  const minSentAtMs = sentTimeValues.length ? Math.min(...sentTimeValues) : Date.now() - lookbackDays * MS_IN_DAY;
  const maxSentAtMs = sentTimeValues.length ? Math.max(...sentTimeValues) : Date.now();

  const targetJids = uniqueStrings([
    ...scopedRows.map(({ row }) => row.target?.phone_number || null),
    ...Array.from(seenById.values()).map((entry) => entry.remoteJid)
  ]);
  const inboundData = await loadInboundByJid(supabase, targetJids, minSentAtMs, maxSentAtMs);

  const observations: Observation[] = [];
  const contentTypeStatsMap = new Map<string, { sent: number; observed: number; responses: number; score: number }>();

  for (const { row, contentType: inferredContentType } of scopedRows) {
    if (!ATTEMPT_STATUSES.has(row.status)) continue;

    const eventMs = parseDateMs(row.sent_at || row.created_at);
    if (eventMs == null) continue;

    const { day, hour, slot } = getHourOfWeek(eventMs, tzOffsetMinutes);
    const messageId = row.whatsapp_message_id || '';
    const seen = messageId ? seenById.get(messageId) : undefined;
    const observed = Boolean(seen);
    const latencySec = seen ? Math.max(0, Math.round((seen.observedAtMs - eventMs) / 1000)) : null;

    const targetJid = normalizeText(row.target?.phone_number) || seen?.remoteJid || null;
    const inboundSeries = targetJid ? inboundData.byJid.get(targetJid) || [] : [];
    const responseCount24h = inboundSeries.length
      ? countBetween(inboundSeries, eventMs, eventMs + MS_IN_DAY)
      : 0;

    const ageDays = Math.max(0, (nowMs - eventMs) / MS_IN_DAY);
    const weight = Math.pow(0.5, ageDays / modelSettings.halfLifeDays);

    const score = computeObservationScore({
      status: row.status,
      observed,
      responseCount24h,
      latencySec
    });

    observations.push({
      id: row.id,
      targetId: row.target_id,
      targetName: row.target?.name || row.target_id || 'Unknown',
      targetJid,
      targetType: row.target?.type || 'unknown',
      status: row.status,
      contentType: inferredContentType,
      timeMs: eventMs,
      day,
      hour,
      slot,
      observed,
      latencySec,
      responseCount24h,
      score,
      weight
    });

    const contentStats = contentTypeStatsMap.get(inferredContentType) || {
      sent: 0,
      observed: 0,
      responses: 0,
      score: 0
    };
    contentStats.sent += 1;
    if (observed) contentStats.observed += 1;
    contentStats.responses += responseCount24h;
    contentStats.score += score;
    contentTypeStatsMap.set(inferredContentType, contentStats);
  }

  type MutableSlotMetric = {
    sentCount: number;
    failedCount: number;
    weightedSamples: number;
    weightedScore: number;
    weightedObserved: number;
    weightedResponses: number;
    weightedLatencyTotal: number;
    weightedLatencyCount: number;
    contentTypeWeights: Record<string, number>;
  };

  const mutableSlots: MutableSlotMetric[] = Array.from({ length: SLOT_COUNT }, () => ({
    sentCount: 0,
    failedCount: 0,
    weightedSamples: 0,
    weightedScore: 0,
    weightedObserved: 0,
    weightedResponses: 0,
    weightedLatencyTotal: 0,
    weightedLatencyCount: 0,
    contentTypeWeights: {}
  }));

  let weightedScoreTotal = 0;
  let weightedScoreWeight = 0;
  let weightedLatencyTotal = 0;
  let weightedLatencyWeight = 0;
  let observedCount = 0;
  let responseTotal = 0;

  for (const observation of observations) {
    const slotMetric = mutableSlots[observation.slot];
    if (!slotMetric) continue;

    slotMetric.sentCount += 1;
    if (observation.status === 'failed') {
      slotMetric.failedCount += 1;
    }
    slotMetric.weightedSamples += observation.weight;
    slotMetric.weightedScore += observation.score * observation.weight;
    slotMetric.weightedObserved += (observation.observed ? 1 : 0) * observation.weight;
    slotMetric.weightedResponses += observation.responseCount24h * observation.weight;

    const currentTypeWeight = slotMetric.contentTypeWeights[observation.contentType] || 0;
    slotMetric.contentTypeWeights[observation.contentType] = currentTypeWeight + observation.weight;

    if (observation.latencySec != null) {
      slotMetric.weightedLatencyTotal += observation.latencySec * observation.weight;
      slotMetric.weightedLatencyCount += observation.weight;
      weightedLatencyTotal += observation.latencySec * observation.weight;
      weightedLatencyWeight += observation.weight;
    }

    if (observation.observed) {
      observedCount += 1;
    }
    responseTotal += observation.responseCount24h;

    weightedScoreTotal += observation.score * observation.weight;
    weightedScoreWeight += observation.weight;
  }

  const avgPostsPerSlotPerDay = observations.length > 0
    ? observations.length / Math.max(lookbackDays * 24, 1)
    : 0;

  const windows: SlotInsight[] = mutableSlots.map((metric, slot) => {
    const day = Math.floor(slot / 24);
    const hour = slot % 24;
    const alpha = modelSettings.priorAlpha + metric.weightedScore;
    const beta = modelSettings.priorBeta + Math.max(metric.weightedSamples - metric.weightedScore, 0);
    const posteriorMean = alpha / Math.max(alpha + beta, 1e-9);
    const variance = (alpha * beta) /
      (Math.pow(alpha + beta, 2) * Math.max(alpha + beta + 1, 1e-9));

    const expectedObservedRate = metric.weightedSamples > 0
      ? metric.weightedObserved / metric.weightedSamples
      : 0;
    const expectedResponses24h = metric.weightedSamples > 0
      ? metric.weightedResponses / metric.weightedSamples
      : 0;

    const avgLatencySec = metric.weightedLatencyCount > 0
      ? metric.weightedLatencyTotal / metric.weightedLatencyCount
      : null;

    const pressureRatio = avgPostsPerSlotPerDay > 0
      ? (metric.sentCount / Math.max(lookbackDays, 1)) / avgPostsPerSlotPerDay
      : 0;
    const fatiguePenalty = clamp((pressureRatio - 1) * 0.08, 0, 0.3);
    const responseBoost = clamp(expectedResponses24h / 6, 0, 0.2);
    const objective = clamp(posteriorMean + responseBoost - fatiguePenalty, 0, 1);

    const confidenceFromSample = clamp(metric.weightedSamples / modelSettings.confidenceTarget, 0, 1);
    const confidenceFromVariance = 1 - clamp(Math.sqrt(variance) / 0.3, 0, 1);
    const confidence = clamp(confidenceFromSample * 0.7 + confidenceFromVariance * 0.3, 0, 1);

    let primaryContentType = 'text';
    let primaryWeight = -1;
    for (const [contentType, weight] of Object.entries(metric.contentTypeWeights)) {
      if (weight > primaryWeight) {
        primaryWeight = weight;
        primaryContentType = contentType;
      }
    }

    return {
      slot,
      day,
      dayLabel: DAY_LABELS[day] || `Day ${day}`,
      hour,
      label: `${DAY_LABELS[day] || `Day ${day}`} ${formatTime(hour)}`,
      sentCount: metric.sentCount,
      failedCount: metric.failedCount,
      weightedSamples: Number(metric.weightedSamples.toFixed(3)),
      posteriorMean: Number(posteriorMean.toFixed(4)),
      objective: Number(objective.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      expectedObservedRate: Number(expectedObservedRate.toFixed(4)),
      expectedResponses24h: Number(expectedResponses24h.toFixed(4)),
      fatiguePenalty: Number(fatiguePenalty.toFixed(4)),
      pressureRatio: Number(pressureRatio.toFixed(4)),
      avgLatencySec: avgLatencySec == null ? null : Number(avgLatencySec.toFixed(2)),
      primaryContentType
    };
  });

  const sortedWindows = [...windows]
    .filter((window) => window.sentCount > 0)
    .sort((left, right) => right.objective - left.objective || right.confidence - left.confidence);

  const recommendationLimit = 6;
  const recommendations: Recommendation[] = [];
  for (const candidate of sortedWindows) {
    if (recommendations.some((existing) => existing.day === candidate.day && Math.abs(existing.hour - candidate.hour) <= 1)) {
      continue;
    }

    const reason = [
      `${Math.round(candidate.expectedObservedRate * 100)}% observed delivery`,
      `${candidate.expectedResponses24h.toFixed(2)} avg responses in 24h`,
      `${Math.round(candidate.confidence * 100)}% confidence`
    ].join(' · ');

    recommendations.push({
      label: candidate.label,
      day: candidate.day,
      dayLabel: candidate.dayLabel,
      hour: candidate.hour,
      time: formatTime(candidate.hour),
      objective: candidate.objective,
      confidence: candidate.confidence,
      expectedObservedRate: candidate.expectedObservedRate,
      expectedResponses24h: candidate.expectedResponses24h,
      reason
    });

    if (recommendations.length >= recommendationLimit) break;
  }

  const suggestedBatchTimes = uniqueStrings(
    recommendations
      .map((window) => `${String(window.hour).padStart(2, '0')}:00`)
      .slice(0, 3)
  ).sort();

  const topRecommendation = recommendations[0];
  const suggestedCron = topRecommendation
    ? `0 ${topRecommendation.hour} * * ${topRecommendation.day}`
    : null;

  const timelineMap = new Map<string, {
    sent: number;
    failed: number;
    observed: number;
    responses24h: number;
    weightedLatency: number;
    weightedLatencyCount: number;
    scoreTotal: number;
  }>();

  for (const observation of observations) {
    const localDate = getLocalDate(observation.timeMs, tzOffsetMinutes);
    const key = localDate.toISOString().slice(0, 10);
    if (!key) continue;

    const current = timelineMap.get(key) || {
      sent: 0,
      failed: 0,
      observed: 0,
      responses24h: 0,
      weightedLatency: 0,
      weightedLatencyCount: 0,
      scoreTotal: 0
    };
    current.sent += 1;
    if (observation.status === 'failed') current.failed += 1;
    if (observation.observed) current.observed += 1;
    current.responses24h += observation.responseCount24h;
    if (observation.latencySec != null) {
      current.weightedLatency += observation.latencySec;
      current.weightedLatencyCount += 1;
    }
    current.scoreTotal += observation.score;
    timelineMap.set(key, current);
  }

  const timeline: TimelinePoint[] = Array.from(timelineMap.entries())
    .map(([date, value]) => {
      const observedRate = value.sent > 0 ? value.observed / value.sent : 0;
      const failureRate = value.sent > 0 ? value.failed / value.sent : 0;
      const avgScore = value.sent > 0 ? value.scoreTotal / value.sent : 0;
      const avgLatencySec = value.weightedLatencyCount > 0 ? value.weightedLatency / value.weightedLatencyCount : null;

      return {
        date,
        sent: value.sent,
        failed: value.failed,
        observed: value.observed,
        responses24h: value.responses24h,
        avgLatencySec: avgLatencySec == null ? null : Number(avgLatencySec.toFixed(2)),
        avgScore: Number(avgScore.toFixed(4)),
        observedRate: Number(observedRate.toFixed(4)),
        failureRate: Number(failureRate.toFixed(4))
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date));

  const riskByTarget = new Map<string, {
    target_name: string;
    target_type: string;
    sent: number;
    failed: number;
    observed: number;
    responses: number;
    latestMs: number;
    recentScores: number[];
    previousScores: number[];
  }>();

  for (const observation of observations) {
    const targetIdKey = observation.targetId || observation.targetJid;
    if (!targetIdKey) continue;

    const existing = riskByTarget.get(targetIdKey) || {
      target_name: observation.targetName,
      target_type: observation.targetType,
      sent: 0,
      failed: 0,
      observed: 0,
      responses: 0,
      latestMs: 0,
      recentScores: [] as number[],
      previousScores: [] as number[]
    };

    existing.sent += 1;
    if (observation.status === 'failed') existing.failed += 1;
    if (observation.observed) existing.observed += 1;
    existing.responses += observation.responseCount24h;
    existing.latestMs = Math.max(existing.latestMs, observation.timeMs);

    const ageDays = (nowMs - observation.timeMs) / MS_IN_DAY;
    if (ageDays <= 7) existing.recentScores.push(observation.score);
    else if (ageDays <= 14) existing.previousScores.push(observation.score);

    riskByTarget.set(targetIdKey, existing);
  }

  const targetRisks: TargetRisk[] = Array.from(riskByTarget.entries())
    .map(([targetIdKey, value]) => {
      const observedRate = value.sent > 0 ? value.observed / value.sent : 0;
      const failureRate = value.sent > 0 ? value.failed / value.sent : 0;
      const avgResponses24h = value.sent > 0 ? value.responses / value.sent : 0;
      const inactivityDays = value.latestMs > 0 ? (nowMs - value.latestMs) / MS_IN_DAY : lookbackDays;

      const recentAvg = value.recentScores.length
        ? value.recentScores.reduce((sum, next) => sum + next, 0) / value.recentScores.length
        : 0;
      const previousAvg = value.previousScores.length
        ? value.previousScores.reduce((sum, next) => sum + next, 0) / value.previousScores.length
        : recentAvg;
      const trendDrop = clamp(previousAvg - recentAvg, 0, 1);

      const postsPerDay = value.sent / Math.max(lookbackDays, 1);
      const fatigueSignal = clamp(postsPerDay / 2, 0, 1) * clamp(1 - recentAvg, 0, 1);

      const riskScore = clamp(
        0.45 * failureRate +
          0.3 * (1 - observedRate) +
          0.15 * clamp(inactivityDays / 30, 0, 1) +
          0.1 * trendDrop,
        0,
        1
      );

      return {
        target_id: targetIdKey,
        target_name: value.target_name,
        target_type: value.target_type,
        sent: value.sent,
        failed: value.failed,
        observedRate: Number(observedRate.toFixed(4)),
        failureRate: Number(failureRate.toFixed(4)),
        avgResponses24h: Number(avgResponses24h.toFixed(4)),
        inactivityDays: Number(inactivityDays.toFixed(2)),
        trendDrop: Number(trendDrop.toFixed(4)),
        fatigueSignal: Number(fatigueSignal.toFixed(4)),
        riskScore: Number(riskScore.toFixed(4))
      };
    })
    .sort((left, right) => right.riskScore - left.riskScore)
    .slice(0, 20);

  const contentTypeStats = Array.from(contentTypeStatsMap.entries())
    .map(([contentType, value]) => ({
      contentType,
      sent: value.sent,
      observedRate: Number((value.sent > 0 ? value.observed / value.sent : 0).toFixed(4)),
      responseRate24h: Number((value.sent > 0 ? value.responses / value.sent : 0).toFixed(4)),
      avgScore: Number((value.sent > 0 ? value.score / value.sent : 0).toFixed(4))
    }))
    .sort((left, right) => right.avgScore - left.avgScore);

  const audienceSnapshots = await loadAudienceSnapshots(supabase, { targetId, lookbackDays });
  const audience = computeAudienceSummary(audienceSnapshots);

  const avgEngagementScore = weightedScoreWeight > 0 ? weightedScoreTotal / weightedScoreWeight : 0;
  const avgLatencySec = weightedLatencyWeight > 0 ? weightedLatencyTotal / weightedLatencyWeight : null;
  const observedRate = statusCounters.sent > 0 ? observedCount / statusCounters.sent : 0;
  const failureRate = statusCounters.sent + statusCounters.failed > 0
    ? statusCounters.failed / (statusCounters.sent + statusCounters.failed)
    : 0;
  const responseRate24h = statusCounters.sent > 0 ? responseTotal / statusCounters.sent : 0;

  const observedIdCoverage = messageIds.length > 0 ? seenById.size / messageIds.length : 0;
  const dataQualityNotes: string[] = [];
  if (!messageIds.length) {
    dataQualityNotes.push('No sent messages with WhatsApp IDs were available in the selected filter window.');
  }
  if (!inboundData.totalFetched) {
    dataQualityNotes.push('No inbound message rows were found for response-rate calculations.');
  }
  if (inboundData.truncated) {
    dataQualityNotes.push('Inbound message scan hit the safety cap and was truncated for latency protection.');
  }
  if (contentTypeFilter) {
    dataQualityNotes.push(`Report is filtered to content type: ${contentTypeFilter}.`);
  }

  const objectiveScore = recommendations.length
    ? recommendations.reduce((sum, next) => sum + next.objective, 0) / recommendations.length
    : 0;
  const confidenceScore = recommendations.length
    ? recommendations.reduce((sum, next) => sum + next.confidence, 0) / recommendations.length
    : 0;

  const report: AnalyticsReport = {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    filters: {
      target_id: targetId,
      content_type: contentTypeFilter,
      tz_offset_min: tzOffsetMinutes
    },
    totals: {
      messages: scopedRows.length,
      attempted: observations.length,
      sent: statusCounters.sent,
      failed: statusCounters.failed,
      skipped: statusCounters.skipped,
      pending: statusCounters.pending,
      processing: statusCounters.processing,
      observed: observedCount,
      responses24h: responseTotal
    },
    rates: {
      observedRate: Number(observedRate.toFixed(4)),
      failureRate: Number(failureRate.toFixed(4)),
      responseRate24h: Number(responseRate24h.toFixed(4)),
      avgLatencySec: avgLatencySec == null ? null : Number(avgLatencySec.toFixed(2)),
      avgEngagementScore: Number(avgEngagementScore.toFixed(4))
    },
    dataQuality: {
      observedIdCoverage: Number(observedIdCoverage.toFixed(4)),
      inboundRowsScanned: inboundData.totalFetched,
      inboundSignalAvailable: inboundData.totalFetched > 0,
      inboundRowsTruncated: inboundData.truncated,
      notes: dataQualityNotes
    },
    model: {
      halfLifeDays: modelSettings.halfLifeDays,
      priorAlpha: modelSettings.priorAlpha,
      priorBeta: modelSettings.priorBeta,
      confidenceTarget: modelSettings.confidenceTarget,
      objectiveScore: Number(objectiveScore.toFixed(4)),
      confidence: Number(confidenceScore.toFixed(4))
    },
    windows,
    recommendations: {
      windows: recommendations,
      suggestedBatchTimes,
      suggestedCron
    },
    timeline,
    contentTypeStats,
    targetRisks,
    audience
  };

  reportCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, report });
  return report;
};

const buildScheduleRecommendations = async (
  options: { lookbackDays?: number } = {}
): Promise<ScheduleRecommendationReport> => {
  const supabase = getSupabase();
  const lookbackDays = normalizeLookbackDays(options.lookbackDays);

  const { data: scheduleData, error: scheduleError } = await supabase
    .from('schedules')
    .select('id,name,timezone,delivery_mode,cron_expression,batch_times,target_ids,active')
    .eq('active', true)
    .order('name', { ascending: true });
  if (scheduleError) throw scheduleError;

  const schedules = (scheduleData || []) as Array<Record<string, unknown>>;
  const allTargetIds = uniqueStrings(
    schedules.flatMap((schedule) => toArray<string>(schedule.target_ids).map((id) => String(id || '').trim()))
  );

  const targetNameById = new Map<string, string>();
  if (allTargetIds.length) {
    const { data: targets, error: targetError } = await supabase
      .from('targets')
      .select('id,name')
      .in('id', allTargetIds);
    if (targetError) throw targetError;

    for (const target of (targets || []) as Array<Record<string, unknown>>) {
      const id = normalizeText(target.id);
      if (!id) continue;
      targetNameById.set(id, String(target.name || id));
    }
  }

  const output: ScheduleRecommendationReport['schedules'] = [];
  for (const row of schedules) {
    const scheduleId = normalizeText(row.id);
    if (!scheduleId) continue;

    const targetIds = uniqueStrings(toArray<string>(row.target_ids).map((id) => String(id || '').trim()));
    const primaryTargetId = targetIds[0] || null;
    const primaryTargetName = primaryTargetId ? targetNameById.get(primaryTargetId) || null : null;

    const reportOptions: ReportOptions = {
      lookbackDays,
      forceRefresh: false
    };
    if (primaryTargetId) {
      reportOptions.targetId = primaryTargetId;
    }
    const report = await buildAnalyticsReport(reportOptions);

    const topWindow = report.recommendations.windows[0] || null;
    const recommendedCron = topWindow ? `0 ${topWindow.hour} * * ${topWindow.day}` : null;
    const recommendedBatchTimes = report.recommendations.suggestedBatchTimes;

    output.push({
      schedule_id: scheduleId,
      schedule_name: String(row.name || scheduleId),
      timezone: String(row.timezone || 'UTC'),
      delivery_mode: String(row.delivery_mode || 'immediate'),
      current_cron_expression: normalizeText(row.cron_expression),
      current_batch_times: toArray<string>(row.batch_times).map((time) => String(time || '').trim()).filter(Boolean),
      primary_target_id: primaryTargetId,
      primary_target_name: primaryTargetName,
      recommended_cron: recommendedCron,
      recommended_batch_times: recommendedBatchTimes,
      objective_score: report.model.objectiveScore,
      confidence: report.model.confidence,
      rationale: topWindow
        ? `${topWindow.dayLabel} ${topWindow.time} · ${(topWindow.objective * 100).toFixed(1)}% objective · ${(topWindow.confidence * 100).toFixed(1)}% confidence`
        : 'Not enough historical data for this target yet.'
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    lookbackDays,
    schedules: output
  };
};

const captureAudienceSnapshots = async (whatsappClient?: WhatsAppClientLike): Promise<CaptureAudienceResult> => {
  const supabase = getSupabase();
  if (!whatsappClient) {
    throw serviceUnavailable('WhatsApp client not available');
  }

  const status = whatsappClient.getStatus?.();
  if (!status || status.status !== 'connected') {
    throw serviceUnavailable('WhatsApp is not connected');
  }

  const { data: targets, error: targetError } = await supabase
    .from('targets')
    .select('id,name,phone_number,type,active')
    .eq('active', true)
    .in('type', ['group', 'channel']);
  if (targetError) throw targetError;

  const groups = await whatsappClient.getGroups?.() || [];
  const channelsWithDiagnostics = whatsappClient.getChannelsWithDiagnostics
    ? await whatsappClient.getChannelsWithDiagnostics()
    : null;
  const channels = channelsWithDiagnostics?.channels || await whatsappClient.getChannels?.() || [];

  const groupMap = new Map<string, { name: string; size: number }>();
  for (const group of groups) {
    const jid = normalizeComparableJid(group.jid || group.id);
    if (!jid) continue;
    groupMap.set(jid, {
      name: String(group.name || group.jid || group.id || jid),
      size: Math.max(0, Math.round(toFiniteNumber(group.size, 0)))
    });
  }

  const channelMap = new Map<string, { name: string; subscribers: number }>();
  for (const channel of channels) {
    const jid = normalizeComparableJid(channel.jid || channel.id);
    if (!jid) continue;
    channelMap.set(jid, {
      name: String(channel.name || channel.jid || channel.id || jid),
      subscribers: Math.max(0, Math.round(toFiniteNumber(channel.subscribers, 0)))
    });
  }

  const nowIso = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];
  const unmatchedTargets: Array<{ target_id: string; target_name: string; target_type: string }> = [];
  let matchedGroups = 0;
  let matchedChannels = 0;

  for (const rawTarget of (targets || []) as Array<Record<string, unknown>>) {
    const target = asTargetRef(rawTarget);
    if (!target) continue;

    const normalizedJid = normalizeComparableJid(target.phone_number);
    if (!normalizedJid) {
      unmatchedTargets.push({
        target_id: target.id,
        target_name: target.name,
        target_type: target.type
      });
      continue;
    }

    if (target.type === 'group') {
      const match = groupMap.get(normalizedJid);
      if (!match) {
        unmatchedTargets.push({ target_id: target.id, target_name: target.name, target_type: target.type });
        continue;
      }
      matchedGroups += 1;
      rows.push({
        target_id: target.id,
        source: 'group',
        audience_size: match.size,
        metadata: {
          jid: target.phone_number,
          name: match.name
        },
        captured_at: nowIso
      });
      continue;
    }

    if (target.type === 'channel') {
      const match = channelMap.get(normalizedJid);
      if (!match) {
        unmatchedTargets.push({ target_id: target.id, target_name: target.name, target_type: target.type });
        continue;
      }
      matchedChannels += 1;
      rows.push({
        target_id: target.id,
        source: 'channel',
        audience_size: match.subscribers,
        metadata: {
          jid: target.phone_number,
          name: match.name
        },
        captured_at: nowIso
      });
    }
  }

  if (rows.length) {
    const { error: insertError } = await supabase.from('audience_snapshots').insert(rows);
    if (insertError) throw insertError;
  }

  reportCache.clear();

  return {
    capturedAt: nowIso,
    inserted: rows.length,
    matchedGroups,
    matchedChannels,
    unmatchedTargets
  };
};

module.exports = {
  buildAnalyticsReport,
  buildScheduleRecommendations,
  captureAudienceSnapshots
};
