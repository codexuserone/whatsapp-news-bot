import type { SupabaseClient } from '@supabase/supabase-js';
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('./feedProcessor');
const settingsService = require('./settingsService');
const { isCurrentlyShabbos } = require('./shabbosService');
const cheerio = require('cheerio');
const sleep = require('../utils/sleep');
const logger = require('../utils/logger');
const withTimeout = require('../utils/withTimeout');
const { getErrorMessage } = require('../utils/errorUtils');
const { computeNextRunAt } = require('../utils/cron');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { safeAxiosRequest } = require('../utils/safeAxios');
const { normalizeMessageText, escapeWhatsAppFormatting } = require('../utils/messageText');
const { isNewsletterJid, prepareNewsletterImage, prepareNewsletterVideo } = require('../utils/whatsappMedia');
const { parseManualMessageContent } = require('../utils/manualMeta');
const { ensureWhatsAppConnected } = require('./whatsappConnection');
const { isScheduleRunning } = require('./scheduleState');
const { withScheduleLock } = require('./scheduleLockService');
const { buildDefaultUserAgent } = require('../utils/httpClientIdentity');
const { normalizeTargetJidForSend } = require('../utils/targetJid');
const { normalizeFeedMedia } = require('../utils/feedMedia');
const { WHATSAPP_STATUS_ENABLED, WHATSAPP_STATUS_DISABLED_REASON } = require('../config/features');
const { ensureFreshStatusRecipients } = require('./statusAudienceService');

type Target = {
  id?: string;
  phone_number: string;
  type: 'individual' | 'group' | 'channel' | 'status';
  name?: string;
  active?: boolean;
  message_delay_ms_override?: number | null;
  inter_target_delay_sec_override?: number | null;
  intra_target_delay_sec_override?: number | null;
};

type Template = {
  id?: string;
  content: string;
  send_images?: boolean | null;
  send_mode?:
    | 'auto_media'
    | 'media_only'
    | 'text_preview'
    | 'text_only'
    | 'image'
    | 'image_only'
    | 'link_preview'
    | null;
};

type FeedItem = {
  id?: string;
  title?: string;
  link?: string;
  description?: string;
  content?: string;
  author?: string;
  image_url?: string;
  media_url?: string | null;
  media_kind?: 'image' | 'video' | 'audio' | 'document' | null;
  media_mime?: string | null;
  media_filename?: string | null;
  image_source?: string | null;
  image_scraped_at?: string | Date | null;
  image_scrape_error?: string | null;
  pub_date?: string | Date;
  categories?: string[];
  raw_data?: Record<string, unknown> | null;
};

type WhatsAppClient = {
  getStatus: () => { status: string };
  sendMessage: (jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
  sendStatusBroadcast: (content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
  editMessage?: (jid: string, messageId: string, text: string) => Promise<any>;
  deleteMessage?: (jid: string, messageId: string) => Promise<any>;
  reconnect?: () => Promise<void> | void;
  takeoverLease?: (
    ttlMs?: number
  ) => Promise<{ ok: boolean; supported: boolean; ownerId: string | null; expiresAt: string | null; reason?: string }>;
  waitForMessage?: (messageId: string, timeoutMs?: number) => Promise<any>;
  confirmSend?: (
    messageId: string,
    options?: { upsertTimeoutMs?: number; ackTimeoutMs?: number }
  ) => Promise<{ ok: boolean; via: 'upsert' | 'ack' | 'none'; status?: number | null; statusLabel?: string | null }>;
  getGroupInfo?: (
    jid: string,
    timeoutMs?: number
  ) => Promise<{ announce: boolean; me: { isAdmin: boolean } } | null>;
};

const DEFAULT_SEND_TIMEOUT_MS = 45000;
const DEFAULT_POST_SEND_EDIT_WINDOW_MINUTES = 15;
const DEFAULT_POST_SEND_CORRECTION_WINDOW_MINUTES = 15;
const MAX_POST_SEND_EDIT_WINDOW_MINUTES = 15;
const MAX_POST_SEND_CORRECTION_WINDOW_MINUTES = 15;
const DEFAULT_UNCERTAIN_RETRY_DELAY_MS = 120000;
const UNCERTAIN_MATCH_LOOKBACK_MS = 30000;
const UNCERTAIN_MATCH_GRACE_MS = 30000;
const MAX_UNCERTAIN_LOGS_PER_PASS = 100;
const AUTH_ERROR_HINT = 'WhatsApp auth state corrupted. Clear sender keys or re-scan the QR code, then retry.';
const MANUAL_POST_PAUSE_ERROR = 'Paused for this post';
const FEED_PAUSED_ERROR = 'Feed paused';
const NON_REVIVABLE_SKIP_ERRORS = new Set([MANUAL_POST_PAUSE_ERROR, FEED_PAUSED_ERROR]);
const SUCCESSFUL_SEND_STATUSES = new Set(['sent', 'delivered', 'read', 'played']);
const QUEUED_CORRECTION_STATUSES = new Set(['awaiting_approval', 'pending', 'failed', 'uncertain', 'skipped']);
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.zip'];

const isSuccessfulSendStatus = (status: unknown) => SUCCESSFUL_SEND_STATUSES.has(String(status || '').toLowerCase());

const getStatusSendTimeoutMs = (kind: 'text' | 'media', fallbackMs: number) => {
  const baseline = Math.max(Number(fallbackMs || DEFAULT_SEND_TIMEOUT_MS), 10000);
  return kind === 'media' ? Math.max(baseline, 90000) : Math.max(baseline, 60000);
};

const computeUncertainRetryDelayMs = (sendTimeoutMs: number) =>
  Math.max(Math.round(Math.max(sendTimeoutMs, 10000) * 2), DEFAULT_UNCERTAIN_RETRY_DELAY_MS);

const isUnknownDeliveryTimeout = (message: unknown) => /timed out sending/i.test(String(message || ''));

const buildUncertainErrorMessage = (message: string) =>
  `Send result is uncertain. Verifying delivery before retrying. ${String(message || '').trim()}`.trim();

const normalizeComparableText = (value: unknown) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeComparableMediaType = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase() || null;

const hasCorrectionChanges = (
  current: { text?: unknown; mediaUrl?: unknown; mediaType?: unknown },
  desired: { text?: unknown; mediaUrl?: unknown; mediaType?: unknown }
) => {
  const currentText = normalizeComparableText(current.text);
  const desiredText = normalizeComparableText(desired.text);
  const currentMediaUrl = normalizeComparableText(current.mediaUrl);
  const desiredMediaUrl = normalizeComparableText(desired.mediaUrl);
  const currentMediaType = normalizeComparableMediaType(current.mediaType);
  const desiredMediaType = normalizeComparableMediaType(desired.mediaType);

  return (
    currentText !== desiredText ||
    currentMediaUrl !== desiredMediaUrl ||
    currentMediaType !== desiredMediaType
  );
};

const chooseCorrectionStrategy = (options: {
  targetType: string | null | undefined;
  sentAgeMs: number | null;
  editWindowMs: number;
  correctionWindowMs: number;
  hasMessageId: boolean;
  supportsEdit: boolean;
  supportsDelete: boolean;
  currentMediaType?: string | null;
  desiredMediaType?: string | null;
}) => {
  const targetType = String(options.targetType || '').trim().toLowerCase();
  const sentAgeMs = options.sentAgeMs;
  if (sentAgeMs == null || sentAgeMs > options.correctionWindowMs || !options.hasMessageId) {
    return 'skip' as const;
  }
  if (targetType === 'status') {
    return 'skip' as const;
  }

  const currentMediaType = normalizeComparableMediaType(options.currentMediaType);
  const desiredMediaType = normalizeComparableMediaType(options.desiredMediaType);
  const isTextOnly = !currentMediaType && !desiredMediaType;

  if (
    options.supportsEdit &&
    targetType !== 'channel' &&
    isTextOnly &&
    sentAgeMs <= options.editWindowMs
  ) {
    return 'edit' as const;
  }

  if (options.supportsDelete) {
    return 'replace' as const;
  }

  return 'skip' as const;
};

type ChatMessageRow = {
  id?: string;
  whatsapp_id?: string | null;
  remote_jid?: string | null;
  from_me?: boolean | null;
  content?: string | null;
  message_type?: string | null;
  media_url?: string | null;
  timestamp?: string | null;
  created_at?: string | null;
  raw_message?: Record<string, unknown> | null;
};

const inferChatMessageMediaKind = (row: ChatMessageRow): 'image' | 'video' | 'audio' | 'document' | null => {
  const raw = row?.raw_message && typeof row.raw_message === 'object'
    ? row.raw_message as Record<string, unknown>
    : null;
  const messageType = String(raw?.messageType || row?.message_type || '').toLowerCase();
  if (messageType.includes('image')) return 'image';
  if (messageType.includes('video')) return 'video';
  if (messageType.includes('audio')) return 'audio';
  if (messageType.includes('document')) return 'document';
  return null;
};

const doesChatMessageMatchExpectedAttempt = (
  row: ChatMessageRow,
  expected: { text?: string | null; mediaType?: string | null }
) => {
  const expectedText = normalizeComparableText(expected?.text);
  const candidateText = normalizeComparableText(row?.content);
  const expectedMediaType = String(expected?.mediaType || '').trim().toLowerCase() || null;
  const candidateMediaType = inferChatMessageMediaKind(row);
  const textMatches = !expectedText || candidateText === expectedText || candidateText.includes(expectedText) || expectedText.includes(candidateText);
  const mediaMatches = expectedMediaType ? candidateMediaType === expectedMediaType : candidateMediaType === null;

  if (expectedText && expectedMediaType) {
    return textMatches && mediaMatches;
  }
  if (expectedText) {
    return textMatches;
  }
  if (expectedMediaType) {
    return mediaMatches;
  }
  return true;
};

const isDuplicateDispatchConflict = (error: unknown) => {
  const code = String((error as { code?: unknown })?.code || '').trim();
  const message = String((error as { message?: unknown })?.message || '').toLowerCase();
  const details = String((error as { details?: unknown })?.details || '').toLowerCase();
  if (code !== '23505') return false;
  if (message.includes('idx_message_logs_unique_dispatch')) return true;
  if (message.includes('duplicate key value')) return true;
  if (details.includes('schedule_id,feed_item_id,target_id')) return true;
  if (details.includes('schedule_id, feed_item_id, target_id')) return true;
  return false;
};

const upsertPendingDispatchRows = async (
  supabase: SupabaseClient,
  rows: Array<Record<string, unknown>>,
  scheduleId: string,
  context: string
) => {
  if (!rows.length) return 0;

  const { data: insertedRows, error: upsertError } = await supabase
    .from('message_logs')
    .upsert(rows, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
    .select('id');

  if (!upsertError) {
    return insertedRows?.length || 0;
  }

  if (!isDuplicateDispatchConflict(upsertError)) {
    logger.warn({ scheduleId, error: upsertError }, context);
    return 0;
  }

  // Fallback path for legacy/partial unique index definitions that bypass onConflict matching.
  let inserted = 0;
  for (const row of rows) {
    const { data: rowInserted, error: rowError } = await supabase
      .from('message_logs')
      .insert(row)
      .select('id');

    if (!rowError) {
      inserted += rowInserted?.length || 0;
      continue;
    }

    if (isDuplicateDispatchConflict(rowError)) {
      continue;
    }

    logger.warn({ scheduleId, error: rowError }, `${context} (row fallback)`);
  }

  return inserted;
};

type ProcessingRecoveryRow = {
  id?: string | null;
  schedule_id?: string | null;
  target_id?: string | null;
  feed_item_id?: string | null;
};

const buildDispatchIdentityKey = (
  scheduleId?: string | null,
  targetId?: string | null,
  feedItemId?: string | null
) => {
  const normalizedScheduleId = String(scheduleId || '').trim();
  const normalizedTargetId = String(targetId || '').trim();
  const normalizedFeedItemId = String(feedItemId || '').trim();
  if (!normalizedScheduleId || !normalizedTargetId || !normalizedFeedItemId) {
    return null;
  }
  return `${normalizedScheduleId}:${normalizedTargetId}:${normalizedFeedItemId}`;
};

const computeStaleProcessingThresholdMs = (sendTimeoutMs: number) =>
  Math.max(Math.round(Math.max(sendTimeoutMs, 10000) * 2.5), 120000);

const partitionStaleProcessingRows = (
  rows: ProcessingRecoveryRow[],
  successfulDispatchKeys: Set<string>
) => {
  const toPending: string[] = [];
  const toFailed: string[] = [];

  for (const row of rows || []) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const key = buildDispatchIdentityKey(row?.schedule_id, row?.target_id, row?.feed_item_id);
    if (key && successfulDispatchKeys.has(key)) {
      toFailed.push(id);
      continue;
    }
    toPending.push(id);
  }

  return { toPending, toFailed };
};

const recoverStaleProcessingLogs = async (
  supabase: SupabaseClient,
  settings: Record<string, unknown>,
  options?: { scheduleId?: string | null; context?: string }
) => {
  const scheduleId = String(options?.scheduleId || '').trim();
  const sendTimeoutMs = Math.max(Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS), 10000);
  const staleThresholdMs = computeStaleProcessingThresholdMs(sendTimeoutMs);
  const staleBeforeIso = new Date(Date.now() - staleThresholdMs).toISOString();

  let query = supabase
    .from('message_logs')
    .select('id,schedule_id,target_id,feed_item_id')
    .eq('status', 'processing')
    .not('processing_started_at', 'is', null)
    .lt('processing_started_at', staleBeforeIso);

  if (scheduleId) {
    query = query.eq('schedule_id', scheduleId);
  }

  const { data: staleRows, error: staleRowsError } = await query;
  if (staleRowsError) {
    logger.warn(
      { scheduleId: scheduleId || null, error: staleRowsError, staleBeforeIso },
      options?.context || 'Failed to inspect stale processing queue rows'
    );
    return { recoveredPending: 0, recoveredFailed: 0 };
  }

  const staleProcessingRows = (staleRows || []) as ProcessingRecoveryRow[];
  if (!staleProcessingRows.length) {
    return { recoveredPending: 0, recoveredFailed: 0 };
  }

  const scheduleIds = Array.from(
    new Set(staleProcessingRows.map((row) => String(row.schedule_id || '').trim()).filter(Boolean))
  );
  const feedItemIds = Array.from(
    new Set(staleProcessingRows.map((row) => String(row.feed_item_id || '').trim()).filter(Boolean))
  );

  const successfulDispatchKeys = new Set<string>();
  if (scheduleIds.length && feedItemIds.length) {
    let successfulQuery = supabase
      .from('message_logs')
      .select('schedule_id,target_id,feed_item_id')
      .eq('status', 'sent')
      .in('schedule_id', scheduleIds)
      .in('feed_item_id', feedItemIds);

    if (scheduleId) {
      successfulQuery = successfulQuery.eq('schedule_id', scheduleId);
    }

    const { data: successfulRows, error: successfulRowsError } = await successfulQuery;
    if (successfulRowsError) {
      logger.warn(
        { scheduleId: scheduleId || null, error: successfulRowsError, staleBeforeIso },
        'Failed to inspect successful dispatch rows while recovering stale processing entries'
      );
    } else {
      for (const row of (successfulRows || []) as ProcessingRecoveryRow[]) {
        const key = buildDispatchIdentityKey(row.schedule_id, row.target_id, row.feed_item_id);
        if (key) {
          successfulDispatchKeys.add(key);
        }
      }
    }
  }

  const { toPending, toFailed } = partitionStaleProcessingRows(staleProcessingRows, successfulDispatchKeys);

  if (toPending.length) {
    await supabase
      .from('message_logs')
      .update({
        status: 'pending',
        processing_started_at: null,
        error_message: 'Recovered stale in-progress send after reconnect/redeploy; retrying.'
      })
      .in('id', toPending);
  }

  if (toFailed.length) {
    await supabase
      .from('message_logs')
      .update({
        status: 'uncertain',
        processing_started_at: null,
        error_message: 'Recovered stale in-progress send after reconnect/redeploy. Delivery status is uncertain because another send record already exists.'
      })
      .in('id', toFailed);
  }

  logger.info(
    {
      scheduleId: scheduleId || null,
      staleBeforeIso,
      staleThresholdMs,
      recoveredPending: toPending.length,
      recoveredFailed: toFailed.length
    },
    options?.context || 'Recovered stale processing queue rows'
  );

  return { recoveredPending: toPending.length, recoveredFailed: toFailed.length };
};

const resolveAttemptWindowStartMs = (row: {
  processing_started_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}) => {
  const candidates = [row?.processing_started_at, row?.updated_at, row?.created_at];
  for (const value of candidates) {
    const ts = Date.parse(String(value || ''));
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  return Date.now();
};

const reconcileUncertainMessageLogs = async (supabase: SupabaseClient, settings: Record<string, unknown>) => {
  const sendTimeoutMs = Math.max(Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS), 10000);
  const retryDelayMs = computeUncertainRetryDelayMs(sendTimeoutMs);
  const maxRetries = Number(settings.max_retries || 3);

  const { data: uncertainRows, error: uncertainRowsError } = await supabase
    .from('message_logs')
    .select(
      'id,status,schedule_id,target_id,feed_item_id,message_content,media_url,media_type,whatsapp_message_id,processing_started_at,created_at,updated_at,retry_count'
    )
    .eq('status', 'uncertain')
    .order('created_at', { ascending: true })
    .limit(MAX_UNCERTAIN_LOGS_PER_PASS);

  if (uncertainRowsError) {
    logger.warn({ error: uncertainRowsError }, 'Failed to load uncertain queue rows for reconciliation');
    return { resolvedSent: 0, requeuedPending: 0, terminalFailed: 0, pendingReview: 0 };
  }

  const rows = Array.isArray(uncertainRows) ? uncertainRows : [];
  if (!rows.length) {
    return { resolvedSent: 0, requeuedPending: 0, terminalFailed: 0, pendingReview: 0 };
  }

  const targetIds = Array.from(new Set(rows.map((row) => String(row?.target_id || '').trim()).filter(Boolean)));
  const { data: targetRows, error: targetRowsError } = targetIds.length
    ? await supabase.from('targets').select('id,phone_number,type').in('id', targetIds)
    : { data: [], error: null };
  if (targetRowsError) {
    logger.warn({ error: targetRowsError }, 'Failed to load targets for uncertain queue reconciliation');
    return { resolvedSent: 0, requeuedPending: 0, terminalFailed: 0, pendingReview: rows.length };
  }

  const targetById = new Map(
    (targetRows || []).map((row: { id?: string }) => [String(row.id || ''), row] as const).filter((entry) => Boolean(entry[0]))
  );

  let resolvedSent = 0;
  let requeuedPending = 0;
  let terminalFailed = 0;
  let pendingReview = 0;

  for (const row of rows as Array<{
    id?: string;
    schedule_id?: string | null;
    target_id?: string | null;
    feed_item_id?: string | null;
    message_content?: string | null;
    media_type?: string | null;
    whatsapp_message_id?: string | null;
    processing_started_at?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    retry_count?: number | null;
  }>) {
    const id = String(row?.id || '').trim();
    if (!id) continue;

    const target = targetById.get(String(row?.target_id || '').trim()) as Target | undefined;
    const targetJid = target ? normalizeTargetJid(target) : '';
    const startedAtMs = resolveAttemptWindowStartMs(row);
    const lowerBoundIso = new Date(startedAtMs - UNCERTAIN_MATCH_LOOKBACK_MS).toISOString();
    const upperBoundIso = new Date(Math.min(Date.now(), startedAtMs + sendTimeoutMs + UNCERTAIN_MATCH_GRACE_MS)).toISOString();

    if (!targetJid) {
      pendingReview += 1;
      continue;
    }

    const { data: chatRows, error: chatRowsError } = await supabase
      .from('chat_messages')
      .select('id,whatsapp_id,remote_jid,from_me,content,message_type,media_url,timestamp,created_at,raw_message')
      .eq('remote_jid', targetJid)
      .eq('from_me', true)
      .gte('created_at', lowerBoundIso)
      .lte('created_at', upperBoundIso)
      .order('created_at', { ascending: true })
      .limit(20);

    if (chatRowsError) {
      logger.warn({ error: chatRowsError, logId: id, targetJid }, 'Failed to inspect local WhatsApp messages for uncertain delivery');
      pendingReview += 1;
      continue;
    }

    const candidates = (chatRows || []) as ChatMessageRow[];
    const explicitMessageId = String(row?.whatsapp_message_id || '').trim();
    let matchedCandidate =
      explicitMessageId
        ? candidates.find((candidate) => String(candidate?.whatsapp_id || '').trim() === explicitMessageId) || null
        : null;

    if (!matchedCandidate) {
      const expected = {
        text: String(row?.message_content || '').trim(),
        mediaType: String(row?.media_type || '').trim().toLowerCase() || null
      };
      const matchingCandidates = candidates.filter((candidate) => doesChatMessageMatchExpectedAttempt(candidate, expected));
      if (matchingCandidates.length === 1) {
        matchedCandidate = matchingCandidates[0] || null;
      } else if (!expected.text && !expected.mediaType && candidates.length === 1) {
        matchedCandidate = candidates[0] || null;
      }
    }

    if (matchedCandidate) {
      const sentAtIso = String(matchedCandidate.timestamp || matchedCandidate.created_at || new Date().toISOString());
      await supabase
        .from('message_logs')
        .update({
          status: 'sent',
          sent_at: sentAtIso,
          processing_started_at: null,
          error_message: null,
          whatsapp_message_id: String(matchedCandidate.whatsapp_id || '').trim() || null
        })
        .eq('id', id);

      const feedItemId = String(row?.feed_item_id || '').trim();
      if (feedItemId) {
        await supabase
          .from('feed_items')
          .update({ sent: true, sent_at: sentAtIso })
          .eq('id', feedItemId)
          .eq('sent', false);
      }

      resolvedSent += 1;
      continue;
    }

    const ageMs = Date.now() - startedAtMs;
    if (ageMs < retryDelayMs) {
      pendingReview += 1;
      continue;
    }

    const currentRetry = Number(row?.retry_count || 0);
    const canAutoRetry = Boolean(String(row?.schedule_id || '').trim() && String(row?.feed_item_id || '').trim());

    if (canAutoRetry && currentRetry < maxRetries) {
      await supabase
        .from('message_logs')
        .update({
          status: 'pending',
          processing_started_at: null,
          error_message: `Retry ${currentRetry + 1}/${maxRetries}: delivery was not observed locally after the uncertain-send verification window`,
          retry_count: currentRetry + 1
        })
        .eq('id', id);
      requeuedPending += 1;
      continue;
    }

    await supabase
      .from('message_logs')
      .update({
        status: 'failed',
        processing_started_at: null,
        error_message: canAutoRetry
          ? `Max retries (${maxRetries}) exceeded after uncertain send verification`
          : 'Delivery was not observed locally after the uncertain-send verification window'
      })
      .eq('id', id);
    terminalFailed += 1;
  }

  if (resolvedSent || requeuedPending || terminalFailed) {
    logger.info(
      { resolvedSent, requeuedPending, terminalFailed, pendingReview },
      'Reconciled uncertain queue rows'
    );
  }

  return { resolvedSent, requeuedPending, terminalFailed, pendingReview };
};

let globalLastTargetId: string | null = null;
let globalLastSentAtMs = 0;
const globalLastSentByTargetId = new Map<string, number>();



// Simple Mutex with Timeout to replace the fragile Promise chain
class SendMutex {
  private queue: Array<{ resolve: (release: () => void) => void; timer: NodeJS.Timeout }> = [];
  private locked = false;

  async run<T>(fn: () => Promise<T>, timeoutMs = 60000): Promise<T> {
    const acquire = new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue if timed out
        this.queue = this.queue.filter(item => item.timer !== timer);
        reject(new Error('Acquire send lock timeout'));
      }, timeoutMs);

      if (!this.locked) {
        this.locked = true;
        clearTimeout(timer);
        resolve(() => this.release());
      } else {
        this.queue.push({ resolve: (release) => { clearTimeout(timer); resolve(release); }, timer });
      }
    });

    let release: () => void;
    try {
      release = await acquire;
    } catch (e) {
      logger.warn({ error: e }, 'Failed to acquire send lock, skipping item');
      throw e;
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next.resolve(() => this.release());
    } else {
      this.locked = false;
    }
  }
}

