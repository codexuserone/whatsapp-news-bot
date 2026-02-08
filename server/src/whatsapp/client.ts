import type { AnyMessageContent, WASocket, proto } from '@whiskeysockets/baileys';
import { randomUUID } from 'crypto';

const { loadBaileys } = require('./baileys');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const withTimeout = require('../utils/withTimeout');
const { getErrorMessage } = require('../utils/errorUtils');
const useSupabaseAuthState = require('./authStore');
const { saveIncomingMessages, classifyAckStatus, persistOutgoingStatusByMessageId } = require('../services/messageService');
const { sendPendingForAllSchedules } = require('../services/queueService');
const { dispatchImmediateSchedules } = require('../services/schedulerService');

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
  viewerRole?: string | null;
  canSend?: boolean | null;
};

type ChannelInfo = ChannelSummary & {
  viewerRole: string | null;
  canSend: boolean | null;
};

type ChannelDiagnostics = {
  methodsTried: string[];
  methodErrors: string[];
  sourceCounts: {
    api: number;
    cache: number;
    metadata: number;
  };
  limitation: string | null;
};

type CachedNewsletterChat = {
  jid: string;
  name: string;
  subscribers: number;
  viewerRole?: string | null;
  canSend?: boolean | null;
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

const normalizeNewsletterJid = (value: unknown, options?: { allowNumeric?: boolean }) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('whatsapp.com/channel/')) return '';
  if (lower.endsWith('@newsletter')) return lower;
  if (raw.includes('@')) return '';
  if (/^[a-z0-9]{10,}$/i.test(raw) && /[a-z]/i.test(raw)) return '';
  if (!options?.allowNumeric) return '';
  const numericLike = raw.replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(numericLike)) return '';
  return `${numericLike}@newsletter`;
};

const extractNewsletterInviteCode = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().includes('@newsletter')) return '';

  const directUrlMatch = raw.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
  if (directUrlMatch?.[1]) {
    return String(directUrlMatch[1] || '').trim();
  }

  if ((raw.startsWith('http://') || raw.startsWith('https://')) && raw.includes('/channel/')) {
    try {
      const parsed = new URL(raw);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const channelIndex = pathParts.findIndex((part) => part.toLowerCase() === 'channel');
      if (channelIndex >= 0) {
        const candidate = String(pathParts[channelIndex + 1] || '').trim();
        if (/^[A-Za-z0-9]{10,}$/.test(candidate)) return candidate;
      }
    } catch {
      // ignore invalid URL
    }
  }

  if (/^[A-Za-z0-9]{10,}$/.test(raw) && /[A-Za-z]/.test(raw)) {
    return raw;
  }

  return '';
};

const readNumericValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readTextValue = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim();
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

  const name =
    readTextValue(record.name) ||
    readTextValue(record.subject) ||
    readTextValue(threadName?.text) ||
    readTextValue(threadMetadata?.name) ||
    jid;

  const subscribers =
    readNumericValue(record.subscribers) ||
    readNumericValue(record.subscribers_count) ||
    readNumericValue(threadMetadata?.subscribers_count);

  const viewerRole = extractChannelViewerRole(record);
  const canSend = inferChannelCanSend(viewerRole);

  return {
    id: jid,
    jid,
    name,
    subscribers,
    viewerRole,
    canSend
  };
};

const extractChannelArray = (input: unknown): unknown[] => {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return [];

  const record = input as Record<string, unknown>;
  const directKeys = ['channels', 'newsletters', 'items', 'data'];
  for (const key of directKeys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }

  const result = record.result;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const resultRecord = result as Record<string, unknown>;
    for (const key of directKeys) {
      const value = resultRecord[key];
      if (Array.isArray(value)) return value;
    }
    const maybeSingle = extractChannelSummary(resultRecord, { allowNumeric: true });
    if (maybeSingle) return [resultRecord];
  }

  const maybeSingle = extractChannelSummary(record, { allowNumeric: true });
  return maybeSingle ? [record] : [];
};

