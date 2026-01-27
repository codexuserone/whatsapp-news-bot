const express = require('express');
const MessageLog = require('../models/MessageLog');

const logRoutes = () => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const { status } = req.query;
    const query = status ? { status } : {};
    const logs = await MessageLog.find(query).sort({ createdAt: -1 }).limit(200);
    res.json(logs);
  });

  return router;
};

module.exports = logRoutes;
