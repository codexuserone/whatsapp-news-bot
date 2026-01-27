const express = require('express');
const FeedItem = require('../models/FeedItem');

const feedItemRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const items = await FeedItem.find().sort({ createdAt: -1 }).limit(200);
    res.json(items);
  });

  return router;
};

module.exports = feedItemRoutes;
