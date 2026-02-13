import type { AnyMessageContent, WASocket, proto } from '@whiskeysockets/baileys';
import { randomUUID } from 'crypto';

const { loadBaileys } = require('./baileys');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const withTimeout = require('../utils/withTimeout');
const { getErrorMessage } = require('../utils/errorUtils');
const useSupabaseAuthState = require('./authStore');
const { saveIncomingMessages } = require('../services/messageService');
const { initSchedulers } = require('../services/schedulerService');
const { runTargetAutoSyncPass } = require('../services/targetSyncService');

type WhatsAppStatus = 'disconnected' | 'connecting' | 'connected' | 'qr' | 'error' | 'conflict';

type MessageStatusSnapshot = {
  status: number | null;
  statusLabel: string | null;
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
    const digits = strippedPrefix.replace(/[^0-9]/g, '');
    const user = digits || strippedPrefix;
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

const normalizeIndividualJid = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().endsWith('@s.whatsapp.net')) return raw;
  if (raw.includes('@')) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 7) return '';
  return `${digits}@s.whatsapp.net`;
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
  qrCode: string | null;
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
  processErrorHandlersBound: boolean;
  waVersion: number[] | null;
  waVersionFetchedAtMs: number | null;
  recentSentMessages: Map<string, proto.IWebMessageInfo>;
  recentMessageStatuses: Map<string, MessageStatusSnapshot>;
  newsletterChatCache: Map<string, CachedNewsletterChat>;
  meJid: string | null;
  meName: string | null;
  hasConnectedOnce: boolean;

  constructor() {
    this.socket = null;
    this.status = 'disconnected';
    this.qrCode = null;
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
    this.processErrorHandlersBound = false;
    this.waVersion = null;
    this.waVersionFetchedAtMs = null;
    this.recentSentMessages = new Map();
    this.recentMessageStatuses = new Map();
    this.newsletterChatCache = new Map();
    this.meJid = null;
    this.meName = null;
    this.hasConnectedOnce = false;
  }

  async init(): Promise<void> {
    try {
      this.authStore = await useSupabaseAuthState(this.sessionId);
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
      'senderkeyrecord.deserialize',
      'sender key record',
      'not valid json'
    ];
    return checks.some((check) => normalized.includes(check.toLowerCase()));
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
      const meRow = meJid
        ? participants.find((participant: any) => String(participant?.id || '') === String(meJid))
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
          jid: meJid,
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
        const meRow = meJid
          ? participants.find((participant: any) => String(participant?.id || '') === String(meJid))
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
            jid: meJid,
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

      if (looksLikeSenderKeyCorruption && this.authStore?.clearKeys) {
        const now = Date.now();
        if (this.lastSenderKeyResetAt && now - this.lastSenderKeyResetAt < 60_000) {
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

  createBaileysLogger() {
    const baseLogger = logger.child({ class: 'baileys' });
    const baileysLogger = Object.create(baseLogger);
    const isBenignMediaTrace = (value: string | null) =>
      Boolean(value && /Input file contains unsupported image format/i.test(value));
    const handleArgs = (args: unknown[]) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      if (this.isAuthStateCorrupted(message) || this.isAuthStateCorrupted(errorMessage)) {
        void this.handleCorruptedAuthState(
          errorMessage ? new Error(errorMessage) : new Error(message || 'Auth error')
        );
      }
    };
    baileysLogger.error = (...args: unknown[]) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      if (isBenignMediaTrace(errorMessage) || isBenignMediaTrace(message)) {
        baseLogger.info(
          { reason: 'unsupported_image_format' },
          'Baileys skipped thumbnail generation for one media payload'
        );
        return;
      }
      baseLogger.error(...args);
      handleArgs(args);
    };
    baileysLogger.warn = (...args: unknown[]) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      if (isBenignMediaTrace(errorMessage) || isBenignMediaTrace(message)) {
        baseLogger.info(
          { reason: 'unsupported_image_format' },
          'Baileys skipped thumbnail generation for one media payload'
        );
        return;
      }
      baseLogger.warn(...args);
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
          logger.warn({ leaseOwner: lease.ownerId, leaseExpiresAt: lease.expiresAt }, 'Lost WhatsApp lease');
          this.stopLeaseRenewal();
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  cleanupSocket(): void {
    if (!this.socket) return;
    const ev = this.socket.ev as unknown as { removeAllListeners: (event: string) => void };
    ev.removeAllListeners('connection.update');
    ev.removeAllListeners('creds.update');
    ev.removeAllListeners('messages.upsert');
    ev.removeAllListeners('messages.update');
    ev.removeAllListeners('chats.set');
    ev.removeAllListeners('chats.upsert');
    ev.removeAllListeners('chats.update');
    ev.removeAllListeners('chats.delete');
  }

  async connect(): Promise<void> {
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
      // Keep lease protection ON by default so deploy overlaps don't fight for the same WA session.
      const skipLease = String(process.env.SKIP_WHATSAPP_LEASE || 'false').toLowerCase() === 'true';
      // Auto-takeover is intentionally opt-in: forcing takeovers during deploy overlaps can
      // cause WhatsApp "conflict/replaced" churn. Use POST /api/whatsapp/takeover when needed.
      const allowAutoTakeover = String(process.env.WHATSAPP_LEASE_AUTO_TAKEOVER || '').toLowerCase() === 'true';
      if (!skipLease && authStore.acquireLease) {
        try {
          const lease = await authStore.acquireLease(this.instanceId, 90_000);
          this.leaseSupported = lease.supported;
          this.leaseHeld = lease.ok;
          this.leaseOwnerId = lease.ownerId;
          this.leaseExpiresAt = lease.expiresAt;

          if (lease.supported && !lease.ok) {
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
        // Lease disabled or not supported - just connect
        this.leaseSupported = false;
        this.leaseHeld = true;
        if (skipLease) {
          logger.info('WhatsApp lease system disabled via SKIP_WHATSAPP_LEASE');
        }
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
      const shouldRefreshVersion =
        !this.waVersion || !this.waVersionFetchedAtMs || now - this.waVersionFetchedAtMs > versionTtlMs;

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

      const browser =
        Browsers?.windows?.('Chrome') || ['Windows', 'Chrome', '120.0.0'];
      const syncFullHistory = String(process.env.WHATSAPP_SYNC_FULL_HISTORY || 'true').toLowerCase() !== 'false';

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
        cachedGroupMetadata: async (jid: string) => this.groupMetadataCache.get(jid)
      };

      if (this.waVersion) {
        socketConfig.version = this.waVersion;
      }

      this.socket = makeWASocket(socketConfig);

      this.setupErrorHandlers();

      const socket = this.socket;
      if (!socket) {
        throw new Error('Failed to initialize socket');
      }

      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.qrCode = await qrcode.toDataURL(qr);
            this.status = 'qr';
            this.lastError = null;
            this.reconnectAttempts = 0;
            logger.info('QR code generated');
            await authStore.updateStatus('qr_ready', this.qrCode);
          } catch (e) {
            logger.error({ e }, 'Error generating QR code');
          }
        }

        if (connection === 'connecting') {
          this.status = 'connecting';
          logger.info('WhatsApp connecting...');
          await authStore.updateStatus('connecting');
        }

        if (connection === 'open') {
          this.isConnecting = false;
          this.status = 'connected';
          this.qrCode = null;
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
          void runTargetAutoSyncPass(this, { silent: true });
        }

        if (connection === 'close') {
          this.isConnecting = false;
          const disconnectError = lastDisconnect?.error as { output?: { statusCode?: number; payload?: { message?: string } }; message?: string } | undefined;
          const statusCode = disconnectError?.output?.statusCode;
          const rawReason = disconnectError?.output?.payload?.message || disconnectError?.message;
          const reason = redactSensitiveText(rawReason);
          this.status = 'disconnected';
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
            await authStore.updateStatus('connecting');
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

          await authStore.updateStatus('disconnected');

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

            this.recentMessageStatuses.set(String(id), snapshot);
            if (this.recentMessageStatuses.size > 1000) {
              const oldest = this.recentMessageStatuses.keys().next().value;
              if (oldest) {
                this.recentMessageStatuses.delete(oldest);
              }
            }
          }
        } catch (e) {
          logger.warn({ e }, 'Failed to process messages.update');
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

      // If it's a crypto/auth error, clear state and retry
      if (this.isAuthStateCorrupted(message)) {
        logger.warn('Auth state corrupted, clearing and retrying');
        await this.handleCorruptedAuthState(error);
      }
    }
  }

  getStatus(): {
    status: WhatsAppStatus;
    lastError: string | null;
    lastSeenAt: Date | null;
    hasQr: boolean;
    me: { jid: string | null; name: string | null };
    instanceId: string;
    sessionId: string;
    lease: { supported: boolean; held: boolean; ownerId: string | null; expiresAt: string | null };
  } {
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
      hasQr: Boolean(this.qrCode),
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
      const participants = Array.isArray(meta?.participants) ? meta.participants : [];
      const meJid = this.meJid || socket?.user?.id || null;
      const meRow = meJid ? participants.find((p: any) => p?.id === meJid) : null;
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
        me: { jid: meJid, isAdmin, admin: adminLevel }
      };
    } catch (error) {
      logger.warn({ jid, error: getErrorMessage(error) }, 'Failed to load group metadata');
      return null;
    }
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
      let handler: ((updates: any[]) => void) | null = null;
      let settled = false;

      const finish = (value: MessageStatusSnapshot | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (handler) {
          socket.ev.off('messages.update', handler);
        }
        resolve(value);
      };

      const timeout = setTimeout(() => finish(null), timeoutMs);

      handler = (updates: any[]) => {
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
          this.recentMessageStatuses.set(messageId, snapshot);
          finish(snapshot);
          return;
        }
      };

      socket.ev.on('messages.update', handler);

      // Avoid race: status may be cached between the first check and listener attach.
      const cachedAfter = this.recentMessageStatuses.get(messageId);
      if (cachedAfter && typeof cachedAfter.status === 'number' && cachedAfter.status >= minStatus) {
        finish(cachedAfter);
      }
    });
  }

  async confirmSend(
    messageId: string,
    options?: { upsertTimeoutMs?: number; ackTimeoutMs?: number }
  ): Promise<{ ok: boolean; via: 'upsert' | 'ack' | 'none'; status?: number | null; statusLabel?: string | null }> {
    const upsertTimeoutMs = Number(options?.upsertTimeoutMs ?? 5000);
    const ackTimeoutMs = Number(options?.ackTimeoutMs ?? 15000);

    try {
      const observed = await this.waitForMessage(messageId, upsertTimeoutMs);
      if (observed) {
        return { ok: true, via: 'upsert' };
      }
    } catch {
      // ignore
    }

    const minStatus = 0;
    const acked = await this.waitForMessageStatus(messageId, minStatus, ackTimeoutMs);
    if (acked) {
      return { ok: true, via: 'ack', status: acked.status, statusLabel: acked.statusLabel };
    }

    return { ok: false, via: 'none' };
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  async getGroups(): Promise<GroupSummary[]> {
    const socket = this.socket;
    const now = Date.now();
    const GROUP_CACHE_TTL_MS = 120000;

    if (this.groupsListCache.length && now - this.groupsListFetchedAtMs < GROUP_CACHE_TTL_MS) {
      return this.groupsListCache;
    }

    if (!socket) {
      if (this.groupsListCache.length) return this.groupsListCache;
      const fallbackFromMetadata = this.getGroupsFromMetadataCache();
      if (fallbackFromMetadata.length) return fallbackFromMetadata;
      return this.getGroupsFromChatStore();
    }

    if (this.groupsListFetchInFlight) {
      return this.groupsListFetchInFlight;
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
              const participants = Array.isArray((group as any).participants) ? (group as any).participants : [];
              const meRow = meJid
                ? participants.find((participant: any) => String(participant?.id || '') === String(meJid))
                : null;
              const adminRaw = meRow?.admin ? String(meRow.admin) : null;
              return {
                jid: meJid,
                isAdmin: Boolean(adminRaw),
                admin: adminRaw
              };
            })()
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        this.groupsListCache = normalized;
        this.groupsListFetchedAtMs = Date.now();
        return normalized;
      } catch (err) {
        const fallback = this.groupsListCache.length
          ? this.groupsListCache
          : (() => {
            const metadataFallback = this.getGroupsFromMetadataCache();
            if (metadataFallback.length) return metadataFallback;
            return this.getGroupsFromChatStore();
          })();
        if (this.isRateOverLimitError(err)) {
          logger.warn({ err, cachedCount: fallback.length }, 'WhatsApp group fetch rate-limited; using cached groups');
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
            ? participants.find((participant: any) => String(participant?.id || '') === String(meJid))
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
              jid: meJid,
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

  async sendMessage(jid: string, content: AnyMessageContent, options: Record<string, unknown> = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    try {
      const msg = await this.socket.sendMessage(jid, content, options);

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
      logger.error({ err, jid }, 'Failed to send message');
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAuthStateCorrupted(message)) {
        void this.handleCorruptedAuthState(err);
      }
      throw err;
    }
  }

  async sendStatusBroadcast(content: AnyMessageContent, options: Record<string, unknown> = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    try {
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
      }
      throw err;
    }
  }

  async editMessage(jid: string, messageId: string, text: string) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    const normalizedText = String(text || '').trim();
    if (!normalizedText) throw new Error('Updated message text is required');
    const normalizedJid = String(jid || '').trim();
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedJid || !normalizedMessageId) {
      throw new Error('jid and messageId are required to edit a message');
    }

    const key: proto.IMessageKey = {
      remoteJid: normalizedJid,
      id: normalizedMessageId,
      fromMe: true
    };

    try {
      return await this.socket.sendMessage(normalizedJid, {
        text: normalizedText,
        edit: key
      });
    } catch (err) {
      logger.error({ err, jid: normalizedJid, messageId: normalizedMessageId }, 'Failed to edit message');
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAuthStateCorrupted(message)) {
        void this.handleCorruptedAuthState(err);
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

  async disconnect(): Promise<void> {
    // Disconnect without logging out (keeps auth state so reconnect doesn't require QR)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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
    this.recentSentMessages.clear();
    this.recentMessageStatuses.clear();
    this.meJid = null;
    this.meName = null;

    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;
    this.lastSeenAt = null;

    if (this.authStore?.updateStatus) {
      await this.authStore.updateStatus('disconnected');
    }
  }

  async hardRefresh(): Promise<void> {
    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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
    this.meJid = null;
    this.meName = null;

    // Reset state
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;

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
    // Clears sender-key cache to fix group send issues without forcing re-login.
    if (this.authStore?.clearKeys) {
      await this.authStore.clearKeys(['sender-key']);
    }
    await this.disconnect();
    await this.connect();
  }
}

module.exports = () => new WhatsAppClient();
