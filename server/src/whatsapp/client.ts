import type { AnyMessageContent, AnyRegularMessageContent, MiscMessageGenerationOptions, WASocket, proto } from '@whiskeysockets/baileys';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';

const { AsyncLocalStorage } = require('async_hooks');
const { loadBaileys } = require('./baileys');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const withTimeout = require('../utils/withTimeout');
const { getErrorMessage } = require('../utils/errorUtils');
const useSupabaseAuthState = require('./authStore');
const { saveIncomingMessages } = require('../services/messageService');
const { initSchedulers } = require('../services/schedulerService');
const { refreshStatusRecipients } = require('../services/statusAudienceService');
const { runTargetAutoSyncPass } = require('../services/targetSyncService');
const { persistReceiptUpdates } = require('../services/receiptService');

const SEND_EPHEMERAL_EXPIRATION =
  String(process.env.WHATSAPP_SEND_EPHEMERAL_EXPIRATION ?? 'true').trim().toLowerCase() !== 'false';
const INCLUDE_GROUP_METADATA_IN_STATUS_AUDIENCE =
  String(process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS ?? 'true').trim().toLowerCase() !== 'false';
const ALLOW_UNMAPPED_LID_STATUS_AUDIENCE =
  String(process.env.WHATSAPP_STATUS_ALLOW_UNMAPPED_LID_AUDIENCE || '').trim().toLowerCase() === 'true';
const STATUS_LID_MAPPING_LIMIT = Math.max(
  0,
  Math.min(Math.floor(Number(process.env.WHATSAPP_STATUS_LID_MAPPING_LIMIT || 2000)), 10000)
);
const AUTO_CLEAR_CORRUPTED_AUTH =
  String(process.env.WHATSAPP_AUTH_AUTO_CLEAR_CORRUPTION ?? 'false').trim().toLowerCase() === 'true';
const newsletterMediaPatchContext = new AsyncLocalStorage();

const isNewsletterMediaDirectPathPatchEnabled = () =>
  String(process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH || '').trim().toLowerCase() === 'true';

const resolveBrowserTuple = (Browsers: Record<string, unknown> | null | undefined, browserName: string) => {
  const requestedPlatform = String(
    process.env.WHATSAPP_BROWSER_PLATFORM ||
    process.env.WHATSAPP_BROWSER ||
    process.env.WHATSAPP_DEVICE_PLATFORM ||
    'ubuntu'
  )
    .trim()
    .toLowerCase();

  const builders: Record<string, unknown> = {
    windows: Browsers?.windows,
    ubuntu: Browsers?.ubuntu,
    macos: Browsers?.macOS,
    'mac os': Browsers?.macOS,
    appropriate: Browsers?.appropriate,
    baileys: Browsers?.baileys
  };

  const requestedBuilder = builders[requestedPlatform];
  const fallbackBuilder =
    Browsers?.ubuntu ||
    Browsers?.windows ||
    Browsers?.appropriate ||
    Browsers?.macOS ||
    Browsers?.baileys;

  const browser =
    typeof requestedBuilder === 'function'
      ? (requestedBuilder as (name: string) => string[])(browserName)
      : typeof fallbackBuilder === 'function'
        ? (fallbackBuilder as (name: string) => string[])(browserName)
        : null;

  if (Array.isArray(browser) && browser.length === 3) {
    return browser;
  }

  return ['Ubuntu', browserName, '22.04.4'];
};

const rewriteNewsletterMediaPath = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/o1/')) return raw.replace(/^\/o1\//, '/m1/');
  if (/^https:\/\/mmg\.whatsapp\.net\/o1\//i.test(raw)) {
    return raw.replace(/^https:\/\/mmg\.whatsapp\.net\/o1\//i, 'https://mmg.whatsapp.net/m1/');
  }
  return raw;
};

const patchNewsletterMediaDirectPaths = <T extends Record<string, any>>(
  message: T,
  options: { force?: boolean } = {}
): T => {
  if (!options.force && !isNewsletterMediaDirectPathPatchEnabled()) return message;
  if (!message || typeof message !== 'object') return message;

  const containers = [
    (message as any).imageMessage,
    (message as any).videoMessage,
    (message as any).documentMessage
  ].filter((container) => container && typeof container === 'object');

  let patched = false;
  for (const container of containers) {
    for (const key of ['directPath', 'thumbnailDirectPath', 'url']) {
      const current = container[key];
      const next = rewriteNewsletterMediaPath(current);
      if (next && next !== current) {
        container[key] = next;
        patched = true;
      }
    }
  }

  if (patched) {
    logger.warn('Patched newsletter media directPath from /o1/ to /m1/');
  }

  return message;
};

const normalizeNewsletterUploadToken = (value: string) => value.replace(/\+/g, '-').replace(/\//g, '_');

const getNewsletterRelayMediaType = (content: AnyMessageContent): 'image' | 'video' | null => {
  if (!content || typeof content !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(content as Record<string, unknown>, 'image')) return 'image';
  if (Object.prototype.hasOwnProperty.call(content as Record<string, unknown>, 'video')) return 'video';
  return null;
};

const STATUS_MEDIA_CONTENT_KEYS = ['image', 'video', 'audio', 'document', 'sticker'] as const;

const isStatusMediaContent = (content: AnyMessageContent) =>
  Boolean(
    content &&
    typeof content === 'object' &&
    STATUS_MEDIA_CONTENT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(content as Record<string, unknown>, key))
  );

const sanitizeStatusBroadcastOptions = (
  content: AnyMessageContent,
  options: Record<string, unknown>
): { options: Record<string, unknown>; strippedOptions: string[] } => {
  const nextOptions = { ...(options || {}) };
  const strippedOptions: string[] = [];

  if (isStatusMediaContent(content)) {
    for (const key of ['backgroundColor', 'font']) {
      if (Object.prototype.hasOwnProperty.call(nextOptions, key)) {
        delete nextOptions[key];
        strippedOptions.push(key);
      }
    }
  }

  return { options: nextOptions, strippedOptions };
};

const preferDeliverableStatusRecipients = (
  recipients: string[]
): { recipients: string[]; droppedLidCount: number } => {
  const normalizedRecipients = Array.from(
    new Set(
      (Array.isArray(recipients) ? recipients : [])
        .map((recipient) => normalizeStatusAudienceJid(recipient))
        .filter(Boolean)
    )
  );

  const phoneRecipients = normalizedRecipients.filter((recipient) => recipient.endsWith('@s.whatsapp.net'));
  if (!phoneRecipients.length) {
    return { recipients: normalizedRecipients, droppedLidCount: 0 };
  }

  const droppedLidCount = normalizedRecipients.filter((recipient) => recipient.endsWith('@lid')).length;
  return {
    recipients: phoneRecipients,
    droppedLidCount
  };
};

type WhatsAppStatus = 'disconnected' | 'connecting' | 'connected' | 'qr' | 'error' | 'conflict' | 'paused';

type MessageStatusSnapshot = {
  status: number | null;
  statusLabel: string | null;
  remoteJid: string | null;
  updatedAtMs: number;
};

type MessageFailureSnapshot = {
  errorCode: string | null;
  errorMessage: string;
  remoteJid: string | null;
  updatedAtMs: number;
};

type ChannelSummary = {
  id: string;
  jid: string;
  name: string;
  subscribers: number;
  role?: string | null;
  canPost?: boolean;
  source?: 'api' | 'cache' | 'metadata' | 'store';
};

type GroupSummary = {
  id: string;
  jid: string;
  name: string;
  size: number;
  announce?: boolean;
  restrict?: boolean;
  participantCount?: number;
  me?: { jid: string | null; isAdmin: boolean; admin: string | null };
};

type ResolvedDestination = {
  input: string;
  type: 'group' | 'channel' | 'individual' | 'status';
  jid: string;
  name: string;
  source: 'group_invite' | 'channel_invite' | 'group_jid' | 'channel_jid' | 'individual_jid' | 'status';
  size?: number;
  participantCount?: number;
  announce?: boolean;
  restrict?: boolean;
  subscribers?: number;
  role?: string | null;
  canPost?: boolean;
  exists?: boolean | null;
  me?: { jid: string | null; isAdmin: boolean; admin: string | null };
  inviteCode?: string | null;
};

type ChannelDiagnostics = {
  methodsTried: string[];
  methodErrors: string[];
  sourceCounts: {
    api: number;
    cache: number;
    metadata: number;
    store: number;
  };
  seeded: {
    provided: number;
    verified: number;
    failed: number;
    failedJids: string[];
  };
  limitation: string | null;
};

type CachedNewsletterChat = {
  jid: string;
  name: string;
  subscribers: number;
  updatedAtMs: number;
};

const isTransientLeaseFailureReason = (reason: unknown) =>
  String(reason || '').trim().toLowerCase() === 'transient_error';

const HARD_REFRESH_RECENT_CONNECTION_GRACE_MS = 2 * 60 * 1000;
const CONTACTS_CACHE_MAX_SIZE = Math.max(Number(process.env.WHATSAPP_CONTACTS_CACHE_MAX_SIZE || 1000), 100);

const INITIAL_QR_TTL_MS = 60_000;
const ROTATED_QR_TTL_MS = 20_000;

const trimMapToMaxSize = <K, V>(map: Map<K, V>, maxSize: number) => {
  let removed = 0;
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
    removed++;
  }
  return removed;
};

const redactSensitiveText = (value?: string | null) => {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(/\b\d{8,15}\b/g, '[redacted-number]')
    .replace(/(<stream:error[^>]*>)[\s\S]*?(<\/stream:error>)/gi, '$1[redacted]$2')
    .slice(0, 320);
};

const mapMessageStatusLabel = (status: number | null) => {
  switch (status) {
    case 0:
      return 'error';
    case 1:
      return 'pending';
    case 2:
      return 'server';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'played';
    default:
      return null;
  }
};

const normalizeNewsletterJid = (value: unknown, options?: { allowNumeric?: boolean }) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  // Baileys treats the newsletter server as exactly "@newsletter". Some UIs surface decorated
  // forms like "true_123@newsletter_ABC..."; canonicalize those to a Baileys-safe jid.
  if (raw.toLowerCase().includes('@newsletter')) {
    const match = raw.toLowerCase().match(/([a-z0-9._-]+)@newsletter/i);
    const userRaw = String(match?.[1] || '').trim();
    if (!userRaw) return '';

    const strippedPrefix = userRaw.replace(/^(true|false)_/i, '');
    const hasLetters = /[a-z]/i.test(strippedPrefix);
    const digits = strippedPrefix.replace(/[^0-9]/g, '');
    const user = hasLetters ? strippedPrefix : (digits || strippedPrefix);
    return user ? `${user}@newsletter` : '';
  }

  if (raw.includes('@')) return '';
  if (!options?.allowNumeric) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? `${digits}@newsletter` : '';
};

const readNumericValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readTextValue = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2060\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const readPositiveInteger = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.trunc(parsed);
  }
  return null;
};

const extractGroupInviteCode = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/chat\.whatsapp\.com\/([A-Za-z0-9]{10,40})/i);
  return String(match?.[1] || '').trim();
};

const extractChannelInviteCode = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]{6,80})/i);
  return String(match?.[1] || '').trim();
};

const normalizeGroupJid = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().endsWith('@g.us')) return raw;
  if (raw.includes('@')) return '';
  const cleaned = raw.replace(/[^0-9-]/g, '');
  return cleaned ? `${cleaned}@g.us` : '';
};

const normalizePersonJidForCompare = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'status@broadcast') return '';

  if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) {
    const atIndex = raw.lastIndexOf('@');
    const server = atIndex > 0 ? raw.slice(atIndex + 1) : '';
    const userRaw = atIndex > 0 ? raw.slice(0, atIndex) : '';
    const userBase = String(userRaw.split(':')[0] || '').trim();
    if (!userBase) return '';

    const digits = userBase.replace(/[^0-9]/g, '');
    if (digits.length >= 7) {
      return `${digits}@s.whatsapp.net`;
    }

    const safeUser = userBase.replace(/[^a-z0-9._-]/g, '');
    if (!safeUser) return '';
    if (server === 'lid') return `${safeUser}@lid`;
    if (server === 's.whatsapp.net') return `${safeUser}@s.whatsapp.net`;
    return '';
  }

  if (raw.includes('@')) return '';

  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 7) return '';
  return `${digits}@s.whatsapp.net`;
};

const isSamePersonJid = (left: unknown, right: unknown) => {
  const normalizedLeft = normalizePersonJidForCompare(left);
  const normalizedRight = normalizePersonJidForCompare(right);
  if (normalizedLeft && normalizedRight) {
    return normalizedLeft === normalizedRight;
  }
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
};

const normalizeIndividualJid = (value: unknown) => {
  return normalizePersonJidForCompare(value);
};

const normalizeStatusAudienceJid = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'status@broadcast') return '';

  if (raw.endsWith('@lid')) {
    const atIndex = raw.lastIndexOf('@');
    const userRaw = atIndex > 0 ? raw.slice(0, atIndex) : '';
    const userBase = String(userRaw.split(':')[0] || '').trim();
    const safeUser = userBase.replace(/[^a-z0-9._-]/g, '');
    return safeUser ? `${safeUser}@lid` : '';
  }

  if (!raw.includes('@')) {
    const digits = raw.replace(/[^0-9]/g, '');
    return digits.length >= 6 ? `${digits}@s.whatsapp.net` : '';
  }

  if (raw.endsWith('@c.us')) {
    const atIndex = raw.lastIndexOf('@');
    const userRaw = atIndex > 0 ? raw.slice(0, atIndex) : '';
    const userBase = String(userRaw.split(':')[0] || '').trim();
    const digits = userBase.replace(/[^0-9]/g, '');
    return digits.length >= 6 ? `${digits}@s.whatsapp.net` : '';
  }

  const normalized = normalizePersonJidForCompare(raw);
  if (!normalized || normalized === 'status@broadcast') return '';
  if (normalized.endsWith('@s.whatsapp.net') || normalized.endsWith('@lid')) return normalized;
  return '';
};

type StatusAudienceSources = {
  contactsCache: number;
  storeContacts: number;
  storeChats: number;
  groupMetadata: number;
  env: number;
  me: number;
  lidMappings: number;
};

const getStatusAudienceSafeSourceCount = (sources: Partial<StatusAudienceSources> | null | undefined) =>
  Math.max(0, Math.floor(Number(sources?.contactsCache || 0))) +
  Math.max(0, Math.floor(Number(sources?.storeContacts || 0))) +
  Math.max(0, Math.floor(Number(sources?.storeChats || 0))) +
  Math.max(0, Math.floor(Number(sources?.env || 0))) +
  Math.max(0, Math.floor(Number(sources?.lidMappings || 0)));

const isUnsafeImplicitStatusAudience = (
  recipients: string[],
  sources: Partial<StatusAudienceSources> | null | undefined
) => {
  if (!recipients.length || ALLOW_UNMAPPED_LID_STATUS_AUDIENCE) return false;
  const groupSignals = Math.max(0, Math.floor(Number(sources?.groupMetadata || 0)));
  if (groupSignals <= 0 || getStatusAudienceSafeSourceCount(sources) > 0) return false;
  const lidCount = recipients.filter((recipient) => recipient.endsWith('@lid')).length;
  return lidCount / recipients.length >= 0.9;
};

