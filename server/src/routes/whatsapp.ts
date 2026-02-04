import type { Request, Response } from 'express';
const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const asyncHandler = require('../middleware/asyncHandler');
const { badRequest } = require('../core/errors');
const withTimeout = require('../utils/withTimeout');
const axios = require('axios');

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; WhatsAppNewsBot/0.2; +https://example.invalid)';

const isHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const downloadImageBuffer = async (url: string) => {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const response = await axios.get(url, {
    timeout: DEFAULT_SEND_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    }
  });
  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  const data = response.data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!contentType.startsWith('image/')) {
    throw new Error(`URL did not return an image (content-type: ${contentType || 'unknown'})`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${buffer.length} bytes)`);
  }
  return { buffer, mimetype: contentType };
};

const whatsappRoutes = () => {
  const router = express.Router();

  router.get('/status', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    res.json(whatsapp?.getStatus() || { status: 'disconnected' });
  }));

  router.get('/qr', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    res.json({ qr: whatsapp?.getQrCode() || null });
  }));

  router.get('/groups', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const groups = await whatsapp?.getGroups() || [];
    res.json(groups);
  }));

  router.get('/channels', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const channels = await whatsapp?.getChannels() || [];
    res.json(channels);
  }));

  router.post('/disconnect', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    await whatsapp?.disconnect();
    res.json({ ok: true });
  }));

  router.post('/hard-refresh', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    await whatsapp?.hardRefresh();
    res.json({ ok: true });
  }));

  router.post('/clear-sender-keys', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.clearSenderKeys !== 'function') {
      throw badRequest('WhatsApp client not available');
    }
    await whatsapp.clearSenderKeys();
    res.json({ ok: true });
  }));

  const normalizeTestJid = (jid: string) => {
    if (jid.includes('@')) return jid;
    return `${jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  };

  const isStatusBroadcast = (jid: string) => jid === 'status@broadcast';

  // Send a test message
  router.post('/send-test', validate(schemas.testMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const { jid, message, imageUrl } = req.body;

    if (!jid || !message) {
      throw badRequest('jid and message are required');
    }

    if (whatsapp?.getStatus()?.status !== 'connected') {
      throw badRequest('WhatsApp is not connected');
    }

    const normalizedJid = normalizeTestJid(jid);
    let content: Record<string, unknown>;
    if (imageUrl) {
      if (!isHttpUrl(imageUrl)) {
        throw badRequest('imageUrl must be an http(s) URL');
      }
      try {
        const { buffer, mimetype } = await downloadImageBuffer(imageUrl);
        content = mimetype
          ? { image: buffer, mimetype, caption: message || '' }
          : { image: buffer, caption: message || '' };
      } catch (error) {
        // Fall back to URL sending (Baileys will attempt to download)
        content = { image: { url: imageUrl }, caption: message || '' };
      }
    } else {
      content = { text: message };
    }

    const sendPromise = isStatusBroadcast(normalizedJid)
      ? whatsapp.sendStatusBroadcast(content)
      : whatsapp.sendMessage(normalizedJid, content);
    const result = await withTimeout(
      sendPromise,
      DEFAULT_SEND_TIMEOUT_MS,
      'Timed out sending test message'
    );
    res.json({ ok: true, messageId: result?.key?.id });
  }));

  // Send to status broadcast
  router.post('/send-status', validate(schemas.statusMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const { message, imageUrl } = req.body;

    if (!message && !imageUrl) {
      throw badRequest('message or imageUrl is required');
    }

    if (whatsapp?.getStatus()?.status !== 'connected') {
      throw badRequest('WhatsApp is not connected');
    }

    let content: Record<string, unknown>;
    if (imageUrl) {
      if (!isHttpUrl(imageUrl)) {
        throw badRequest('imageUrl must be an http(s) URL');
      }
      try {
        const { buffer, mimetype } = await downloadImageBuffer(imageUrl);
        content = mimetype
          ? { image: buffer, mimetype, caption: message || '' }
          : { image: buffer, caption: message || '' };
      } catch {
        content = { image: { url: imageUrl }, caption: message || '' };
      }
    } else {
      content = { text: message };
    }

    const result = await whatsapp.sendStatusBroadcast(content);
    res.json({ ok: true, messageId: result?.key?.id });
  }));

  return router;
};

module.exports = whatsappRoutes;
