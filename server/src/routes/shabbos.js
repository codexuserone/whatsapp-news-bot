const express = require('express');
const { isCurrentlyShabbos, getUpcomingShabbos, DEFAULT_LOCATION } = require('../services/shabbosService');
const settingsService = require('../services/settingsService');

const shabbosRoutes = () => {
  const router = express.Router();

  // Get current Shabbos status
  router.get('/status', async (_req, res) => {
    try {
      const status = await isCurrentlyShabbos();
      res.json(status);
    } catch (error) {
      console.error('Error getting Shabbos status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get upcoming Shabbos times
  router.get('/upcoming', async (_req, res) => {
    try {
      const upcoming = await getUpcomingShabbos();
      res.json(upcoming);
    } catch (error) {
      console.error('Error getting upcoming Shabbos:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get Shabbos settings
  router.get('/settings', async (_req, res) => {
    try {
      const settings = await settingsService.getSettings();
      res.json({
        enabled: settings.shabbosMode?.enabled || false,
        location: settings.shabbosMode?.location || DEFAULT_LOCATION,
        queueMessages: settings.shabbosMode?.queueMessages !== false // default true
      });
    } catch (error) {
      console.error('Error getting Shabbos settings:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update Shabbos settings
  router.put('/settings', async (req, res) => {
    try {
      const { enabled, location, queueMessages } = req.body;
      
      const currentSettings = await settingsService.getSettings();
      const updatedShabbosMode = {
        ...currentSettings.shabbosMode,
        enabled: enabled !== undefined ? enabled : currentSettings.shabbosMode?.enabled,
        location: location || currentSettings.shabbosMode?.location || DEFAULT_LOCATION,
        queueMessages: queueMessages !== undefined ? queueMessages : currentSettings.shabbosMode?.queueMessages
      };

      await settingsService.updateSettings({ shabbosMode: updatedShabbosMode });
      
      res.json({
        enabled: updatedShabbosMode.enabled,
        location: updatedShabbosMode.location,
        queueMessages: updatedShabbosMode.queueMessages
      });
    } catch (error) {
      console.error('Error updating Shabbos settings:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

module.exports = shabbosRoutes;
