const express = require('express');
const Template = require('../models/Template');

const templateRoutes = () => {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const templates = await Template.find();
    res.json(templates);
  });

  router.post('/', async (req, res) => {
    const template = await Template.create(req.body);
    res.json(template);
  });

  router.put('/:id', async (req, res) => {
    const template = await Template.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(template);
  });

  router.delete('/:id', async (req, res) => {
    await Template.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  });

  return router;
};

module.exports = templateRoutes;
