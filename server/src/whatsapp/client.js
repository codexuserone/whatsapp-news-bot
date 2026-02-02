const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const useSupabaseAuthState = require('./authStore');
const { saveIncomingMessages } = require('../services/messageService');
const { sendPendingForAllSchedules } = require('../services/queueService');

class WhatsAppClient {
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
  }

  async init() {
    try {
      this.authStore = await useSupabaseAuthState('primary');
      await this.connect();
    } catch (error) {
      logger.error({ error }, 'Failed to initialize WhatsApp client');
      this.lastError = error.message;
      this.status = 'error';
    }
  }

  // Handle uncaught errors from the socket to prevent crashes
  setupErrorHandlers() {
    if (!this.socket) return;
    
    // Catch all unhandled errors on the socket
    this.socket.ev.on('error', (err) => {
      logger.error({ err }, 'WhatsApp socket error');
      this.lastError = err?.message || 'Socket error';
      if (this.isAuthStateCorrupted(err?.message)) {
        void this.handleCorruptedAuthState(err);
      }
    });

    // Handle process-level uncaught exceptions from crypto errors
    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', async (err) => {
      // Check if it's a crypto/auth error
      if (this.isAuthStateCorrupted(err?.message)) {
        await this.handleCorruptedAuthState(err);
      } else {
        // For other errors, log and exit
        logger.error({ err }, 'Uncaught exception');
        process.exit(1);
      }
    });

    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', async (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (this.isAuthStateCorrupted(message)) {
        await this.handleCorruptedAuthState(reason);
      } else {
        logger.error({ err: reason }, 'Unhandled promise rejection');
      }
    });
  }

  isAuthStateCorrupted(message) {
    if (!message) return false;
    const normalized = message.toLowerCase();
    const checks = [
      'authenticate data',
      'unsupported state',
      'crypto',
      'incorrect private key length',
      'bad decrypt',
      'invalid mac',
      'no session record',
      'no sender key record found for decryption',
      'no senderkeyrecord found for decryption',
      'failed to decrypt message',
    ];
    return checks.some((check) => normalized.includes(check.toLowerCase()));
  }

  async handleCorruptedAuthState(err) {
    if (this.isHandlingAuthCorruption) return;
    this.isHandlingAuthCorruption = true;
    try {
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
          this.socket.ev.removeAllListeners();
          this.socket.end();
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

  extractErrorMessage(args) {
    for (const arg of args) {
      if (!arg) continue;
      if (arg instanceof Error) return arg.message;
      if (arg.err?.message) return arg.err.message;
      if (arg.error?.message) return arg.error.message;
      if (arg.trace && typeof arg.trace === 'string') return arg.trace;
    }
    return null;
  }

  extractLogMessage(args) {
    const last = args[args.length - 1];
    return typeof last === 'string' ? last : null;
  }

  createBaileysLogger() {
    const baseLogger = logger.child({ class: 'baileys' });
    const baileysLogger = Object.create(baseLogger);
    const handleArgs = (args) => {
      const message = this.extractLogMessage(args);
      const errorMessage = this.extractErrorMessage(args);
      if (this.isAuthStateCorrupted(message) || this.isAuthStateCorrupted(errorMessage)) {
        void this.handleCorruptedAuthState(
          errorMessage ? new Error(errorMessage) : new Error(message || 'Auth error')
        );
      }
    };
    baileysLogger.error = (...args) => {
      baseLogger.error(...args);
      handleArgs(args);
    };
    baileysLogger.warn = (...args) => {
      baseLogger.warn(...args);
      handleArgs(args);
    };
    return baileysLogger;
  }

  scheduleReconnect(delay) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  async connect() {
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
          this.socket.ev.removeAllListeners();
          this.socket.end();
        } catch (e) {
          // Ignore cleanup errors
        }
        this.socket = null;
      }

      const { state, saveCreds } = this.authStore;
      
      let version;
      try {
        const versionResult = await fetchLatestBaileysVersion();
        version = versionResult.version;
      } catch (e) {
        logger.warn('Could not fetch latest Baileys version, using default');
        version = [2, 2413, 1];
      }

      this.socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        browser: ['WhatsApp News Bot', 'Chrome', '120.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        retryRequestDelayMs: 500,
        logger: this.createBaileysLogger()
      });
      
      this.setupErrorHandlers();

      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          try {
            this.qrCode = await qrcode.toDataURL(qr);
            this.status = 'qr';
            this.lastError = null;
            this.reconnectAttempts = 0;
            logger.info('QR code generated');
            if (this.authStore.updateStatus) {
              await this.authStore.updateStatus('qr_ready', this.qrCode);
            }
          } catch (e) {
            logger.error({ e }, 'Error generating QR code');
          }
        }

        if (connection === 'connecting') {
          this.status = 'connecting';
          logger.info('WhatsApp connecting...');
          if (this.authStore.updateStatus) {
            await this.authStore.updateStatus('connecting');
          }
        }

        if (connection === 'open') {
          this.isConnecting = false;
          this.status = 'connected';
          this.qrCode = null;
          this.lastError = null;
          this.lastSeenAt = new Date();
          this.reconnectAttempts = 0;
          this.isAuthCorrupted = false;
          logger.info('WhatsApp connected successfully');
          if (this.authStore.updateStatus) {
            await this.authStore.updateStatus('connected', null);
          }
          try {
            await sendPendingForAllSchedules(this);
          } catch (error) {
            logger.error({ error }, 'Failed to send pending schedules after connect');
          }
        }

        if (connection === 'close') {
          this.isConnecting = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.output?.payload?.message || lastDisconnect?.error?.message;
          this.status = 'disconnected';
          if (reason?.includes('QR refs attempts ended')) {
            this.lastError = 'QR expired. Click Hard Refresh to generate a new QR code.';
          } else {
            this.lastError = reason || 'Connection closed';
          }
          
          logger.warn({ statusCode, reason }, 'WhatsApp connection closed');

          // Handle specific disconnect reasons
          if (statusCode === DisconnectReason.loggedOut) {
            logger.info('Logged out, clearing credentials');
            await this.authStore.clearState();
            this.reconnectAttempts = 0;
            // Schedule reconnect to get new QR
            this.scheduleReconnect(2000);
            return;
          }

          // Connection conflict - another device logged in
          if (statusCode === 440 || reason?.includes('conflict')) {
            logger.warn('Connection conflict detected - another session is active');
            this.lastError = 'Another session is active. Please close other WhatsApp Web sessions or click Hard Refresh.';
            // Don't auto-reconnect on conflict - let user decide
            if (this.authStore.updateStatus) {
              await this.authStore.updateStatus('conflict');
            }
            return;
          }

          if (this.authStore.updateStatus) {
            await this.authStore.updateStatus('disconnected');
          }

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

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('messages.upsert', async ({ type, messages }) => {
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
      this.lastError = error.message;
      this.status = 'error';
      
      // If it's a crypto/auth error, clear state and retry
      if (this.isAuthStateCorrupted(error.message)) {
        logger.warn('Auth state corrupted, clearing and retrying');
        await this.handleCorruptedAuthState(error);
      }
    }
  }

  getStatus() {
    return {
      status: this.status,
      lastError: this.lastError,
      lastSeenAt: this.lastSeenAt,
      hasQr: Boolean(this.qrCode)
    };
  }

  getQrCode() {
    return this.qrCode;
  }

  async getGroups() {
    if (!this.socket) return [];
    try {
      const groups = await this.socket.groupFetchAllParticipating();
      return Object.values(groups || {}).map((group) => ({
        id: group.id,
        jid: group.id,
        name: group.subject || group.name || group.id,
        size: group.size || 0
      }));
    } catch (err) {
      logger.error({ err }, 'Failed to fetch groups');
      return [];
    }
  }

  async getChannels() {
    if (!this.socket) return [];
    try {
      const newsletters = await this.socket.newsletterSubscribe?.() || [];
      const subscribed = await this.socket.newsletterGetSubscribed?.() || [];
      return subscribed.map((channel) => ({
        id: channel.id,
        jid: channel.id,
        name: channel.name || channel.id,
        subscribers: channel.subscribers || 0
      }));
    } catch (err) {
      logger.warn({ err }, 'Channels not supported or failed to fetch');
      return [];
    }
  }

  async sendMessage(jid, content, options = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    try {
      const msg = await this.socket.sendMessage(jid, content, options);
      return msg;
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send message');
      throw err;
    }
  }

  async sendStatusBroadcast(content, options = {}) {
    if (!this.socket) throw new Error('WhatsApp not connected');
    if (this.isAuthCorrupted) throw new Error('Session corrupted. Please scan QR code again.');
    try {
      const msg = await this.socket.sendMessage('status@broadcast', content, options);
      return msg;
    } catch (err) {
      logger.error({ err }, 'Failed to send status broadcast');
      throw err;
    }
  }

  getSocket() {
    return this.socket;
  }

  async waitForMessage(messageId, timeoutMs = 30000) {
    if (!this.socket) return null;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), timeoutMs);
      const handler = ({ messages }) => {
        const found = messages.find((m) => m.key.id === messageId);
        if (found) {
          clearTimeout(timeout);
          this.socket.ev.off('messages.update', handler);
          resolve(found);
        }
      };
      this.socket.ev.on('messages.update', handler);
    });
  }

  async disconnect() {
    if (this.socket) {
      await this.socket.logout();
      this.socket = null;
      this.status = 'disconnected';
      this.qrCode = null;
    }
  }

  async hardRefresh() {
    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Cleanup existing socket
    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners();
        this.socket.end();
      } catch (e) {
        // Ignore cleanup errors
      }
      this.socket = null;
    }
    
    // Reset state
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;
    
    // Clear auth state to force new QR
    await this.authStore.clearState();
    
    // Reconnect
    await this.connect();
  }
}

module.exports = () => new WhatsAppClient();
