import type { AnyMessageContent, WASocket, proto } from '@whiskeysockets/baileys';

const { loadBaileys } = require('./baileys');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const useSupabaseAuthState = require('./authStore');
const { saveIncomingMessages } = require('../services/messageService');
const { sendPendingForAllSchedules } = require('../services/queueService');

type WhatsAppStatus = 'disconnected' | 'connecting' | 'connected' | 'qr' | 'error';

class WhatsAppClient {
  socket: WASocket | null;
  status: WhatsAppStatus;
  qrCode: string | null;
  lastError: string | null;
  lastSeenAt: Date | null;
  authStore: {
    state: { creds: Record<string, unknown>; keys: { get: (type: string, ids: string[]) => Promise<Record<string, unknown>>; set: (data: Record<string, Record<string, unknown>>) => Promise<void> } };
    saveCreds: () => Promise<void>;
    clearState: () => Promise<void>;
    clearKeys?: (types?: string[]) => Promise<void>;
    updateStatus: (status: string, qrCode?: string | null) => Promise<void>;
  } | null;
  reconnectAttempts: number;
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

  constructor() {
    this.socket = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;
    this.lastSeenAt = null;
    this.authStore = null;
    this.reconnectAttempts = 0;
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

      const socketConfig: Record<string, unknown> = {
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
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
          this.isAuthCorrupted = false;
          this.lastSenderKeyResetAt = null;
          this.lastKeyCacheResetAt = null;
          logger.info('WhatsApp connected successfully');
          await authStore.updateStatus('connected', null);
          try {
            await sendPendingForAllSchedules(this);
          } catch (error) {
            logger.error({ error }, 'Failed to send pending schedules after connect');
          }
        }

        if (connection === 'close') {
          this.isConnecting = false;
          const disconnectError = lastDisconnect?.error as { output?: { statusCode?: number; payload?: { message?: string } }; message?: string } | undefined;
          const statusCode = disconnectError?.output?.statusCode;
          const reason = disconnectError?.output?.payload?.message || disconnectError?.message;
          this.status = 'disconnected';
          if (reason?.includes('QR refs attempts ended')) {
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

          if (statusCode === DisconnectReason.restartRequired || reason?.includes('restart required')) {
            logger.info('Restart required, reconnecting');
            this.lastError = null;
            this.status = 'connecting';
            await authStore.updateStatus('connecting');
            this.scheduleReconnect(2000);
            return;
          }

          // Connection conflict - another device logged in
          if (statusCode === 440 || reason?.includes('conflict')) {
            logger.warn('Connection conflict detected - another session is active');
            this.lastError = 'Another session is active. Please close other WhatsApp Web sessions or click Hard Refresh.';
            // Don't auto-reconnect on conflict - let user decide
            await authStore.updateStatus('conflict');
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
        if (type !== 'notify') return;
        try {
          await saveIncomingMessages(messages);
        } catch (e) {
          logger.error({ e }, 'Error saving incoming messages');
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

  getStatus(): { status: WhatsAppStatus; lastError: string | null; lastSeenAt: Date | null; hasQr: boolean } {
    return {
      status: this.status,
      lastError: this.lastError,
      lastSeenAt: this.lastSeenAt,
      hasQr: Boolean(this.qrCode)
    };
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  async getGroups(): Promise<Array<{ id: string; jid: string; name: string; size: number }>> {
    const socket = this.socket;
    if (!socket) return [];
    try {
      const groups = await socket.groupFetchAllParticipating();
      Object.values(groups || {}).forEach((group: { id?: string }) => {
        if (group?.id) {
          this.groupMetadataCache.set(group.id, group);
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

  async getChannels(): Promise<Array<{ id: string; jid: string; name: string; subscribers: number }>> {
    const socket = this.socket as any;
    if (!socket) return [];
    try {
      const subscribed = await socket.newsletterGetSubscribed?.() || [];
      return (subscribed || []).map((channel: { id?: string; name?: string; subscribers?: number }) => ({
        id: channel.id || '',
        jid: channel.id || '',
        name: channel.name || channel.id || '',
        subscribers: channel.subscribers || 0
      }));
    } catch (err) {
      logger.warn({ err }, 'Channels not supported or failed to fetch');
      return [];
    }
  }

  async sendMessage(jid: string, content: AnyMessageContent, options: Record<string, unknown> = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    try {
      const msg = await this.socket.sendMessage(jid, content, options);
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
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), timeoutMs);
      const handler = ({ messages }: { messages: proto.IWebMessageInfo[] }) => {
        const found = messages.find((m) => m.key?.id === messageId);
        if (found) {
          clearTimeout(timeout);
          socket.ev.off('messages.upsert', handler);
          resolve(found);
        }
      };
      socket.ev.on('messages.upsert', handler);
    });
  }

  async disconnect(): Promise<void> {
    // Disconnect without logging out (keeps auth state so reconnect doesn't require QR)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    
    // Reset state
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;
    
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
