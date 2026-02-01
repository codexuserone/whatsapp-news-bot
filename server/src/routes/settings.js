const express = require('express');
const settingsService = require('../services/settingsService');

const settingsRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const settings = await settingsService.getSettings();
      res.json(settings);
    } catch (error) {
      console.error('Error fetching settings:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/', async (req, res) => {
    try {
      const settings = await settingsService.updateSettings(req.body);
      res.json(settings);
    } catch (error) {
      console.error('Error updating settings:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = settingsRoutes;
