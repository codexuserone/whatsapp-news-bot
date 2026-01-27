const express = require('express');
const Schedule = require('../models/Schedule');
const { sendQueuedForSchedule } = require('../services/queueService');
const { initSchedulers } = require('../services/schedulerService');

const scheduleRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const schedules = await Schedule.find();
    res.json(schedules);
  });

  router.post('/', async (req, res) => {
    const schedule = await Schedule.create(req.body);
    await initSchedulers(req.app.locals.whatsapp);
    res.json(schedule);
  });

  router.put('/:id', async (req, res) => {
    const schedule = await Schedule.findByIdAndUpdate(req.params.id, req.body, { new: true });
    await initSchedulers(req.app.locals.whatsapp);
    res.json(schedule);
  });

  router.delete('/:id', async (req, res) => {
    await Schedule.findByIdAndDelete(req.params.id);
    await initSchedulers(req.app.locals.whatsapp);
    res.json({ ok: true });
  });

  router.post('/:id/dispatch', async (req, res) => {
    const whatsapp = req.app.locals.whatsapp;
    const result = await sendQueuedForSchedule(req.params.id, whatsapp);
    res.json(result);
  });

  return router;
};

module.exports = scheduleRoutes;
