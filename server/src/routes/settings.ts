import type { Request, Response } from 'express';
const express = require('express');
const settingsService = require('../services/settingsService');
const { validate, schemas } = require('../middleware/validation');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const settingsRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const settings = await settingsService.getSettings();
      res.json(settings);
    } catch (error) {
      console.error('Error fetching settings:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/', validate(schemas.settings), async (req: Request, res: Response) => {
    try {
      const settings = await settingsService.updateSettings(req.body);
      res.json(settings);
    } catch (error) {
      console.error('Error updating settings:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = settingsRoutes;
