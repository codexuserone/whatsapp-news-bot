const express = require('express');
const Target = require('../models/Target');

const targetRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const targets = await Target.find();
    res.json(targets);
  });

  router.post('/', async (req, res) => {
    const target = await Target.create(req.body);
    res.json(target);
  });

  router.put('/:id', async (req, res) => {
    const target = await Target.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(target);
  });

  router.delete('/:id', async (req, res) => {
    await Target.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  });

  return router;
};

module.exports = targetRoutes;