const sendMutex = new SendMutex();
const statusSendMutex = new SendMutex();


// Replaces withGlobalSendLock
const withGlobalSendLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  return sendMutex.run(fn, 120000); // 2 minute max wait to acquire lock
};

const withStatusSendLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  return statusSendMutex.run(fn, 180000);
};

const withTargetSendLock = async <T>(target: Target, fn: () => Promise<T>): Promise<T> => {
  if (target?.type === 'status') {
    return withStatusSendLock(fn);
  }
  return withGlobalSendLock(fn);
};

const waitForDelays = async (
  target: Target,
  settings: Record<string, unknown>
) => {
  const targetId = String(target?.id || target?.phone_number || '').trim();
  const toInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.floor(parsed));
  };
  const baseMessageDelayMs = toInt(settings.message_delay_ms, 0);
  const baseInterTargetDelaySec = toInt(settings.defaultInterTargetDelaySec, 0);
  const baseIntraTargetDelaySec = toInt(settings.defaultIntraTargetDelaySec, 0);

  const messageDelayMs = toInt(target?.message_delay_ms_override ?? baseMessageDelayMs, baseMessageDelayMs);
  const interTargetDelayMs =
    toInt(target?.inter_target_delay_sec_override ?? baseInterTargetDelaySec, baseInterTargetDelaySec) * 1000;
  const intraTargetDelayMs =
    toInt(target?.intra_target_delay_sec_override ?? baseIntraTargetDelaySec, baseIntraTargetDelaySec) * 1000;

  const minBetweenAnyMs = Math.max(messageDelayMs, 0);
  const minBetweenSameTargetMs = Math.max(messageDelayMs, intraTargetDelayMs, 0);

  const now = Date.now();
  // Safety: If globalLastSentAtMs is in the future (bad clock?), reset it
  if (globalLastSentAtMs > now + 30000) globalLastSentAtMs = now;

  const sinceGlobal = globalLastSentAtMs ? now - globalLastSentAtMs : Number.POSITIVE_INFINITY;
  const lastTargetSent = globalLastSentByTargetId.get(targetId) || 0;
  const sinceTarget = lastTargetSent ? now - lastTargetSent : Number.POSITIVE_INFINITY;

  const waitGlobal = Number.isFinite(sinceGlobal) ? Math.max(minBetweenAnyMs - sinceGlobal, 0) : 0;
  const waitSameTarget = Number.isFinite(sinceTarget) ? Math.max(minBetweenSameTargetMs - sinceTarget, 0) : 0;

  const switchedTargets = Boolean(globalLastTargetId && globalLastTargetId !== targetId);
  const waitSwitchTarget = switchedTargets && Number.isFinite(sinceGlobal)
    ? Math.max(interTargetDelayMs - sinceGlobal, 0)
    : 0;

  const waitMs = Math.min(Math.max(waitGlobal, waitSameTarget, waitSwitchTarget), 30000); // Cap wait at 30s
  if (waitMs > 0) {
    await sleep(waitMs);
  }
};

const isAuthStateError = (message: string) => {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return [
    'senderkeyrecord.deserialize',
    'sender key record',
    'not valid json',
    'incorrect private key length',
    'session corrupted',
    'bad key material',
    'no session record'
  ].some((needle) => normalized.includes(needle));
};

const isConnectionStateError = (message: string) => {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return [
    'whatsapp not connected',
    'whatsapp requires qr scan',
    'whatsapp is paused',
    'timed out waiting for whatsapp connection',
    'connection closed',
    'connection failure',
    'socket closed'
  ].some((needle) => normalized.includes(needle));
};

const buildConnectionWaitErrorMessage = (message: string) => {
  const normalized = String(message || '').trim();
  return normalized ? `Waiting for WhatsApp connection: ${normalized}` : 'Waiting for WhatsApp connection';
};

const applyTemplate = (templateBody: string, data: Record<string, unknown>): string => {
  const rendered = templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = data[key];
    return value != null ? escapeWhatsAppFormatting(value) : '';
  });
  return normalizeMessageText(rendered);
};

const isHttpUrl = (value?: string | null) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// Check if URL points to an image (not video/audio)
const isImageUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);

  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg'];
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v'];
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'];

  // Explicitly exclude videos and audio
  if (videoExtensions.some(hasExt)) return false;
  if (audioExtensions.some(hasExt)) return false;

  // Check if it's a known image extension
  return imageExtensions.some(hasExt);
};

const isVideoUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v'];
  return videoExtensions.some(hasExt);
};

const isAudioUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);
  return AUDIO_EXTENSIONS.some(hasExt);
};

const isDocumentUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);
  return DOCUMENT_EXTENSIONS.some(hasExt);
};

const DEFAULT_USER_AGENT = buildDefaultUserAgent();

const normalizeUrlCandidate = (candidate?: string | null, baseUrl?: string | null) => {
  const raw = String(candidate || '').trim();
  if (!raw) return undefined;

  // protocol-relative
  if (raw.startsWith('//')) {
    const value = `https:${raw}`;
    return isHttpUrl(value) ? value : undefined;
  }

  if (isHttpUrl(raw)) return raw;
  if (!baseUrl || !isHttpUrl(baseUrl)) return undefined;

  try {
    const resolved = new URL(raw, baseUrl).toString();
    return isHttpUrl(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
};

const pickFromSrcset = (srcset?: string | null) => {
  const value = String(srcset || '').trim();
  if (!value) return undefined;
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/)[0])
    .filter(Boolean);
  return entries.length ? entries[entries.length - 1] : undefined;
};

const isLikelyDecorativeImageUrl = (value: string) => {
  const lower = String(value || '').toLowerCase();
  const blockedHints = ['logo', 'sprite', 'icon', 'avatar', 'gravatar', 'emoji', 'pixel'];
  return blockedHints.some((hint) => lower.includes(hint));
};

const normalizeImageCandidate = (candidate?: string | null, baseUrl?: string | null) => {
  const resolved = normalizeUrlCandidate(candidate, baseUrl);
  if (!resolved) return undefined;
  if (!isImageUrl(resolved)) return undefined;
  if (isLikelyDecorativeImageUrl(resolved)) return undefined;
  return resolved;
};

const appendStructuredDataImageCandidates = (node: unknown, output: string[]) => {
  if (node == null) return;
  if (typeof node === 'string') {
    output.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      appendStructuredDataImageCandidates(entry, output);
    }
    return;
  }
  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const imageLikeKeys = ['image', 'thumbnailUrl', 'contentUrl', 'primaryImageOfPage'];
  for (const key of imageLikeKeys) {
    appendStructuredDataImageCandidates(record[key], output);
  }

  if (record['@graph']) {
    appendStructuredDataImageCandidates(record['@graph'], output);
  }
};

const collectStructuredDataImageCandidates = ($: any) => {
  const candidates: string[] = [];
  $('script[type="application/ld+json"]').each((_: number, element: unknown) => {
    try {
      const raw = String($(element).contents().text() || '').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      appendStructuredDataImageCandidates(parsed, candidates);
    } catch {
      // Ignore malformed structured data blocks.
    }
  });
  return candidates;
};

const collectDomImageCandidates = ($: any) => {
  const selectors = [
    'article img',
    'main img',
    '.entry-content img',
    '.post-content img',
    '.article-content img',
    '.story-body img',
    'img'
  ];

  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    candidates.push(normalized);
  };

  for (const selector of selectors) {
    const elements = $(selector).slice(0, 8);
    elements.each((_: number, element: unknown) => {
      const img = $(element);
      const srcset = img.attr('data-srcset') || img.attr('srcset');
      pushCandidate(pickFromSrcset(srcset));
      pushCandidate(img.attr('data-src'));
      pushCandidate(img.attr('data-lazy-src'));
      pushCandidate(img.attr('data-original'));
      pushCandidate(img.attr('data-image'));
      pushCandidate(img.attr('src'));
    });
    if (candidates.length >= 20) break;
  }

  return candidates;
};

