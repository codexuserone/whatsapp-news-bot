const express = require('express');
const FeedItem = require('../models/FeedItem');

const feedItemRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const items = await FeedItem.find(
      {},
      { orderBy: { column: 'created_at', ascending: false }, limit: 200 }
    );
    res.json(items);
  });

  return router;
};

module.exports = feedItemRoutes;
