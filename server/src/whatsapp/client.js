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

  async connect() {
    try {
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
        keepAliveIntervalMs: 30000
      });

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
          this.status = 'connected';
          this.qrCode = null;
          this.lastError = null;
          this.lastSeenAt = new Date();
          this.reconnectAttempts = 0;
          logger.info('WhatsApp connected successfully');
          if (this.authStore.updateStatus) {
            await this.authStore.updateStatus('connected', null);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.output?.payload?.message || lastDisconnect?.error?.message;
          this.status = 'disconnected';
          this.lastError = reason || 'Connection closed';
          
          logger.warn({ statusCode, reason }, 'WhatsApp connection closed');

          if (statusCode === DisconnectReason.loggedOut) {
            logger.info('Logged out, clearing credentials');
            await this.authStore.clearState();
            this.reconnectAttempts = 0;
          }

          if (this.authStore.updateStatus) {
            await this.authStore.updateStatus('disconnected');
          }

          // Auto-reconnect with exponential backoff
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
            logger.info({ attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
            setTimeout(() => this.connect(), delay);
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
      logger.error({ error }, 'Error connecting to WhatsApp');
      this.lastError = error.message;
      this.status = 'error';
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
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    await this.authStore.clearState();
    this.status = 'disconnected';
    this.qrCode = null;
    await this.connect();
  }
}

module.exports = () => new WhatsAppClient();
