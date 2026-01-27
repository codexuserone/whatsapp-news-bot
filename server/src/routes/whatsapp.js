const express = require('express');

const whatsappRoutes = () => {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    res.json(whatsapp.getStatus());
  });

  router.get('/qr', (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    res.json({ qr: whatsapp.getQrCode() });
  });

  router.get('/groups', async (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    const groups = await whatsapp.getGroups();
    res.json(groups);
  });

  router.get('/channels', async (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    const channels = await whatsapp.getChannels();
    res.json(channels);
  });

  router.post('/disconnect', async (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    await whatsapp.disconnect();
    res.json({ ok: true });
  });

  router.post('/hard-refresh', async (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    await whatsapp.hardRefresh();
    res.json({ ok: true });
  });

  return router;
};

module.exports = whatsappRoutes;