const scrapeImageFromPage = async (pageUrl: string) => {
  const response = await safeAxiosRequest(pageUrl, {
    timeout: 12000,
    maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 2 * 1024 * 1024,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const html = String(response.data || '');
  const $ = cheerio.load(html);

  const metaCandidates = [
    $('meta[property="og:image:secure_url"]').attr('content'),
    $('meta[property="og:image"]').attr('content'),
    $('meta[property="og:image:url"]').attr('content'),
    $('meta[name="og:image"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
    $('meta[itemprop="image"]').attr('content'),
    $('link[rel="image_src"]').attr('href')
  ];

  for (const raw of metaCandidates) {
    const resolved = normalizeImageCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  const structuredDataCandidates = collectStructuredDataImageCandidates($);
  for (const raw of structuredDataCandidates) {
    const resolved = normalizeImageCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  const domCandidates = collectDomImageCandidates($);
  for (const raw of domCandidates) {
    const resolved = normalizeImageCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  return null;
};

const toOriginOrUndefined = (value?: string | null) => {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const downloadImageBuffer = async (imageUrl: string, refererUrl?: string | null) => {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const SUPPORTED_WHATSAPP_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const validUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const response = await safeAxiosRequest(imageUrl, {
    timeout: 20000,
    responseType: 'arraybuffer',
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent': validUserAgent,
      // Prefer source JPEG/PNG files so CDNs do not transparently re-encode them to WebP.
      'Accept': 'image/jpeg,image/png,image/apng,image/*;q=0.9,*/*;q=0.8',
      'Referer': toOriginOrUndefined(refererUrl),
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"'
    }
  });

  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  const data = response.data;
  let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const detectMimeTypeFromBuffer = (value: Buffer): string | null => {
    if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
      return 'image/jpeg';
    }
    if (
      value.length >= 8 &&
      value[0] === 0x89 &&
      value[1] === 0x50 &&
      value[2] === 0x4e &&
      value[3] === 0x47 &&
      value[4] === 0x0d &&
      value[5] === 0x0a &&
      value[6] === 0x1a &&
      value[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (
      value.length >= 12 &&
      value.slice(0, 4).toString('ascii') === 'RIFF' &&
      value.slice(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return null;
  };

  let preparedMimeType: string | null = null;
  try {
    const prepared = await prepareNewsletterImage(buffer, { maxBytes: MAX_IMAGE_BYTES });
    if (Buffer.isBuffer(prepared?.buffer) && prepared.buffer.length) {
      buffer = prepared.buffer;
    }
    preparedMimeType = String(prepared?.mimetype || '').trim().toLowerCase() || null;
  } catch {
    // Fall through to the raw detection checks below.
  }

  let detectedMimeType = preparedMimeType || detectMimeTypeFromBuffer(buffer);

  // Some sites return formats like AVIF/SVG/GIF even when we prefer jpeg/png/webp.
  // If sharp is available, transcode to JPEG so WhatsApp uploads work reliably.
  if (!detectedMimeType || !SUPPORTED_WHATSAPP_IMAGE_MIME.has(detectedMimeType)) {
    const baseContentType = contentType.split(';')[0]?.trim() || '';
    const isProbablyImage =
      baseContentType.startsWith('image/') || baseContentType === '' || baseContentType === 'application/octet-stream';
    if (!isProbablyImage) {
      throw new Error('URL did not return an image');
    }

    try {
      const prepared = await prepareNewsletterImage(buffer, { maxBytes: MAX_IMAGE_BYTES });
      buffer = prepared.buffer;
      detectedMimeType = prepared.mimetype;
    } catch {
      // Fall through to the normal unsupported checks below.
    }
  }

  if (!detectedMimeType) {
    throw new Error('Unsupported or corrupt image data for WhatsApp upload');
  }
  if (!SUPPORTED_WHATSAPP_IMAGE_MIME.has(detectedMimeType)) {
    const normalizedMimeType = contentType.split(';')[0]?.trim() || '';
    throw new Error(`Unsupported image MIME type for WhatsApp upload (${normalizedMimeType || detectedMimeType})`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${buffer.length} bytes)`);
  }
  return { buffer, mimetype: detectedMimeType };
};

const downloadVideoBuffer = async (videoUrl: string, refererUrl?: string | null) => {
  const MAX_VIDEO_BYTES = Math.max(
    1,
    Math.floor(Number(process.env.MAX_VIDEO_BYTES || process.env.WHATSAPP_MAX_VIDEO_BYTES || 32 * 1024 * 1024))
  );
  const validUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const response = await safeAxiosRequest(videoUrl, {
    timeout: 30000,
    responseType: 'arraybuffer',
    maxContentLength: MAX_VIDEO_BYTES,
    maxBodyLength: MAX_VIDEO_BYTES,
    headers: {
      'User-Agent': validUserAgent,
      Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      'Referer': toOriginOrUndefined(refererUrl),
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"'
    }
  });

  const data = response.data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buffer.length) {
    throw new Error('Video download returned empty body');
  }

  // MP4 typically contains "ftyp" at offset 4.
  const hasMp4Signature = buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
  if (!hasMp4Signature) {
    throw new Error('Unsupported or corrupt video data for WhatsApp upload (expected mp4)');
  }

  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(`Video too large (${buffer.length} bytes)`);
  }

  return { buffer, mimetype: 'video/mp4' };
};

const downloadAudioBuffer = async (audioUrl: string, refererUrl?: string | null) => {
  const MAX_AUDIO_BYTES = Math.max(
    1,
    Math.floor(Number(process.env.MAX_AUDIO_BYTES || process.env.WHATSAPP_MAX_AUDIO_BYTES || 20 * 1024 * 1024))
  );
  const refererOrigin = toOriginOrUndefined(refererUrl);
  const response = await safeAxiosRequest(audioUrl, {
    timeout: Math.max(DEFAULT_SEND_TIMEOUT_MS, 30000),
    responseType: 'arraybuffer',
    maxContentLength: MAX_AUDIO_BYTES,
    maxBodyLength: MAX_AUDIO_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'audio/*;q=0.9,*/*;q=0.8',
      ...(refererOrigin ? { Referer: refererOrigin } : {})
    }
  });
  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  if (!buffer.length) throw new Error('Audio download returned empty body');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error(`Audio too large (${buffer.length} bytes)`);
  const contentTypeHeader = String(response.headers?.['content-type'] || 'audio/mpeg');
  const mimetype = (contentTypeHeader.split(';')[0] || 'audio/mpeg').trim().toLowerCase() || 'audio/mpeg';
  if (!mimetype.startsWith('audio/')) throw new Error('Unsupported audio payload');
  return { buffer, mimetype };
};

const downloadDocumentBuffer = async (documentUrl: string, refererUrl?: string | null) => {
  const MAX_DOCUMENT_BYTES = Math.max(
    1,
    Math.floor(Number(process.env.MAX_DOCUMENT_BYTES || process.env.WHATSAPP_MAX_DOCUMENT_BYTES || 25 * 1024 * 1024))
  );
  const refererOrigin = toOriginOrUndefined(refererUrl);
  const response = await safeAxiosRequest(documentUrl, {
    timeout: Math.max(DEFAULT_SEND_TIMEOUT_MS, 30000),
    responseType: 'arraybuffer',
    maxContentLength: MAX_DOCUMENT_BYTES,
    maxBodyLength: MAX_DOCUMENT_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/*,text/plain,text/csv;q=0.9,*/*;q=0.8',
      ...(refererOrigin ? { Referer: refererOrigin } : {})
    }
  });
  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  if (!buffer.length) throw new Error('Document download returned empty body');
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error(`Document too large (${buffer.length} bytes)`);
  const contentTypeHeader = String(response.headers?.['content-type'] || 'application/octet-stream');
  const mimetype = (contentTypeHeader.split(';')[0] || 'application/octet-stream').trim().toLowerCase() || 'application/octet-stream';
  const filenameHeader = String(response.headers?.['content-disposition'] || '');
  const filenameMatch = filenameHeader.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  const filename = filenameMatch?.[1] ? decodeURIComponent(filenameMatch[1]).replace(/"/g, '').trim() : '';
  return { buffer, mimetype, filename };
};

const maybeUpdateFeedItemImage = async (
  supabase: SupabaseClient | undefined,
  feedItemId: string | undefined,
  patch: Record<string, unknown>
) => {
  if (!supabase || !feedItemId) return;
  try {
    await supabase.from('feed_items').update(patch).eq('id', feedItemId);
  } catch (error) {
    logger.warn({ error, feedItemId }, 'Failed to update feed item image fields');
  }
};

const resolveMediaUrlForFeedItem = async (
  supabase: SupabaseClient | undefined,
  feedItem: FeedItem,
  allowMedia: boolean
): Promise<{
  url: string | null;
  kind: 'image' | 'video' | 'audio' | 'document' | null;
  mime: string | null;
  filename: string | null;
  source: string | null;
  scraped: boolean;
  error: string | null;
}> => {
  if (!allowMedia) {
    return { url: null, kind: null, mime: null, filename: null, source: null, scraped: false, error: null };
  }

  let existingUrlIssue: string | null = null;
  const normalizedMedia = normalizeFeedMedia({
    mediaUrl: feedItem.media_url || (feedItem?.raw_data && typeof feedItem.raw_data === 'object'
      ? (feedItem.raw_data as Record<string, unknown>).media_url
      : null),
    mediaKind: feedItem.media_kind || (feedItem?.raw_data && typeof feedItem.raw_data === 'object'
      ? (feedItem.raw_data as Record<string, unknown>).media_kind
      : null),
    mediaMime: feedItem.media_mime || (feedItem?.raw_data && typeof feedItem.raw_data === 'object'
      ? (feedItem.raw_data as Record<string, unknown>).media_mime
      : null),
    mediaFilename: feedItem.media_filename || (feedItem?.raw_data && typeof feedItem.raw_data === 'object'
      ? (feedItem.raw_data as Record<string, unknown>).media_filename
      : null),
    imageUrl: typeof feedItem.image_url === 'string' ? feedItem.image_url : null,
    rawData: feedItem.raw_data || null
  });
  const existing = normalizedMedia.mediaUrl || null;
  if (existing && isHttpUrl(existing)) {
    const normalizedKind =
      normalizedMedia.mediaKind ||
      (isVideoUrl(existing)
        ? 'video'
        : isAudioUrl(existing)
          ? 'audio'
          : isDocumentUrl(existing)
            ? 'document'
            : isImageUrl(existing)
              ? 'image'
              : null);
    if (normalizedKind === 'image' || normalizedKind === 'video' || normalizedKind === 'audio' || normalizedKind === 'document') {
      try {
        await assertSafeOutboundUrl(existing);
        return {
          url: existing,
          kind: normalizedKind,
          mime: normalizedMedia.mediaMime || null,
          filename: normalizedMedia.mediaFilename || null,
          source: feedItem.image_source || 'feed',
          scraped: false,
          error: null
        };
      } catch (error) {
        existingUrlIssue = getErrorMessage(error);
      }
    } else {
      existingUrlIssue = 'Feed media URL is not a supported WhatsApp media type';
    }
  }

  const link = typeof feedItem.link === 'string' ? feedItem.link : null;
  if (!link || !isHttpUrl(link)) {
    return { url: null, kind: null, mime: null, filename: null, source: null, scraped: false, error: existingUrlIssue };
  }

  const scrapedAt = feedItem.image_scraped_at ? new Date(feedItem.image_scraped_at).getTime() : 0;
  const recentlyScraped = scrapedAt && !Number.isNaN(scrapedAt) && Date.now() - scrapedAt < 24 * 60 * 60 * 1000;
  if (recentlyScraped) {
    return {
      url: null,
      kind: null,
      mime: null,
      filename: null,
      source: null,
      scraped: false,
      error: feedItem.image_scrape_error || existingUrlIssue || null
    };
  }

  try {
    const scraped = await scrapeImageFromPage(link);
    const nowIso = new Date().toISOString();
    if (scraped) {
      try {
        await assertSafeOutboundUrl(scraped);
      } catch (error) {
        const message = getErrorMessage(error);
        feedItem.image_scraped_at = nowIso;
        feedItem.image_scrape_error = message;
        await maybeUpdateFeedItemImage(supabase, feedItem.id, {
          image_scraped_at: nowIso,
          image_scrape_error: message
        });
        return { url: null, kind: null, mime: null, filename: null, source: null, scraped: true, error: message };
      }

      feedItem.image_url = scraped;
      feedItem.image_source = 'page';
      feedItem.image_scraped_at = nowIso;
      feedItem.image_scrape_error = null;
      await maybeUpdateFeedItemImage(supabase, feedItem.id, {
        image_url: scraped,
        image_source: 'page',
        image_scraped_at: nowIso,
        image_scrape_error: null
      });
      return { url: scraped, kind: 'image', mime: 'image/*', filename: null, source: 'page', scraped: true, error: null };
    }

    feedItem.image_scraped_at = nowIso;
    feedItem.image_scrape_error = 'No image found on page';
    await maybeUpdateFeedItemImage(supabase, feedItem.id, {
      image_scraped_at: nowIso,
      image_scrape_error: 'No image found on page'
    });
    return { url: null, kind: null, mime: null, filename: null, source: null, scraped: true, error: 'No image found on page' };
  } catch (error) {
    const message = getErrorMessage(error);
    const nowIso = new Date().toISOString();
    feedItem.image_scraped_at = nowIso;
    feedItem.image_scrape_error = message;
    await maybeUpdateFeedItemImage(supabase, feedItem.id, {
      image_scraped_at: nowIso,
      image_scrape_error: message
    });
    return { url: null, kind: null, mime: null, filename: null, source: null, scraped: true, error: message };
  }
};

const normalizeTargetJid = (target: Target) => {
  const normalized = normalizeTargetJidForSend(target);
  if (!normalized) {
    throw new Error('Target destination is invalid');
  }
  return normalized;
};

const buildMessageData = (feedItem: FeedItem) => ({
  id: feedItem.id,
  guid: (feedItem as unknown as { guid?: string }).guid,
  title: feedItem.title,
  url: feedItem.link,
  link: feedItem.link,
  description: feedItem.description,
  content: feedItem.content,
  author: feedItem.author,
  image_url: feedItem.image_url,
  imageUrl: feedItem.image_url,
  media_url: feedItem.media_url || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_url
    : ''),
  mediaUrl: feedItem.media_url || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_url
    : ''),
  media_kind: feedItem.media_kind || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_kind
    : ''),
  mediaKind: feedItem.media_kind || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_kind
    : ''),
  media_mime: feedItem.media_mime || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_mime
    : ''),
  mediaMime: feedItem.media_mime || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_mime
    : ''),
  media_filename: feedItem.media_filename || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_filename
    : ''),
  mediaFilename: feedItem.media_filename || (typeof feedItem.raw_data === 'object' && feedItem.raw_data
    ? (feedItem.raw_data as Record<string, unknown>).media_filename
    : ''),
  normalized_url: (feedItem as unknown as { normalized_url?: string }).normalized_url,
  normalizedUrl: (feedItem as unknown as { normalized_url?: string }).normalized_url,
  content_hash: (feedItem as unknown as { content_hash?: string }).content_hash,
  contentHash: (feedItem as unknown as { content_hash?: string }).content_hash,
  pub_date: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  publishedAt: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  categories: Array.isArray(feedItem.categories) ? feedItem.categories.join(', ') : '',
  ...(typeof (feedItem as unknown as { raw_data?: unknown }).raw_data === 'object' &&
    (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
    ? Object.fromEntries(
      Object.entries((feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data || {}).map(
        ([key, value]) => {
          if (value == null) return [key, ''];
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [key, value];
          try {
            return [key, JSON.stringify(value)];
          } catch {
            return [key, String(value)];
          }
        }
      )
    )
    : {})
});

const hasHttpUrl = (value: string) => /https?:\/\/[^\s]+/i.test(String(value || ''));

const ensurePreviewLink = (value: string, link?: string | null) => {
  const text = String(value || '').trim();
  const normalizedLink = String(link || '').trim();
  if (!normalizedLink) return text;
  if (hasHttpUrl(text)) return text;
  if (!text) return normalizedLink;
  return `${text}\n${normalizedLink}`;
};

type TemplateSendMode = 'auto_media' | 'media_only' | 'text_preview' | 'text_only';

const getTemplateSendMode = (template: Template): TemplateSendMode => {
  if ((template?.send_mode === 'image' || template?.send_mode === 'auto_media') && template?.send_images === false) {
    return 'text_preview';
  }
  if (
    template?.send_mode === 'auto_media' ||
    template?.send_mode === 'media_only' ||
    template?.send_mode === 'text_preview' ||
    template?.send_mode === 'text_only'
  ) {
    return template.send_mode as TemplateSendMode;
  }
  if (template?.send_mode === 'image') return 'auto_media';
  if (template?.send_mode === 'image_only') return 'media_only';
  if (template?.send_mode === 'link_preview') return 'text_preview';
  return template?.send_images === false ? 'text_preview' : 'auto_media';
};

const renderTemplateMessage = (
  template: Template,
  feedItem: FeedItem,
  overrideText?: string | null
): {
  sendMode: TemplateSendMode;
  renderedText: string;
  textWithPreview: string;
  outboundText: string;
  includeImageCaption: boolean;
  allowTextFallback: boolean;
} => {
  const payload = buildMessageData(feedItem);
  const manualOverrideText = normalizeMessageText(String(overrideText || '')).trim();
  const renderedText = (manualOverrideText || applyTemplate(template.content, payload)).trim();
  if (!renderedText) {
    throw new Error('Template rendered empty message');
  }

  const sendMode = getTemplateSendMode(template);
  const includeImageCaption = sendMode !== 'media_only';
  const allowTextFallback = sendMode !== 'media_only';
  const textWithPreview = ensurePreviewLink(renderedText, feedItem.link);
  const outboundText =
    sendMode === 'text_only'
      ? renderedText
      : sendMode === 'text_preview'
        ? textWithPreview
        : includeImageCaption
          ? renderedText
          : '';

  return {
    sendMode,
    renderedText,
    textWithPreview,
    outboundText,
    includeImageCaption,
    allowTextFallback
  };
};

type SendWithMediaResult = {
  response: any;
  text: string;
  media: {
    type: string | null;
    url: string | null;
    sent: boolean;
    error: string | null;
  };
};

const sendMessageWithTemplate = async (
  whatsappClient: WhatsAppClient,
  target: Target,
  template: Template,
  feedItem: FeedItem,
  options?: { sendImages?: boolean; supabase?: SupabaseClient; sendTimeoutMs?: number; overrideText?: string | null }
): Promise<SendWithMediaResult> => {
  if (!whatsappClient || whatsappClient.getStatus().status !== 'connected') {
    throw new Error('WhatsApp not connected');
  }

  if (!target?.phone_number) {
    throw new Error('Target phone number missing');
  }
  if (target.type === 'status' && !WHATSAPP_STATUS_ENABLED) {
    throw new Error(WHATSAPP_STATUS_DISABLED_REASON);
  }

  const jid = normalizeTargetJid(target);
  const allowImages = options?.sendImages !== false;
  const sendTimeoutMs = Math.max(Number(options?.sendTimeoutMs || DEFAULT_SEND_TIMEOUT_MS), 10000);
  const rendered = renderTemplateMessage(template, feedItem, options?.overrideText);
  const sendMode = rendered.sendMode;
  const includeImageCaption = rendered.includeImageCaption;
  const allowTextFallback = rendered.allowTextFallback;
  const renderedText = rendered.renderedText;
  const textWithPreview = rendered.textWithPreview;
  const buildStatusOptions = async () => {
    if (target.type !== 'status') return undefined;
    const snapshot = await ensureFreshStatusRecipients(whatsappClient, { maxAgeMinutes: 10, sampleSize: 25 });
    if (!snapshot.recipients.length) {
      throw new Error('No fresh status recipients are available for this status send.');
    }
    return { statusJidList: snapshot.recipients };
  };

  const sendText = async (text: string, modeOptions?: { disableLinkPreview?: boolean }) => {
    const content: Record<string, unknown> = modeOptions?.disableLinkPreview
      ? { text, linkPreview: null }
      : { text };
    if (target.type === 'status') {
      const statusOptions = await buildStatusOptions();
      return withTimeout(
        whatsappClient.sendStatusBroadcast(content, statusOptions),
        getStatusSendTimeoutMs('text', sendTimeoutMs),
        'Timed out sending status message'
      );
    }
    return withTimeout(
      whatsappClient.sendMessage(jid, content),
      sendTimeoutMs,
      'Timed out sending message'
    );
  };

  if (sendMode === 'text_only') {
    const response = await sendText(renderedText, { disableLinkPreview: true });
    return {
      response,
      text: renderedText,
      media: { type: null, url: null, sent: false, error: null }
    };
  }

  if (sendMode === 'text_preview') {
    const response = await sendText(textWithPreview);
    return {
      response,
      text: textWithPreview,
      media: { type: null, url: null, sent: false, error: null }
    };
  }

  const resolved = await resolveMediaUrlForFeedItem(options?.supabase, feedItem, allowImages);
  if (sendMode === 'media_only' && !resolved.url) {
    throw new Error('Media-only mode requires an available media file for this feed item');
  }

  if (allowImages && resolved.url) {
    let safeUrl: string;
    try {
      safeUrl = (await assertSafeOutboundUrl(resolved.url)).toString();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn({ error, jid, mediaUrl: resolved.url, kind: resolved.kind }, 'Blocked unsafe media URL');
      if (!allowTextFallback) {
        throw new Error(`Image-only mode blocked unsafe media URL: ${message}`);
      }
      const response = await sendText(textWithPreview);
      return {
        response,
        text: textWithPreview,
        media: { type: resolved.kind || 'image', url: resolved.url, sent: false, error: message }
      };
    }

    if (resolved.kind === 'video') {
      try {
        const { buffer, mimetype } = await downloadVideoBuffer(safeUrl, feedItem.link);
        let sendBuffer = buffer;
        let sendMime = mimetype;
        let newsletterExtras: Record<string, unknown> | null = null;
        if (isNewsletterJid(jid)) {
          try {
            const prepared = await prepareNewsletterVideo(buffer, { maxBytes: 32 * 1024 * 1024 });
            sendBuffer = prepared.buffer;
            sendMime = prepared.mimetype || sendMime;
            newsletterExtras = {
              ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
              ...(typeof prepared.seconds === 'number' ? { seconds: prepared.seconds } : {}),
              ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
              ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
            };
          } catch (error) {
            logger.warn(
              { error, jid, originalSize: buffer.length, maxBytes: 32 * 1024 * 1024 },
              'Failed to normalize newsletter video; sending original buffer (may fail if too large)'
            );
          }
        }

        const content: Record<string, unknown> = includeImageCaption
          ? { video: sendBuffer, caption: renderedText }
          : { video: sendBuffer };
        if (sendMime) {
          content.mimetype = sendMime;
        }
        if (newsletterExtras && Object.keys(newsletterExtras).length) {
          Object.assign(content, newsletterExtras);
        }

        const statusOptions = target.type === 'status' ? await buildStatusOptions() : undefined;
        const response =
          target.type === 'status'
            ? await withTimeout(
              whatsappClient.sendStatusBroadcast(content, statusOptions),
              getStatusSendTimeoutMs('media', sendTimeoutMs),
              'Timed out sending video status message'
            )
            : await withTimeout(
              whatsappClient.sendMessage(jid, content),
              sendTimeoutMs,
              'Timed out sending video message'
            );

        return {
          response,
          text: includeImageCaption ? renderedText : '',
          media: { type: 'video', url: safeUrl, sent: true, error: null }
        };
      } catch (error) {
        const bufferErrorMessage = getErrorMessage(error);
        if (!allowTextFallback) {
          throw new Error(bufferErrorMessage);
        }
        logger.warn({ error, jid, videoUrl: safeUrl }, 'Video send failed; using text fallback');
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: { type: 'video', url: safeUrl, sent: false, error: bufferErrorMessage }
        };
      }
    }

    if (resolved.kind === 'audio') {
      if (target.type === 'status') {
        if (!allowTextFallback) {
          throw new Error('Status only supports text, image, and video');
        }
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: { type: 'audio', url: safeUrl, sent: false, error: 'Status only supports text, image, and video' }
        };
      }
      try {
        const { buffer, mimetype } = await downloadAudioBuffer(safeUrl, feedItem.link);
        const content: Record<string, unknown> = { audio: buffer, mimetype, ptt: false };
        const response = await withTimeout(
          whatsappClient.sendMessage(jid, content),
          sendTimeoutMs,
          'Timed out sending audio message'
        );
        return {
          response,
          text: '',
          media: { type: 'audio', url: safeUrl, sent: true, error: null }
        };
      } catch (error) {
        const bufferErrorMessage = getErrorMessage(error);
        if (!allowTextFallback) {
          throw new Error(bufferErrorMessage);
        }
        logger.warn({ error, jid, audioUrl: safeUrl }, 'Audio send failed; using text fallback');
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: { type: 'audio', url: safeUrl, sent: false, error: bufferErrorMessage }
        };
      }
    }

    if (resolved.kind === 'document') {
      if (target.type === 'status') {
        if (!allowTextFallback) {
          throw new Error('Status only supports text, image, and video');
        }
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: { type: 'document', url: safeUrl, sent: false, error: 'Status only supports text, image, and video' }
        };
      }
      try {
        const { buffer, mimetype, filename } = await downloadDocumentBuffer(safeUrl, feedItem.link);
        const content: Record<string, unknown> = {
          document: buffer,
          mimetype: resolved.mime || mimetype || 'application/octet-stream',
          fileName: resolved.filename || filename || 'attachment'
        };
        if (includeImageCaption && renderedText) {
          content.caption = renderedText;
        }
        const response = await withTimeout(
          whatsappClient.sendMessage(jid, content),
          sendTimeoutMs,
          'Timed out sending document message'
        );
        return {
          response,
          text: includeImageCaption ? renderedText : '',
          media: { type: 'document', url: safeUrl, sent: true, error: null }
        };
      } catch (error) {
        const bufferErrorMessage = getErrorMessage(error);
        if (!allowTextFallback) {
          throw new Error(bufferErrorMessage);
        }
        logger.warn({ error, jid, documentUrl: safeUrl }, 'Document send failed; using text fallback');
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: { type: 'document', url: safeUrl, sent: false, error: bufferErrorMessage }
        };
      }
    }

    try {
      const { buffer, mimetype } = await downloadImageBuffer(safeUrl, feedItem.link);
      let sendBuffer = buffer;
      let sendMime = mimetype;
      let newsletterExtras: Record<string, unknown> | null = null;
      if (isNewsletterJid(jid)) {
        try {
          const prepared = await prepareNewsletterImage(buffer, { maxBytes: 8 * 1024 * 1024 });
          sendBuffer = prepared.buffer;
          sendMime = prepared.mimetype || sendMime;
          newsletterExtras = {
            ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
            ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
            ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
          };
        } catch (error) {
          logger.warn(
            { error, jid, originalSize: buffer.length, maxBytes: 8 * 1024 * 1024 },
            'Failed to normalize newsletter image; sending original buffer (may fail if too large)'
          );
        }
      }

      const content: Record<string, unknown> = includeImageCaption
        ? { image: sendBuffer, caption: renderedText }
        : { image: sendBuffer };
      if (sendMime) {
        content.mimetype = sendMime;
      }
      if (newsletterExtras && Object.keys(newsletterExtras).length) {
        Object.assign(content, newsletterExtras);
      }

      const statusOptions = target.type === 'status' ? await buildStatusOptions() : undefined;
      const response =
        target.type === 'status'
          ? await withTimeout(
            whatsappClient.sendStatusBroadcast(content, statusOptions),
            getStatusSendTimeoutMs('media', sendTimeoutMs),
            'Timed out sending image status message'
          )
          : await withTimeout(
            whatsappClient.sendMessage(jid, content),
            sendTimeoutMs,
            'Timed out sending image message'
          );

      return {
        response,
        text: includeImageCaption ? renderedText : '',
        media: { type: 'image', url: safeUrl, sent: true, error: null }
      };
    } catch (error) {
      const bufferErrorMessage = getErrorMessage(error);
      const isUnsupportedImage =
        /Unsupported image MIME type for WhatsApp upload|Unsupported or corrupt image data for WhatsApp upload|URL did not return an image/i.test(
          bufferErrorMessage
        );

      if (!allowTextFallback) {
        throw new Error(bufferErrorMessage);
      }

      if (isUnsupportedImage) {
        logger.info(
          { jid, imageUrl: safeUrl, reason: bufferErrorMessage },
          'Skipping unsupported image type and falling back to text'
        );
      } else {
        logger.warn({ error, jid, imageUrl: safeUrl }, 'Image send failed; using text fallback');
      }

      const response = await sendText(textWithPreview);
      return {
        response,
        text: textWithPreview,
        media: { type: 'image', url: safeUrl, sent: false, error: bufferErrorMessage }
      };
    }
  }

  if (sendMode === 'media_only') {
    throw new Error('Media-only mode could not find a usable media file to send');
  }

  const response = await sendText(textWithPreview);
  return {
    response,
    text: textWithPreview,
    media: { type: null, url: null, sent: false, error: null }
  };
};

type ReconcileUpdatedFeedItemsResult = {
  processed: number;
  refreshed: number;
  edited: number;
  replaced: number;
  skipped: number;
  failed: number;
  reason?: string;
};

const parseWindowMinutes = (value: unknown, fallbackMinutes: number, maxMinutes = 720) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackMinutes;
  return Math.min(Math.max(Math.floor(parsed), 1), maxMinutes);
};

const getPostSendWindows = (settings: Record<string, unknown>) => {
  const editMinutes = parseWindowMinutes(
    settings.post_send_edit_window_minutes,
    DEFAULT_POST_SEND_EDIT_WINDOW_MINUTES,
    MAX_POST_SEND_EDIT_WINDOW_MINUTES
  );
  const correctionMinutes = Math.max(
    editMinutes,
    parseWindowMinutes(
      settings.post_send_correction_window_minutes,
      DEFAULT_POST_SEND_CORRECTION_WINDOW_MINUTES,
      MAX_POST_SEND_CORRECTION_WINDOW_MINUTES
    )
  );
  return {
    editWindowMs: editMinutes * 60 * 1000,
    correctionWindowMs: correctionMinutes * 60 * 1000
  };
};

const getSentAgeMs = (sentAt: unknown): number | null => {
  const iso = String(sentAt || '').trim();
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(Date.now() - parsed, 0);
};

const reconcileUpdatedFeedItems = async (
  updatedFeedItems: FeedItem[],
  whatsappClient?: WhatsAppClient | null
): Promise<ReconcileUpdatedFeedItemsResult> => {
  const result: ReconcileUpdatedFeedItemsResult = {
    processed: 0,
    refreshed: 0,
    edited: 0,
    replaced: 0,
    skipped: 0,
    failed: 0
  };

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ...result, reason: 'Database not available' };
  }

  if (!Array.isArray(updatedFeedItems) || updatedFeedItems.length === 0) {
    return result;
  }

  if (await settingsService.isAppPaused()) {
    return { ...result, reason: 'App is paused' };
  }

  if (!whatsappClient || whatsappClient.getStatus().status !== 'connected') {
    return { ...result, reason: 'WhatsApp not connected' };
  }

  const byFeedItemId = new Map<string, FeedItem>();
  for (const item of updatedFeedItems) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    byFeedItemId.set(id, item);
  }

  const feedItemIds = Array.from(byFeedItemId.keys());
  if (!feedItemIds.length) {
    return result;
  }

  const settings = await settingsService.getSettings();
  const sendTimeoutMs = Math.max(Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS), 10000);
  const { editWindowMs, correctionWindowMs } = getPostSendWindows(settings);
  const correctionCutoffIso = new Date(Date.now() - correctionWindowMs).toISOString();

  type CorrectionLogRow = {
    id: string;
    feed_item_id?: string | null;
    target_id?: string | null;
    template_id?: string | null;
    status?: string | null;
    sent_at?: string | null;
    whatsapp_message_id?: string | null;
    message_content?: string | null;
    media_url?: string | null;
    media_type?: string | null;
    corrected_at?: string | null;
    correction_kind?: string | null;
    correction_error?: string | null;
  };

  const [sentLogsRes, queuedLogsRes] = await Promise.all([
    supabase
      .from('message_logs')
      .select('id,feed_item_id,target_id,template_id,status,sent_at,whatsapp_message_id,message_content,media_url,media_type,corrected_at,correction_kind,correction_error')
      .in('feed_item_id', feedItemIds)
      .in('status', Array.from(SUCCESSFUL_SEND_STATUSES))
      .gte('sent_at', correctionCutoffIso)
      .not('target_id', 'is', null),
    supabase
      .from('message_logs')
      .select('id,feed_item_id,target_id,template_id,status,sent_at,whatsapp_message_id,message_content,media_url,media_type,corrected_at,correction_kind,correction_error')
      .in('feed_item_id', feedItemIds)
      .in('status', Array.from(QUEUED_CORRECTION_STATUSES))
      .not('target_id', 'is', null)
  ]);

  if (sentLogsRes.error || queuedLogsRes.error) {
    logger.warn(
      { sentLogsError: sentLogsRes.error, queuedLogsError: queuedLogsRes.error },
      'Failed loading message logs for feed-item reconciliation'
    );
    return { ...result, reason: 'Failed loading message logs' };
  }

  const sentLogs = (sentLogsRes.data || []) as CorrectionLogRow[];
  const queuedLogs = (queuedLogsRes.data || []) as CorrectionLogRow[];
  if (!sentLogs.length && !queuedLogs.length) {
    return result;
  }

  const targetIds = Array.from(
    new Set(
      [...sentLogs, ...queuedLogs]
        .map((row) => String(row.target_id || '').trim())
        .filter(Boolean)
    )
  );
  const templateIds = Array.from(
    new Set(
      [...sentLogs, ...queuedLogs]
        .map((row) => String(row.template_id || '').trim())
        .filter(Boolean)
    )
  );

  const [targetsRes, templatesRes] = await Promise.all([
    targetIds.length
      ? supabase.from('targets').select('*').in('id', targetIds)
      : Promise.resolve({ data: [], error: null }),
    templateIds.length
      ? supabase.from('templates').select('*').in('id', templateIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (targetsRes.error || templatesRes.error) {
    logger.warn(
      { targetError: targetsRes.error, templateError: templatesRes.error },
      'Failed loading targets/templates for feed-item reconciliation'
    );
    return { ...result, reason: 'Failed loading targets/templates' };
  }

  const targetsById = new Map<string, Target>();
  for (const row of (targetsRes.data || []) as Target[]) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    targetsById.set(id, row);
  }

  const templatesById = new Map<string, Template>();
  for (const row of (templatesRes.data || []) as Template[]) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    templatesById.set(id, row);
  }

  const applyCorrectionSnapshot = async (
    log: CorrectionLogRow,
    desired: { text: string; mediaUrl: string | null; mediaType: string | null },
    kind: string,
    correctionError?: string | null
  ) => {
    await supabase
      .from('message_logs')
      .update({
        message_content: desired.text || null,
        media_url: desired.mediaUrl,
        media_type: desired.mediaType,
        corrected_at: new Date().toISOString(),
        correction_kind: kind,
        correction_error: correctionError || null
      })
      .eq('id', log.id);
  };

  for (const log of queuedLogs) {
    const feedItemId = String(log.feed_item_id || '').trim();
    const targetId = String(log.target_id || '').trim();
    const templateId = String(log.template_id || '').trim();

    const feedItem = byFeedItemId.get(feedItemId);
    const target = targetsById.get(targetId);
    const template = templatesById.get(templateId);

    if (!feedItem || !target || !template || target.active === false) {
      result.skipped += 1;
      continue;
    }

    let rendered: ReturnType<typeof renderTemplateMessage>;
    let expectedMedia: Awaited<ReturnType<typeof resolveMediaUrlForFeedItem>>;
    try {
      rendered = renderTemplateMessage(template, feedItem);
      expectedMedia =
        rendered.sendMode === 'auto_media' || rendered.sendMode === 'media_only'
          ? await resolveMediaUrlForFeedItem(supabase, feedItem, true)
          : { url: null, kind: null, mime: null, filename: null, source: null, scraped: false, error: null };
    } catch (error) {
      result.failed += 1;
      logger.warn({ error, feedItemId, targetId, templateId }, 'Failed to render updated template for queued message');
      continue;
    }

    const desiredText = String(rendered.outboundText || '').trim();
    const desiredMediaUrl = String(expectedMedia.url || '').trim() || null;
    const desiredMediaType = normalizeComparableMediaType(expectedMedia.kind);
    if (!desiredText && !desiredMediaUrl) {
      result.skipped += 1;
      continue;
    }

    if (!hasCorrectionChanges(
      {
        text: normalizeMessageText(String(log.message_content || '')).trim(),
        mediaUrl: log.media_url,
        mediaType: log.media_type
      },
      {
        text: normalizeMessageText(desiredText).trim(),
        mediaUrl: desiredMediaUrl,
        mediaType: desiredMediaType
      }
    )) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;
    try {
      await applyCorrectionSnapshot(
        log,
        {
          text: desiredText,
          mediaUrl: desiredMediaUrl,
          mediaType: desiredMediaType
        },
        'pending_refresh'
      );
      result.refreshed += 1;
    } catch (error) {
      result.failed += 1;
      logger.warn(
        { error, logId: log.id, targetId, feedItemId, status: log.status },
        'Failed to refresh queued message snapshot during feed reconciliation'
      );
    }
  }

  for (const log of sentLogs) {
    const feedItemId = String(log.feed_item_id || '').trim();
    const targetId = String(log.target_id || '').trim();
    const templateId = String(log.template_id || '').trim();

    const feedItem = byFeedItemId.get(feedItemId);
    const target = targetsById.get(targetId);
    const template = templatesById.get(templateId);

    if (!feedItem || !target || !template || target.active === false) {
      result.skipped += 1;
      continue;
    }

    let rendered: ReturnType<typeof renderTemplateMessage>;
    let expectedMedia: Awaited<ReturnType<typeof resolveMediaUrlForFeedItem>>;
    try {
      rendered = renderTemplateMessage(template, feedItem);
      expectedMedia =
        rendered.sendMode === 'auto_media' || rendered.sendMode === 'media_only'
          ? await resolveMediaUrlForFeedItem(supabase, feedItem, true)
          : { url: null, kind: null, mime: null, filename: null, source: null, scraped: false, error: null };
    } catch (error) {
      result.failed += 1;
      logger.warn({ error, feedItemId, targetId, templateId }, 'Failed to render updated template for sent message');
      continue;
    }

    const desiredText = String(rendered.outboundText || '').trim();
    const desiredMediaUrl = String(expectedMedia.url || '').trim() || null;
    const desiredMediaType = normalizeComparableMediaType(expectedMedia.kind);
    if (!desiredText && !desiredMediaUrl) {
      result.skipped += 1;
      continue;
    }

    if (!hasCorrectionChanges(
      {
        text: normalizeMessageText(String(log.message_content || '')).trim(),
        mediaUrl: log.media_url,
        mediaType: log.media_type
      },
      {
        text: normalizeMessageText(desiredText).trim(),
        mediaUrl: desiredMediaUrl,
        mediaType: desiredMediaType
      }
    )) {
      result.skipped += 1;
      continue;
    }

    const sentAgeMs = getSentAgeMs(log.sent_at);
    if (sentAgeMs == null || sentAgeMs > correctionWindowMs) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const normalizedTargetId = String(target.id || target.phone_number || targetId);
    let jid = '';
    try {
      jid = normalizeTargetJid(target);
    } catch (error) {
      result.failed += 1;
      logger.warn({ error, logId: log.id, targetId }, 'Failed to normalize target JID for feed-item reconciliation');
      continue;
    }
    const whatsappMessageId = String(log.whatsapp_message_id || '').trim();
    const correctionStrategy = chooseCorrectionStrategy({
      targetType: target.type,
      sentAgeMs,
      editWindowMs,
      correctionWindowMs,
      hasMessageId: Boolean(whatsappMessageId),
      supportsEdit: Boolean(whatsappClient.editMessage),
      supportsDelete: Boolean(whatsappClient.deleteMessage),
      currentMediaType: String(log.media_type || '').trim() || null,
      desiredMediaType
    });

    if (correctionStrategy === 'edit') {
      try {
        await withGlobalSendLock(async () => {
          await waitForDelays(target as Target, settings);
          await withTimeout(
            whatsappClient.editMessage!(
              jid,
              whatsappMessageId,
              desiredText
            ),
            sendTimeoutMs,
            'Timed out editing message'
          );
        });

        await supabase
          .from('message_logs')
          .update({
            message_content: desiredText,
            error_message: null,
            corrected_at: new Date().toISOString(),
            correction_kind: 'edit',
            correction_error: null
          })
          .eq('id', log.id);

        result.edited += 1;
        continue;
      } catch (error) {
        logger.warn(
          { error, logId: log.id, targetId, feedItemId },
          'Failed to edit sent message during feed reconciliation; falling back to replacement when available'
        );
        if (!whatsappClient.deleteMessage) {
          result.failed += 1;
          continue;
        }
      }
    }

    if (correctionStrategy === 'replace' || (correctionStrategy === 'edit' && Boolean(whatsappClient.deleteMessage))) {
      try {
        const replacementResult = await withGlobalSendLock(async () => {
          await waitForDelays(target as Target, settings);
          await withTimeout(
            whatsappClient.deleteMessage!(jid, whatsappMessageId),
            sendTimeoutMs,
            'Timed out deleting message before replacement'
          );
          return sendMessageWithTemplate(
            whatsappClient,
            target,
            template,
            feedItem,
            {
              supabase,
              sendTimeoutMs
            }
          );
        });

        await supabase
          .from('message_logs')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            message_content: replacementResult?.text || null,
            whatsapp_message_id: replacementResult?.response?.key?.id || null,
            media_url: replacementResult?.media?.url || null,
            media_type: replacementResult?.media?.type || null,
            media_sent: Boolean(replacementResult?.media?.sent),
            media_error: replacementResult?.media?.error || null,
            error_message: null,
            corrected_at: new Date().toISOString(),
            correction_kind: 'replacement',
            correction_error: null
          })
          .eq('id', log.id);

        result.replaced += 1;
        continue;
      } catch (error) {
        result.failed += 1;
        await supabase
          .from('message_logs')
          .update({
            corrected_at: new Date().toISOString(),
            correction_error: getErrorMessage(error)
          })
          .eq('id', log.id);
        logger.warn(
          { error, logId: log.id, targetId, feedItemId, targetType: target.type },
          'Failed to replace sent message during feed reconciliation'
        );
        continue;
      }
    }

    result.skipped += 1;
    logger.debug(
      {
        logId: log.id,
        targetId,
        feedItemId,
        sentAgeMs,
        editWindowMs,
        correctionWindowMs,
        hasEditMessageId: Boolean(whatsappMessageId),
        targetType: target.type,
        desiredMediaType
      },
      'Skipping correction because this target/message does not support edit or replacement'
    );
  }

  return result;
};

type Schedule = {
  id: string;
  feed_id?: string | null;
  template_id?: string | null;
  target_ids?: string[];
  state?: string | null;
  delivery_mode?: 'immediate' | 'batched' | 'batch' | null;
  batch_times?: string[] | null;
  cron_expression?: string | null;
  timezone?: string | null;
  last_run_at?: string | null;
  last_queued_at?: string | null;
  last_dispatched_at?: string | null;
  created_at?: string | null;
  active?: boolean;
  approval_required?: boolean | null;
};

type SendQueuedOptions = {
  skipFeedRefresh?: boolean;
  allowOverdueBatchDispatch?: boolean;
  skipQueueGeneration?: boolean;
};

const parseBatchTimes = (value: unknown): string[] => {
  const seen = new Set<string>();
  const times = Array.isArray(value) ? value : [];
  for (const time of times) {
    const normalized = String(time || '').trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) continue;
    seen.add(normalized);
  }
  return Array.from(seen).sort();
};

const getLocalMinuteOfDay = (timezone?: string | null, date = new Date()) => {
  const tz = String(timezone || 'UTC').trim() || 'UTC';
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return Number.NaN;
  return hour * 60 + minute;
};

const normalizeBatchGraceMinutes = (value: number) => {
  if (!Number.isFinite(value)) return 8;
  return Math.min(Math.max(Math.floor(value), 1), 30);
};

const isMinuteAlignedToBatchTimes = (
  minuteOfDay: number,
  times: string[],
  graceMinutes: number
) => {
  if (!times.length || !Number.isFinite(minuteOfDay)) return false;
  const grace = normalizeBatchGraceMinutes(graceMinutes);
  return times.some((time) => {
    const [hourRaw, minuteRaw] = String(time).split(':');
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const targetMinute = hour * 60 + minute;
    const directDiff = Math.abs(minuteOfDay - targetMinute);
    const wrappedDiff = Math.min(directDiff, 1440 - directDiff);
    return wrappedDiff <= grace;
  });
};

const isBatchTimestampAligned = (
  timestampMs: number,
  times: string[],
  timezone?: string | null,
  graceMinutes = Math.max(Number(process.env.BATCH_WINDOW_GRACE_MINUTES || 8), 1)
) => {
  if (!Number.isFinite(timestampMs)) return false;
  const minuteOfDay = getLocalMinuteOfDay(timezone, new Date(timestampMs));
  return isMinuteAlignedToBatchTimes(minuteOfDay, times, graceMinutes);
};

const isWithinBatchWindow = (
  times: string[],
  timezone?: string | null,
  graceMinutes = Math.max(Number(process.env.BATCH_WINDOW_GRACE_MINUTES || 8), 1)
) => {
  if (!times.length) return false;
  const nowMinute = getLocalMinuteOfDay(timezone);
  if (!Number.isFinite(nowMinute)) return false;
  return isMinuteAlignedToBatchTimes(nowMinute, times, graceMinutes);
};

const getOverdueBatchDispatchGraceMs = () => {
  const minutesRaw = Number(process.env.BATCH_OVERDUE_DISPATCH_GRACE_MINUTES || 20);
  const minutes = Number.isFinite(minutesRaw) ? Math.max(Math.floor(minutesRaw), 5) : 20;
  return Math.min(minutes, 180) * 60 * 1000;
};

const toDailyCronExpression = (time: string) => {
  const [hour, minute] = time.split(':').map((part) => Number(part));
  return `${minute} ${hour} * * *`;
};

const computeNextBatchRunAt = (times: string[], timezone?: string | null) => {
  let nextValue: string | null = null;
  for (const time of times) {
    const expression = toDailyCronExpression(time);
    const candidate = computeNextRunAt(expression, timezone || 'UTC');
    if (!candidate) continue;
    if (!nextValue || new Date(candidate).getTime() < new Date(nextValue).getTime()) {
      nextValue = candidate;
    }
  }
  return nextValue;
};

const compareFeedDispatchOrder = (
  left: { pub_date?: string | null; created_at?: string | null; id?: string | null },
  right: { pub_date?: string | null; created_at?: string | null; id?: string | null }
) => {
  const leftPub = left?.pub_date ? Date.parse(String(left.pub_date)) : Number.NaN;
  const rightPub = right?.pub_date ? Date.parse(String(right.pub_date)) : Number.NaN;
  const leftCreated = left?.created_at ? Date.parse(String(left.created_at)) : Number.NaN;
  const rightCreated = right?.created_at ? Date.parse(String(right.created_at)) : Number.NaN;
  const leftPrimary = Number.isFinite(leftPub) ? leftPub : Number.isFinite(leftCreated) ? leftCreated : 0;
  const rightPrimary = Number.isFinite(rightPub) ? rightPub : Number.isFinite(rightCreated) ? rightCreated : 0;
  if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
};

const planFeedDispatchPage = <T extends { pub_date?: string | null; created_at?: string | null; id?: string | null }>(
  page: T[]
) => {
  const scanItems = Array.isArray(page) ? [...page] : [];
  const dispatchItems = [...scanItems].sort(compareFeedDispatchOrder);
  const lastScanned = scanItems.length ? scanItems[scanItems.length - 1] : null;
  return {
    dispatchItems,
    cursorAt: lastScanned?.created_at ? String(lastScanned.created_at) : null,
    cursorId: lastScanned?.id ? String(lastScanned.id) : null
  };
};

const queueSinceLastRunForSchedule = async (
  supabase: SupabaseClient,
  schedule: Schedule,
  targets: Target[]
): Promise<{ queued: number; feedItemCount: number; cursorAt: string | null }> => {
  if (!schedule.feed_id) return { queued: 0, feedItemCount: 0, cursorAt: null };
  const sinceIso =
    schedule.last_queued_at ||
    schedule.last_run_at ||
    schedule.created_at ||
    new Date().toISOString();
  if (!targets.length) return { queued: 0, feedItemCount: 0, cursorAt: null };

  const targetIds = targets.map((t) => t.id).filter(Boolean) as string[];
  if (!targetIds.length) return { queued: 0, feedItemCount: 0, cursorAt: null };

  const queuedStatus = schedule.approval_required === true ? 'awaiting_approval' : 'pending';

  const FEED_PAGE_SIZE = 200;
  const LOG_BATCH_SIZE = 1000;

  let cursorAt = sinceIso;
  let cursorId: string | null = null;
  let totalQueued = 0;
  let totalFeedItems = 0;

  // Pre-fetch existing combinations to avoid duplicates in batch
  const existingCombos = new Set<string>();
  const refreshExistingCombos = async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Last 7 days
    const { data: existing } = await supabase
      .from('message_logs')
      .select('schedule_id,feed_item_id,target_id')
      .eq('schedule_id', schedule.id)
      .gte('created_at', since);

    existingCombos.clear();
    for (const row of (existing || [])) {
      const key = `${row.schedule_id}:${row.feed_item_id}:${row.target_id}`;
      existingCombos.add(key);
    }
  };

  await refreshExistingCombos();

  const flushBatch = async (batch: Array<Record<string, unknown>>) => {
    if (!batch.length) return 0;

    // Filter out any that we know already exist
    const filtered = batch.filter(item => {
      const key = `${item.schedule_id}:${item.feed_item_id}:${item.target_id}`;
      return !existingCombos.has(key);
    });

    if (!filtered.length) return 0;

    const inserted = await upsertPendingDispatchRows(
      supabase,
      filtered,
      schedule.id,
      'Failed to queue items since last run'
    );

    // Add newly inserted to our tracking set
    for (const item of filtered) {
      const key = `${item.schedule_id}:${item.feed_item_id}:${item.target_id}`;
      existingCombos.add(key);
    }

    return inserted;
  };

  while (true) {
    let query = supabase
      .from('feed_items')
      .select('id, created_at, pub_date')
      .eq('feed_id', schedule.feed_id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(FEED_PAGE_SIZE);

    if (cursorId) {
      query = query.or(`created_at.gt.${cursorAt},and(created_at.eq.${cursorAt},id.gt.${cursorId})`);
    } else {
      query = query.gte('created_at', cursorAt);
    }

    const { data: page, error: itemsError } = await query;
    if (itemsError) {
      logger.warn({ scheduleId: schedule.id, error: itemsError }, 'Failed to load feed items since last queued');
      break;
    }

    const pagePlan = planFeedDispatchPage((page || []) as Array<{ id?: string; created_at?: string; pub_date?: string }>);
    const items = pagePlan.dispatchItems;
    if (!items.length) {
      break;
    }

    totalFeedItems += items.length;

    let batch: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const feedItemId = item?.id ? String(item.id) : null;
      if (!feedItemId) continue;
      for (const targetId of targetIds) {
        batch.push({
          feed_item_id: feedItemId,
          target_id: targetId,
          schedule_id: schedule.id,
          template_id: schedule.template_id,
          status: queuedStatus,
          approved_at: null,
          approved_by: null
        });
        if (batch.length >= LOG_BATCH_SIZE) {
          totalQueued += await flushBatch(batch);
          batch = [];
        }
      }
    }
    if (batch.length) {
      totalQueued += await flushBatch(batch);
    }

    cursorAt = pagePlan.cursorAt || cursorAt;
    cursorId = pagePlan.cursorId || cursorId;
  }

  return { queued: totalQueued, feedItemCount: totalFeedItems, cursorAt: cursorAt || null };
};

const queueRecentMissingForSchedule = async (
  supabase: SupabaseClient,
  schedule: Schedule,
  targets: Target[],
  lookbackHours: number
): Promise<number> => {
  if (!schedule.feed_id) return 0;
  if (!Array.isArray(targets) || !targets.length) return 0;
  if (!schedule.last_run_at && !schedule.last_queued_at) return 0;

  const lookback = Math.min(Math.max(Number(lookbackHours) || 0, 1), 72);
  const sinceIso = new Date(Date.now() - lookback * 60 * 60 * 1000).toISOString();

  const { data: recentItems, error: itemsError } = await supabase
    .from('feed_items')
    .select('id,created_at,pub_date')
    .eq('feed_id', schedule.feed_id)
    .gte('created_at', sinceIso)
    .order('pub_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(400);

  if (itemsError || !recentItems?.length) {
    if (itemsError) {
      logger.warn({ scheduleId: schedule.id, error: itemsError }, 'Failed loading recent feed items for reconciliation');
    }
    return 0;
  }

  const targetIds = targets.map((target) => target.id).filter(Boolean) as string[];
  if (!targetIds.length) return 0;

  const queuedStatus = schedule.approval_required === true ? 'awaiting_approval' : 'pending';

  const pendingRows: Array<Record<string, unknown>> = [];
  for (const item of recentItems as Array<{ id?: string }>) {
    const feedItemId = item?.id ? String(item.id) : null;
    if (!feedItemId) continue;
    for (const targetId of targetIds) {
      pendingRows.push({
        feed_item_id: feedItemId,
        target_id: targetId,
        schedule_id: schedule.id,
        template_id: schedule.template_id,
        status: queuedStatus,
        approved_at: null,
        approved_by: null
      });
    }
  }

  if (!pendingRows.length) return 0;

  const inserted = await upsertPendingDispatchRows(
    supabase,
    pendingRows,
    schedule.id,
    'Failed reconciling recent queue items'
  );
  if (inserted > 0) {
    logger.info({ scheduleId: schedule.id, inserted, lookbackHours: lookback }, 'Reconciled missing recent queue items');
  }
  return inserted;
};

type QueueLatestResult = {
  queued: number;
  inserted: number;
  revived: number;
  skipped: number;
  reason?: string;
  feedItemId?: string;
  feedItemTitle?: string | null;
  cursorAt?: string | null;
};

const queueLatestForSchedule = async (
  scheduleId: string,
  options?: { schedule?: Schedule; targets?: Target[] }
): Promise<QueueLatestResult> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'Database not available' };
  }
  if (await settingsService.isAppPaused()) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'App is paused' };
  }

  let schedule: Schedule | null = options?.schedule ?? null;
  if (!schedule) {
    const { data } = await supabase.from('schedules').select('*').eq('id', scheduleId).single();
    schedule = (data as Schedule | null) ?? null;
  }

  if (!schedule || !isScheduleRunning(schedule)) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'Schedule not found or not running' };
  }

  if (!schedule.feed_id) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'Schedule has no feed' };
  }

  let targets: Target[] = options?.targets ?? [];
  if (!targets.length) {
    const { data } = await supabase
      .from('targets')
      .select('*')
      .in('id', Array.isArray(schedule.target_ids) ? schedule.target_ids : [])
      .eq('active', true);
    targets = data || [];
  }

  if (!targets.length) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'No active targets' };
  }

  const { data: latestFeedItem } = await supabase
    .from('feed_items')
    .select('id, title, created_at, pub_date')
    .eq('feed_id', schedule.feed_id)
    .order('pub_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .single();

  if (!latestFeedItem?.id) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'No feed items found' };
  }

  const targetIds = targets.map((target) => target.id).filter(Boolean) as string[];
  const { data: existingLogs, error: existingLogsError } = await supabase
    .from('message_logs')
    .select('id, target_id, status, error_message, approved_at')
    .eq('schedule_id', schedule.id)
    .eq('feed_item_id', latestFeedItem.id)
    .in('target_id', targetIds);

  if (existingLogsError) {
    logger.warn({ scheduleId: schedule.id, error: existingLogsError }, 'Failed to check existing logs');
  }

  type ExistingLogRow = {
    id: string;
    target_id: string;
    status: string;
    error_message?: string | null;
    approved_at?: string | null;
  };
  const existingByTarget = new Map<string, ExistingLogRow>();
  for (const row of (existingLogs || []) as Array<Partial<ExistingLogRow>>) {
    if (!row?.id || !row?.target_id || !row?.status) continue;
    existingByTarget.set(String(row.target_id), {
      id: String(row.id),
      target_id: String(row.target_id),
      status: String(row.status),
      error_message: row.error_message ? String(row.error_message) : null,
      approved_at: row.approved_at ? String(row.approved_at) : null
    });
  }

  const requiresApproval = schedule.approval_required === true;
  const queuedStatus = requiresApproval ? 'awaiting_approval' : 'pending';

  const toInsert: Array<Record<string, unknown>> = [];
  const toRevivePending: string[] = [];
  const toReviveAwaitingApproval: string[] = [];
  let skipped = 0;

  for (const targetId of targetIds) {
    const existing = existingByTarget.get(targetId);
    if (!existing) {
      toInsert.push({
        feed_item_id: latestFeedItem.id,
        target_id: targetId,
        schedule_id: schedule.id,
        template_id: schedule.template_id,
        status: queuedStatus,
        approved_at: null,
        approved_by: null
      });
      continue;
    }

    if (isSuccessfulSendStatus(existing.status) || existing.status === 'processing') {
      skipped += 1;
      continue;
    }

    if (existing.status === 'skipped' && NON_REVIVABLE_SKIP_ERRORS.has(String(existing.error_message || ''))) {
      skipped += 1;
      continue;
    }

    if (existing.status === 'failed' || existing.status === 'skipped') {
      if (requiresApproval && !String(existing.approved_at || '').trim()) {
        toReviveAwaitingApproval.push(existing.id);
      } else {
        toRevivePending.push(existing.id);
      }
      continue;
    }
  }

  let revived = 0;
  if (toRevivePending.length) {
    const { data: revivedRows } = await supabase
      .from('message_logs')
      .update({ status: 'pending', error_message: null, retry_count: 0, processing_started_at: null })
      .in('id', toRevivePending)
      .select('id');
    revived += revivedRows?.length || 0;
  }

  if (toReviveAwaitingApproval.length) {
    const { data: revivedRows } = await supabase
      .from('message_logs')
      .update({ status: 'awaiting_approval', error_message: null, retry_count: 0, processing_started_at: null })
      .in('id', toReviveAwaitingApproval)
      .select('id');
    revived += revivedRows?.length || 0;
  }

  let inserted = 0;
  if (toInsert.length) {
    inserted = await upsertPendingDispatchRows(
      supabase,
      toInsert,
      schedule.id,
      'Failed to queue latest feed item'
    );
  }

  return {
    queued: inserted + revived,
    inserted,
    revived,
    skipped,
    feedItemId: latestFeedItem.id,
    feedItemTitle: latestFeedItem.title || null,
    cursorAt: latestFeedItem.created_at ? String(latestFeedItem.created_at) : null
  };
};

const sendQueuedForSchedule = async (
  scheduleId: string,
  whatsappClient?: WhatsAppClient | null,
  options?: SendQueuedOptions
) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.error({ scheduleId }, 'Database not available - cannot send messages');
    return { sent: 0, error: 'Database not available' };
  }
  if (await settingsService.isAppPaused()) {
    logger.info({ scheduleId }, 'Skipping dispatch because app is paused');
    return { sent: 0, queued: 0, skipped: true, reason: 'App is paused' };
  }

  try {
    logger.info({ scheduleId }, 'Starting dispatch for schedule');
    // Get schedule
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();

    if (scheduleError || !schedule || !isScheduleRunning(schedule)) {
      logger.warn(
        { scheduleId, error: scheduleError?.message, schedule, active: schedule?.active, state: schedule?.state },
        'Schedule not found or not running'
      );
      return { sent: 0, queued: 0 };
    }

    const deliveryMode = schedule.delivery_mode === 'batch' || schedule.delivery_mode === 'batched' ? 'batched' : 'immediate';

    // Check if schedule has feed_id - if not, it's a manual dispatch only
    if (!schedule.feed_id) {
      const shabbosStatus = await isCurrentlyShabbos();
      if (shabbosStatus.isShabbos) {
        logger.info({ scheduleId, reason: shabbosStatus.reason, endsAt: shabbosStatus.endsAt },
          'Skipping message send - Shabbos/Yom Tov active');
        return {
          sent: 0,
          queued: 0,
          skipped: true,
          reason: shabbosStatus.reason,
          resumeAt: shabbosStatus.endsAt
        };
      }

      if (!whatsappClient) {
        logger.warn({ scheduleId }, 'Skipping send - WhatsApp client not available');
        return { sent: 0, queued: 0, skipped: true, reason: 'WhatsApp not connected' };
      }

      const connectedForManualDispatch = await ensureWhatsAppConnected(whatsappClient, {
        attempts: 6,
        delayMs: 1000,
        triggerReconnect: true,
        triggerTakeover: true,
        logContext: `schedule ${scheduleId} manual dispatch`
      });
      if (!connectedForManualDispatch) {
        const whatsappStatus = whatsappClient.getStatus();
        const statusLabel = whatsappStatus?.status || 'unknown';
        const reason =
          statusLabel === 'paused'
            ? 'WhatsApp is paused'
            : statusLabel === 'qr' || statusLabel === 'qr_ready'
              ? 'WhatsApp requires QR scan'
              : 'WhatsApp not connected';
        logger.warn({ scheduleId, whatsappStatus: statusLabel }, 'Skipping send - WhatsApp not connected');
        return { sent: 0, queued: 0, skipped: true, reason };
      }

      logger.warn({ scheduleId }, 'Schedule has no feed_id - manual dispatch only');
      // For manual dispatch, we need to look for pending logs without feed items
      const { data: manualLogs, error: manualLogsError } = await supabase
        .from('message_logs')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('status', 'pending')
        .is('feed_item_id', null);

      if (manualLogsError) throw manualLogsError;

      if (!manualLogs || manualLogs.length === 0) {
        logger.info({ scheduleId }, 'No pending manual messages to send');
        return {
          sent: 0,
          queued: 0,
          skipped: true,
          reason: 'Nothing is queued for this automation yet. New feed matches will appear here automatically.'
        };
      }

      // For manual dispatch, we can't proceed without feed items
      logger.warn({ scheduleId, count: manualLogs.length },
        'Pending manual logs found but no feed items - cannot send');
      return {
        sent: 0,
        queued: 0,
        skipped: true,
        reason: 'This automation has no sendable feed item queued right now.'
      };
    }

    // Get targets
    const targetIds = Array.isArray(schedule.target_ids) ? schedule.target_ids : [];

    const { data: targets, error: targetsError } = await supabase
      .from('targets')
      .select('*')
      .in('id', targetIds)
      .eq('active', true);

    if (targetsError) {
      logger.error({ scheduleId, error: targetsError }, 'Failed to fetch targets');
      throw targetsError;
    }
    logger.info({ scheduleId, targetCount: targets?.length || 0 }, 'Found targets for schedule');

    const settings = await settingsService.getSettings();

    const { data: feed, error: feedError } = await supabase
      .from('feeds')
      .select('*')
      .eq('id', schedule.feed_id)
      .single();

    if (feedError || !feed) {
      logger.warn({ scheduleId, feedId: schedule.feed_id, error: feedError }, 'Feed not found for schedule dispatch');
      return { sent: 0, queued: 0, skipped: true, reason: 'Feed not found' };
    }

    if (feed.active === false) {
      logger.info({ scheduleId, feedId: schedule.feed_id }, 'Skipping dispatch because feed is paused');
      return { sent: 0, queued: 0, skipped: true, reason: FEED_PAUSED_ERROR };
    }

    let reconcileResult: ReconcileUpdatedFeedItemsResult | null = null;

    if (!options?.skipFeedRefresh) {
      try {
        const feedRefreshResult = await fetchAndProcessFeed(feed);
        const updatedItems = Array.isArray(feedRefreshResult?.updatedItems)
          ? feedRefreshResult.updatedItems
          : [];
        if (updatedItems.length && whatsappClient?.getStatus?.().status === 'connected') {
          reconcileResult = await reconcileUpdatedFeedItems(updatedItems, whatsappClient);
          logger.info(
            { scheduleId, feedId: schedule.feed_id, reconcile: reconcileResult },
            'Applied post-send reconciliation during schedule dispatch'
          );
        }
      } catch (error) {
        logger.warn({ scheduleId, feedId: schedule.feed_id, error }, 'Failed to refresh feed during dispatch');
      }
    }

    let queuedCount = 0;
    let queueCursorAt: string | null =
      schedule.last_queued_at ||
      schedule.last_run_at ||
      schedule.created_at ||
      null;

    if (!options?.skipQueueGeneration) {
      const sinceResult = await queueSinceLastRunForSchedule(supabase, schedule, targets);
      queuedCount += sinceResult.queued;
      queueCursorAt = sinceResult.cursorAt || queueCursorAt;
    }

    // Persist the queue cursor even if we skip sending (e.g. WhatsApp disconnected or Shabbos).
    // This avoids re-scanning the same feed items on every retry.
    if (queueCursorAt) {
      const { error: queueCursorError } = await supabase
        .from('schedules')
        .update({ last_queued_at: queueCursorAt })
        .eq('id', scheduleId);
      if (queueCursorError) {
        const msg = String((queueCursorError as { message?: unknown })?.message || queueCursorError);
        const missingQueueCursorColumn =
          msg.toLowerCase().includes('last_queued_at') && msg.toLowerCase().includes('does not exist');
        if (missingQueueCursorColumn) {
          logger.warn(
            { scheduleId, error: queueCursorError },
            'Schedule queue cursor columns missing; run SQL migrations (scripts/012_schedule_queue_cursor.sql)'
          );
        } else {
          logger.warn({ scheduleId, error: queueCursorError }, 'Failed to update schedule queue cursor');
        }
      }
    }

    if (deliveryMode === 'batched') {
      const batchTimes = parseBatchTimes(schedule.batch_times);
      const timezone = String(schedule.timezone || 'UTC').trim() || 'UTC';
      const batchWindowGraceMinutes = Math.max(Number(process.env.BATCH_WINDOW_GRACE_MINUTES || 8), 1);
      const withinWindow = isWithinBatchWindow(batchTimes, timezone, batchWindowGraceMinutes);
      const allowOverdueBatchDispatch = options?.allowOverdueBatchDispatch === true;
      const overdueDispatchGraceMs = getOverdueBatchDispatchGraceMs();

      let nextRunAtIso = String(schedule.next_run_at || '').trim();
      let nextRunAtMs = Date.parse(nextRunAtIso);
      if (!Number.isFinite(nextRunAtMs)) {
        const computedNextRunAt = computeNextBatchRunAt(batchTimes, timezone);
        if (computedNextRunAt) {
          nextRunAtIso = computedNextRunAt;
          nextRunAtMs = Date.parse(computedNextRunAt);
        }
      }

      const nowMs = Date.now();
      const overdueAgeMs = Number.isFinite(nextRunAtMs) ? nowMs - nextRunAtMs : Number.NaN;
      const overdueAligned =
        Number.isFinite(nextRunAtMs) &&
        isBatchTimestampAligned(nextRunAtMs, batchTimes, timezone, batchWindowGraceMinutes);
      const isOverdueDispatch =
        allowOverdueBatchDispatch &&
        overdueAligned &&
        Number.isFinite(overdueAgeMs) &&
        overdueAgeMs >= 0 &&
        overdueAgeMs <= overdueDispatchGraceMs;

      if (!withinWindow && !isOverdueDispatch) {
        const misalignedOverdueCursor =
          allowOverdueBatchDispatch &&
          Number.isFinite(overdueAgeMs) &&
          overdueAgeMs >= 0 &&
          !overdueAligned;
        const staleDueCursor =
          Number.isFinite(overdueAgeMs) &&
          (overdueAgeMs > overdueDispatchGraceMs || misalignedOverdueCursor);

        if (staleDueCursor) {
          const computedNextRunAt = computeNextBatchRunAt(batchTimes, timezone);
          if (computedNextRunAt) {
            nextRunAtIso = computedNextRunAt;
            nextRunAtMs = Date.parse(computedNextRunAt);
            await supabase.from('schedules').update({ next_run_at: computedNextRunAt }).eq('id', scheduleId);
          }
        }

        if (misalignedOverdueCursor) {
          logger.warn(
            {
              scheduleId,
              timezone,
              batchTimes,
              nextRunAt: nextRunAtIso
            },
            'Skipping overdue batch dispatch because next_run_at is not aligned to configured batch times'
          );
        }

        const resumeAtIso = Number.isFinite(nextRunAtMs) ? new Date(nextRunAtMs).toISOString() : null;
        const reason = resumeAtIso
          ? `Waiting for the next batch send window (${timezone}).`
          : `Waiting for the next batch send window (${timezone}); no next run is scheduled yet.`;
        logger.info(
          {
            scheduleId,
            timezone,
            batchTimes,
            queuedCount,
            allowOverdueBatchDispatch,
            nextRunAt: resumeAtIso
          },
          'Skipping batched send outside dispatch window'
        );
        return {
          sent: 0,
          queued: queuedCount,
          skipped: true,
          reason,
          resumeAt: resumeAtIso
        };
      }
    }

    const shabbosStatus = await isCurrentlyShabbos();
    if (shabbosStatus.isShabbos) {
      logger.info({ scheduleId, reason: shabbosStatus.reason, endsAt: shabbosStatus.endsAt },
        'Skipping message send - Shabbos/Yom Tov active');
      return {
        sent: 0,
        queued: queuedCount,
        skipped: true,
        reason: shabbosStatus.reason,
        resumeAt: shabbosStatus.endsAt
      };
    }

    if (!whatsappClient) {
      logger.warn({ scheduleId }, 'Skipping send - WhatsApp client not available');
      return { sent: 0, queued: queuedCount, skipped: true, reason: 'WhatsApp not connected' };
    }

    const connectedForDispatch = await ensureWhatsAppConnected(whatsappClient, {
      attempts: 6,
      delayMs: 1000,
      triggerReconnect: true,
      triggerTakeover: true,
      logContext: `schedule ${scheduleId} dispatch`
    });
    if (!connectedForDispatch) {
      const whatsappStatus = whatsappClient.getStatus();
      const statusLabel = whatsappStatus?.status || 'unknown';
      const reason =
        statusLabel === 'paused'
          ? 'WhatsApp is paused'
          : statusLabel === 'qr' || statusLabel === 'qr_ready'
            ? 'WhatsApp requires QR scan'
            : 'WhatsApp not connected';
      logger.warn({ scheduleId, whatsappStatus: statusLabel }, 'Skipping send - WhatsApp not connected');
      return { sent: 0, queued: queuedCount, skipped: true, reason };
    }

    await recoverStaleProcessingLogs(supabase, settings, {
      scheduleId,
      context: 'Recovered stale processing rows before schedule dispatch'
    });

    const maxPendingAgeHours = Math.max(Number(settings.max_pending_age_hours || 48), 1);
    const staleCutoffMs = Date.now() - maxPendingAgeHours * 60 * 60 * 1000;

    // Get template
    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', schedule.template_id)
      .single();

    if (templateError || !template) {
      logger.error({ scheduleId, templateId: schedule.template_id, error: templateError },
        'Template not found for schedule');
      throw new Error('Template not found for schedule');
    }
    logger.info({ scheduleId, templateId: template.id }, 'Found template for schedule');

    let sentCount = 0;

    for (const target of targets || []) {
      // Get pending message logs for this target and schedule
      const { data: logs, error: logsError } = await supabase
        .from('message_logs')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('target_id', target.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });

      if (logsError) continue;

      if (!logs || logs.length === 0) {
        continue;
      }

      const staleLogIds = (logs || [])
        .filter((entry: { id?: string; created_at?: string | null }) => {
          const createdAt = entry?.created_at ? new Date(entry.created_at).getTime() : 0;
          return Boolean(entry?.id) && Number.isFinite(createdAt) && createdAt > 0 && createdAt < staleCutoffMs;
        })
        .map((entry: { id?: string }) => entry.id)
        .filter(Boolean) as string[];

      if (staleLogIds.length) {
        await supabase
          .from('message_logs')
          .update({
            status: 'skipped',
            processing_started_at: null,
            error_message: `Skipped stale queued item (> ${maxPendingAgeHours}h old)`,
            media_url: null,
            media_type: null,
            media_sent: false,
            media_error: null
          })
          .in('id', staleLogIds);
      }

      const runnableLogs = (logs || []).filter(
        (entry: { id?: string }) => Boolean(entry?.id) && !staleLogIds.includes(String(entry.id))
      );

      if (!runnableLogs.length) {
        continue;
      }

      const feedItemIds = Array.from(
        new Set(
          (runnableLogs || [])
            .map((entry: { feed_item_id?: string | null }) => String(entry.feed_item_id || '').trim())
            .filter(Boolean)
        )
      );
      const feedItemTimingById = new Map<string, { pub_date?: string | null; created_at?: string | null }>();
      if (feedItemIds.length) {
        const { data: feedTimingRows, error: feedTimingError } = await supabase
          .from('feed_items')
          .select('id,pub_date,created_at')
          .in('id', feedItemIds);
        if (feedTimingError) {
          logger.warn({ scheduleId, targetId: target.id, error: feedTimingError }, 'Failed to load feed item timing metadata');
        } else {
          for (const row of (feedTimingRows || []) as Array<{ id?: string; pub_date?: string | null; created_at?: string | null }>) {
            const id = String(row.id || '').trim();
            if (!id) continue;
            feedItemTimingById.set(id, {
              pub_date: row.pub_date || null,
              created_at: row.created_at || null
            });
          }
        }
      }

      const toTs = (value?: string | null) => {
        if (!value) return Number.NaN;
        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : Number.NaN;
      };

      const sortedLogs = [...runnableLogs].sort((a: any, b: any) => {
        const aFeedId = String(a?.feed_item_id || '').trim();
        const bFeedId = String(b?.feed_item_id || '').trim();
        const aTiming = feedItemTimingById.get(aFeedId);
        const bTiming = feedItemTimingById.get(bFeedId);

        const aPrimary = toTs(aTiming?.pub_date) || toTs(aTiming?.created_at) || toTs(a?.created_at);
        const bPrimary = toTs(bTiming?.pub_date) || toTs(bTiming?.created_at) || toTs(b?.created_at);
        if (Number.isFinite(aPrimary) && Number.isFinite(bPrimary) && aPrimary !== bPrimary) {
          return aPrimary - bPrimary;
        }

        const aCreated = toTs(a?.created_at);
        const bCreated = toTs(b?.created_at);
        if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) {
          return aCreated - bCreated;
        }

        const aId = String(a?.id || '');
        const bId = String(b?.id || '');
        return aId.localeCompare(bId);
      });

      if (target.type === 'group' && whatsappClient.getGroupInfo) {
        try {
          const jid = normalizeTargetJid(target);
          const info = await whatsappClient.getGroupInfo(jid);
          if (info?.announce && !info?.me?.isAdmin) {
            const reason = 'Group is admin-only (announce mode) and this WhatsApp account is not an admin';
            const ids = (sortedLogs || []).map((l: { id?: string }) => l.id).filter(Boolean) as string[];
            if (ids.length) {
              await supabase
                .from('message_logs')
                .update({
                  status: 'failed',
                  processing_started_at: null,
                  error_message: reason,
                  media_url: null,
                  media_type: null,
                  media_sent: false,
                  media_error: null
                })
                .in('id', ids);
            }
            continue;
          }
        } catch (error) {
          logger.warn({ scheduleId, targetId: target.id, error }, 'Failed to check group send policy');
        }
      }

      for (const log of sortedLogs || []) {
        // Get feed item
        const { data: feedItem, error: feedItemError } = await supabase
          .from('feed_items')
          .select('*')
          .eq('id', log.feed_item_id)
          .single();

        if (feedItemError || !feedItem) {
          await supabase
            .from('message_logs')
            .update({
              status: 'failed',
              error_message: 'Feed item missing',
              processing_started_at: null,
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
          continue;
        }

        let didClaim = false;
        let expectedRender: ReturnType<typeof renderTemplateMessage> | null = null;
        let expectedMedia: { url: string | null; kind: 'image' | 'video' | 'audio' | 'document' | null } = {
          url: null,
          kind: null
        };
        try {
          expectedRender = renderTemplateMessage(template, feedItem, typeof log.message_content === 'string' ? log.message_content : null);
          expectedMedia =
            expectedRender.sendMode === 'auto_media' || expectedRender.sendMode === 'media_only'
              ? await resolveMediaUrlForFeedItem(supabase, feedItem, true)
              : { url: null, kind: null };
          const sendResult = await withTargetSendLock(target as Target, async () => {
            const { data: claimedRows, error: claimError } = await supabase
              .from('message_logs')
              .update({
                status: 'processing',
                processing_started_at: new Date().toISOString(),
                error_message: null
              })
              .eq('id', log.id)
              .eq('status', 'pending')
              .select('id');

            if (claimError) {
              logger.warn({ scheduleId, logId: log.id, error: claimError }, 'Failed to claim message log');
              return null;
            }

            if (!claimedRows || claimedRows.length === 0) {
              return null;
            }

            didClaim = true;
            await waitForDelays(target as Target, settings);
            const result = await sendMessageWithTemplate(whatsappClient, target, template, feedItem, {
              supabase,
              sendTimeoutMs: Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
              overrideText: typeof log.message_content === 'string' ? log.message_content : null
            });
            const nowMs = Date.now();
            globalLastSentAtMs = nowMs;
            globalLastTargetId = String(target.id);
            globalLastSentByTargetId.set(String(target.id), nowMs);
            if (globalLastSentByTargetId.size > 1000) {
              globalLastSentByTargetId.clear();
            }
            return result;
          });
          if (!didClaim || !sendResult) {
            continue;
          }
          const response = sendResult?.response;

          const messageId = response?.key?.id;
          if (!messageId) {
            throw new Error('Message send not confirmed (missing message id)');
          }
          if (messageId) {
            if (whatsappClient.confirmSend) {
              const isMedia =
                (sendResult?.media?.type === 'image' || sendResult?.media?.type === 'video') &&
                Boolean(sendResult?.media?.sent);
              const confirmation = await whatsappClient.confirmSend(
                messageId,
                isMedia
                  ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
                  : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 }
              );
              if (!confirmation?.ok) {
                throw new Error('Message send not confirmed (no upsert/ack)');
              }
            } else if (whatsappClient.waitForMessage) {
              const observed = await whatsappClient.waitForMessage(messageId, 15000);
              if (!observed) {
                throw new Error('Message send not confirmed (no local upsert)');
              }
            }
          }

          await supabase
            .from('message_logs')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              processing_started_at: null,
              error_message: null,
              message_content: sendResult?.text || null,
              whatsapp_message_id: messageId,
              media_url: sendResult?.media?.url || null,
              media_type: sendResult?.media?.type || null,
              media_sent: Boolean(sendResult?.media?.sent),
              media_error: sendResult?.media?.error || null
            })
            .eq('id', log.id);

          const { error: markSentError } = await supabase
            .from('feed_items')
            .update({ sent: true, sent_at: new Date().toISOString() })
            .eq('id', feedItem.id)
            .eq('sent', false);
          if (markSentError) {
            logger.warn({ scheduleId, feedItemId: feedItem.id, error: markSentError }, 'Failed to mark feed item as sent');
          }

          sentCount += 1;
        } catch (error) {
          if (!didClaim) {
            logger.warn({ scheduleId, logId: log.id, error }, 'Failed before claiming queue row for send');
            continue;
          }
          logger.error({ error, scheduleId, feedItemId: feedItem.id, targetId: target.id }, 'Failed to send message');

          const rawErrorMessage = getErrorMessage(error);
          const authError = isAuthStateError(rawErrorMessage);
          const errorMessage = authError
            ? `${AUTH_ERROR_HINT} (${rawErrorMessage || 'unknown auth error'})`
            : rawErrorMessage;
          const timeoutUnknownDelivery = isUnknownDeliveryTimeout(rawErrorMessage);
          const connectionStateError = isConnectionStateError(rawErrorMessage);
          const nonRetryable = [
            'Template rendered empty message',
            'Target phone number missing',
            'Group ID invalid',
            'Channel ID invalid',
            'Phone number invalid',
            'Image-only mode'
          ].some((needle) => rawErrorMessage.includes(needle));

          if (timeoutUnknownDelivery) {
            await supabase
              .from('message_logs')
              .update({
                status: 'uncertain',
                error_message: buildUncertainErrorMessage(errorMessage),
                message_content: expectedRender?.outboundText || null,
                media_url: expectedMedia.url || null,
                media_type: expectedMedia.kind || null,
                media_sent: false,
                media_error: errorMessage
              })
              .eq('id', log.id);
            continue;
          }

          const maxRetries = Number(settings.max_retries || 3);
          const currentRetry = log.retry_count || 0;

          if (connectionStateError) {
            await supabase
              .from('message_logs')
              .update({
                status: 'pending',
                processing_started_at: null,
                error_message: buildConnectionWaitErrorMessage(errorMessage),
                retry_count: currentRetry
              })
              .eq('id', log.id);
            continue;
          }

          if (nonRetryable) {
            await supabase
              .from('message_logs')
              .update({
                status: 'failed',
                processing_started_at: null,
                error_message: errorMessage,
                media_url: null,
                media_type: null,
                media_sent: false,
                media_error: null
              })
              .eq('id', log.id);
            continue;
          }

          if (currentRetry < maxRetries) {
            logger.info({
              scheduleId,
              feedItemId: feedItem.id,
              targetId: target.id,
              retry: currentRetry + 1,
              maxRetries
            }, 'Retrying failed message');

            // Update retry count and keep as pending
            await supabase
              .from('message_logs')
              .update({
                status: 'pending',
                processing_started_at: null,
                error_message: `Retry ${currentRetry + 1}/${maxRetries}: ${errorMessage}`,
                retry_count: currentRetry + 1,
                media_url: null,
                media_type: null,
                media_sent: false,
                media_error: null
              })
              .eq('id', log.id);

            continue;
          }

          // Max retries reached, mark as failed
          await supabase
            .from('message_logs')
            .update({
              status: 'failed',
              processing_started_at: null,
              error_message: `Max retries (${maxRetries}) exceeded: ${errorMessage}`,
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
        }

        // Delay is handled via waitForDelays() under a global send lock.
      }
    }

    const lastRunAt = new Date().toISOString();
    let nextRunAt: string | null = null;
    if (deliveryMode === 'batched') {
      const batchTimes = parseBatchTimes(schedule.batch_times);
      nextRunAt = computeNextBatchRunAt(batchTimes, schedule.timezone || 'UTC');
    } else if (schedule.cron_expression) {
      nextRunAt = computeNextRunAt(schedule.cron_expression, schedule.timezone);
    }
    const scheduleUpdates: Record<string, unknown> = { last_run_at: lastRunAt, next_run_at: nextRunAt };
    if (queueCursorAt) {
      scheduleUpdates.last_queued_at = queueCursorAt;
    }
    if (deliveryMode === 'batched') {
      scheduleUpdates.last_dispatched_at = lastRunAt;
    }
    const { error: scheduleUpdateError } = await supabase.from('schedules').update(scheduleUpdates).eq('id', scheduleId);
    if (scheduleUpdateError) {
      const msg = String((scheduleUpdateError as { message?: unknown })?.message || scheduleUpdateError);
      const missingQueueCursorColumn =
        msg.toLowerCase().includes('last_queued_at') && msg.toLowerCase().includes('does not exist');
      if (missingQueueCursorColumn) {
        logger.warn(
          { scheduleId, error: scheduleUpdateError },
          'Schedule queue cursor columns missing; run SQL migrations (scripts/012_schedule_queue_cursor.sql)'
        );
        await supabase.from('schedules').update({ last_run_at: lastRunAt, next_run_at: nextRunAt }).eq('id', scheduleId);
      } else {
        logger.warn({ scheduleId, error: scheduleUpdateError }, 'Failed to update schedule run timestamps');
      }
    }

    if (sentCount === 0 && queuedCount === 0) {
      logger.info({ scheduleId }, 'Dispatch finished with no queue entries to send');
      return {
        sent: 0,
        queued: 0,
        skipped: true,
        reason: 'Nothing is queued for this automation right now.',
        reconcile: reconcileResult
      };
    }

    logger.info({ scheduleId, sentCount, queuedCount, reconcileResult }, 'Dispatch completed successfully');
    return { sent: sentCount, queued: queuedCount, reconcile: reconcileResult };
  } catch (error) {
    logger.error({ error, scheduleId }, 'Failed to send queued messages');
    return { sent: 0, queued: 0, error: getErrorMessage(error) };
  }
};

const sendQueueLogNow = async (logId: string, whatsappClient?: WhatsAppClient | null) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: 'Database not available' };
  }
  if (await settingsService.isAppPaused()) {
    return { ok: false, error: 'App is paused' };
  }

  const connected = await ensureWhatsAppConnected(whatsappClient, {
    attempts: 12,
    delayMs: 1200,
    triggerReconnect: true,
    triggerTakeover: true,
    logContext: `send-now ${logId}`
  });

  if (!connected) {
    const statusLabel = String(whatsappClient?.getStatus?.()?.status || 'unknown');
    const error =
      statusLabel === 'paused'
        ? 'WhatsApp is paused'
        : statusLabel === 'qr' || statusLabel === 'qr_ready'
          ? 'WhatsApp requires QR scan'
          : 'WhatsApp not connected';
    return { ok: false, error };
  }

  const activeWhatsappClient = whatsappClient;
  if (!activeWhatsappClient) {
    return { ok: false, error: 'WhatsApp not connected' };
  }

  try {
    const { data: logRow, error: logError } = await supabase
      .from('message_logs')
      .select('*')
      .eq('id', logId)
      .single();

    if (logError || !logRow) {
      return { ok: false, error: 'Queue item not found' };
    }

    const log = logRow as {
      id: string;
      status: string;
      retry_count?: number | null;
      schedule_id?: string | null;
      target_id?: string | null;
      feed_item_id?: string | null;
      template_id?: string | null;
      message_content?: string | null;
      media_url?: string | null;
      media_type?: string | null;
      disable_link_preview?: boolean | null;
      include_caption?: boolean | null;
      processing_started_at?: string | null;
    };

    if (isSuccessfulSendStatus(log.status)) {
      return { ok: false, error: 'Queue item is already sent' };
    }

    const originalStatus = String(log.status || '').trim().toLowerCase() || 'pending';
    const originalRetryCount = Math.max(Number(log.retry_count || 0), 0);

    if (!log.target_id) {
      return { ok: false, error: 'Queue item is missing target' };
    }

    const isAutomationBacked = Boolean(log.schedule_id && log.feed_item_id);

    const actor = process.env.BASIC_AUTH_USER || 'send-now';
    const claimPatch: Record<string, unknown> = {
      status: 'processing',
      processing_started_at: new Date().toISOString(),
      retry_count: 0,
      error_message: null
    };
    if (log.status === 'awaiting_approval') {
      claimPatch.approved_at = new Date().toISOString();
      claimPatch.approved_by = actor;
    }

    const { data: claimRows, error: claimError } = await supabase
      .from('message_logs')
      .update(claimPatch)
      .eq('id', log.id)
      .in('status', ['awaiting_approval', 'pending', 'failed', 'skipped', 'uncertain'])
      .select('id');

    if (claimError) {
      return { ok: false, error: getErrorMessage(claimError) };
    }

    if (!claimRows || claimRows.length === 0) {
      return { ok: false, error: 'Queue item is currently being processed by another worker' };
    }

    const emptyRes = { data: null, error: null } as const;
    const [scheduleRes, targetRes, feedItemRes] = await Promise.all([
      log.schedule_id ? supabase.from('schedules').select('*').eq('id', log.schedule_id).single() : Promise.resolve(emptyRes),
      supabase.from('targets').select('*').eq('id', log.target_id).single(),
      log.feed_item_id ? supabase.from('feed_items').select('*').eq('id', log.feed_item_id).single() : Promise.resolve(emptyRes)
    ]);

    if (targetRes.error || !targetRes.data) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Target not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Target not found' };
    }

    if (isAutomationBacked && (scheduleRes as { error?: unknown }).error) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Schedule not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Schedule not found' };
    }

    if (isAutomationBacked && !scheduleRes.data) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Schedule not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Schedule not found' };
    }

    if (isAutomationBacked && (feedItemRes as { error?: unknown }).error) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Feed item not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Feed item not found' };
    }

    if (isAutomationBacked && !feedItemRes.data) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Feed item not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Feed item not found' };
    }

    const settings = await settingsService.getSettings();

    const targetRow = targetRes.data as Target;
    const jid = normalizeTargetJid(targetRow);
    const parsedManual = parseManualMessageContent(log.message_content);
    const disableLinkPreview =
      typeof log.disable_link_preview === 'boolean'
        ? log.disable_link_preview === true
        : parsedManual.meta.disableLinkPreview === true;
    const includeCaption =
      typeof log.include_caption === 'boolean'
        ? log.include_caption !== false
        : parsedManual.meta.includeCaption !== false;
    let uncertainMessageContent = normalizeMessageText(String(parsedManual.text || '')).trim() || null;
    let uncertainMediaUrl = String(log.media_url || '').trim() || null;
    let uncertainMediaType = String(log.media_type || '').trim().toLowerCase() || null;

    const sendTextManual = async (text: string) => {
      const content: Record<string, unknown> = disableLinkPreview ? { text, linkPreview: null } : { text };
      if (targetRow.type === 'status') {
        const statusSnapshot = await ensureFreshStatusRecipients(activeWhatsappClient, { maxAgeMinutes: 10, sampleSize: 25 });
        if (!statusSnapshot.recipients.length) {
          throw new Error('No fresh status recipients are available for this status send.');
        }
        return withTimeout(
          activeWhatsappClient.sendStatusBroadcast(content, { statusJidList: statusSnapshot.recipients }),
          getStatusSendTimeoutMs('text', Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS)),
          'Timed out sending status message'
        );
      }
      return withTimeout(
        activeWhatsappClient.sendMessage(jid, content),
        Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
        'Timed out sending message'
      );
    };

    const ensureSendConfirmed = async (messageId: string | null | undefined, isMedia: boolean) => {
      if (!messageId) return;
      if (activeWhatsappClient.confirmSend) {
        const confirmation = await activeWhatsappClient.confirmSend(
          messageId,
          isMedia
            ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
            : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 }
        );
        if (!confirmation?.ok) {
          throw new Error('Message send not confirmed (no upsert/ack)');
        }
        return;
      }
      if (activeWhatsappClient.waitForMessage) {
        const observed = await activeWhatsappClient.waitForMessage(messageId, 15000);
        if (!observed) {
          throw new Error('Message send not confirmed (no local upsert)');
        }
      }
    };

    try {
      if (isAutomationBacked) {
        const scheduleRow = scheduleRes.data as { template_id?: unknown };
        const templateId = (log.template_id || scheduleRow?.template_id) as string | null;
        if (!templateId) {
          await supabase
            .from('message_logs')
            .update({
              status: 'failed',
              processing_started_at: null,
              error_message: 'Template not found',
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
          return { ok: false, error: 'Template not found' };
        }

        const { data: template, error: templateError } = await supabase
          .from('templates')
          .select('*')
          .eq('id', templateId)
          .single();

        if (templateError || !template) {
          await supabase
            .from('message_logs')
            .update({
              status: 'failed',
              processing_started_at: null,
              error_message: 'Template not found',
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
          return { ok: false, error: 'Template not found' };
        }

        const expectedRender = renderTemplateMessage(
          template as Template,
          feedItemRes.data as FeedItem,
          typeof log.message_content === 'string' ? log.message_content : null
        );
        const expectedMedia =
          expectedRender.sendMode === 'auto_media' || expectedRender.sendMode === 'media_only'
            ? await resolveMediaUrlForFeedItem(supabase, feedItemRes.data as FeedItem, true)
            : { url: null, kind: null };
        uncertainMessageContent = expectedRender.outboundText || null;
        uncertainMediaUrl = expectedMedia.url || null;
        uncertainMediaType = expectedMedia.kind || null;

        const sendResult = await withTargetSendLock(targetRow, async () => {
          await waitForDelays(targetRow, settings);
          const result = await sendMessageWithTemplate(
            activeWhatsappClient,
            targetRow,
            template as Template,
            feedItemRes.data as FeedItem,
            {
              supabase,
              sendTimeoutMs: Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
              overrideText: typeof log.message_content === 'string' ? log.message_content : null
            }
          );
          const nowMs = Date.now();
          globalLastSentAtMs = nowMs;
          globalLastTargetId = String(targetRow.id);
          globalLastSentByTargetId.set(String(targetRow.id), nowMs);
          if (globalLastSentByTargetId.size > 1000) {
            globalLastSentByTargetId.clear();
          }
          return result;
        });

        const messageId = sendResult?.response?.key?.id;
        await ensureSendConfirmed(
          messageId || null,
          ['image', 'video', 'audio', 'document'].includes(String(sendResult?.media?.type || '')) &&
            Boolean(sendResult?.media?.sent)
        );

        await supabase
          .from('message_logs')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            processing_started_at: null,
            error_message: null,
            message_content: sendResult?.text || null,
            whatsapp_message_id: messageId || null,
            media_url: sendResult?.media?.url || null,
            media_type: sendResult?.media?.type || null,
            media_sent: Boolean(sendResult?.media?.sent),
            media_error: sendResult?.media?.error || null
          })
          .eq('id', log.id);

        await supabase
          .from('feed_items')
          .update({ sent: true, sent_at: new Date().toISOString() })
          .eq('id', String((feedItemRes.data as FeedItem).id || ''))
          .eq('sent', false);

        return { ok: true, messageId: messageId || null, mediaSent: Boolean(sendResult?.media?.sent) };
      }

      // Manual queue entry: message + optional media_url/media_type.
      const manualText = normalizeMessageText(String(parsedManual.text || '')).trim();
      const manualMediaUrlRaw = String(log.media_url || '').trim();
      const manualMediaType = String(log.media_type || '').trim().toLowerCase();
      const manualHasMedia = Boolean(manualMediaUrlRaw);

      if (!manualHasMedia && !manualText) {
        throw new Error('Manual message must include message text or a media URL');
      }

      const sendResult = await withTargetSendLock(targetRow, async () => {
        await waitForDelays(targetRow, settings);

        if (!manualHasMedia) {
          const response = await sendTextManual(manualText);
          const nowMs = Date.now();
          globalLastSentAtMs = nowMs;
          globalLastTargetId = String(targetRow.id);
          globalLastSentByTargetId.set(String(targetRow.id), nowMs);
          if (globalLastSentByTargetId.size > 1000) {
            globalLastSentByTargetId.clear();
          }
          return { response, media: null as null };
        }

        let safeUrl = manualMediaUrlRaw;
        try {
          safeUrl = (await assertSafeOutboundUrl(manualMediaUrlRaw)).toString();
        } catch (error) {
          throw new Error(`Blocked unsafe media URL: ${getErrorMessage(error)}`);
        }

        const inferredKind =
          manualMediaType === 'video'
            ? 'video'
            : manualMediaType === 'image'
              ? 'image'
              : manualMediaType === 'audio'
                ? 'audio'
                : manualMediaType === 'document'
                  ? 'document'
                : isVideoUrl(safeUrl)
                  ? 'video'
                  : isAudioUrl(safeUrl)
                    ? 'audio'
                    : isDocumentUrl(safeUrl)
                      ? 'document'
                  : isImageUrl(safeUrl)
                  ? 'image'
                : null;
        uncertainMediaType = inferredKind;
        uncertainMediaUrl = safeUrl;

        if (!inferredKind) {
          throw new Error('Unsupported media URL (expected image, video, audio, or document)');
        }

        if (inferredKind === 'video') {
          try {
            const { buffer, mimetype } = await downloadVideoBuffer(safeUrl, null);
            let sendBuffer = buffer;
            let sendMime = mimetype;
            let newsletterExtras: Record<string, unknown> | null = null;
            if (isNewsletterJid(jid)) {
              try {
                const prepared = await prepareNewsletterVideo(buffer, { maxBytes: 32 * 1024 * 1024 });
                sendBuffer = prepared.buffer;
                sendMime = prepared.mimetype || sendMime;
                newsletterExtras = {
                  ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
                  ...(typeof prepared.seconds === 'number' ? { seconds: prepared.seconds } : {}),
                  ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
                  ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
                };
              } catch (error) {
                logger.warn({ error, jid }, 'Failed to normalize newsletter video; sending original buffer');
              }
            }

            const content: Record<string, unknown> =
              includeCaption && manualText
                ? { video: sendBuffer, caption: manualText }
                : { video: sendBuffer };
            if (sendMime) content.mimetype = sendMime;
            if (newsletterExtras && Object.keys(newsletterExtras).length) {
              Object.assign(content, newsletterExtras);
            }
            const statusSnapshot =
              targetRow.type === 'status'
                ? await ensureFreshStatusRecipients(activeWhatsappClient, { maxAgeMinutes: 10, sampleSize: 25 })
                : null;

            const response =
              targetRow.type === 'status'
                ? await withTimeout(
                  activeWhatsappClient.sendStatusBroadcast(content, { statusJidList: statusSnapshot?.recipients || [] }),
                  getStatusSendTimeoutMs('media', Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS)),
                  'Timed out sending video status message'
                )
                : await withTimeout(
                  activeWhatsappClient.sendMessage(jid, content),
                  Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
                  'Timed out sending video message'
                );

            const nowMs = Date.now();
            globalLastSentAtMs = nowMs;
            globalLastTargetId = String(targetRow.id);
            globalLastSentByTargetId.set(String(targetRow.id), nowMs);
            if (globalLastSentByTargetId.size > 1000) {
              globalLastSentByTargetId.clear();
            }

            return { response, media: { type: 'video', url: safeUrl, sent: true, error: null } };
          } catch (error) {
            const message = getErrorMessage(error);
            if (!manualText) {
              throw error;
            }
            logger.warn({ error, jid, videoUrl: safeUrl }, 'Manual video send failed; using text fallback');
            const response = await sendTextManual(manualText);
            return { response, media: { type: 'video', url: safeUrl, sent: false, error: message } };
          }
        }

        if (inferredKind === 'audio') {
          if (targetRow.type === 'status') {
            throw new Error('Status only supports text, image, and video');
          }
          try {
            const { buffer, mimetype } = await downloadAudioBuffer(safeUrl, null);
            const content: Record<string, unknown> = { audio: buffer, mimetype, ptt: false };
            const response = await withTimeout(
              activeWhatsappClient.sendMessage(jid, content),
              Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
              'Timed out sending audio message'
            );

            const nowMs = Date.now();
            globalLastSentAtMs = nowMs;
            globalLastTargetId = String(targetRow.id);
            globalLastSentByTargetId.set(String(targetRow.id), nowMs);
            if (globalLastSentByTargetId.size > 1000) {
              globalLastSentByTargetId.clear();
            }

            return { response, media: { type: 'audio', url: safeUrl, sent: true, error: null } };
          } catch (error) {
            const message = getErrorMessage(error);
            if (!manualText) {
              throw error;
            }
            logger.warn({ error, jid, audioUrl: safeUrl }, 'Manual audio send failed; using text fallback');
            const response = await sendTextManual(manualText);
            return { response, media: { type: 'audio', url: safeUrl, sent: false, error: message } };
          }
        }

        if (inferredKind === 'document') {
          if (targetRow.type === 'status') {
            throw new Error('Status only supports text, image, and video');
          }
          try {
            const { buffer, mimetype, filename } = await downloadDocumentBuffer(safeUrl, null);
            const content: Record<string, unknown> = {
              document: buffer,
              mimetype: parsedManual.meta.documentMime || mimetype || 'application/octet-stream',
              fileName: parsedManual.meta.documentFilename || filename || 'attachment'
            };
            if (includeCaption && manualText) {
              content.caption = manualText;
            }
            const response = await withTimeout(
              activeWhatsappClient.sendMessage(jid, content),
              Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
              'Timed out sending document message'
            );

            const nowMs = Date.now();
            globalLastSentAtMs = nowMs;
            globalLastTargetId = String(targetRow.id);
            globalLastSentByTargetId.set(String(targetRow.id), nowMs);
            if (globalLastSentByTargetId.size > 1000) {
              globalLastSentByTargetId.clear();
            }

            return { response, media: { type: 'document', url: safeUrl, sent: true, error: null } };
          } catch (error) {
            const message = getErrorMessage(error);
            if (!manualText) {
              throw error;
            }
            logger.warn({ error, jid, documentUrl: safeUrl }, 'Manual document send failed; using text fallback');
            const response = await sendTextManual(manualText);
            return { response, media: { type: 'document', url: safeUrl, sent: false, error: message } };
          }
        }

        try {
          const { buffer, mimetype } = await downloadImageBuffer(safeUrl, null);
          let sendBuffer = buffer;
          let sendMime = mimetype;
          let newsletterExtras: Record<string, unknown> | null = null;
          if (isNewsletterJid(jid)) {
            try {
              const prepared = await prepareNewsletterImage(buffer, { maxBytes: 8 * 1024 * 1024 });
              sendBuffer = prepared.buffer;
              sendMime = prepared.mimetype || sendMime;
              newsletterExtras = {
                ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
                ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
                ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
              };
            } catch (error) {
              logger.warn({ error, jid }, 'Failed to normalize newsletter image; sending original buffer');
            }
          }

          const content: Record<string, unknown> =
            includeCaption && manualText
              ? { image: sendBuffer, caption: manualText }
              : { image: sendBuffer };
          if (sendMime) content.mimetype = sendMime;
          if (newsletterExtras && Object.keys(newsletterExtras).length) {
            Object.assign(content, newsletterExtras);
          }
          const statusSnapshot =
            targetRow.type === 'status'
              ? await ensureFreshStatusRecipients(activeWhatsappClient, { maxAgeMinutes: 10, sampleSize: 25 })
              : null;

          const response =
            targetRow.type === 'status'
              ? await withTimeout(
                activeWhatsappClient.sendStatusBroadcast(content, { statusJidList: statusSnapshot?.recipients || [] }),
                getStatusSendTimeoutMs('media', Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS)),
                'Timed out sending image status message'
              )
              : await withTimeout(
                activeWhatsappClient.sendMessage(jid, content),
                Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
                'Timed out sending image message'
              );

          const nowMs = Date.now();
          globalLastSentAtMs = nowMs;
          globalLastTargetId = String(targetRow.id);
          globalLastSentByTargetId.set(String(targetRow.id), nowMs);
          if (globalLastSentByTargetId.size > 1000) {
            globalLastSentByTargetId.clear();
          }

          return { response, media: { type: 'image', url: safeUrl, sent: true, error: null } };
        } catch (error) {
          const message = getErrorMessage(error);
          if (!manualText) {
            throw error;
          }
          logger.warn({ error, jid, imageUrl: safeUrl }, 'Manual image send failed; using text fallback');
          const response = await sendTextManual(manualText);
          return { response, media: { type: 'image', url: safeUrl, sent: false, error: message } };
        }
      });

      const messageId = sendResult?.response?.key?.id;
      const isMediaConfirmed = Boolean(sendResult?.media?.type) && Boolean(sendResult?.media?.sent);
      await ensureSendConfirmed(messageId || null, isMediaConfirmed);

      await supabase
        .from('message_logs')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          processing_started_at: null,
          error_message: null,
          message_content: manualText || null,
          whatsapp_message_id: messageId || null,
          media_url: sendResult?.media?.url || (manualHasMedia ? manualMediaUrlRaw : null) || null,
          media_type: sendResult?.media?.type || (manualHasMedia ? (manualMediaType || null) : null) || null,
          media_sent: Boolean(sendResult?.media?.sent),
          media_error: sendResult?.media?.error || null
        })
        .eq('id', log.id);

      return { ok: true, messageId: messageId || null, mediaSent: Boolean(sendResult?.media?.sent) };
    } catch (error) {
      const rawErrorMessage = getErrorMessage(error);
      const authError = isAuthStateError(rawErrorMessage);
      const errorMessage = authError
        ? `${AUTH_ERROR_HINT} (${rawErrorMessage || 'unknown auth error'})`
        : rawErrorMessage;
      const connectionStateError = isConnectionStateError(rawErrorMessage);
      const timedOut = isUnknownDeliveryTimeout(rawErrorMessage);
      const terminalStatus = timedOut ? 'uncertain' : connectionStateError ? originalStatus : 'failed';

      const keepMedia = !isAutomationBacked && Boolean(String(log.media_url || '').trim());
      const failurePatch: Record<string, unknown> = {
        status: terminalStatus,
        processing_started_at: timedOut ? log.processing_started_at || new Date().toISOString() : null,
        error_message: timedOut
          ? buildUncertainErrorMessage(errorMessage)
          : connectionStateError
            ? buildConnectionWaitErrorMessage(errorMessage)
            : errorMessage,
        message_content: timedOut ? uncertainMessageContent : log.message_content || null,
        media_url: timedOut ? uncertainMediaUrl : keepMedia ? log.media_url || null : null,
        media_type: timedOut ? uncertainMediaType : keepMedia ? log.media_type || null : null,
        media_sent: false,
        media_error: timedOut || keepMedia ? errorMessage : null
      };
      if (connectionStateError) {
        failurePatch.retry_count = originalRetryCount;
      }
      await supabase
        .from('message_logs')
        .update(failurePatch)
        .eq('id', log.id);

      return { ok: false, error: errorMessage };
    }
  } catch (error) {
    logger.error({ error, logId }, 'Failed to send queue item now');
    return { ok: false, error: getErrorMessage(error) };
  }
};

const sendPendingForAllSchedules = async (whatsappClient?: WhatsAppClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.error('Database not available - cannot send pending messages');
    return { sent: 0, schedules: 0, error: 'Database not available' };
  }
  if (await settingsService.isAppPaused()) {
    logger.info('Skipping pending send pass because app is paused');
    return { sent: 0, queued: 0, schedules: 0, skipped: true, reason: 'App is paused' };
  }

  try {
    const settings = await settingsService.getSettings();
    await recoverStaleProcessingLogs(supabase, settings, {
      context: 'Recovered stale processing rows before pending-send catch-up pass'
    });
    const uncertainReconcile = await reconcileUncertainMessageLogs(supabase, settings);

    const orphanCleanupCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: orphanPendingRows, error: orphanPendingError } = await supabase
      .from('message_logs')
      .select('id,target_id,message_content,media_url')
      .is('schedule_id', null)
      .eq('status', 'pending')
      .lt('created_at', orphanCleanupCutoffIso);
    if (orphanPendingError) throw orphanPendingError;

    const orphanPendingIds = (orphanPendingRows || [])
      .filter((row: { id?: string; target_id?: string | null; message_content?: string | null; media_url?: string | null }) => {
        const hasTarget = Boolean(String(row.target_id || '').trim());
        const hasText = Boolean(String(row.message_content || '').trim());
        const hasMedia = Boolean(String(row.media_url || '').trim());
        return !hasTarget || (!hasText && !hasMedia);
      })
      .map((row: { id?: string }) => row.id)
      .filter(Boolean) as string[];
    if (orphanPendingIds.length) {
      const { error: cleanupError } = await supabase
        .from('message_logs')
        .delete()
        .in('id', orphanPendingIds);
      if (cleanupError) {
        logger.warn({ error: cleanupError, orphanPendingCount: orphanPendingIds.length }, 'Failed cleaning orphan pending logs');
      } else {
        logger.info({ orphanPendingCount: orphanPendingIds.length }, 'Cleaned orphan pending logs');
      }
    }

    const { data: pendingLogs, error: pendingLogsError } = await supabase
      .from('message_logs')
      .select('schedule_id')
      .eq('status', 'pending');

    if (pendingLogsError) {
      throw pendingLogsError;
    }

    const scheduleIds = [...new Set((pendingLogs || []).map((log: { schedule_id?: string }) => log.schedule_id).filter(Boolean))] as string[];
    const { data: scheduleRows } = await supabase
      .from('schedules')
      .select('id,delivery_mode,next_run_at,batch_times,timezone,state,active')
      .in('id', scheduleIds);

    const scheduleById = new Map(
      (scheduleRows || [])
        .filter((row: { id?: string }) => Boolean(row?.id))
        .map((row: { id?: string }) => [String(row.id), row] as const)
    );

    let totalSent = 0;
    let totalQueued = 0;
    let skippedBatch = 0;

    for (const scheduleId of scheduleIds) {
      const schedule = scheduleById.get(scheduleId) as
        | {
          delivery_mode?: string | null;
          next_run_at?: string | null;
          batch_times?: string[] | null;
          timezone?: string | null;
          active?: boolean;
          state?: string | null;
        }
        | undefined;
      if (schedule && !isScheduleRunning(schedule)) {
        continue;
      }

      const isBatchSchedule = schedule?.delivery_mode === 'batched' || schedule?.delivery_mode === 'batch';
      if (isBatchSchedule) {
        const overdueDispatchGraceMs = getOverdueBatchDispatchGraceMs();
        let nextRunAtMs = schedule?.next_run_at ? Date.parse(String(schedule.next_run_at)) : Number.NaN;

        // Never dispatch batched schedules without a valid due cursor.
        if (!Number.isFinite(nextRunAtMs)) {
          const batchTimes = parseBatchTimes(schedule?.batch_times);
          const computedNextRunAt = computeNextBatchRunAt(batchTimes, schedule?.timezone || 'UTC');
          if (computedNextRunAt) {
            nextRunAtMs = Date.parse(computedNextRunAt);
            await supabase.from('schedules').update({ next_run_at: computedNextRunAt }).eq('id', scheduleId);
            schedule.next_run_at = computedNextRunAt;
          }
        }

        const overdueAgeMs = Number.isFinite(nextRunAtMs) ? Date.now() - nextRunAtMs : Number.NaN;
        const shouldAttemptBatchDispatch =
          Number.isFinite(overdueAgeMs) &&
          overdueAgeMs >= 0 &&
          overdueAgeMs <= overdueDispatchGraceMs;

        if (!shouldAttemptBatchDispatch) {
          const staleDueCursor = Number.isFinite(overdueAgeMs) && overdueAgeMs > overdueDispatchGraceMs;
          if (staleDueCursor) {
            const batchTimes = parseBatchTimes(schedule?.batch_times);
            const computedNextRunAt = computeNextBatchRunAt(batchTimes, schedule?.timezone || 'UTC');
            if (computedNextRunAt) {
              await supabase.from('schedules').update({ next_run_at: computedNextRunAt }).eq('id', scheduleId);
              schedule.next_run_at = computedNextRunAt;
            }
          }
          skippedBatch += 1;
          continue;
        }
      }

      const lockResult = await withScheduleLock(
        supabase,
        scheduleId,
        async () =>
          sendQueuedForSchedule(scheduleId, whatsappClient, {
            allowOverdueBatchDispatch: true,
            skipQueueGeneration: true
          }),
        { timeoutMs: 300000, skipIfLocked: true }
      );
      if (lockResult.skipped || !lockResult.result) {
        continue;
      }

      const result = lockResult.result;
      if (result?.sent) {
        totalSent += result.sent;
      }
      if (result?.queued) {
        totalQueued += result.queued;
      }
    }

    // Handle stale pending schedules that no longer exist in schedules table.
    for (const scheduleId of scheduleIds) {
      if (scheduleById.has(scheduleId)) {
        continue;
      }
      logger.warn({ scheduleId }, 'Skipping pending logs for missing schedule');
    }

    logger.info(
      { scheduleCount: scheduleIds.length, skippedBatch, totalSent, totalQueued, uncertainReconcile },
      'Processed pending schedules after reconnect'
    );
    return { sent: totalSent, queued: totalQueued, schedules: scheduleIds.length, uncertainReconcile };
  } catch (error) {
    logger.error({ error }, 'Failed to send pending schedules after reconnect');
    return { sent: 0, queued: 0, schedules: 0, error: getErrorMessage(error) };
  }
};

module.exports = {
  sendQueuedForSchedule,
  sendPendingForAllSchedules,
  queueLatestForSchedule,
  sendQueueLogNow,
  reconcileUpdatedFeedItems,
  __testUtils: {
    buildDispatchIdentityKey,
    computeStaleProcessingThresholdMs,
    partitionStaleProcessingRows,
    computeUncertainRetryDelayMs,
    compareFeedDispatchOrder,
    planFeedDispatchPage,
    inferChatMessageMediaKind,
    doesChatMessageMatchExpectedAttempt,
    hasCorrectionChanges,
    chooseCorrectionStrategy,
    isConnectionStateError,
    buildConnectionWaitErrorMessage
  }
};
