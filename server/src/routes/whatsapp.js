const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const withTimeout = require('../utils/withTimeout');

const DEFAULT_SEND_TIMEOUT_MS = 15000;

const whatsappRoutes = () => {
  const router = express.Router();

  router.get('/status', (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      res.json(whatsapp?.getStatus() || { status: 'disconnected' });
    } catch (error) {
      console.error('Error getting WhatsApp status:', error);
      res.json({ status: 'error', error: error.message });
    }
  });

  router.get('/qr', (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      res.json({ qr: whatsapp?.getQrCode() || null });
    } catch (error) {
      console.error('Error getting QR code:', error);
      res.json({ qr: null });
    }
  });

  router.get('/groups', async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const groups = await whatsapp?.getGroups() || [];
      res.json(groups);
    } catch (error) {
      console.error('Error fetching groups:', error);
      res.json([]);
    }
  });

  router.get('/channels', async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const channels = await whatsapp?.getChannels() || [];
      res.json(channels);
    } catch (error) {
      console.error('Error fetching channels:', error);
      res.json([]);
    }
  });

  router.post('/disconnect', async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      await whatsapp?.disconnect();
      res.json({ ok: true });
    } catch (error) {
      console.error('Error disconnecting:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/hard-refresh', async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      await whatsapp?.hardRefresh();
      res.json({ ok: true });
    } catch (error) {
      console.error('Error hard refreshing:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  const normalizeTestJid = (jid) => {
    if (jid.includes('@')) return jid;
    return `${jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  };

  const isStatusBroadcast = (jid) => jid === 'status@broadcast';

  // Send a test message
  router.post('/send-test', validate(schemas.testMessage), async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const { jid, message } = req.body;
      
      if (!jid || !message) {
        return res.status(400).json({ ok: false, error: 'jid and message are required' });
      }

      if (whatsapp?.getStatus()?.status !== 'connected') {
        return res.status(400).json({ ok: false, error: 'WhatsApp is not connected' });
      }

      const normalizedJid = normalizeTestJid(jid);
      const sendPromise = isStatusBroadcast(normalizedJid)
        ? whatsapp.sendStatusBroadcast({ text: message })
        : whatsapp.sendMessage(normalizedJid, { text: message });
      const result = await withTimeout(
        sendPromise,
        DEFAULT_SEND_TIMEOUT_MS,
        'Timed out sending test message'
      );
      res.json({ ok: true, messageId: result?.key?.id });
    } catch (error) {
      console.error('Error sending test message:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Send to status broadcast
  router.post('/send-status', validate(schemas.statusMessage), async (req, res) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const { message, imageUrl } = req.body;
      
      if (!message && !imageUrl) {
        return res.status(400).json({ ok: false, error: 'message or imageUrl is required' });
      }

      if (whatsapp?.getStatus()?.status !== 'connected') {
        return res.status(400).json({ ok: false, error: 'WhatsApp is not connected' });
      }

      let content;
      if (imageUrl) {
        content = { image: { url: imageUrl }, caption: message || '' };
      } else {
        content = { text: message };
      }

      const result = await whatsapp.sendStatusBroadcast(content);
      res.json({ ok: true, messageId: result?.key?.id });
    } catch (error) {
      console.error('Error sending status:', error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
};

module.exports = whatsappRoutes;
