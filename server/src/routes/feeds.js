const express = require('express');
const Feed = require('../models/Feed');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('../services/feedProcessor');
const { initSchedulers, triggerImmediateSchedules } = require('../services/schedulerService');

const feedsRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const feeds = await Feed.find();
    res.json(feeds);
  });

  router.post('/', async (req, res) => {
    const feed = await Feed.create(req.body);
    await initSchedulers(req.app.locals.whatsapp);
    res.json(feed);
  });

  router.put('/:id', async (req, res) => {
    const feed = await Feed.findByIdAndUpdate(req.params.id, req.body, { new: true });
    await initSchedulers(req.app.locals.whatsapp);
    res.json(feed);
  });

  router.delete('/:id', async (req, res) => {
    await Feed.findByIdAndDelete(req.params.id);
    await initSchedulers(req.app.locals.whatsapp);
    res.json({ ok: true });
  });

  router.post('/:id/refresh', async (req, res) => {
    const feed = await Feed.findById(req.params.id);
    if (!feed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    const items = await fetchAndProcessFeed(feed);
    await queueFeedItemsForSchedules(feed._id, items);
    if (items.length) {
      await triggerImmediateSchedules(feed._id, req.app.locals.whatsapp);
    }
    res.json({ ok: true, items });
  });

  return router;
};

module.exports = feedsRoutes;