const extractChannelViewerRole = (metadataLike: unknown) => {
  if (!metadataLike || typeof metadataLike !== 'object') return null;

  const metadata = metadataLike as Record<string, unknown>;
  const viewerMetadata =
    (metadata.viewer_metadata && typeof metadata.viewer_metadata === 'object'
      ? (metadata.viewer_metadata as Record<string, unknown>)
      : null) ||
    (metadata.viewerMetadata && typeof metadata.viewerMetadata === 'object'
      ? (metadata.viewerMetadata as Record<string, unknown>)
      : null);

  const roleCandidates = [
    viewerMetadata?.role,
    viewerMetadata?.type,
    metadata.viewer_role,
    metadata.role,
    metadata.participant_role,
    metadata.participantRole
  ];

  for (const candidate of roleCandidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }

  return null;
};

const inferChannelCanSend = (viewerRole: string | null) => {
  if (!viewerRole) return null;

  const normalized = String(viewerRole).trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized.includes('owner') ||
    normalized.includes('admin') ||
    normalized.includes('editor') ||
    normalized.includes('write')
  ) {
    return true;
  }

  if (
    normalized.includes('subscriber') ||
    normalized.includes('viewer') ||
    normalized.includes('read') ||
    normalized.includes('follower')
  ) {
    return false;
  }

  return null;
};

class WhatsAppClient {
  socket: WASocket | null;
  status: WhatsAppStatus;
  qrCode: string | null;
  lastError: string | null;
  lastSeenAt: Date | null;
  instanceId: string;
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
  processErrorHandlersBound: boolean;
  waVersion: number[] | null;
  waVersionFetchedAtMs: number | null;
  recentSentMessages: Map<string, proto.IWebMessageInfo>;
  recentMessageStatuses: Map<string, MessageStatusSnapshot>;
  newsletterChatCache: Map<string, CachedNewsletterChat>;
  meJid: string | null;
  meName: string | null;

  constructor() {
    this.socket = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;
    this.lastSeenAt = null;
    this.instanceId = randomUUID();
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
    this.processErrorHandlersBound = false;
    this.waVersion = null;
    this.waVersionFetchedAtMs = null;
    this.recentSentMessages = new Map();
    this.recentMessageStatuses = new Map();
    this.newsletterChatCache = new Map();
    this.meJid = null;
    this.meName = null;
  }

