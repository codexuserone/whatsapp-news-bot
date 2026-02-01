const express = require('express');
const MessageLog = require('../models/MessageLog');

const logRoutes = () => {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const { status } = req.query;
    const query = status ? { status } : {};
    const logs = await MessageLog.find(query, {
      orderBy: { column: 'created_at', ascending: false },
      limit: 200
    });
    res.json(logs);
  });

  return router;
};

module.exports = logRoutes;
