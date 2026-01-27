const {
  fetchLatestBaileysVersion,
  makeWASocket,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const logger = require('../utils/logger');
const useMongoAuthState = require('./authStore');
const { saveIncomingMessages } = require('../services/messageService');

class WhatsAppClient {
  constructor() {
    this.socket = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastError = null;
    this.lastSeenAt = null;
    this.authStore = null;
  }

  async init() {
    this.authStore = await useMongoAuthState('primary');
    await this.connect();
  }

  async connect() {
    const { state, saveCreds } = this.authStore;
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qrCode = await qrcode.toDataURL(qr);
        this.status = 'qr';
        this.lastError = null;
      }

      if (connection === 'connecting') {
        this.status = 'connecting';
      }

      if (connection === 'open') {
        this.status = 'connected';
        this.qrCode = null;
        this.lastError = null;
        this.lastSeenAt = new Date();
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        this.status = 'disconnected';
        this.lastError = lastDisconnect?.error?.message || null;

        if (reason === DisconnectReason.loggedOut) {
          await this.authStore.clearState();
        }

        logger.warn({ reason }, 'WhatsApp connection closed');
        await this.connect();
      }
    });

    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('messages.upsert', async ({ type, messages }) => {
      if (type !== 'notify') {
        return;
      }
      await saveIncomingMessages(messages);
    });
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