  async init(): Promise<void> {
    try {
      this.authStore = await useSupabaseAuthState('primary');
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
      baseLogger.error(...args);
      handleArgs(args);
    };
    baileysLogger.warn = (...args: unknown[]) => {
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
      const skipLease = process.env.SKIP_WHATSAPP_LEASE === 'true';
      const allowAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER === 'true';
      if (!skipLease && authStore.acquireLease) {
        try {
          const lease = await authStore.acquireLease(this.instanceId, 90_000);
          this.leaseSupported = lease.supported;
          this.leaseHeld = lease.ok;
          this.leaseOwnerId = lease.ownerId;
          this.leaseExpiresAt = lease.expiresAt;

          if (lease.supported && !lease.ok) {
            if (allowAutoTakeover && authStore.forceAcquireLease) {
              logger.warn({ holder: lease.ownerId }, 'Lease held; attempting auto-takeover');
              try {
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
                  this.scheduleReconnect(15000 + Math.random() * 5000);
                  return;
                }
              } catch (error) {
                logger.warn({ error }, 'Auto-takeover failed; skipping connect until lease is available');
                this.status = 'conflict';
                this.lastError = 'Failed to acquire WhatsApp lease.';
                await authStore.updateStatus('conflict');
                this.scheduleReconnect(15000 + Math.random() * 5000);
                return;
              }
            } else {
              logger.warn({ holder: lease.ownerId }, 'Lease held by another instance; skipping connect');
              this.status = 'conflict';
              this.lastError = 'Another instance currently holds the WhatsApp lease.';
              await authStore.updateStatus('conflict');
              this.scheduleReconnect(15000 + Math.random() * 5000);
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
      const syncFullHistory = process.env.WHATSAPP_SYNC_FULL_HISTORY !== 'false';
      const browserForSync =
        syncFullHistory && Browsers?.macOS
          ? Browsers.macOS('Desktop')
          : browser;

      const socketConfig: Record<string, unknown> = {
        auth: state,
        printQRInTerminal: false,
        syncFullHistory,
        markOnlineOnConnect: false,
        emitOwnEvents: true,
        browser: browserForSync,
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
            await sendPendingForAllSchedules(this);
          } catch (error) {
            logger.error({ error }, 'Failed to send pending schedules after connect');
          }
          try {
            await dispatchImmediateSchedules(this, {
              skipFeedRefresh: true,
              reason: 'whatsapp_reconnect'
            });
          } catch (error) {
            logger.error({ error }, 'Failed to run immediate schedule catch-up after connect');
          }
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
            logger.info({ delay: Math.round(delay/1000) }, 'Scheduling reconnect with jitter');
            this.scheduleReconnect(delay);
            return;
          }

          await authStore.updateStatus('disconnected');

          // Auto-reconnect with exponential backoff (never gives up entirely).
          this.reconnectAttempts += 1;
          const exponent = Math.min(this.reconnectAttempts, 6);
          const delay = Math.min(2000 * Math.pow(2, exponent), 60000);
          if (this.reconnectAttempts > this.maxReconnectAttempts) {
            this.lastError = `Connection unstable. Auto-retrying in ${Math.round(delay / 1000)}s.`;
            logger.warn({ attempt: this.reconnectAttempts, delay }, 'Reconnect attempts exceeded threshold; continuing retries');
          } else {
            logger.info({ attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
          }
          this.scheduleReconnect(delay);
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

            const statusLabel = classifyAckStatus(status)?.statusLabel || null;
            const remoteJid = entry?.key?.remoteJid ? String(entry.key.remoteJid) : null;
            const snapshot: MessageStatusSnapshot = {
              status,
              statusLabel,
              remoteJid,
              updatedAtMs: Date.now()
            };

            this.recentMessageStatuses.set(String(id), snapshot);
            if (this.recentMessageStatuses.size > 1000) {
              const oldest = this.recentMessageStatuses.keys().next().value;
              if (oldest) {
                this.recentMessageStatuses.delete(oldest);
              }
            }

            void persistOutgoingStatusByMessageId(String(id), status, remoteJid).catch((error: unknown) => {
              logger.warn({ error, messageId: id, status }, 'Failed to persist outgoing message ack status');
            });
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
    lease: { supported: boolean; held: boolean; ownerId: string | null; expiresAt: string | null };
  } {
    return {
      status: this.status,
      lastError: this.lastError,
      lastSeenAt: this.lastSeenAt,
      hasQr: Boolean(this.qrCode),
      me: { jid: this.meJid, name: this.meName },
      instanceId: this.instanceId,
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

          const statusLabel = classifyAckStatus(status)?.statusLabel || null;
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

  async reconnect(): Promise<void> {
    if (this.isConnecting) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.lastError = null;
    this.status = 'connecting';

    if (this.authStore?.updateStatus) {
      await this.authStore.updateStatus('connecting');
    }

    this.scheduleReconnect(100);
  }

  async getGroups(): Promise<Array<{ id: string; jid: string; name: string; size: number }>> {
    const socket = this.socket;
    if (!socket) return [];
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
      return Object.values(groups || {}).map((group) => ({
        id: group.id,
        jid: group.id,
        name: group.subject || group.id,
        size: group.size || 0
      }));
    } catch (err) {
      logger.error({ err }, 'Failed to fetch groups');
      return [];
    }
  }

  cacheNewsletterChat(chatLike: unknown): void {
    const channel = extractChannelSummary(chatLike, { allowNumeric: false });
    if (!channel) return;
    const existing = this.newsletterChatCache.get(channel.jid);
    const subscribers = channel.subscribers || existing?.subscribers || 0;
    const name = channel.name || existing?.name || channel.jid;
    const viewerRole = channel.viewerRole || existing?.viewerRole || null;
    const canSend = typeof channel.canSend === 'boolean' ? channel.canSend : existing?.canSend ?? null;
    this.newsletterChatCache.set(channel.jid, {
      jid: channel.jid,
      name,
      subscribers,
      viewerRole,
      canSend,
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

  removeNewsletterChats(jidsLike: unknown): void {
    const list = Array.isArray(jidsLike) ? jidsLike : [];
    for (const jidValue of list) {
      const jid = normalizeNewsletterJid(jidValue, { allowNumeric: false });
      if (!jid) continue;
      this.newsletterChatCache.delete(jid);
    }
  }

  async getChannelsWithDiagnostics(): Promise<{ channels: ChannelSummary[]; diagnostics: ChannelDiagnostics }> {
    const socket = this.socket as any;
    const diagnostics: ChannelDiagnostics = {
      methodsTried: [],
      methodErrors: [],
      sourceCounts: { api: 0, cache: 0, metadata: 0 },
      limitation: null
    };

    if (!socket) {
      diagnostics.limitation = 'WhatsApp is not connected.';
      return { channels: [], diagnostics };
    }

    const channelMap = new Map<string, ChannelSummary>();
    const mergeChannel = (candidate: ChannelSummary, source: 'api' | 'cache' | 'metadata') => {
      const existing = channelMap.get(candidate.jid);
      const merged: ChannelSummary = {
        id: candidate.jid,
        jid: candidate.jid,
        name: candidate.name || existing?.name || candidate.jid,
        subscribers: candidate.subscribers || existing?.subscribers || 0,
        viewerRole: candidate.viewerRole || existing?.viewerRole || null,
        canSend:
          typeof candidate.canSend === 'boolean'
            ? candidate.canSend
            : typeof existing?.canSend === 'boolean'
              ? existing.canSend
              : null
      };
      channelMap.set(candidate.jid, merged);
      diagnostics.sourceCounts[source] += 1;
    };

    const methodCandidates = [
      'newsletterGetSubscribed',
      'newsletterList',
      'newsletterGetAdmin',
      'newsletterGetOwned',
      'newsletterGetAll'
    ];

    for (const methodName of methodCandidates) {
      const method = socket?.[methodName];
      if (typeof method !== 'function') {
        diagnostics.methodsTried.push(`${methodName}:missing`);
        continue;
      }

      diagnostics.methodsTried.push(`${methodName}:called`);
      try {
        const result = await method.call(socket);
        const entries = extractChannelArray(result);
        for (const entry of entries) {
          const normalized = extractChannelSummary(entry, { allowNumeric: true });
          if (!normalized) continue;
          mergeChannel(normalized, 'api');
          this.cacheNewsletterChat(normalized);
        }
      } catch (error) {
        diagnostics.methodErrors.push(`${methodName}: ${getErrorMessage(error)}`);
      }
    }

    for (const cached of this.newsletterChatCache.values()) {
      mergeChannel(
        {
          id: cached.jid,
          jid: cached.jid,
          name: cached.name || cached.jid,
          subscribers: cached.subscribers || 0,
          viewerRole: cached.viewerRole || null,
          canSend: typeof cached.canSend === 'boolean' ? cached.canSend : null
        },
        'cache'
      );
    }

    if (typeof socket.newsletterMetadata === 'function' && channelMap.size > 0) {
      const toEnrich = Array.from(channelMap.values())
        .filter((channel) => channel.name === channel.jid || channel.subscribers <= 0)
        .slice(0, 50);

      for (const channel of toEnrich) {
        try {
          const metadata = await socket.newsletterMetadata('jid', channel.jid);
          const normalized = extractChannelSummary(metadata, { allowNumeric: true });
          if (!normalized) continue;
          normalized.viewerRole = extractChannelViewerRole(metadata);
          normalized.canSend = inferChannelCanSend(normalized.viewerRole || null);
          mergeChannel(normalized, 'metadata');
          this.cacheNewsletterChat(normalized);
        } catch {
          // Metadata fetch is best-effort only.
        }
      }
    }

    const channels = Array.from(channelMap.values()).sort((a, b) => a.name.localeCompare(b.name));

    if (!channels.length) {
      const hasListingMethod = methodCandidates.some((name) => typeof socket?.[name] === 'function');
      diagnostics.limitation = hasListingMethod
        ? 'WhatsApp returned no discoverable channels for this session. Open the channel in your phone app, then refresh.'
        : 'Current Baileys build does not expose a channel list API. This app can only discover channels that appear in chat history.';
    }

    return { channels, diagnostics };
  }

  async getChannels(): Promise<Array<{ id: string; jid: string; name: string; subscribers: number }>> {
    const result = await this.getChannelsWithDiagnostics();
    return result.channels;
  }

  async resolveChannel(channelLike: unknown): Promise<ChannelSummary | null> {
    const socket = this.socket as any;
    if (!socket) return null;

    const jid = normalizeNewsletterJid(channelLike, { allowNumeric: true });
    const inviteCode = extractNewsletterInviteCode(channelLike);
    if (!jid && !inviteCode) return null;

    const cached = jid ? this.newsletterChatCache.get(jid) : null;
    if (cached && jid) {
      return {
        id: jid,
        jid,
        name: cached.name || jid,
        subscribers: cached.subscribers || 0,
        viewerRole: cached.viewerRole || null,
        canSend: typeof cached.canSend === 'boolean' ? cached.canSend : null
      };
    }

    if (typeof socket.newsletterMetadata === 'function') {
      const metadataLookups: Array<{ type: 'jid' | 'invite'; key: string }> = [];
      if (jid) metadataLookups.push({ type: 'jid', key: jid });
      if (inviteCode) metadataLookups.push({ type: 'invite', key: inviteCode });

      for (const lookup of metadataLookups) {
        try {
          const metadata = await socket.newsletterMetadata(lookup.type, lookup.key);
          const normalized = extractChannelSummary(metadata, { allowNumeric: true });
          if (!normalized) continue;
          normalized.viewerRole = extractChannelViewerRole(metadata);
          normalized.canSend = inferChannelCanSend(normalized.viewerRole || null);
          this.cacheNewsletterChat(normalized);
          return normalized;
        } catch (error) {
          logger.warn(
            { lookupType: lookup.type, lookupKey: lookup.key, error: getErrorMessage(error) },
            'Failed to resolve channel metadata'
          );
        }
      }
    }

    const discovered = await this.getChannelsWithDiagnostics();
    const match = discovered.channels.find((channel) => (jid ? channel.jid === jid : false));
    return match || null;
  }

  async getChannelInfo(channelLike: unknown): Promise<ChannelInfo | null> {
    const socket = this.socket as any;
    if (!socket) return null;

    const channel = await this.resolveChannel(channelLike);
    if (!channel) return null;

    let viewerRole: string | null = null;
    let canSend: boolean | null = null;

    if (typeof socket.newsletterMetadata === 'function') {
      try {
        const metadata = await socket.newsletterMetadata('jid', channel.jid);
        const normalized = extractChannelSummary(metadata, { allowNumeric: true });
        if (normalized) {
          this.cacheNewsletterChat(normalized);
          channel.name = normalized.name || channel.name;
          channel.subscribers = Math.max(channel.subscribers || 0, normalized.subscribers || 0);
        }

        viewerRole = extractChannelViewerRole(metadata);
        canSend = inferChannelCanSend(viewerRole);
      } catch (error) {
        logger.warn({ jid: channel.jid, error: getErrorMessage(error) }, 'Failed to load channel info metadata');
      }
    }

    return {
      id: channel.jid,
      jid: channel.jid,
      name: channel.name || channel.jid,
      subscribers: channel.subscribers || 0,
      viewerRole,
      canSend
    };
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
