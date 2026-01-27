const express = require('express');
const settingsService = require('../services/settingsService');

const settingsRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const settings = await settingsService.getSettings();
    res.json(settings);
  });

  router.put('/', async (req, res) => {
    const settings = await settingsService.updateSettings(req.body);
    res.json(settings);
  });

  return router;
};

module.exports = settingsRoutes;
