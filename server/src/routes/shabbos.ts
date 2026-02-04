import type { Request, Response } from 'express';
const express = require('express');
const { isCurrentlyShabbos, getUpcomingShabbos, DEFAULT_LOCATION } = require('../services/shabbosService');
const settingsService = require('../services/settingsService');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const shabbosRoutes = () => {
  const router = express.Router();

  // Get current Shabbos status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const status = await isCurrentlyShabbos();
      res.json(status);
    } catch (error) {
      console.error('Error getting Shabbos status:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get upcoming Shabbos times
  router.get('/upcoming', async (_req: Request, res: Response) => {
    try {
      const upcoming = await getUpcomingShabbos();
      res.json(upcoming);
    } catch (error) {
      console.error('Error getting upcoming Shabbos:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get Shabbos settings (returns flat format for frontend)
  router.get('/settings', async (_req: Request, res: Response) => {
    try {
      const settings = await settingsService.getSettings();
      const loc = settings.shabbosMode?.location || DEFAULT_LOCATION;
      res.json({
        enabled: settings.shabbosMode?.enabled ?? true,
        city: loc.city || 'New York',
        latitude: loc.latitude ?? 40.7128,
        longitude: loc.longitude ?? -74.006,
        tzid: loc.tzid || 'America/New_York',
        candleLightingMins: settings.shabbosMode?.candleLightingMins ?? 18,
        havdalahMins: settings.shabbosMode?.havdalahMins ?? 50,
        queueMessages: settings.shabbosMode?.queueMessages !== false
      });
    } catch (error) {
      console.error('Error getting Shabbos settings:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Update Shabbos settings (accepts flat format from frontend)
  router.put('/settings', async (req: Request, res: Response) => {
    try {
      const {
        enabled,
        location,
        city,
        latitude,
        longitude,
        tzid,
        candleLightingMins,
        havdalahMins,
        queueMessages
      } = req.body;

      const currentSettings = await settingsService.getSettings();
      const currentLoc = currentSettings.shabbosMode?.location || DEFAULT_LOCATION;

      const newLocation =
        location ||
        (city || latitude !== undefined || longitude !== undefined || tzid
          ? {
              city: city ?? currentLoc.city,
              latitude: latitude ?? currentLoc.latitude,
              longitude: longitude ?? currentLoc.longitude,
              tzid: tzid ?? currentLoc.tzid
            }
          : currentLoc);

      const updatedShabbosMode = {
        ...currentSettings.shabbosMode,
        enabled: enabled !== undefined ? enabled : currentSettings.shabbosMode?.enabled,
        location: newLocation,
        candleLightingMins:
          candleLightingMins !== undefined ? candleLightingMins : currentSettings.shabbosMode?.candleLightingMins ?? 18,
        havdalahMins:
          havdalahMins !== undefined ? havdalahMins : currentSettings.shabbosMode?.havdalahMins ?? 50,
        queueMessages: queueMessages !== undefined ? queueMessages : currentSettings.shabbosMode?.queueMessages
      };

      await settingsService.updateSettings({ shabbosMode: updatedShabbosMode });

      const loc = updatedShabbosMode.location || DEFAULT_LOCATION;
      res.json({
        enabled: updatedShabbosMode.enabled,
        city: loc.city,
        latitude: loc.latitude,
        longitude: loc.longitude,
        tzid: loc.tzid,
        candleLightingMins: updatedShabbosMode.candleLightingMins ?? 18,
        havdalahMins: updatedShabbosMode.havdalahMins ?? 50,
        queueMessages: updatedShabbosMode.queueMessages
      });
    } catch (error) {
      console.error('Error updating Shabbos settings:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = shabbosRoutes;