const stripTargetTypeTags = (value: string) =>
  String(value || '')
    .replace(/\((group|channel|status|individual)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasRawJidLabel = (value: string) =>
  /@(g\.us|newsletter(?:_[a-z0-9_-]+)?|s\.whatsapp\.net|lid)\b/i.test(String(value || '').trim());

const isLikelyPlaceholderChannelName = (value: string) => {
  const normalized = readTextValue(value).toLowerCase();
  if (!normalized) return true;
  if (/^channel[\s_-]*\d+$/i.test(normalized)) return true;
  if (/^[\d\s._-]{6,}$/.test(normalized)) return true;
  return false;
};

const sanitizeChannelDisplayName = (name: unknown, jid: string) => {
  const normalizedJid = String(jid || '').trim();
  let cleaned = readTextValue(name);
  if (!cleaned) return '';

  if (/\btarget\b/i.test(cleaned)) {
    const beforeTarget = readTextValue(cleaned.split(/\btarget\b/i)[0]);
    if (beforeTarget.length >= 3) cleaned = beforeTarget;
  }

  const repeatedTypeMentions = (cleaned.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) {
    const firstSegment = readTextValue(cleaned.split(/\((group|channel|status|individual)\)/i)[0]);
    if (firstSegment) cleaned = firstSegment;
  }

  cleaned = stripTargetTypeTags(cleaned);
  if (!cleaned) return '';
  if (isLikelyPlaceholderChannelName(cleaned)) return '';
  if (hasRawJidLabel(cleaned)) return '';
  if (normalizedJid && cleaned.toLowerCase() === normalizedJid.toLowerCase()) return '';
  return cleaned;
};

const extractChannelSummary = (input: unknown, options?: { allowNumeric?: boolean }): ChannelSummary | null => {
  if (typeof input === 'string') {
    const jid = normalizeNewsletterJid(input, options);
    if (!jid) return null;
    return { id: jid, jid, name: jid, subscribers: 0 };
  }

  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const jid =
    normalizeNewsletterJid(record.jid, options) ||
    normalizeNewsletterJid(record.id, options) ||
    normalizeNewsletterJid(record.newsletter_id, options);
  if (!jid) return null;

  const threadMetadata =
    record.thread_metadata && typeof record.thread_metadata === 'object'
      ? (record.thread_metadata as Record<string, unknown>)
      : null;
  const threadName =
    threadMetadata?.name && typeof threadMetadata.name === 'object'
      ? (threadMetadata.name as Record<string, unknown>)
      : null;

  const rawName =
    readTextValue(record.name) ||
    readTextValue(record.subject) ||
    readTextValue(threadName?.text) ||
    readTextValue(threadMetadata?.name) ||
    jid;
  const name = sanitizeChannelDisplayName(rawName, jid) || jid;

  const subscribers =
    readNumericValue(record.subscribers) ||
    readNumericValue(record.subscribers_count) ||
    readNumericValue(threadMetadata?.subscribers_count);

  const viewerMetadata =
    record.viewer_metadata && typeof record.viewer_metadata === 'object'
      ? (record.viewer_metadata as Record<string, unknown>)
      : null;
  const roleRaw = readTextValue(viewerMetadata?.role);
  const role = roleRaw || null;
  const canPost = role === 'OWNER' || role === 'ADMIN';

  return {
    id: jid,
    jid,
    name,
    subscribers,
    role,
    canPost
  };
};

const resolveSessionId = () => {
  const explicit = String(process.env.WHATSAPP_SESSION_ID || '').trim();
  if (explicit) return explicit;
  return process.env.NODE_ENV === 'production' ? 'primary' : 'local';
};

class WhatsAppClient {
  socket: WASocket | null;
  status: WhatsAppStatus;
  isPaused: boolean;
  qrCode: string | null;
  qrGeneratedAtMs: number | null;
  qrExpiresAtMs: number | null;
  qrGenerationCount: number;
  lastError: string | null;
  lastSeenAt: Date | null;
  instanceId: string;
  sessionId: string;
  authStore: {
    state: { creds: Record<string, unknown>; keys: { get: (type: string, ids: string[]) => Promise<Record<string, unknown>>; set: (data: Record<string, Record<string, unknown>>) => Promise<void> } };
    saveCreds: () => Promise<void>;
    clearState: () => Promise<void>;
    clearKeys?: (types?: string[]) => Promise<void>;
    updateStatus: (status: string, qrCode?: string | null) => Promise<void>;
    acquireLease?: (
      ownerId: string,
      ttlMs?: number
    ) => Promise<{ ok: boolean; supported: boolean; ownerId: string | null; expiresAt: string | null; reason?: string }>;
    renewLease?: (
      ownerId: string,
      ttlMs?: number
    ) => Promise<{ ok: boolean; supported: boolean; ownerId: string | null; expiresAt: string | null; reason?: string }>;
    releaseLease?: (
      ownerId: string
    ) => Promise<{ ok: boolean; supported: boolean; ownerId: string | null; expiresAt: string | null; reason?: string }>;
    forceAcquireLease?: (
      ownerId: string,
      ttlMs?: number
    ) => Promise<{ ok: boolean; supported: boolean; ownerId: string | null; expiresAt: string | null; reason?: string }>;
    getLeaseInfo?: () => Promise<{ supported: boolean; ownerId: string | null; expiresAt: string | null }>;
  } | null;
  leaseSupported: boolean;
  leaseHeld: boolean;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
  leaseRenewTimer: NodeJS.Timeout | null;
  reconnectAttempts: number;
  conflictAttempts: number;
  maxReconnectAttempts: number;
  isConnecting: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  isHandlingAuthCorruption: boolean;
  isAuthCorrupted: boolean;
  lastSenderKeyResetAt: number | null;
  lastKeyCacheResetAt: number | null;
  groupMetadataCache: Map<string, unknown>;
  groupsListCache: GroupSummary[];
  groupsListFetchedAtMs: number;
  groupsListFetchInFlight: Promise<GroupSummary[]> | null;
  groupsListRateLimitedUntilMs: number;
  presenceOfflineTimer: NodeJS.Timeout | null;
  processErrorHandlersBound: boolean;
  waVersion: number[] | null;
  waVersionFetchedAtMs: number | null;
  contactsCache: Map<string, { name?: string }>;
  recentSentMessages: Map<string, proto.IWebMessageInfo>;
  recentMessageStatuses: Map<string, MessageStatusSnapshot>;
  recentMessageFailures: Map<string, MessageFailureSnapshot>;
  pendingReceiptUpdates: Map<string, MessageStatusSnapshot>;
  pendingReceiptFlushTimer: NodeJS.Timeout | null;
  newsletterChatCache: Map<string, CachedNewsletterChat>;
  meJid: string | null;
  meName: string | null;
  hasConnectedOnce: boolean;

  constructor() {
    this.socket = null;
    this.status = 'disconnected';
    this.isPaused = false;
    this.qrCode = null;
    this.qrGeneratedAtMs = null;
    this.qrExpiresAtMs = null;
    this.qrGenerationCount = 0;
    this.lastError = null;
    this.lastSeenAt = null;
    this.instanceId = randomUUID();
    this.sessionId = resolveSessionId();
    this.authStore = null;
    this.leaseSupported = false;
    this.leaseHeld = false;
    this.leaseOwnerId = null;
    this.leaseExpiresAt = null;
    this.leaseRenewTimer = null;
    this.reconnectAttempts = 0;
    this.conflictAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isConnecting = false;
    this.reconnectTimer = null;
    this.isHandlingAuthCorruption = false;
    this.isAuthCorrupted = false;
    this.lastSenderKeyResetAt = null;
    this.lastKeyCacheResetAt = null;
    this.groupMetadataCache = new Map();
    this.groupsListCache = [];
    this.groupsListFetchedAtMs = 0;
    this.groupsListFetchInFlight = null;
    this.groupsListRateLimitedUntilMs = 0;
    this.presenceOfflineTimer = null;
    this.processErrorHandlersBound = false;
    this.waVersion = null;
    this.waVersionFetchedAtMs = null;
    this.contactsCache = new Map();
    this.recentSentMessages = new Map();
    this.recentMessageStatuses = new Map();
    this.recentMessageFailures = new Map();
    this.pendingReceiptUpdates = new Map();
    this.pendingReceiptFlushTimer = null;
    this.newsletterChatCache = new Map();
    this.meJid = null;
    this.meName = null;
    this.hasConnectedOnce = false;
  }

  clearQrState(): void {
    this.qrCode = null;
    this.qrGeneratedAtMs = null;
    this.qrExpiresAtMs = null;
  }

  resetQrLifecycle(): void {
    this.clearQrState();
    this.qrGenerationCount = 0;
  }

  resolveIncomingQrTtlMs(): number {
    return this.qrGenerationCount > 0 ? ROTATED_QR_TTL_MS : INITIAL_QR_TTL_MS;
  }

  getQrState(): {
    qr: string | null;
    generatedAt: string | null;
    expiresAt: string | null;
    ttlMs: number | null;
    remainingMs: number | null;
  } {
    if (this.qrExpiresAtMs && this.qrExpiresAtMs <= Date.now()) {
      this.clearQrState();
    }

    const remainingMs =
      this.qrExpiresAtMs && this.qrExpiresAtMs > Date.now()
        ? Math.max(this.qrExpiresAtMs - Date.now(), 0)
        : null;

    return {
      qr: this.qrCode,
      generatedAt: this.qrGeneratedAtMs ? new Date(this.qrGeneratedAtMs).toISOString() : null,
      expiresAt: this.qrExpiresAtMs ? new Date(this.qrExpiresAtMs).toISOString() : null,
      ttlMs: this.qrGeneratedAtMs && this.qrExpiresAtMs ? Math.max(this.qrExpiresAtMs - this.qrGeneratedAtMs, 0) : null,
      remainingMs
    };
  }

  scheduleReceiptFlush(): void {
    if (this.pendingReceiptFlushTimer) return;
    this.pendingReceiptFlushTimer = setTimeout(() => {
      this.pendingReceiptFlushTimer = null;
      void this.flushPendingReceiptUpdates();
    }, 900);
  }

  clearPresenceOfflineHeartbeat(): void {
    if (!this.presenceOfflineTimer) return;
    clearInterval(this.presenceOfflineTimer);
    this.presenceOfflineTimer = null;
  }

  startPresenceOfflineHeartbeat(): void {
    this.clearPresenceOfflineHeartbeat();

    const socket = this.socket as any;
    if (!socket || typeof socket.sendPresenceUpdate !== 'function') return;

    const intervalMs = Math.max(Number(process.env.WHATSAPP_PRESENCE_OFFLINE_INTERVAL_MS || 5 * 60_000) || 0, 0);
    if (intervalMs <= 0) return;

    const tick = async () => {
      if (this.status !== 'connected') return;
      const current = this.socket as any;
      if (!current || typeof current.sendPresenceUpdate !== 'function') return;
      try {
        await current.sendPresenceUpdate('unavailable');
      } catch (error) {
        logger.debug({ error }, 'Failed to send offline presence update');
      }
    };

    void tick();
    this.presenceOfflineTimer = setInterval(() => void tick(), Math.max(intervalMs, 60_000));
  }

  async flushPendingReceiptUpdates(): Promise<void> {
    if (!this.pendingReceiptUpdates.size) return;

    const updates = Array.from(this.pendingReceiptUpdates.entries()).map(([id, snapshot]) => ({
      id,
      status: snapshot.status,
      statusLabel: snapshot.statusLabel,
      remoteJid: snapshot.remoteJid,
      updatedAtMs: snapshot.updatedAtMs
    }));
    this.pendingReceiptUpdates.clear();

    try {
      await persistReceiptUpdates(updates);
    } catch (error) {
      logger.warn({ error }, 'Failed to persist delivery receipts');
    }
  }

  rememberMessageStatus(messageId: string, snapshot: MessageStatusSnapshot): void {
    const id = String(messageId || '').trim();
    if (!id) return;

    const existing = this.recentMessageStatuses.get(id);
    const existingStatus = typeof existing?.status === 'number' ? existing.status : -1;
    const nextStatus = typeof snapshot.status === 'number' ? snapshot.status : -1;

    if (!existing || nextStatus >= existingStatus) {
      this.recentMessageStatuses.set(id, snapshot);
    }

    if (snapshot.statusLabel === 'delivered' || snapshot.statusLabel === 'read' || snapshot.statusLabel === 'played') {
      this.pendingReceiptUpdates.set(id, snapshot);
      if (this.pendingReceiptUpdates.size > 2000) {
        this.pendingReceiptUpdates.clear();
      }
      this.scheduleReceiptFlush();
    }

    if (this.recentMessageStatuses.size > 1000) {
      const oldest = this.recentMessageStatuses.keys().next().value;
      if (oldest) {
        this.recentMessageStatuses.delete(oldest);
      }
    }
  }

  rememberMessageFailure(messageId: string, snapshot: MessageFailureSnapshot): void {
    const id = String(messageId || '').trim();
    if (!id) return;

    this.recentMessageFailures.set(id, snapshot);
    if (this.recentMessageFailures.size > 1000) {
      const oldest = this.recentMessageFailures.keys().next().value;
      if (oldest) {
        this.recentMessageFailures.delete(oldest);
      }
    }
  }

  async init(): Promise<void> {
    try {
      this.authStore = await useSupabaseAuthState(this.sessionId);

      // Respect a persisted pause flag so the bot doesn't immediately reconnect after a restart/deploy.
      try {
        const settingsService = require('../services/settingsService');
        const settings = await settingsService.getSettings?.();
        const paused = settings?.whatsapp_paused === true;
        if (paused) {
          this.isPaused = true;
          this.isConnecting = false;
          this.status = 'paused';
          this.lastError = 'WhatsApp session paused.';
          // Keep the cross-instance lease while paused so only one instance continues
          // feed polling + queue work (and so deploy overlaps don't start a second bot).
          try {
            const store = this.authStore;
            if (store?.acquireLease) {
              const lease = await store.acquireLease(this.instanceId, 90_000);
              this.leaseSupported = lease.supported;
              this.leaseHeld = lease.ok;
              this.leaseOwnerId = lease.ownerId;
              this.leaseExpiresAt = lease.expiresAt;
              if (lease.supported && lease.ok) {
                this.startLeaseRenewal(90_000);
              }
            } else {
              this.leaseSupported = false;
              this.leaseHeld = true;
              this.leaseOwnerId = null;
              this.leaseExpiresAt = null;
            }
          } catch (error) {
            logger.warn({ error }, 'Failed to acquire WhatsApp lease while paused');
          }
          return;
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to load WhatsApp pause state from settings');
      }

      await this.connect();
    } catch (error) {
      logger.error({ error }, 'Failed to initialize WhatsApp client');
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.status = 'error';
    }
  }

  // Handle uncaught errors from the socket to prevent crashes
  setupErrorHandlers(): void {
    if (!this.socket || this.processErrorHandlersBound) return;
    this.processErrorHandlersBound = true;

    // Handle process-level uncaught exceptions from crypto errors
    const handleUncaught = async (err: Error) => {
      // Check if it's a crypto/auth error
      if (this.isAuthStateCorrupted(err?.message)) {
        await this.handleCorruptedAuthState(err);
      } else if (this.isRecoverableSessionCryptoError(err?.message)) {
        this.markSessionUnhealthy(err);
      } else {
        // For other errors, log and exit
        logger.error({ err }, 'Uncaught exception');
        process.exit(1);
      }
    };

    const handleRejection = async (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (this.isAuthStateCorrupted(message)) {
        await this.handleCorruptedAuthState(reason);
      } else if (this.isRecoverableSessionCryptoError(message)) {
        this.markSessionUnhealthy(reason);
      } else {
        logger.error({ err: reason }, 'Unhandled promise rejection');
      }
    };

    process.on('uncaughtException', handleUncaught);
    process.on('unhandledRejection', handleRejection);
  }

  isAuthStateCorrupted(message?: string | null): boolean {
    if (!message) return false;
    const normalized = message.toLowerCase();
    const checks = [
      'authenticate data',
      'unsupported state',
      'incorrect private key length',
      'invalid account signature',
      'senderkeyrecord.deserialize',
      'sender key record',
      'not valid json'
    ];
    return checks.some((check) => normalized.includes(check.toLowerCase()));
  }

  isRecoverableSessionCryptoError(message?: string | null): boolean {
    if (!message) return false;
    const normalized = String(message || '').toLowerCase();
    return [
      'bad mac',
      'no matching sessions',
      'no session record'
    ].some((check) => normalized.includes(check));
  }

  markSessionUnhealthy(error: unknown): void {
    const message = getErrorMessage(error);
    this.status = 'error';
    this.isAuthCorrupted = true;
    this.lastError = `WhatsApp session key mismatch detected. Background sends are blocked until recovery. ${message}`.trim();
    logger.warn({ error }, 'WhatsApp session marked unhealthy after crypto/session mismatch');
    if (this.socket) {
      try {
        this.cleanupSocket();
        this.socket.end(new Error('Socket closed after session key mismatch'));
      } catch {
        // ignore cleanup errors
      }
      this.socket = null;
    }
    if (this.authStore?.updateStatus) {
      void this.authStore.updateStatus('error').catch((updateError: unknown) => {
        logger.warn({ error: updateError }, 'Failed to persist unhealthy WhatsApp session status');
      });
    }
  }

  isRateOverLimitError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    if (message.includes('rate-overlimit') || message.includes('too many requests')) {
      return true;
    }

    const record = error as {
      data?: unknown;
      statusCode?: unknown;
      output?: { statusCode?: unknown; payload?: { statusCode?: unknown } };
    };
    const statusCandidates = [
      Number(record?.data),
      Number(record?.statusCode),
      Number(record?.output?.statusCode),
      Number(record?.output?.payload?.statusCode)
    ];

    return statusCandidates.some((status) => Number.isFinite(status) && status === 429);
  }

  getGroupsFromMetadataCache(): GroupSummary[] {
    const groups: GroupSummary[] = [];
    for (const [jid, raw] of this.groupMetadataCache.entries()) {
      const metadata = raw as {
        subject?: unknown;
        name?: unknown;
        size?: unknown;
        announce?: unknown;
        restrict?: unknown;
        participants?: unknown;
      };
      const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
      const sizeCandidate = Number(metadata?.size);
      const size = Number.isFinite(sizeCandidate) ? sizeCandidate : participants.length;
      const meJid = this.meJid || (this.socket as any)?.user?.id || null;
      const meComparable = normalizePersonJidForCompare(meJid);
      const meRow = meJid
        ? participants.find((participant: any) => isSamePersonJid(participant?.id, meComparable || meJid))
        : null;
      const adminRaw = meRow?.admin ? String(meRow.admin) : null;
      groups.push({
        id: jid,
        jid,
        name: String(metadata?.subject || metadata?.name || jid),
        size,
        announce: Boolean(metadata?.announce),
        restrict: Boolean(metadata?.restrict),
        participantCount: participants.length,
        me: {
          jid: meComparable || (meJid ? String(meJid) : null),
          isAdmin: Boolean(adminRaw),
          admin: adminRaw
        }
      });
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name));
  }

  getGroupsFromChatStore(): GroupSummary[] {
    const socket = this.socket as any;
    if (!socket) return [];

    try {
      const chats = socket.store?.chats?.all?.() || socket.store?.chats || [];
      const chatArray = Array.isArray(chats) ? chats : Object.values(chats || {});
      const map = new Map<string, GroupSummary>();

      for (const chat of chatArray as Array<Record<string, unknown>>) {
        const jid = String(chat?.id || chat?.jid || '').trim();
        if (!jid || !jid.endsWith('@g.us')) continue;
        const name = String(chat?.name || chat?.subject || jid).trim() || jid;
        const sizeRaw = Number(chat?.size);
        const participants = Array.isArray(chat?.participants) ? chat.participants : [];
        const size = Number.isFinite(sizeRaw) ? sizeRaw : participants.length;
        const meJid = this.meJid || socket?.user?.id || null;
        const meComparable = normalizePersonJidForCompare(meJid);
        const meRow = meJid
          ? participants.find((participant: any) => isSamePersonJid(participant?.id, meComparable || meJid))
          : null;
        const adminRaw = meRow?.admin ? String(meRow.admin) : null;
        map.set(jid, {
          id: jid,
          jid,
          name,
          size,
          announce: Boolean(chat?.announce),
          restrict: Boolean(chat?.restrict),
          participantCount: participants.length,
          me: {
            jid: meComparable || (meJid ? String(meJid) : null),
            isAdmin: Boolean(adminRaw),
            admin: adminRaw
          }
        });
      }

      return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /**
   * Collects individual contact JIDs for status broadcasts.
   * Baileys requires a `statusJidList` option when sending to `status@broadcast`;
   * without it, the status may only be visible to a random subset of contacts or
   * silently fail for most recipients.
   */
  private resolveStatusAudience(): {
    participants: string[];
    sources: StatusAudienceSources;
    warnings: string[];
    selfJid: string | null;
  } {
    const socket = this.socket as any;
    const participants = new Set<string>();
    const sources = {
      contactsCache: 0,
      storeContacts: 0,
      storeChats: 0,
      groupMetadata: 0,
      env: 0,
      me: 0,
      lidMappings: 0
    };
    const warnings: string[] = [];

    const addCandidate = (value: unknown, source: keyof typeof sources) => {
      const normalized = normalizeStatusAudienceJid(value);
      if (!normalized) return;
      if (participants.has(normalized)) return;
      participants.add(normalized);
      sources[source] += 1;
    };

    try {
      for (const [jid] of this.contactsCache.entries()) {
        addCandidate(jid, 'contactsCache');
      }

      const storeContacts = socket?.store?.contacts;
      if (Array.isArray(storeContacts)) {
        for (const contact of storeContacts) {
          const row = contact as Record<string, unknown>;
          addCandidate(row.id || row.jid, 'storeContacts');
          addCandidate(row.phone, 'storeContacts');
        }
      } else if (storeContacts && typeof storeContacts === 'object') {
        for (const [jid, contact] of Object.entries(storeContacts as Record<string, unknown>)) {
          addCandidate(jid, 'storeContacts');
          const row = (contact || {}) as Record<string, unknown>;
          addCandidate(row.id || row.jid, 'storeContacts');
          addCandidate(row.phone, 'storeContacts');
        }
      }

      const chatsRaw = socket?.store?.chats?.all?.() || socket?.store?.chats || [];
      const chats = Array.isArray(chatsRaw) ? chatsRaw : Object.values(chatsRaw || {});
      for (const chat of chats as Array<Record<string, unknown>>) {
        addCandidate(chat?.id || chat?.jid, 'storeChats');
      }

      if (INCLUDE_GROUP_METADATA_IN_STATUS_AUDIENCE) {
        for (const raw of this.groupMetadataCache.values()) {
          const participantsRaw = Array.isArray((raw as { participants?: unknown[] })?.participants)
            ? (raw as { participants?: unknown[] }).participants || []
            : [];
          for (const participant of participantsRaw as Array<Record<string, unknown>>) {
            addCandidate(participant?.id, 'groupMetadata');
            addCandidate(participant?.jid, 'groupMetadata');
            addCandidate(participant?.pn, 'groupMetadata');
            addCandidate(participant?.phone, 'groupMetadata');
            addCandidate(participant?.phoneNumber, 'groupMetadata');
            addCandidate(participant?.phone_number, 'groupMetadata');
          }
        }
      } else if (this.groupMetadataCache.size > 0) {
        warnings.push('Group participants are not used as Status recipients unless WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS=true.');
      }

      const envAudience = String(
        process.env.WHATSAPP_STATUS_AUDIENCE_JIDS || process.env.WHATSAPP_STATUS_JID_LIST || ''
      )
        .split(',')
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      for (const candidate of envAudience) {
        addCandidate(candidate, 'env');
      }

      const selfJid = normalizeStatusAudienceJid(this.meJid || socket?.user?.id);
      if (selfJid) {
        sources.me += 1;
      }
    } catch (error) {
      warnings.push(`status-audience-resolution-error:${getErrorMessage(error)}`);
    }

    const resolved = Array.from(participants.values()).sort();
    if (!resolved.length) {
      warnings.push('No status recipients resolved from contacts/cache/store');
    }

    const selfJid = normalizeStatusAudienceJid(this.meJid || socket?.user?.id) || null;
    return { participants: resolved.filter((participant) => participant !== selfJid), sources, warnings, selfJid };
  }

  private async resolveStatusAudienceWithLidMappings(): Promise<{
    participants: string[];
    sources: StatusAudienceSources;
    warnings: string[];
    selfJid: string | null;
  }> {
    const audience = this.resolveStatusAudience();
    const participants = new Set(audience.participants);
    const lidRecipients = audience.participants.filter((participant) => participant.endsWith('@lid'));
    const lidMapping = (this.socket as any)?.signalRepository?.lidMapping;
    const getPNForLID = typeof lidMapping?.getPNForLID === 'function'
      ? lidMapping.getPNForLID.bind(lidMapping)
      : null;

    if (lidRecipients.length && !getPNForLID) {
      audience.warnings.push('Status audience has LID recipients but no Baileys phone-number mapping store is available.');
      return { ...audience, participants: Array.from(participants.values()).sort() };
    }

    if (!getPNForLID || !STATUS_LID_MAPPING_LIMIT) {
      return { ...audience, participants: Array.from(participants.values()).sort() };
    }

    let attempted = 0;
    let resolved = 0;
    for (const lid of lidRecipients.slice(0, STATUS_LID_MAPPING_LIMIT)) {
      attempted += 1;
      try {
        const pn = normalizeStatusAudienceJid(await getPNForLID(lid));
        if (!pn || !pn.endsWith('@s.whatsapp.net')) continue;
        participants.delete(lid);
        participants.add(pn);
        resolved += 1;
      } catch (error) {
        audience.warnings.push(`status-lid-mapping-error:${getErrorMessage(error)}`);
        break;
      }
    }

    if (resolved > 0) {
      audience.sources.lidMappings += resolved;
    }
    if (attempted < lidRecipients.length) {
      audience.warnings.push(`Status LID mapping capped at ${STATUS_LID_MAPPING_LIMIT} of ${lidRecipients.length} recipients.`);
    }
    if (lidRecipients.length && resolved < lidRecipients.length) {
      audience.warnings.push(`Status audience has ${lidRecipients.length - resolved} LID recipients without phone-number mappings.`);
    }

    const selfJid = audience.selfJid;
    return {
      ...audience,
      participants: Array.from(participants.values())
        .filter((participant) => !selfJid || participant !== selfJid)
        .sort()
    };
  }

  async getStatusParticipants(): Promise<string[]> {
    const audience = await this.resolveStatusAudienceWithLidMappings();
    logger.debug(
      {
        participantCount: audience.participants.length,
        sources: audience.sources,
        warnings: audience.warnings
      },
      'Status participants resolved'
    );
    return audience.participants;
  }

  async getStatusAudience(options?: { sampleSize?: number }) {
    const audience = await this.resolveStatusAudienceWithLidMappings();
    const sampleSize = Math.max(1, Math.min(Number(options?.sampleSize || 25), 200));
    return {
      participantCount: audience.participants.length,
      sample: audience.participants.slice(0, sampleSize),
      selfJid: audience.selfJid,
      sources: audience.sources,
      warnings: audience.warnings
    };
  }

  async handleCorruptedAuthState(err: unknown): Promise<void> {
    if (this.isHandlingAuthCorruption) return;
    this.isHandlingAuthCorruption = true;
    try {
      const message = err instanceof Error ? err.message : String(err);
      const normalized = message.toLowerCase();

      const looksLikeSenderKeyCorruption =
        normalized.includes('senderkeyrecord.deserialize') ||
        normalized.includes('sender key record') ||
        normalized.includes('not valid json');

      const looksLikeBadKeyMaterial = normalized.includes('incorrect private key length');
      const looksLikePairingSignatureFailure = normalized.includes('invalid account signature');

      if (looksLikeSenderKeyCorruption && this.authStore?.clearKeys) {
        const now = Date.now();
        if (this.lastSenderKeyResetAt && now - this.lastSenderKeyResetAt < 15_000) {
          logger.warn({ err }, 'Sender-key reset already attempted recently - escalating to full reset');
        } else {
          this.lastSenderKeyResetAt = now;
          logger.warn({ err }, 'Sender-key error detected - clearing sender-key cache');
          this.status = 'error';
          this.lastError = 'Sender-key cache cleared. Reconnecting...';
          await this.authStore.clearKeys(['sender-key']);
          if (this.authStore?.updateStatus) {
            await this.authStore.updateStatus('error');
          }
          if (this.socket) {
            try {
              this.cleanupSocket();
              this.socket.end(new Error('Socket closed'));
            } catch {
              // ignore
            }
            this.socket = null;
          }
          this.scheduleReconnect(2000);
          return;
        }
      }

      // Attempt key-cache reset before forcing a full re-login.
      if (looksLikeBadKeyMaterial && this.authStore?.clearKeys) {
        const now = Date.now();
        if (!this.lastKeyCacheResetAt || now - this.lastKeyCacheResetAt >= 60_000) {
          this.lastKeyCacheResetAt = now;
          logger.warn({ err }, 'Bad key material detected - clearing key cache and reconnecting');
          this.status = 'error';
          this.lastError = 'Key cache cleared. Reconnecting...';
          await this.authStore.clearKeys();
          if (this.authStore?.updateStatus) {
            await this.authStore.updateStatus('error');
          }
          if (this.socket) {
            try {
              this.cleanupSocket();
              this.socket.end(new Error('Socket closed'));
            } catch {
              // ignore
            }
            this.socket = null;
          }
          this.scheduleReconnect(2000);
          return;
        }
      }

      const hasActiveQr = Boolean(this.qrCode && (!this.qrExpiresAtMs || this.qrExpiresAtMs > Date.now()));
      const socketUserId = (() => {
        try {
          return (this.socket as any)?.user?.id ? String((this.socket as any).user.id) : null;
        } catch {
          return null;
        }
      })();
      const hasAuthenticatedIdentity = Boolean(this.hasConnectedOnce || this.lastSeenAt || this.meJid || socketUserId);

      if (looksLikePairingSignatureFailure && hasActiveQr && !hasAuthenticatedIdentity && this.authStore?.clearState) {
        logger.warn({ err }, 'QR pairing was rejected before login completed; generating a fresh QR');
        this.isConnecting = false;
        this.isAuthCorrupted = false;
        this.status = 'disconnected';
        this.lastError = 'QR was rejected by WhatsApp before login completed. A fresh QR is being generated.';
        this.resetQrLifecycle();
        if (this.socket) {
          try {
            this.cleanupSocket();
            this.socket.end(new Error('Socket closed after rejected QR pairing'));
          } catch {
            // ignore cleanup errors
          }
          this.socket = null;
        }
        await this.authStore.clearState();
        if (this.authStore?.updateStatus) {
          await this.authStore.updateStatus('disconnected', null);
        }
        this.scheduleReconnect(1000);
        return;
      }

      if (!AUTO_CLEAR_CORRUPTED_AUTH) {
        logger.error({ err }, 'Crypto/auth error detected - marking session unhealthy without clearing auth state');
        this.markSessionUnhealthy(err);
        return;
      }

      logger.error({ err }, 'Crypto/auth error detected - clearing auth state');
      this.status = 'error';
      this.lastError = 'Session corrupted. Please scan QR code again.';
      this.isAuthCorrupted = true;
      if (this.authStore?.clearState) {
        await this.authStore.clearState();
      }
      if (this.authStore?.updateStatus) {
        await this.authStore.updateStatus('error');
      }
      if (this.socket) {
        try {
          this.cleanupSocket();
          this.socket.end(new Error('Socket closed'));
        } catch (e) {
          // Ignore cleanup errors
        }
        this.socket = null;
      }
      this.scheduleReconnect(5000);
    } finally {
      this.isHandlingAuthCorruption = false;
    }
  }

  extractErrorMessage(args: unknown[]): string | null {
    for (const arg of args) {
      if (!arg) continue;
      if (arg instanceof Error) return arg.message;
      if (typeof arg === 'object' && arg !== null) {
        const record = arg as { err?: { message?: string }; error?: { message?: string }; trace?: string };
        if (record.err?.message) return record.err.message;
        if (record.error?.message) return record.error.message;
        if (record.trace && typeof record.trace === 'string') return record.trace;
      }
    }
    return null;
  }

  extractLogMessage(args: unknown[]): string | null {
    const last = args[args.length - 1];
    return typeof last === 'string' ? last : null;
  }

  extractAckFailure(args: unknown[]): { messageId: string; remoteJid: string | null; errorCode: string | null } | null {
    const logMessage = this.extractLogMessage(args);
    const stack = args.filter((arg) => arg && typeof arg === 'object') as Record<string, unknown>[];
    const seen = new Set<unknown>();

    while (stack.length) {
      const current = stack.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);

      const attrs = current.attrs && typeof current.attrs === 'object'
        ? current.attrs as Record<string, unknown>
        : null;
      const id = attrs?.id != null ? String(attrs.id).trim() : '';
      const error = attrs?.error != null ? String(attrs.error).trim() : '';
      const packetClass = attrs?.class != null ? String(attrs.class).trim() : '';
      const looksLikeAckFailure =
        Boolean(error && id) &&
        (
          /received error in ack/i.test(String(logMessage || '')) ||
          /message/i.test(packetClass)
        );

      if (looksLikeAckFailure) {
        return {
          messageId: id,
          remoteJid: attrs?.from != null ? String(attrs.from) : null,
          errorCode: error || null
        };
      }

      for (const value of Object.values(current)) {
        if (value && typeof value === 'object' && !seen.has(value)) {
          stack.push(value as Record<string, unknown>);
        }
      }
    }

    return null;
  }

  createBaileysLogger() {
    const baseLogger = logger.child({ class: 'baileys' });
    const baileysLogger = Object.create(baseLogger);
    const isBenignMediaTrace = (value: string | null) =>
      Boolean(value && /Input file contains unsupported image format/i.test(value));
    const isThrottleTrace = (value: string | null) =>
      Boolean(value && /rate-overlimit|too many requests/i.test(value));
    const isBenignInitQueryTrace = (message: string | null, errorMessage: string | null) =>
      Boolean(
        message &&
        /unexpected error in ['"]?init queries['"]?/i.test(message) &&
        (!errorMessage || /bad-request/i.test(errorMessage))
      );
    const handleArgs = (args: unknown[]) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      const ackFailure = this.extractAckFailure(args);
      if (ackFailure) {
        this.rememberMessageFailure(ackFailure.messageId, {
          errorCode: ackFailure.errorCode,
          errorMessage: ackFailure.errorCode
            ? `WhatsApp server rejected message ack ${ackFailure.errorCode}`
            : 'WhatsApp server rejected message ack',
          remoteJid: ackFailure.remoteJid,
          updatedAtMs: Date.now()
        });
      }
      if (this.isAuthStateCorrupted(message) || this.isAuthStateCorrupted(errorMessage)) {
        void this.handleCorruptedAuthState(
          errorMessage ? new Error(errorMessage) : new Error(message || 'Auth error')
        );
      } else if (this.isRecoverableSessionCryptoError(message) || this.isRecoverableSessionCryptoError(errorMessage)) {
        this.markSessionUnhealthy(errorMessage ? new Error(errorMessage) : new Error(message || 'Session crypto error'));
      }
    };
    baileysLogger.error = (...args: unknown[]) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      if (isBenignInitQueryTrace(message, errorMessage)) {
        baseLogger.debug({ reason: 'init_query_bad_request' }, 'Baileys init query rejected during reconnect');
        return;
      }
      if (isBenignMediaTrace(errorMessage) || isBenignMediaTrace(message)) {
        baseLogger.info(
          { reason: 'unsupported_image_format' },
          'Baileys skipped thumbnail generation for one media payload'
        );
        return;
      }
      if (isThrottleTrace(errorMessage) || isThrottleTrace(message)) {
        baseLogger.debug({ reason: 'throttled' }, 'Baileys request throttled');
        return;
      }
      baseLogger.error(...args);
      handleArgs(args);
    };
    baileysLogger.warn = (...args: unknown[]) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      if (isBenignInitQueryTrace(message, errorMessage)) {
        baseLogger.debug({ reason: 'init_query_bad_request' }, 'Baileys init query rejected during reconnect');
        return;
      }
      if (isBenignMediaTrace(errorMessage) || isBenignMediaTrace(message)) {
        baseLogger.info(
          { reason: 'unsupported_image_format' },
          'Baileys skipped thumbnail generation for one media payload'
        );
        return;
      }
      if (isThrottleTrace(errorMessage) || isThrottleTrace(message)) {
        baseLogger.debug({ reason: 'throttled' }, 'Baileys request throttled');
        return;
      }
      baseLogger.warn(...args);
      handleArgs(args);
    };
    baileysLogger.info = (...args: unknown[]) => {
      baseLogger.info(...args);
      handleArgs(args);
    };
    return baileysLogger;
  }

  startLeaseRenewal(ttlMs = 90_000): void {
    const authStore = this.authStore;
    if (!authStore?.renewLease) return;
    if (!this.leaseSupported || !this.leaseHeld) return;
    if (this.leaseRenewTimer) return;

    // Renew frequently to reduce takeover delay during rolling deploys.
    const intervalMs = Math.max(10_000, Math.floor(Number(ttlMs) / 3));

    const tick = async () => {
      const store = this.authStore;
      if (!store?.renewLease) return;
      try {
        const lease = await store.renewLease(this.instanceId, ttlMs);
        if (!lease.supported) {
          this.leaseSupported = false;
          this.leaseHeld = false;
          this.leaseOwnerId = null;
          this.leaseExpiresAt = null;
          this.stopLeaseRenewal();
          return;
        }

        this.leaseSupported = true;
        this.leaseHeld = Boolean(lease.ok);
        this.leaseOwnerId = lease.ownerId;
        this.leaseExpiresAt = lease.expiresAt;

        if (!lease.ok) {
          if (isTransientLeaseFailureReason(lease.reason)) {
            logger.warn('WhatsApp lease renewal check is temporarily unavailable; keeping current socket alive');
            return;
          }
          logger.warn({ leaseOwner: lease.ownerId, leaseExpiresAt: lease.expiresAt }, 'Lost WhatsApp lease');
          this.stopLeaseRenewal();
          if (this.isPaused) {
            // While paused we only want to stop being the active instance; keep the UI in "paused"
            // instead of flipping to a confusing conflict state.
            if (this.socket) {
              try {
                this.cleanupSocket();
                this.socket.end(new Error('Lease lost'));
              } catch {
                // ignore
              }
              this.socket = null;
            }
            return;
          }
          this.status = 'conflict';
          this.lastError =
            'Another bot instance took over this WhatsApp session. This instance will stay idle.';
          if (this.authStore?.updateStatus) {
            await this.authStore.updateStatus('conflict');
          }
          if (this.socket) {
            try {
              this.cleanupSocket();
              this.socket.end(new Error('Lease lost'));
            } catch {
              // ignore
            }
            this.socket = null;
          }
          // Periodically retry acquisition in case the other instance stops.
          this.scheduleReconnect(15000);
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to renew WhatsApp lease');
      }
    };

    void tick();
    this.leaseRenewTimer = setInterval(() => {
      void tick();
    }, intervalMs);
  }

  stopLeaseRenewal(): void {
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
  }

  async takeoverLease(ttlMs = 90_000): Promise<{
    ok: boolean;
    supported: boolean;
    ownerId: string | null;
    expiresAt: string | null;
    reason?: string;
  }> {
    if (this.isPaused) {
      return { ok: false, supported: Boolean(this.authStore?.forceAcquireLease), ownerId: null, expiresAt: null, reason: 'paused' };
    }
    const store = this.authStore;
    if (!store?.forceAcquireLease) {
      return { ok: false, supported: false, ownerId: null, expiresAt: null, reason: 'unsupported' };
    }

    const lease = await store.forceAcquireLease(this.instanceId, ttlMs);
    this.leaseSupported = lease.supported;
    this.leaseHeld = Boolean(lease.ok);
    this.leaseOwnerId = lease.ownerId;
    this.leaseExpiresAt = lease.expiresAt;

    if (!lease.supported) {
      return lease;
    }

    if (!lease.ok) {
      if (isTransientLeaseFailureReason(lease.reason)) {
        this.status = 'connecting';
        this.lastError = 'Lease check temporarily unavailable. Retry the takeover once connectivity stabilizes.';
        return lease;
      }
      this.status = 'conflict';
      const holder = lease.ownerId || 'unknown';
      const until = lease.expiresAt || 'unknown';
      this.lastError = `Failed to take over lease (held by ${holder} until ${until}).`;
      if (store.updateStatus) {
        await store.updateStatus('conflict');
      }
      return lease;
    }

    // Close current socket and reconnect as lease holder.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopLeaseRenewal();
    this.startLeaseRenewal(ttlMs);

    if (this.socket) {
      try {
        this.cleanupSocket();
        this.socket.end(new Error('Lease takeover'));
      } catch {
        // ignore
      }
      this.socket = null;
    }

    this.isConnecting = false;
    await this.connect();
    return lease;
  }

  scheduleReconnect(delay: number): void {
    if (this.isPaused) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  async reconnect(): Promise<void> {
    if (this.isPaused) {
      this.status = 'paused';
      this.lastError = this.lastError || 'WhatsApp session paused.';
      return;
    }

    const currentStatus = String(this.status || 'unknown');
    if (currentStatus === 'connected' || currentStatus === 'connecting') {
      return;
    }

    // If a reconnect is already scheduled, let that timer fire.
    if (this.reconnectTimer) {
      return;
    }

    await this.connect();
  }

  cleanupSocket(): void {
    if (!this.socket) return;
    const ev = this.socket.ev as unknown as { removeAllListeners: (event: string) => void };
    ev.removeAllListeners('connection.update');
    ev.removeAllListeners('creds.update');
    ev.removeAllListeners('messages.upsert');
    ev.removeAllListeners('messages.update');
    ev.removeAllListeners('message-receipt.update');
    ev.removeAllListeners('chats.set');
    ev.removeAllListeners('chats.upsert');
    ev.removeAllListeners('chats.update');
    ev.removeAllListeners('chats.delete');
  }

  async connect(): Promise<void> {
    if (this.isPaused) {
      this.isConnecting = false;
      this.status = 'paused';
      this.lastError = 'WhatsApp session paused.';
      return;
    }

    // Prevent concurrent connection attempts
    if (this.isConnecting) {
      logger.warn('Connection already in progress, skipping');
      return;
    }
    this.isConnecting = true;

    try {
      // Clean up existing socket
      if (this.socket) {
        try {
          this.cleanupSocket();
          this.socket.end(new Error('Socket closed'));
        } catch (e) {
          // Ignore cleanup errors
        }
        this.socket = null;
      }

      const authStore = this.authStore;
      if (!authStore) {
        throw new Error('Auth store not initialized');
      }

      // Acquire a cross-instance lease so only one bot connects at a time.
      // This prevents WhatsApp "conflict/replaced" errors during rolling deploys.
      // Auto-takeover is intentionally opt-in: forcing takeovers during deploy overlaps can
      // cause WhatsApp "conflict/replaced" churn. Use POST /api/whatsapp/takeover when needed.
      const allowAutoTakeover = String(process.env.WHATSAPP_LEASE_AUTO_TAKEOVER || '').toLowerCase() === 'true';
      if (authStore.acquireLease) {
        try {
          const lease = await authStore.acquireLease(this.instanceId, 90_000);
          this.leaseSupported = lease.supported;
          this.leaseHeld = lease.ok;
          this.leaseOwnerId = lease.ownerId;
          this.leaseExpiresAt = lease.expiresAt;

          if (lease.supported && !lease.ok) {
            if (isTransientLeaseFailureReason(lease.reason)) {
              logger.warn('WhatsApp lease check is temporarily unavailable; retrying without declaring a conflict');
              this.status = 'connecting';
              this.lastError = 'Lease check temporarily unavailable. Retrying...';
              await authStore.updateStatus('connecting');
              this.isConnecting = false;
              this.scheduleReconnect(5000 + Math.random() * 2000);
              return;
            }
            const nowMs = Date.now();
            const expiryMs = lease.expiresAt ? Date.parse(lease.expiresAt) : Number.NaN;
            const leaseStillValid = Number.isFinite(expiryMs) && expiryMs > nowMs;
            const retryJitterMs = Math.random() * 5000;
            const retryDelayMs = Number.isFinite(expiryMs)
              ? Math.min(Math.max(expiryMs - nowMs, 10_000), 60_000) + retryJitterMs
              : 15_000 + retryJitterMs;
            const nearExpiry = Number.isFinite(expiryMs) ? expiryMs - nowMs <= 10_000 : true;

            if (!allowAutoTakeover || (leaseStillValid && !nearExpiry)) {
              logger.warn(
                { holder: lease.ownerId, expiresAt: lease.expiresAt, retryDelayMs },
                'Lease held by another instance; skipping connect until lease is available'
              );
              this.status = 'conflict';
              this.lastError = 'Another instance currently holds the WhatsApp lease.';
              await authStore.updateStatus('conflict');
              this.isConnecting = false;
              this.scheduleReconnect(retryDelayMs);
              return;
            }

            logger.warn({ holder: lease.ownerId, expiresAt: lease.expiresAt }, 'Lease held, attempting auto-takeover...');
            this.status = 'connecting';
            this.lastError = null; // Don't show confusing messages to users

            try {
              if (authStore.forceAcquireLease) {
                const takeover = await authStore.forceAcquireLease(this.instanceId, 90_000);
                if (takeover.ok) {
                  logger.info('Auto-takeover successful');
                  this.leaseHeld = true;
                  this.leaseOwnerId = takeover.ownerId;
                  this.leaseExpiresAt = takeover.expiresAt;
                  this.startLeaseRenewal(90_000);
                  // Continue with connection below.
                } else if (isTransientLeaseFailureReason(takeover.reason)) {
                  logger.warn('WhatsApp lease takeover check is temporarily unavailable; retrying shortly');
                  this.status = 'connecting';
                  this.lastError = 'Lease takeover temporarily unavailable. Retrying...';
                  await authStore.updateStatus('connecting');
                  this.isConnecting = false;
                  this.scheduleReconnect(5000 + Math.random() * 2000);
                  return;
                } else {
                  logger.warn({ holder: takeover.ownerId }, 'Lease held by another instance; skipping connect');
                  this.status = 'conflict';
                  this.lastError = 'Another instance currently holds the WhatsApp lease.';
                  await authStore.updateStatus('conflict');
                  this.isConnecting = false;
                  this.scheduleReconnect(retryDelayMs);
                  return;
                }
              } else {
                logger.warn('Auto-takeover requested but forceAcquireLease is not available; skipping connect');
                this.status = 'conflict';
                this.lastError = 'Another instance currently holds the WhatsApp lease.';
                await authStore.updateStatus('conflict');
                this.isConnecting = false;
                this.scheduleReconnect(retryDelayMs);
                return;
              }
            } catch (error) {
              logger.warn({ error }, 'Auto-takeover failed; skipping connect until lease is available');
              this.status = 'conflict';
              this.lastError = 'Failed to acquire WhatsApp lease.';
              await authStore.updateStatus('conflict');
              this.isConnecting = false;
              this.scheduleReconnect(retryDelayMs);
              return;
            }
          }

          if (lease.supported && lease.ok) {
            this.startLeaseRenewal(90_000);
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to acquire WhatsApp lease; refusing to connect without lock');
          this.status = 'conflict';
          this.lastError = 'Unable to acquire WhatsApp lease; retrying.';
          await authStore.updateStatus('conflict');
          this.isConnecting = false;
          this.scheduleReconnect(15000 + Math.random() * 5000);
          return;
        }
      } else {
        // No lease helper available - proceed without coordinated ownership.
        this.leaseSupported = false;
        this.leaseHeld = true;
      }

      if (this.isPaused) {
        this.isConnecting = false;
        this.status = 'paused';
        this.lastError = 'WhatsApp session paused.';
        // Pause only affects the WhatsApp socket; keep the lease so schedulers can continue on a single instance.
        return;
      }

      const {
        makeWASocket,
        DisconnectReason,
        fetchLatestWaWebVersion,
        fetchLatestBaileysVersion,
        Browsers
      } = await loadBaileys();

      const { state, saveCreds } = authStore;

      const now = Date.now();
      const versionTtlMs = 6 * 60 * 60 * 1000;
      const resolveLatestWaVersion =
        String(process.env.WHATSAPP_RESOLVE_LATEST_VERSION || '').trim().toLowerCase() === 'true';
      const shouldRefreshVersion =
        resolveLatestWaVersion &&
        (!this.waVersion || !this.waVersionFetchedAtMs || now - this.waVersionFetchedAtMs > versionTtlMs);

      if (shouldRefreshVersion) {
        const isValidVersion = (candidate: unknown) =>
          Array.isArray(candidate) &&
          candidate.length === 3 &&
          candidate.every((n: unknown) => typeof n === 'number' && Number.isFinite(n));

        try {
          if (typeof fetchLatestWaWebVersion === 'function') {
            const latestWeb = await fetchLatestWaWebVersion({ timeout: 10000 });
            if (isValidVersion(latestWeb?.version)) {
              this.waVersion = latestWeb.version;
              this.waVersionFetchedAtMs = now;
              logger.info({ version: latestWeb.version }, 'WhatsApp web version resolved from web client');
            }
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to fetch WhatsApp web version from web client');
        }

        if (!this.waVersion && typeof fetchLatestBaileysVersion === 'function') {
          try {
            const latest = await fetchLatestBaileysVersion({ timeout: 10000 });
            if (isValidVersion(latest?.version)) {
              this.waVersion = latest.version;
              this.waVersionFetchedAtMs = now;
              logger.info({ version: latest.version, isLatest: Boolean(latest?.isLatest) }, 'WhatsApp web version resolved from Baileys');
            }
          } catch (error) {
            logger.warn({ error }, 'Failed to fetch latest Baileys version; using bundled version');
          }
        }
      }

      const browserName = String(
        process.env.WHATSAPP_BROWSER_NAME ||
        process.env.WHATSAPP_BROWSER_LABEL ||
        process.env.WHATSAPP_BROWSER_BRAND ||
        process.env.WHATSAPP_DEVICE_NAME ||
        process.env.WHATSAPP_DEVICE_LABEL ||
        'Anash Bot'
      )
        .trim()
        .slice(0, 64) || 'Anash Bot';
      const browser = resolveBrowserTuple(Browsers as Record<string, unknown> | null | undefined, browserName);

      const syncFullHistory =
        String(process.env.WHATSAPP_SYNC_FULL_HISTORY || '').trim().toLowerCase() === 'true';

      this.resetQrLifecycle();

      const socketConfig: Record<string, unknown> = {
        auth: state,
        printQRInTerminal: false,
        syncFullHistory,
        markOnlineOnConnect: false,
        emitOwnEvents: true,
        browser,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 500,
        logger: this.createBaileysLogger(),
        cachedGroupMetadata: async (jid: string) => this.groupMetadataCache.get(jid),
        patchMessageBeforeSending: async (message: Record<string, any>) =>
          newsletterMediaPatchContext.getStore()
            ? patchNewsletterMediaDirectPaths(message)
            : message,
        getMessage: async (key: { id?: string | null }) => {
          const messageId = String(key?.id || '').trim();
          if (!messageId) return undefined;
          const cached = this.recentSentMessages.get(messageId);
          return cached?.message || undefined;
        }
      };

      if (this.waVersion) {
        socketConfig.version = this.waVersion;
      }

      if (this.isPaused) {
        this.isConnecting = false;
        this.status = 'paused';
        this.lastError = 'WhatsApp session paused.';
        // Pause only affects the WhatsApp socket; keep the lease so schedulers can continue on a single instance.
        return;
      }

      this.socket = makeWASocket(socketConfig);

      this.setupErrorHandlers();

      const socket = this.socket;
      if (!socket) {
        throw new Error('Failed to initialize socket');
      }

      if (this.isPaused) {
        try {
          this.cleanupSocket();
          socket.end(new Error('Paused'));
        } catch {
          // ignore
        }
        this.socket = null;
        this.isConnecting = false;
        this.status = 'paused';
        this.lastError = 'WhatsApp session paused.';
        this.clearPresenceOfflineHeartbeat();
        // Pause only affects the WhatsApp socket; keep the lease so schedulers can continue on a single instance.
        return;
      }

      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrTtlMs = this.resolveIncomingQrTtlMs();
            this.qrCode = await qrcode.toDataURL(qr);
            this.qrGeneratedAtMs = Date.now();
            this.qrExpiresAtMs = this.qrGeneratedAtMs + qrTtlMs;
            this.qrGenerationCount += 1;
            this.status = 'qr';
            this.lastError = null;
            this.reconnectAttempts = 0;
            logger.info({ qrTtlMs, qrGenerationCount: this.qrGenerationCount }, 'QR code generated');
            await authStore.updateStatus('qr_ready', this.qrCode);
          } catch (e) {
            logger.error({ e }, 'Error generating QR code');
          }
        }

        if (connection === 'connecting') {
          this.status = 'connecting';
          logger.info('WhatsApp connecting...');
          await authStore.updateStatus('connecting', null);
        }

        if (connection === 'open') {
          this.isConnecting = false;
          this.status = 'connected';
          this.resetQrLifecycle();
          this.lastError = null;
          this.lastSeenAt = new Date();
          this.reconnectAttempts = 0;
          this.conflictAttempts = 0; // Reset conflict counter on successful connection
          this.isAuthCorrupted = false;
          this.hasConnectedOnce = true;
          this.lastSenderKeyResetAt = null;
          this.lastKeyCacheResetAt = null;
          try {
            const socketUser = (socket as any)?.user;
            this.meJid = socketUser?.id ? String(socketUser.id) : null;
            this.meName = socketUser?.name ? String(socketUser.name) : null;
          } catch {
            this.meJid = null;
            this.meName = null;
          }
          logger.info('WhatsApp connected successfully');
          await authStore.updateStatus('connected', null);
          try {
            await initSchedulers(this);
          } catch (error) {
            logger.error({ error }, 'Failed to initialize schedulers after reconnect');
          }
          void refreshStatusRecipients(this, { sampleSize: 25 }).catch((error: unknown) => {
            logger.warn({ error: getErrorMessage(error) }, 'Failed to refresh persisted status recipients after connect');
          });
          void runTargetAutoSyncPass(this, { silent: true });
          this.startPresenceOfflineHeartbeat();
        }

        if (connection === 'close') {
          this.isConnecting = false;
          this.resetQrLifecycle();
          if (this.isPaused) {
            this.status = 'paused';
            this.lastError = 'WhatsApp session paused.';
            this.clearPresenceOfflineHeartbeat();
            this.meJid = null;
            this.meName = null;
            await authStore.updateStatus('paused', null);
            return;
          }
          const disconnectError = lastDisconnect?.error as { output?: { statusCode?: number; payload?: { message?: string } }; message?: string } | undefined;
          const statusCode = disconnectError?.output?.statusCode;
          const rawReason = disconnectError?.output?.payload?.message || disconnectError?.message;
          const reason = redactSensitiveText(rawReason);
          this.status = 'disconnected';
          this.clearPresenceOfflineHeartbeat();
          this.meJid = null;
          this.meName = null;
          if (String(rawReason || '').includes('QR refs attempts ended')) {
            this.lastError = 'QR expired. Click Hard Refresh to generate a new QR code.';
          } else {
            this.lastError = reason || 'Connection closed';
          }

          logger.warn({ statusCode, reason }, 'WhatsApp connection closed');

          // Handle specific disconnect reasons
          if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
            logger.info('Logged out, clearing credentials');
            await authStore.clearState();
            this.reconnectAttempts = 0;
            // Schedule reconnect to get new QR
            this.scheduleReconnect(2000);
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || String(rawReason || '').includes('restart required')) {
            logger.info('Restart required, reconnecting');
            this.lastError = null;
            this.status = 'connecting';
            await authStore.updateStatus('connecting', null);
            this.scheduleReconnect(2000);
            return;
          }

          // Connection conflict - another device logged in
          if (statusCode === 440 || String(rawReason || '').includes('conflict')) {
            this.conflictAttempts = (this.conflictAttempts || 0) + 1;

            if (this.conflictAttempts > 3) {
              // After 3 conflict attempts, stay disconnected to prevent fighting
              logger.error('Too many connection conflicts, staying disconnected. Another instance is likely active.');
              this.status = 'disconnected';
              this.lastError = 'Another WhatsApp instance is active. If this persists, click Hard Refresh.';
              return;
            }

            logger.warn({ attempt: this.conflictAttempts }, 'Connection conflict detected - another session is active, will retry with backoff');
            this.status = 'connecting';
            this.lastError = null; // Don't show confusing message
            // Exponential backoff: 15s, 30s, 60s + random jitter to prevent simultaneous reconnection
            const baseDelay = Math.min(15000 * Math.pow(2, this.conflictAttempts - 1), 60000);
            const jitter = Math.random() * 5000; // 0-5s random delay
            const delay = baseDelay + jitter;
            logger.info({ delay: Math.round(delay / 1000) }, 'Scheduling reconnect with jitter');
            this.scheduleReconnect(delay);
            return;
          }

          await authStore.updateStatus('disconnected', null);

          // Auto-reconnect with exponential backoff for other errors
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 60000);
            logger.info({ attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
            this.scheduleReconnect(delay);
          } else {
            logger.error('Max reconnect attempts reached');
            this.lastError = 'Max reconnect attempts reached. Click Hard Refresh to retry.';
          }
        }
      });

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
          const row = contact as unknown as Record<string, unknown>;
          const jid = normalizeStatusAudienceJid(row.id || row.jid || row.phone);
          if (jid) {
            const contactName = contact.name || contact.notify || '';
            this.contactsCache.set(jid, contactName ? { name: contactName } : {});
          }
        }
        const trimmed = trimMapToMaxSize(this.contactsCache, CONTACTS_CACHE_MAX_SIZE);
        logger.debug(
          { count: contacts.length, cacheSize: this.contactsCache.size, trimmed },
          'Contacts upserted into cache'
        );
      });

      socket.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
          const row = update as Record<string, unknown>;
          const jid = normalizeStatusAudienceJid(row.id || row.jid || row.phone);
          if (jid) {
            const existing = this.contactsCache.get(jid) || {};
            const updatedName = update.name || update.notify || existing.name || '';
            this.contactsCache.set(jid, updatedName ? { ...existing, name: updatedName } : existing);
          }
        }
        const trimmed = trimMapToMaxSize(this.contactsCache, CONTACTS_CACHE_MAX_SIZE);
        logger.debug(
          { count: updates.length, cacheSize: this.contactsCache.size, trimmed },
          'Contacts updated in cache'
        );
      });

      socket.ev.on('messages.upsert', async ({ type, messages }) => {
        const list = Array.isArray(messages) ? messages : [];

        for (const message of list as any[]) {
          const id = message?.key?.id;
          if (id && message?.key?.fromMe) {
            this.recentSentMessages.set(String(id), message);
            if (this.recentSentMessages.size > 500) {
              const oldest = this.recentSentMessages.keys().next().value;
              if (oldest) {
                this.recentSentMessages.delete(oldest);
              }
            }
          }

          this.cacheNewsletterFromMessageLike(message);
        }

        const toSave =
          type === 'notify' ? list : list.filter((message: any) => Boolean(message?.key?.fromMe));
        if (!toSave.length) return;
        try {
          await saveIncomingMessages(toSave);
        } catch (e) {
          logger.error({ e }, 'Error saving incoming messages');
        }
      });

      socket.ev.on('messages.update', (updates) => {
        try {
          const list = Array.isArray(updates) ? updates : [];
          for (const entry of list as any[]) {
            const id = entry?.key?.id;
            if (!id) continue;
            if (!entry?.key?.fromMe) continue;
            const status = entry?.update?.status;
            if (typeof status !== 'number') continue;

            const statusLabel = mapMessageStatusLabel(status);
            const snapshot: MessageStatusSnapshot = {
              status,
              statusLabel,
              remoteJid: entry?.key?.remoteJid ? String(entry.key.remoteJid) : null,
              updatedAtMs: Date.now()
            };

            this.rememberMessageStatus(String(id), snapshot);
          }
        } catch (e) {
          logger.warn({ e }, 'Failed to process messages.update');
        }
      });

      socket.ev.on('message-receipt.update', (updates) => {
        try {
          const list = Array.isArray(updates) ? updates : [];
          for (const entry of list as any[]) {
            const id = entry?.key?.id;
            if (!id) continue;

            const receipt = entry?.receipt || {};
            const status =
              receipt?.readTimestamp != null
                ? 4
                : receipt?.receiptTimestamp != null
                  ? 3
                  : null;
            if (status == null) continue;

            const snapshot: MessageStatusSnapshot = {
              status,
              statusLabel: mapMessageStatusLabel(status),
              remoteJid: entry?.key?.remoteJid ? String(entry.key.remoteJid) : null,
              updatedAtMs: Date.now()
            };

            this.rememberMessageStatus(String(id), snapshot);
          }
        } catch (e) {
          logger.warn({ e }, 'Failed to process message-receipt.update');
        }
      });

      (socket.ev as any).on('chats.set', (payload: unknown) => {
        const chats =
          payload && typeof payload === 'object'
            ? ((payload as { chats?: unknown[] }).chats || [])
            : [];
        this.cacheNewsletterChats(chats);
      });

      (socket.ev as any).on('chats.upsert', (chats: unknown) => {
        this.cacheNewsletterChats(chats);
      });

      (socket.ev as any).on('chats.update', (updates: unknown) => {
        this.cacheNewsletterChats(updates);
      });

      (socket.ev as any).on('chats.delete', (deletes: unknown) => {
        this.removeNewsletterChats(deletes);
      });

      (socket.ev as any).on('messaging-history.set', (payload: unknown) => {
        const safePayload = payload && typeof payload === 'object' ? (payload as { chats?: unknown[]; messages?: unknown[] }) : {};
        const chats = Array.isArray(safePayload.chats) ? safePayload.chats : [];
        const messages = Array.isArray(safePayload.messages) ? safePayload.messages : [];
        this.cacheNewsletterChats(chats);
        for (const message of messages) {
          this.cacheNewsletterFromMessageLike(message);
        }
      });
    } catch (error) {
      this.isConnecting = false;
      logger.error({ error }, 'Error connecting to WhatsApp');
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.status = 'error';

      // If it's a crypto/auth error, block sends and require explicit recovery.
      if (this.isAuthStateCorrupted(message)) {
        logger.warn('Auth state appears corrupted; entering guarded recovery state');
        await this.handleCorruptedAuthState(error);
        return;
      }

      if (this.isRecoverableSessionCryptoError(message)) {
        this.markSessionUnhealthy(error);
        return;
      }

      // Non-auth failures can happen before the socket emits connection.update (e.g. during init).
      // Schedule a bounded reconnect so the bot can self-heal without manual intervention.
      if (!this.isPaused && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const baseDelay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);
        const jitter = Math.random() * 5000;
        const delay = baseDelay + jitter;
        logger.info({ attempt: this.reconnectAttempts, delay }, 'Scheduling reconnect after WhatsApp connect failure');
        this.scheduleReconnect(delay);
      }
    }
  }

  getStatus(): {
    status: WhatsAppStatus;
    lastError: string | null;
    lastSeenAt: Date | null;
    hasQr: boolean;
    qr: {
      generatedAt: string | null;
      expiresAt: string | null;
      ttlMs: number | null;
      remainingMs: number | null;
    };
    me: { jid: string | null; name: string | null };
    instanceId: string;
    sessionId: string;
    lease: { supported: boolean; held: boolean; ownerId: string | null; expiresAt: string | null };
  } {
    const qrState = this.getQrState();
    if (this.isPaused) {
      this.status = 'paused';
      if (!this.lastError) {
        this.lastError = 'WhatsApp session paused.';
      }
      return {
        status: this.status,
        lastError: this.lastError,
        lastSeenAt: this.lastSeenAt,
        hasQr: Boolean(qrState.qr),
        qr: {
          generatedAt: qrState.generatedAt,
          expiresAt: qrState.expiresAt,
          ttlMs: qrState.ttlMs,
          remainingMs: qrState.remainingMs
        },
        me: { jid: this.meJid, name: this.meName },
        instanceId: this.instanceId,
        sessionId: this.sessionId,
        lease: {
          supported: this.leaseSupported,
          held: this.leaseHeld,
          ownerId: this.leaseOwnerId,
          expiresAt: this.leaseExpiresAt
        }
      };
    }

    if (this.status === 'conflict' && this.leaseSupported && !this.leaseHeld && this.leaseExpiresAt) {
      const expiryMs = Date.parse(this.leaseExpiresAt);
      const isExpired = Number.isFinite(expiryMs) && expiryMs < Date.now() - 5000;
      if (isExpired && !this.isConnecting && !this.reconnectTimer) {
        this.status = 'connecting';
        this.lastError = 'Lease expired. Retrying connection...';
        this.scheduleReconnect(250);
      }
    }

    return {
      status: this.status,
      lastError: this.lastError,
      lastSeenAt: this.lastSeenAt,
      hasQr: Boolean(qrState.qr),
      qr: {
        generatedAt: qrState.generatedAt,
        expiresAt: qrState.expiresAt,
        ttlMs: qrState.ttlMs,
        remainingMs: qrState.remainingMs
      },
      me: { jid: this.meJid, name: this.meName },
      instanceId: this.instanceId,
      sessionId: this.sessionId,
      lease: {
        supported: this.leaseSupported,
        held: this.leaseHeld,
        ownerId: this.leaseOwnerId,
        expiresAt: this.leaseExpiresAt
      }
    };
  }

  getMe(): { jid: string | null; name: string | null } {
    return { jid: this.meJid, name: this.meName };
  }

  async getGroupInfo(
    jid: string,
    timeoutMs = 15000
  ): Promise<
    | {
      jid: string;
      name: string;
      size: number;
      announce: boolean;
      restrict: boolean;
      ephemeralDuration: number | null;
      participantCount: number;
      me: { jid: string | null; isAdmin: boolean; admin: string | null };
    }
    | null
  > {
    const socket = this.socket as any;
    if (!socket) return null;

    try {
      const meta = await withTimeout(socket.groupMetadata(jid), timeoutMs, 'Timed out fetching group metadata');
      if (meta?.id) {
        this.groupMetadataCache.set(String(meta.id), meta);
        if (this.groupMetadataCache.size > 500) {
          const oldest = this.groupMetadataCache.keys().next().value;
          if (oldest) {
            this.groupMetadataCache.delete(oldest);
          }
        }
      }
      const participants = Array.isArray(meta?.participants) ? meta.participants : [];
      const meJid = this.meJid || socket?.user?.id || null;
      const meComparable = normalizePersonJidForCompare(meJid);
      const meRow = meJid ? participants.find((p: any) => isSamePersonJid(p?.id, meComparable || meJid)) : null;
      const adminLevel = meRow?.admin ? String(meRow.admin) : null;
      const isAdmin = Boolean(adminLevel);

      return {
        jid,
        name: String(meta?.subject || jid),
        size: Number(meta?.size || 0),
        announce: Boolean(meta?.announce),
        restrict: Boolean(meta?.restrict),
        ephemeralDuration: typeof meta?.ephemeralDuration === 'number' ? meta.ephemeralDuration : null,
        participantCount: participants.length,
        me: { jid: meComparable || (meJid ? String(meJid) : null), isAdmin, admin: adminLevel }
      };
    } catch (error) {
      logger.warn({ jid, error: getErrorMessage(error) }, 'Failed to load group metadata');
      return null;
    }
  }

  private resolveDirectChatEphemeralExpiration(jid: string): number | null {
    const socket = this.socket as any;
    if (!socket) return null;

    const normalizedTarget = normalizePersonJidForCompare(jid);
    if (!normalizedTarget) return null;

    try {
      const chatsRaw = socket.store?.chats?.all?.() || socket.store?.chats || [];
      const chats = Array.isArray(chatsRaw) ? chatsRaw : Object.values(chatsRaw || {});
      for (const chat of chats as Array<Record<string, unknown>>) {
        const chatJid = String(chat?.id || chat?.jid || '').trim();
        if (!chatJid || !isSamePersonJid(chatJid, normalizedTarget)) continue;
        return readPositiveInteger(chat?.ephemeralExpiration);
      }
    } catch {
      return null;
    }

    return null;
  }

  private async resolveSendOptions(jid: string, options: MiscMessageGenerationOptions) {
    const normalizedJid = String(jid || '').trim();
    if (!normalizedJid) return options;
    if (Object.prototype.hasOwnProperty.call(options, 'ephemeralExpiration')) {
      return options;
    }
    if (normalizedJid === 'status@broadcast') {
      return options;
    }
    if (normalizeNewsletterJid(normalizedJid, { allowNumeric: false })) {
      return options;
    }

    const isGroup = normalizedJid.endsWith('@g.us');
    const groupBaseOptions = () =>
      Object.prototype.hasOwnProperty.call(options, 'useUserDevicesCache')
        ? { ...options }
        : {
            ...options,
            useUserDevicesCache: false
          };

    if (!SEND_EPHEMERAL_EXPIRATION) {
      if (isGroup) {
        logger.info(
          {
            jid: normalizedJid,
            resolutionMs: 0,
            cachedMetadata: this.groupMetadataCache.has(normalizedJid),
            ephemeralExpiration: null,
            ephemeralExpirationSkipped: true
          },
          'Resolved group send options'
        );
        return groupBaseOptions();
      }
      return options;
    }

    let ephemeralExpiration: number | null = null;
    const resolutionStartedAt = Date.now();

    if (normalizedJid.endsWith('@g.us')) {
      const cached = this.groupMetadataCache.get(normalizedJid) as Record<string, unknown> | undefined;
      ephemeralExpiration = readPositiveInteger(cached?.ephemeralDuration);
      if (!ephemeralExpiration) {
        const info = await this.getGroupInfo(normalizedJid);
        ephemeralExpiration = readPositiveInteger(info?.ephemeralDuration);
      }
    } else {
      ephemeralExpiration = this.resolveDirectChatEphemeralExpiration(normalizedJid);
    }

    if (isGroup) {
      logger.info(
        {
          jid: normalizedJid,
          resolutionMs: Date.now() - resolutionStartedAt,
          cachedMetadata: this.groupMetadataCache.has(normalizedJid),
          ephemeralExpiration
        },
        'Resolved group send options'
      );
    }

    if (isGroup) {
      const resolvedOptions = groupBaseOptions();
      if (!ephemeralExpiration) {
        return resolvedOptions;
      }
      return {
        ...resolvedOptions,
        ephemeralExpiration
      };
    }

    if (!ephemeralExpiration) {
      return options;
    }

    return {
      ...options,
      ephemeralExpiration
    };
  }

  async waitForMessageStatus(
    messageId: string,
    minStatus: number,
    timeoutMs = 30000
  ): Promise<MessageStatusSnapshot | null> {
    const socket = this.socket as any;
    if (!socket) return null;

    const cached = this.recentMessageStatuses.get(messageId);
    if (cached && typeof cached.status === 'number' && cached.status >= minStatus) {
      return cached;
    }

    return new Promise((resolve) => {
      let updateHandler: ((updates: any[]) => void) | null = null;
      let receiptHandler: ((updates: any[]) => void) | null = null;
      let settled = false;

      const finish = (value: MessageStatusSnapshot | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (updateHandler) {
          socket.ev.off('messages.update', updateHandler);
        }
        if (receiptHandler) {
          socket.ev.off('message-receipt.update', receiptHandler);
        }
        resolve(value);
      };

      const timeout = setTimeout(() => finish(null), timeoutMs);

      updateHandler = (updates: any[]) => {
        const list = Array.isArray(updates) ? updates : [];
        for (const entry of list) {
          const id = entry?.key?.id;
          if (!id || String(id) !== messageId) continue;
          const status = entry?.update?.status;
          if (typeof status !== 'number') continue;
          if (status < minStatus) continue;

          const statusLabel = mapMessageStatusLabel(status);
          const snapshot: MessageStatusSnapshot = {
            status,
            statusLabel,
            remoteJid: entry?.key?.remoteJid ? String(entry.key.remoteJid) : null,
            updatedAtMs: Date.now()
          };
          this.rememberMessageStatus(messageId, snapshot);
          finish(snapshot);
          return;
        }
      };

      receiptHandler = (updates: any[]) => {
        const list = Array.isArray(updates) ? updates : [];
        for (const entry of list) {
          const id = entry?.key?.id;
          if (!id || String(id) !== messageId) continue;

          const receipt = entry?.receipt || {};
          const status =
            receipt?.readTimestamp != null
              ? 4
              : receipt?.receiptTimestamp != null
                ? 3
                : null;
          if (status == null || status < minStatus) continue;

          const snapshot: MessageStatusSnapshot = {
            status,
            statusLabel: mapMessageStatusLabel(status),
            remoteJid: entry?.key?.remoteJid ? String(entry.key.remoteJid) : null,
            updatedAtMs: Date.now()
          };
          this.rememberMessageStatus(messageId, snapshot);
          finish(snapshot);
          return;
        }
      };

      socket.ev.on('messages.update', updateHandler);
      socket.ev.on('message-receipt.update', receiptHandler);

      // Avoid race: status may be cached between the first check and listener attach.
      const cachedAfter = this.recentMessageStatuses.get(messageId);
      if (cachedAfter && typeof cachedAfter.status === 'number' && cachedAfter.status >= minStatus) {
        finish(cachedAfter);
      }
    });
  }

  async waitForMessageFailure(messageId: string, timeoutMs = 15000): Promise<MessageFailureSnapshot | null> {
    const id = String(messageId || '').trim();
    if (!id) return null;

    const cached = this.recentMessageFailures.get(id);
    if (cached) return cached;

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        const failure = this.recentMessageFailures.get(id);
        if (failure) {
          clearInterval(interval);
          resolve(failure);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(interval);
          resolve(null);
        }
      }, 100);
    });
  }

  async confirmSend(
    messageId: string,
    options?: { upsertTimeoutMs?: number; ackTimeoutMs?: number; requireServerAck?: boolean; failureGraceMs?: number }
  ): Promise<{ ok: boolean; via: 'upsert' | 'ack' | 'none'; status?: number | null; statusLabel?: string | null; error?: string | null }> {
    const upsertTimeoutMs = Number(options?.upsertTimeoutMs ?? 5000);
    const ackTimeoutMs = Number(options?.ackTimeoutMs ?? 15000);
    const requireServerAck = Boolean(options?.requireServerAck);
    const failureGraceMs = Math.max(Number(options?.failureGraceMs ?? 0), 0);
    const minStatus = 2;
    let sawLocalUpsert = false;

    const waitForAckOrFailure = async (timeoutMs: number) => {
      const ackPromise = this.waitForMessageStatus(messageId, minStatus, timeoutMs).then((acked) =>
        acked ? ({ type: 'ack' as const, value: acked }) : ({ type: 'none' as const })
      );
      const failurePromise = this.waitForMessageFailure(messageId, timeoutMs).then((failed) =>
        failed ? ({ type: 'failure' as const, value: failed }) : ({ type: 'none' as const })
      );
      return Promise.race([ackPromise, failurePromise]);
    };

    try {
      const observed = await this.waitForMessage(messageId, upsertTimeoutMs);
      if (observed) {
        sawLocalUpsert = true;
      }
    } catch {
      // ignore
    }

    const cachedFailure = this.recentMessageFailures.get(messageId);
    if (cachedFailure) {
      return { ok: false, via: 'none', error: cachedFailure.errorMessage };
    }

    if (sawLocalUpsert) {
      const cachedAfterUpsert = this.recentMessageStatuses.get(messageId);
      if (cachedAfterUpsert && typeof cachedAfterUpsert.status === 'number' && cachedAfterUpsert.status >= minStatus) {
        return {
          ok: true,
          via: 'ack',
          status: cachedAfterUpsert.status,
          statusLabel: cachedAfterUpsert.statusLabel
        };
      }

      if (requireServerAck) {
        const outcome = await waitForAckOrFailure(ackTimeoutMs);
        if (outcome.type === 'failure') {
          return { ok: false, via: 'none', error: outcome.value.errorMessage };
        }
        if (outcome.type === 'ack') {
          return { ok: true, via: 'ack', status: outcome.value.status, statusLabel: outcome.value.statusLabel };
        }
        return {
          ok: false,
          via: 'upsert',
          status: 1,
          statusLabel: 'pending',
          error: 'Server ack not observed'
        };
      }

      if (failureGraceMs > 0) {
        const failed = await this.waitForMessageFailure(messageId, failureGraceMs);
        if (failed) {
          return { ok: false, via: 'none', error: failed.errorMessage };
        }
      }

      return { ok: true, via: 'upsert', status: 1, statusLabel: 'pending' };
    }

    const outcome = await waitForAckOrFailure(ackTimeoutMs);
    if (outcome.type === 'failure') {
      return { ok: false, via: 'none', error: outcome.value.errorMessage };
    }
    if (outcome.type === 'ack') {
      return { ok: true, via: 'ack', status: outcome.value.status, statusLabel: outcome.value.statusLabel };
    }

    return { ok: false, via: 'none', error: requireServerAck ? 'Server ack not observed' : null };
  }

  getQrCode(): string | null {
    return this.getQrState().qr;
  }

  async getGroups(): Promise<GroupSummary[]> {
    const socket = this.socket;
    const now = Date.now();
    const GROUP_CACHE_TTL_MS = 15 * 60 * 1000;
    const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

    const fallbackGroups = () => {
      if (this.groupsListCache.length) return this.groupsListCache;
      const fallbackFromMetadata = this.getGroupsFromMetadataCache();
      if (fallbackFromMetadata.length) return fallbackFromMetadata;
      return this.getGroupsFromChatStore();
    };

    if (this.groupsListCache.length && now - this.groupsListFetchedAtMs < GROUP_CACHE_TTL_MS) {
      return this.groupsListCache;
    }

    if (this.groupsListFetchInFlight) {
      return this.groupsListFetchInFlight;
    }

    if (!socket) {
      return fallbackGroups();
    }

    if (this.groupsListRateLimitedUntilMs && now < this.groupsListRateLimitedUntilMs) {
      return fallbackGroups();
    }

    this.groupsListFetchInFlight = (async () => {
      try {
        const groups = await socket.groupFetchAllParticipating();
        Object.values(groups || {}).forEach((group: { id?: string }) => {
          if (group?.id) {
            this.groupMetadataCache.set(group.id, group);
            if (this.groupMetadataCache.size > 500) {
              const oldest = this.groupMetadataCache.keys().next().value;
              if (oldest) {
                this.groupMetadataCache.delete(oldest);
              }
            }
          }
        });

        const normalized = Object.values(groups || {})
          .map((group) => ({
            id: group.id,
            jid: group.id,
            name: group.subject || group.id,
            size: group.size || 0,
            announce: Boolean((group as any).announce),
            restrict: Boolean((group as any).restrict),
        participantCount: Array.isArray((group as any).participants) ? (group as any).participants.length : Number(group.size || 0),
        me: (() => {
          const meJid = this.meJid || (socket as any)?.user?.id || null;
          const meComparable = normalizePersonJidForCompare(meJid);
          const participants = Array.isArray((group as any).participants) ? (group as any).participants : [];
          const meRow = meJid
            ? participants.find((participant: any) => isSamePersonJid(participant?.id, meComparable || meJid))
            : null;
          const adminRaw = meRow?.admin ? String(meRow.admin) : null;
          return {
            jid: meComparable || (meJid ? String(meJid) : null),
            isAdmin: Boolean(adminRaw),
            admin: adminRaw
          };
        })()
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        this.groupsListCache = normalized;
        this.groupsListFetchedAtMs = Date.now();
        this.groupsListRateLimitedUntilMs = 0;
        return normalized;
      } catch (err) {
        const fallback = fallbackGroups();
        if (this.isRateOverLimitError(err)) {
          this.groupsListCache = fallback;
          this.groupsListFetchedAtMs = Date.now();
          this.groupsListRateLimitedUntilMs = Date.now() + RATE_LIMIT_BACKOFF_MS;
          logger.debug({ cachedCount: fallback.length }, 'WhatsApp group fetch throttled; using cached groups');
          return fallback;
        }

        logger.error({ err, cachedCount: fallback.length }, 'Failed to fetch groups');
        return fallback;
      } finally {
        this.groupsListFetchInFlight = null;
      }
    })();

    return this.groupsListFetchInFlight;
  }

  cacheNewsletterChat(chatLike: unknown): void {
    const channel = extractChannelSummary(chatLike, { allowNumeric: false });
    if (!channel) return;
    const existing = this.newsletterChatCache.get(channel.jid);
    const subscribers = channel.subscribers || existing?.subscribers || 0;
    const nextName = sanitizeChannelDisplayName(channel.name, channel.jid);
    const existingName = sanitizeChannelDisplayName(existing?.name, channel.jid);
    const name = nextName || existingName || channel.jid;
    this.newsletterChatCache.set(channel.jid, {
      jid: channel.jid,
      name,
      subscribers,
      updatedAtMs: Date.now()
    });
    if (this.newsletterChatCache.size > 1000) {
      const oldest = this.newsletterChatCache.keys().next().value;
      if (oldest) {
        this.newsletterChatCache.delete(oldest);
      }
    }
  }

  cacheNewsletterChats(chatsLike: unknown): void {
    const list = Array.isArray(chatsLike) ? chatsLike : [];
    for (const chat of list) {
      this.cacheNewsletterChat(chat);
    }
  }

  cacheNewsletterFromMessageLike(messageLike: unknown): void {
    const message = messageLike as { key?: { remoteJid?: unknown }; remoteJid?: unknown; jid?: unknown; pushName?: unknown; name?: unknown; subject?: unknown };
    const remoteJid =
      normalizeNewsletterJid(message?.key?.remoteJid, { allowNumeric: false }) ||
      normalizeNewsletterJid(message?.remoteJid, { allowNumeric: false }) ||
      normalizeNewsletterJid(message?.jid, { allowNumeric: false });
    if (!remoteJid) return;
    const safeName =
      sanitizeChannelDisplayName(message?.name, remoteJid) ||
      sanitizeChannelDisplayName(message?.subject, remoteJid) ||
      sanitizeChannelDisplayName(message?.pushName, remoteJid) ||
      remoteJid;
    this.cacheNewsletterChat({ jid: remoteJid, name: safeName, subscribers: 0 });
  }

  removeNewsletterChats(jidsLike: unknown): void {
    const list = Array.isArray(jidsLike) ? jidsLike : [];
    for (const jidValue of list) {
      const jid = normalizeNewsletterJid(jidValue, { allowNumeric: false });
      if (!jid) continue;
      this.newsletterChatCache.delete(jid);
    }
  }

  async getChannelsWithDiagnostics(seedJids: string[] = []): Promise<{ channels: ChannelSummary[]; diagnostics: ChannelDiagnostics }> {
    const socket = this.socket as any;
    const diagnostics: ChannelDiagnostics = {
      methodsTried: [],
      methodErrors: [],
      sourceCounts: { api: 0, cache: 0, metadata: 0, store: 0 },
      seeded: { provided: 0, verified: 0, failed: 0, failedJids: [] },
      limitation: null
    };

    if (!socket) {
      diagnostics.limitation = 'WhatsApp is not connected.';
      return { channels: [], diagnostics };
    }

    const normalizedSeedJids = Array.from(
      new Set(
        (Array.isArray(seedJids) ? seedJids : [])
          .map((value) => normalizeNewsletterJid(value, { allowNumeric: true }))
          .filter(Boolean)
      )
    );
    diagnostics.seeded.provided = normalizedSeedJids.length;

    const channelMap = new Map<string, ChannelSummary>();
    const mergeChannel = (candidate: ChannelSummary, source: 'api' | 'cache' | 'metadata' | 'store') => {
      const existing = channelMap.get(candidate.jid);
      const candidateName = sanitizeChannelDisplayName(candidate.name, candidate.jid);
      const existingName = sanitizeChannelDisplayName(existing?.name, candidate.jid);
      const pickSource = () => {
        if (!existing?.source) return source;
        if (existing.source === source) return source;
        const rank: Record<'api' | 'metadata' | 'cache' | 'store', number> = {
          api: 5,
          metadata: 4,
          cache: 3,
          store: 2
        };
        return rank[source] >= rank[existing.source] ? source : existing.source;
      };
      const merged: ChannelSummary = {
        id: candidate.jid,
        jid: candidate.jid,
        name: candidateName || existingName || candidate.jid,
        subscribers: candidate.subscribers || existing?.subscribers || 0,
        role: candidate.role || existing?.role || null,
        canPost:
          typeof candidate.canPost === 'boolean'
            ? candidate.canPost
            : (existing?.canPost || false),
        source: pickSource()
      };
      channelMap.set(candidate.jid, merged);
      diagnostics.sourceCounts[source] += 1;
    }

    // Method 0: Verify known/saved channel JIDs through metadata
    if (normalizedSeedJids.length && typeof socket.newsletterMetadata === 'function') {
      diagnostics.methodsTried.push('seed:metadata-verify');
      for (const seedJid of normalizedSeedJids.slice(0, 100)) {
        try {
          const metadata = await socket.newsletterMetadata('jid', seedJid);
          const normalized = extractChannelSummary(metadata, { allowNumeric: true });
          if (!normalized?.jid) continue;
          mergeChannel(normalized, 'metadata');
          this.cacheNewsletterChat(normalized);
          diagnostics.seeded.verified += 1;
        } catch (error) {
          diagnostics.methodErrors.push(`seed:${seedJid}:${getErrorMessage(error)}`);
          diagnostics.seeded.failed += 1;
          diagnostics.seeded.failedJids.push(seedJid);
        }
      }
    }

    diagnostics.methodsTried.push('api:list-not-available-in-current-baileys');

    // Method 1: Scan chat store for newsletter JIDs
    diagnostics.methodsTried.push('store:scan');
    try {
      const chats = socket.store?.chats?.all() || socket.store?.chats || [];
      const chatArray = Array.isArray(chats) ? chats : Object.values(chats);

      for (const chat of chatArray) {
        if (!chat || typeof chat !== 'object') continue;

        const chatId = (chat as any).id || (chat as any).jid || '';
        const normalizedChatJid = normalizeNewsletterJid(chatId, { allowNumeric: false });
        if (normalizedChatJid) {
          const name = (chat as any).name || (chat as any).subject || normalizedChatJid;
          mergeChannel({
            id: normalizedChatJid,
            jid: normalizedChatJid,
            name: name,
            subscribers: 0
          }, 'store');
          this.cacheNewsletterChat({ jid: normalizedChatJid, name, subscribers: 0 });
        }
      }
    } catch (error) {
      diagnostics.methodErrors.push(`store: ${getErrorMessage(error)}`);
    }

    // Method 2: Use cached newsletters from events/messages
    for (const cached of this.newsletterChatCache.values()) {
      mergeChannel(
        {
          id: cached.jid,
          jid: cached.jid,
          name: cached.name || cached.jid,
          subscribers: cached.subscribers || 0
        },
        'cache'
      );
    }

    // Method 3: Enrich with metadata if available
    if (typeof socket.newsletterMetadata === 'function' && channelMap.size > 0) {
      const toEnrich = Array.from(channelMap.values())
        .filter((channel) => channel.name === channel.jid || channel.subscribers <= 0)
        .slice(0, 50);

      for (const channel of toEnrich) {
        try {
          const metadata = await socket.newsletterMetadata('jid', channel.jid);
          const normalized = extractChannelSummary(metadata, { allowNumeric: true });
          if (!normalized) continue;
          mergeChannel(normalized, 'metadata');
          this.cacheNewsletterChat(normalized);
        } catch {
          // Metadata fetch is best-effort only.
        }
      }
    }

    const channels = Array.from(channelMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (!channels.length) {
      diagnostics.limitation = 'No channels discovered from this session yet. Open/view the channel in WhatsApp, then refresh.';
    }

    return { channels, diagnostics };
  }

  async getChannels(seedJids: string[] = []): Promise<Array<{ id: string; jid: string; name: string; subscribers: number }>> {
    const result = await this.getChannelsWithDiagnostics(seedJids);
    return result.channels;
  }

  async resolveDestination(
    input: string,
    forceType: 'auto' | 'group' | 'channel' | 'individual' | 'status' = 'auto',
    timeoutMs = 15000
  ): Promise<ResolvedDestination | null> {
    const socket = this.socket as any;
    if (!socket) return null;

    const rawInput = String(input || '').trim();
    if (!rawInput) return null;
    const normalizedInput = rawInput.toLowerCase();

    const meJid = this.meJid || socket?.user?.id || null;
    const meComparable = normalizePersonJidForCompare(meJid);

    if (forceType === 'status' || normalizedInput === 'status' || normalizedInput === 'status@broadcast') {
      return {
        input: rawInput,
        type: 'status',
        jid: 'status@broadcast',
        name: 'My Status',
        source: 'status'
      };
    }

    if (forceType === 'auto' || forceType === 'group') {
      const groupInviteCode = extractGroupInviteCode(rawInput);
      if (groupInviteCode && typeof socket.groupGetInviteInfo === 'function') {
        try {
          const metadata = await withTimeout(
            socket.groupGetInviteInfo(groupInviteCode),
            timeoutMs,
            'Timed out resolving group invite'
          );
          const jid = String(metadata?.id || '').trim();
          if (!jid) return null;
          const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
          const meRow = meJid
            ? participants.find((participant: any) => isSamePersonJid(participant?.id, meComparable || meJid))
            : null;
          const adminRaw = meRow?.admin ? String(meRow.admin) : null;
          return {
            input: rawInput,
            type: 'group',
            jid,
            name: String(metadata?.subject || jid),
            source: 'group_invite',
            size: Number(metadata?.size || 0),
            participantCount: participants.length,
            announce: Boolean(metadata?.announce),
            restrict: Boolean(metadata?.restrict),
            me: {
              jid: meComparable || (meJid ? String(meJid) : null),
              isAdmin: Boolean(adminRaw),
              admin: adminRaw
            },
            inviteCode: groupInviteCode
          };
        } catch (error) {
          logger.warn({ input: rawInput, error: getErrorMessage(error) }, 'Failed to resolve group invite');
        }
      }
    }

    if (forceType === 'auto' || forceType === 'channel') {
      const channelInviteCode = extractChannelInviteCode(rawInput);
      if (channelInviteCode && typeof socket.newsletterMetadata === 'function') {
        try {
          const metadata = await withTimeout(
            socket.newsletterMetadata('invite', channelInviteCode),
            timeoutMs,
            'Timed out resolving channel invite'
          );
          const normalized = extractChannelSummary(metadata, { allowNumeric: true });
          if (normalized?.jid) {
            return {
              input: rawInput,
              type: 'channel',
              jid: normalized.jid,
              name: normalized.name || normalized.jid,
              source: 'channel_invite',
              subscribers: Number(normalized.subscribers || 0),
              role: normalized.role || null,
              canPost: Boolean(normalized.canPost),
              inviteCode: channelInviteCode
            };
          }
        } catch (error) {
          logger.warn({ input: rawInput, error: getErrorMessage(error) }, 'Failed to resolve channel invite');
        }
      }
    }

    const explicitGroupJid = normalizeGroupJid(rawInput);
    if (explicitGroupJid && (forceType === 'auto' || forceType === 'group')) {
      const groupInfo = await this.getGroupInfo(explicitGroupJid, timeoutMs);
      if (!groupInfo) return null;
      return {
        input: rawInput,
        type: 'group',
        jid: groupInfo.jid,
        name: groupInfo.name,
        source: 'group_jid',
        size: groupInfo.size,
        participantCount: groupInfo.participantCount,
        announce: groupInfo.announce,
        restrict: groupInfo.restrict,
        me: groupInfo.me
      };
    }

    const explicitChannelJid = normalizeNewsletterJid(rawInput, { allowNumeric: true });
    if (explicitChannelJid && (forceType === 'auto' || forceType === 'channel')) {
      let normalized: ChannelSummary | null = null;
      if (typeof socket.newsletterMetadata === 'function') {
        try {
          const metadata = await withTimeout(
            socket.newsletterMetadata('jid', explicitChannelJid),
            timeoutMs,
            'Timed out resolving channel metadata'
          );
          normalized = extractChannelSummary(metadata, { allowNumeric: true });
        } catch {
          normalized = null;
        }
      }
      if (!normalized) {
        try {
          const discovered = await this.getChannelsWithDiagnostics([explicitChannelJid]);
          normalized =
            discovered.channels.find(
              (channel) => String(channel?.jid || '').toLowerCase() === explicitChannelJid.toLowerCase()
            ) || null;
        } catch {
          normalized = null;
        }
      }

      if (!normalized?.jid) {
        return null;
      }

      return {
        input: rawInput,
        type: 'channel',
        jid: normalized.jid,
        name: normalized.name || normalized.jid,
        source: 'channel_jid',
        subscribers: Number(normalized.subscribers || 0),
        role: normalized.role || null,
        canPost: Boolean(normalized.canPost)
      };
    }

    if (forceType === 'auto' || forceType === 'individual') {
      const normalizedIndividual = normalizeIndividualJid(rawInput);
      if (normalizedIndividual) {
        let exists: boolean | null = null;
        if (typeof socket.onWhatsApp === 'function') {
          try {
            const lookup = await withTimeout(
              socket.onWhatsApp(normalizedIndividual),
              timeoutMs,
              'Timed out checking WhatsApp number'
            );
            const first = Array.isArray(lookup) ? lookup[0] : null;
            exists = first ? Boolean((first as { exists?: unknown }).exists) : null;
          } catch {
            exists = null;
          }
        }

        return {
          input: rawInput,
          type: 'individual',
          jid: normalizedIndividual,
          name: normalizedIndividual.replace('@s.whatsapp.net', ''),
          source: 'individual_jid',
          exists
      };
    }
  }

    return null;
  }

  getHardRefreshState(force = false): { allowed: boolean; reason: string | null } {
    if (force) {
      return { allowed: true, reason: null };
    }

    const currentStatus = String(this.status || 'unknown');
    if (currentStatus === 'connected') {
      return {
        allowed: false,
        reason: 'WhatsApp is already connected. Use reconnect or takeover instead of hard refresh.'
      };
    }

    if (currentStatus === 'connecting') {
      return {
        allowed: false,
        reason: 'WhatsApp is still connecting. Wait before forcing a new QR.'
      };
    }

    const lastSeenAtMs = this.lastSeenAt instanceof Date ? this.lastSeenAt.getTime() : Number.NaN;
    const recentlyConnected =
      Number.isFinite(lastSeenAtMs) && Date.now() - lastSeenAtMs < HARD_REFRESH_RECENT_CONNECTION_GRACE_MS;

    if (recentlyConnected) {
      return {
        allowed: false,
        reason: 'WhatsApp connected recently. Wait before forcing a new QR.'
      };
    }

    return { allowed: true, reason: null };
  }

  private async uploadNewsletterMediaWithHandle(
    filePath: string,
    mediaType: 'image' | 'video',
    fileHashB64: string,
    timeoutMs?: number
  ): Promise<{ mediaUrl: string; directPath: string; handle: string }> {
    const socket = this.socket as any;
    if (!socket?.refreshMediaConn) {
      throw new Error('Baileys socket does not expose refreshMediaConn');
    }

    const { DEFAULT_ORIGIN } = await loadBaileys();
    let mediaConn = await socket.refreshMediaConn(false);
    const hosts = Array.isArray(mediaConn?.hosts) ? mediaConn.hosts : [];
    const token = normalizeNewsletterUploadToken(String(fileHashB64 || '').trim());
    const normalizedType = mediaType === 'video' ? 'video' : 'image';
    let lastError = 'No newsletter upload hosts are available';

    for (let index = 0; index < hosts.length; index += 1) {
      const hostname = String(hosts[index]?.hostname || '').trim();
      if (!hostname) continue;

      try {
        const url = new URL(`https://${hostname}/newsletter/newsletter-${normalizedType}/${token}`);
        url.searchParams.set('auth', String(mediaConn?.auth || ''));
        url.searchParams.set('token', token);

        const requestOptions = {
          method: 'POST',
          body: createReadStream(filePath),
          headers: {
            'Content-Type': 'application/octet-stream',
            Origin: DEFAULT_ORIGIN,
            Referer: `${DEFAULT_ORIGIN}/`
          },
          duplex: 'half',
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
        } as unknown as RequestInit;

        const response = await fetch(url.toString(), requestOptions);

        const bodyText = await response.text();
        let payload: Record<string, unknown> | null = null;
        try {
          payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        } catch {
          payload = null;
        }

        if (!response.ok) {
          throw new Error(
            `Newsletter media upload failed (${response.status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`
          );
        }

        const mediaUrl = String(payload?.url || '').trim();
        const directPath = String(payload?.direct_path || payload?.directPath || '').trim();
        const handle = String(
          payload?.handle || payload?.media_handle || payload?.mediaHandle || payload?.object_id || ''
        ).trim();

        if (!mediaUrl || !directPath) {
          throw new Error('Newsletter media upload response is missing url or direct_path');
        }
        if (!handle) {
          throw new Error('Newsletter media upload response is missing handle');
        }

        return { mediaUrl, directPath, handle };
      } catch (error) {
        lastError = getErrorMessage(error);
        logger.warn({ error: lastError, hostname, mediaType }, 'Newsletter media upload attempt failed');
        if (index < hosts.length - 1) {
          try {
            mediaConn = await socket.refreshMediaConn(true);
          } catch {
            // ignore refresh failures and continue to the next host
          }
        }
      }
    }

    throw new Error(lastError || 'Newsletter media upload failed');
  }

  private async sendNewsletterMediaMessage(
    jid: string,
    content: AnyMessageContent,
    options: MiscMessageGenerationOptions = {}
  ) {
    const socket = this.socket as any;
    if (!socket?.sendNode) {
      throw new Error('Baileys socket does not expose sendNode');
    }

    const mediaType = getNewsletterRelayMediaType(content);
    if (!mediaType) {
      throw new Error('Newsletter relay only supports image or video content');
    }

    const {
      DEFAULT_ORIGIN,
      encodeNewsletterMessage,
      generateMessageIDV2,
      prepareWAMessageMedia
    } = await loadBaileys();

    let mediaHandle = '';
    const upload = async (
      filePath: string,
      uploadOptions: { fileEncSha256B64: string; mediaType: string; timeoutMs?: number }
    ) => {
      const result = await this.uploadNewsletterMediaWithHandle(
        filePath,
        mediaType,
        uploadOptions.fileEncSha256B64,
        uploadOptions.timeoutMs
      );
      mediaHandle = result.handle;
      return {
        mediaUrl: result.mediaUrl,
        directPath: result.directPath
      };
    };

    const message = patchNewsletterMediaDirectPaths(
      await prepareWAMessageMedia(content as Record<string, unknown>, {
        ...options,
        jid,
        upload,
        logger,
        mediaCache: socket.mediaCache,
        options: socket.options || { headers: { Origin: DEFAULT_ORIGIN } }
      }),
      { force: Boolean(newsletterMediaPatchContext.getStore()) }
    ) as proto.IMessage;

    const messageId = generateMessageIDV2(socket.user?.id);
    const plaintextNode = {
      tag: 'plaintext',
      attrs: { mediatype: mediaType },
      content: encodeNewsletterMessage(message)
    };
    const stanzaAttrs: Record<string, string> = {
      to: jid,
      id: messageId,
      type: 'media'
    };

    if (mediaHandle) {
      stanzaAttrs.media_id = mediaHandle;
    }

    await socket.sendNode({
      tag: 'message',
      attrs: stanzaAttrs,
      content: [plaintextNode]
    });

    return {
      key: {
        remoteJid: jid,
        fromMe: true,
        id: messageId
      },
      message,
      status: 1,
      messageTimestamp: Math.floor(Date.now() / 1000)
    };
  }

  async sendMessage(jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    const normalizedJid = String(jid || '').trim();
    const isGroup = normalizedJid.endsWith('@g.us');
    const isNewsletter = Boolean(normalizeNewsletterJid(normalizedJid, { allowNumeric: false }));
    const sendStartedAt = Date.now();
    try {
      const effectiveOptions = await this.resolveSendOptions(jid, options);
      if (isGroup) {
        logger.info(
          {
            jid: normalizedJid,
            preparationMs: Date.now() - sendStartedAt,
            optionKeys: Object.keys(effectiveOptions || {}).sort()
          },
          'Starting group send'
        );
      }
      const sendOperation = async () => this.socket!.sendMessage(jid, content, effectiveOptions);
      let msg;
      if (isNewsletter && getNewsletterRelayMediaType(content)) {
        try {
          msg = await newsletterMediaPatchContext.run(
            true,
            async () => await this.sendNewsletterMediaMessage(jid, content, effectiveOptions)
          );
        } catch (newsletterError) {
          logger.warn(
            { error: getErrorMessage(newsletterError), jid: normalizedJid },
            'Dedicated newsletter media relay failed; falling back to Baileys sendMessage'
          );
          msg = await newsletterMediaPatchContext.run(true, sendOperation);
        }
      } else {
        msg = isNewsletter
          ? await newsletterMediaPatchContext.run(true, sendOperation)
          : await sendOperation();
      }
      if (isGroup) {
        logger.info(
          {
            jid: normalizedJid,
            totalMs: Date.now() - sendStartedAt,
            messageId: msg?.key?.id || null
          },
          'Group send resolved'
        );
      }

      try {
        const id = msg?.key?.id;
        if (id) {
          this.recentSentMessages.set(String(id), msg);
          if (this.recentSentMessages.size > 500) {
            const oldest = this.recentSentMessages.keys().next().value;
            if (oldest) {
              this.recentSentMessages.delete(oldest);
            }
          }
        }
      } catch {
        // ignore cache errors
      }

      return msg;
    } catch (err) {
      logger.error({ err, jid, totalMs: Date.now() - sendStartedAt }, 'Failed to send message');
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAuthStateCorrupted(message)) {
        void this.handleCorruptedAuthState(err);
      } else if (this.isRecoverableSessionCryptoError(message)) {
        this.markSessionUnhealthy(err);
      }
      throw err;
    }
  }

  async sendStatusBroadcast(content: AnyMessageContent, options: Record<string, unknown> = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    try {
      const sanitized = sanitizeStatusBroadcastOptions(content, options);
      const explicitStatusJids = Array.isArray((options as { statusJidList?: unknown[] }).statusJidList)
        ? ((options as { statusJidList?: unknown[] }).statusJidList || [])
            .map((value) => normalizeStatusAudienceJid(value))
            .filter(Boolean)
        : [];
      const dedupedExplicit = Array.from(new Set(explicitStatusJids));

      const resolvedAudience = await this.resolveStatusAudienceWithLidMappings();
      const preferredAudience = preferDeliverableStatusRecipients(
        dedupedExplicit.length ? dedupedExplicit : resolvedAudience.participants
      );
      const statusJidList = preferredAudience.recipients;

      if (!statusJidList.length) {
        throw new Error(
          'No status recipients resolved. Open WhatsApp contacts/chats first or set WHATSAPP_STATUS_AUDIENCE_JIDS.'
        );
      }
      if (!dedupedExplicit.length && isUnsafeImplicitStatusAudience(statusJidList, resolvedAudience.sources)) {
        throw new Error(
          'Status audience only contains group-participant LID recipients. Add explicit private Status recipients or wait for Baileys to resolve phone-number mappings before sending.'
        );
      }

      options = { ...sanitized.options, broadcast: true, statusJidList };
      logger.debug(
        {
          participantCount: statusJidList.length,
          explicitCount: dedupedExplicit.length,
          sources: resolvedAudience.sources,
          warnings: resolvedAudience.warnings
        },
        'Sending status broadcast'
      );
      if (sanitized.strippedOptions.length) {
        logger.warn(
          {
            strippedOptions: sanitized.strippedOptions
          },
          'Removed text-only status styling options from media status payload'
        );
      }
      if (preferredAudience.droppedLidCount > 0) {
        logger.warn(
          {
            droppedLidCount: preferredAudience.droppedLidCount,
            participantCount: statusJidList.length
          },
          'Dropped LID-only status recipients because phone-number recipients were available'
        );
      }

      const msg = await this.socket.sendMessage('status@broadcast', content, options);

      try {
        const id = msg?.key?.id;
        if (id) {
          this.recentSentMessages.set(String(id), msg);
          if (this.recentSentMessages.size > 500) {
            const oldest = this.recentSentMessages.keys().next().value;
            if (oldest) {
              this.recentSentMessages.delete(oldest);
            }
          }
        }
      } catch {
        // ignore cache errors
      }

      return msg;
    } catch (err) {
      logger.error({ err }, 'Failed to send status broadcast');
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAuthStateCorrupted(message)) {
        void this.handleCorruptedAuthState(err);
      } else if (this.isRecoverableSessionCryptoError(message)) {
        this.markSessionUnhealthy(err);
      }
      throw err;
    }
  }

  async editMessage(jid: string, messageId: string, contentOrText: string | AnyRegularMessageContent) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    const normalizedJid = String(jid || '').trim();
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedJid || !normalizedMessageId) {
      throw new Error('jid and messageId are required to edit a message');
    }

    let content: AnyRegularMessageContent;
    if (typeof contentOrText === 'string') {
      const normalizedText = String(contentOrText || '').trim();
      if (!normalizedText) throw new Error('Updated message text is required');
      content = { text: normalizedText };
    } else if (contentOrText && typeof contentOrText === 'object') {
      const editableContent = { ...(contentOrText as Record<string, unknown>) } as AnyRegularMessageContent;
      const hasText = Boolean(String((editableContent as { text?: unknown }).text || '').trim());
      const hasMedia = ['image', 'video', 'document'].some((key) =>
        Object.prototype.hasOwnProperty.call(editableContent as Record<string, unknown>, key)
      );
      if (!hasText && !hasMedia) {
        throw new Error('Updated message content is required');
      }
      content = editableContent;
    } else {
      throw new Error('Updated message content is required');
    }

    const key: proto.IMessageKey = {
      remoteJid: normalizedJid,
      id: normalizedMessageId,
      fromMe: true
    };

    try {
      return await this.socket.sendMessage(normalizedJid, ({
        ...(content as Record<string, unknown>),
        edit: key
      } as unknown) as AnyMessageContent);
    } catch (err) {
      logger.error({ err, jid: normalizedJid, messageId: normalizedMessageId }, 'Failed to edit message');
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAuthStateCorrupted(message)) {
        void this.handleCorruptedAuthState(err);
      } else if (this.isRecoverableSessionCryptoError(message)) {
        this.markSessionUnhealthy(err);
      }
      throw err;
    }
  }

  async deleteMessage(jid: string, messageId: string) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    const normalizedJid = String(jid || '').trim();
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedJid || !normalizedMessageId) {
      throw new Error('jid and messageId are required to delete a message');
    }

    const cached = this.recentSentMessages.get(normalizedMessageId);
    const cachedKey = cached?.key || null;
    const key: proto.IMessageKey = {
      remoteJid: String(cachedKey?.remoteJid || normalizedJid),
      id: String(cachedKey?.id || normalizedMessageId),
      fromMe: true
    };

    try {
      return await this.socket.sendMessage(normalizedJid, { delete: key });
    } catch (err) {
      logger.error({ err, jid: normalizedJid, messageId: normalizedMessageId }, 'Failed to delete message');
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAuthStateCorrupted(message)) {
        void this.handleCorruptedAuthState(err);
      } else if (this.isRecoverableSessionCryptoError(message)) {
        this.markSessionUnhealthy(err);
      }
      throw err;
    }
  }

  getSocket(): WASocket | null {
    return this.socket;
  }

  async waitForMessage(messageId: string, timeoutMs = 30000): Promise<proto.IWebMessageInfo | null> {
    const socket = this.socket;
    if (!socket) return null;

    const cached = this.recentSentMessages.get(messageId);
    if (cached) {
      return cached;
    }
    return new Promise((resolve) => {
      let handler:
        | ((event: { messages: proto.IWebMessageInfo[] }) => void)
        | null = null;
      let settled = false;

      const finish = (value: proto.IWebMessageInfo | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (handler) {
          socket.ev.off('messages.upsert', handler);
        }
        resolve(value);
      };

      const timeout = setTimeout(() => finish(null), timeoutMs);

      handler = ({ messages }: { messages: proto.IWebMessageInfo[] }) => {
        const found = messages.find((m) => m.key?.id === messageId);
        if (found) {
          this.recentSentMessages.set(messageId, found);
          finish(found);
        }
      };

      socket.ev.on('messages.upsert', handler);

      // Avoid race: message may be cached between the first check and listener attach.
      const cachedAfter = this.recentSentMessages.get(messageId);
      if (cachedAfter) {
        finish(cachedAfter);
      }
    });
  }

  async persistPauseSetting(paused: boolean): Promise<void> {
    try {
      const settingsService = require('../services/settingsService');
      if (typeof settingsService?.updateSettings !== 'function') return;
      await settingsService.updateSettings({
        whatsapp_paused: paused,
        whatsapp_paused_at: paused ? new Date().toISOString() : null
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to persist WhatsApp pause setting');
    }
  }

  async pause(): Promise<void> {
    this.isPaused = true;
    this.isConnecting = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.persistPauseSetting(true);

    try {
      await this.disconnect({ releaseLease: false });
    } catch (error) {
      logger.warn({ error }, 'Failed to disconnect WhatsApp while pausing');
    }

    this.status = 'paused';
    this.lastError = 'WhatsApp session paused.';
  }

  async resume(): Promise<void> {
    this.isPaused = false;
    this.isConnecting = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.persistPauseSetting(false);

    if (this.lastError === 'WhatsApp session paused.') {
      this.lastError = null;
    }

    await this.connect();
  }

  async disconnect(options?: { releaseLease?: boolean }): Promise<void> {
    const releaseLease = options?.releaseLease !== false;

    // Disconnect without logging out (keeps auth state so reconnect doesn't require QR)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearPresenceOfflineHeartbeat();
    if (releaseLease) {
      this.stopLeaseRenewal();
      if (this.authStore?.releaseLease) {
        try {
          await this.authStore.releaseLease(this.instanceId);
        } catch (error) {
          logger.warn({ error }, 'Failed to release WhatsApp lease');
        }
      }
      this.leaseHeld = false;
      this.leaseOwnerId = null;
      this.leaseExpiresAt = null;
    }

    if (this.socket) {
      try {
        this.cleanupSocket();
        this.socket.end(new Error('Socket closed'));
      } catch {
        // ignore
      }
      this.socket = null;
    }

    this.groupMetadataCache.clear();
    this.contactsCache.clear();
    this.recentSentMessages.clear();
    this.recentMessageStatuses.clear();
    this.recentMessageFailures.clear();
    this.pendingReceiptUpdates.clear();
    if (this.pendingReceiptFlushTimer) {
      clearTimeout(this.pendingReceiptFlushTimer);
      this.pendingReceiptFlushTimer = null;
    }
    this.meJid = null;
    this.meName = null;

    this.status = 'disconnected';
    this.resetQrLifecycle();
    this.lastError = null;
    this.lastSeenAt = null;

    if (this.authStore?.updateStatus) {
      await this.authStore.updateStatus('disconnected', null);
    }
  }

  async hardRefresh(options?: { force?: boolean }): Promise<void> {
    if (this.isPaused) {
      this.status = 'paused';
      this.lastError = 'WhatsApp is paused. Resume before hard refresh.';
      return;
    }

    const refreshState = this.getHardRefreshState(Boolean(options?.force));
    if (!refreshState.allowed) {
      this.lastError = refreshState.reason;
      throw new Error(refreshState.reason || 'Hard refresh is not allowed right now.');
    }

    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearPresenceOfflineHeartbeat();
    // Cleanup existing socket
    if (this.socket) {
      try {
        this.cleanupSocket();
        this.socket.end(new Error('Socket closed'));
      } catch (e) {
        // Ignore cleanup errors
      }
      this.socket = null;
    }

    this.groupMetadataCache.clear();
    this.recentSentMessages.clear();
    this.recentMessageStatuses.clear();
    this.recentMessageFailures.clear();
    this.pendingReceiptUpdates.clear();
    if (this.pendingReceiptFlushTimer) {
      clearTimeout(this.pendingReceiptFlushTimer);
      this.pendingReceiptFlushTimer = null;
    }
    this.meJid = null;
    this.meName = null;

    // Reset state
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.status = 'disconnected';
    this.resetQrLifecycle();
    this.lastError = null;
    this.isAuthCorrupted = false;
    this.hasConnectedOnce = false;
    this.lastSeenAt = null;
    this.lastSenderKeyResetAt = null;
    this.lastKeyCacheResetAt = null;

    // Stop renewing while we clear/recreate auth state.
    this.stopLeaseRenewal();

    // Clear auth state to force new QR
    if (this.authStore?.clearState) {
      await this.authStore.clearState();
    }

    // Reconnect
    await this.connect();
  }

  async clearSenderKeys(): Promise<void> {
    if (this.isPaused) {
      this.status = 'paused';
      this.lastError = 'WhatsApp is paused. Resume before clearing sender keys.';
      return;
    }
    // Clears sender-key cache to fix group send issues without forcing re-login.
    if (this.authStore?.clearKeys) {
      await this.authStore.clearKeys(['sender-key']);
    }
    await this.disconnect();
    await this.connect();
  }
}

const createWhatsAppClient = () => new WhatsAppClient();

module.exports = Object.assign(createWhatsAppClient, {
  resolveBrowserTuple,
  patchNewsletterMediaDirectPaths
});
