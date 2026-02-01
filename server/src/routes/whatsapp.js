const express = require('express');

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

  return router;
};

module.exports = whatsappRoutes;
