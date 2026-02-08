import type { Request, Response } from 'express';
const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const asyncHandler = require('../middleware/asyncHandler');
const { badRequest } = require('../core/errors');
const withTimeout = require('../utils/withTimeout');
const axios = require('axios');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { getErrorMessage } = require('../utils/errorUtils');
const { getSupabaseClient } = require('../db/supabase');
const { normalizeMessageText } = require('../utils/messageText');

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT =
  process.env.MEDIA_FETCH_USER_AGENT ||
  process.env.FEED_USER_AGENT ||
  'Mozilla/5.0 (compatible; AnashNewsBot/1.0; +https://whatsapp-news-bot-3-69qh.onrender.com)';

const isHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const downloadImageBuffer = async (url: string) => {
  await assertSafeOutboundUrl(url);
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

const toTimestampIso = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return new Date(parsed * 1000).toISOString();
    }
  }

  if (value && typeof value === 'object' && 'low' in (value as Record<string, unknown>)) {
    const low = Number((value as Record<string, unknown>).low);
    if (Number.isFinite(low) && low > 0) {
      return new Date(low * 1000).toISOString();
    }
  }

  return new Date().toISOString();
};

const persistOutgoingChatSnapshot = async (params: {
  messageId: string | null;
  remoteJid: string;
  text: string;
  mediaUrl: string | null;
  mediaType: string | null;
  messageTimestamp: unknown;
  source: 'send-test' | 'send-status';
}) => {
  if (!params.messageId) return;
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    await supabase
      .from('chat_messages')
      .upsert(
        {
          whatsapp_id: params.messageId,
          remote_jid: params.remoteJid,
          from_me: true,
          message_type: params.mediaType || 'text',
          content: params.text,
          media_url: params.mediaUrl,
          status: 'sent',
          timestamp: toTimestampIso(params.messageTimestamp),
          raw_message: {
            source: params.source,
            media_type: params.mediaType,
            media_url: params.mediaUrl
          }
        },
        { onConflict: 'whatsapp_id' }
      );
  } catch {
    // Best effort only. Delivery verification should not block send endpoints.
  }
};

const whatsappRoutes = () => {
  const router = express.Router();

  const runAsync = (label: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch((error) => {
        console.warn(`${label} failed:`, error);
      });
    });
  };

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
    const enriched =
      whatsapp && typeof whatsapp.getChannelsWithDiagnostics === 'function'
        ? await whatsapp.getChannelsWithDiagnostics()
        : null;
    const channels = enriched?.channels || await whatsapp?.getChannels() || [];
    res.json(channels);
  }));

  router.get('/channels/diagnostics', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp) {
      return res.json({
        channels: [],
        diagnostics: {
          methodsTried: [],
          methodErrors: [],
          sourceCounts: { api: 0, cache: 0, metadata: 0 },
          limitation: 'WhatsApp is not connected.'
        }
      });
    }

    if (typeof whatsapp.getChannelsWithDiagnostics === 'function') {
      const result = await whatsapp.getChannelsWithDiagnostics();
      return res.json(result);
    }

    const channels = await whatsapp.getChannels?.() || [];
    return res.json({
      channels,
      diagnostics: {
        methodsTried: [],
        methodErrors: [],
        sourceCounts: { api: 0, cache: 0, metadata: 0 },
        limitation: channels.length ? null : 'Channel diagnostics are unavailable in this server build.'
      }
    });
  }));

  router.post('/disconnect', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    await whatsapp?.disconnect();
    res.json({ ok: true });
  }));

  router.post('/reconnect', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.reconnect !== 'function') {
      throw badRequest('WhatsApp client not available');
    }

    runAsync('WhatsApp reconnect', async () => {
      await whatsapp.reconnect();
    });

    res.json({ ok: true, started: true });
  }));

  router.post('/hard-refresh', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.hardRefresh !== 'function') {
      throw badRequest('WhatsApp client not available');
    }

    runAsync('WhatsApp hard refresh', async () => {
      await whatsapp.hardRefresh();
    });

    res.json({ ok: true, started: true });
  }));

  // Force this instance to take over the WhatsApp lease (for recovery after deploy conflicts)
  router.post('/takeover', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.takeoverLease !== 'function') {
      throw badRequest('WhatsApp client not available');
    }
    const lease = await whatsapp.takeoverLease();
    res.json({ ok: true, lease });
  }));

  router.post('/clear-sender-keys', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.clearSenderKeys !== 'function') {
      throw badRequest('WhatsApp client not available');
    }

    runAsync('Clear sender keys', async () => {
      await whatsapp.clearSenderKeys();
    });

    res.json({ ok: true, started: true });
  }));

  const normalizeTestJid = (jid: string) => {
    if (jid.includes('@')) return jid;
    return `${jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  };

  const isStatusBroadcast = (jid: string) => jid === 'status@broadcast';

  // Send a test message
  router.post('/send-test', validate(schemas.testMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const { jid, message, imageUrl, confirm } = req.body;
    const normalizedMessage = normalizeMessageText(message);

    if (!jid || !normalizedMessage) {
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
        await assertSafeOutboundUrl(imageUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'imageUrl is not allowed'));
      }
      try {
        const { buffer, mimetype } = await downloadImageBuffer(imageUrl);
        content = mimetype
          ? { image: buffer, mimetype, caption: normalizedMessage || '' }
          : { image: buffer, caption: normalizedMessage || '' };
      } catch (error) {
        // Fall back to URL sending (Baileys will attempt to download)
        content = { image: { url: imageUrl }, caption: normalizedMessage || '' };
      }
    } else {
      content = { text: normalizedMessage };
    }

    const sendPromise = isStatusBroadcast(normalizedJid)
      ? whatsapp.sendStatusBroadcast(content)
      : whatsapp.sendMessage(normalizedJid, content);
    const result = await withTimeout(
      sendPromise,
      DEFAULT_SEND_TIMEOUT_MS,
      'Timed out sending test message'
    );

    const messageId = result?.key?.id;
    let confirmation: { ok: boolean; via: string; status?: number | null; statusLabel?: string | null } | null = null;
    if (confirm && messageId && whatsapp?.confirmSend) {
      const timeouts = imageUrl
        ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
        : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 };
      confirmation = await whatsapp.confirmSend(messageId, timeouts);
    }

    await persistOutgoingChatSnapshot({
      messageId: messageId || null,
      remoteJid: normalizedJid,
      text: normalizedMessage,
      mediaUrl: imageUrl || null,
      mediaType: imageUrl ? 'image' : 'text',
      messageTimestamp: result?.messageTimestamp,
      source: 'send-test'
    });

    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        let targetId: string | null = null;
        const { data: target } = await supabase
          .from('targets')
          .select('id')
          .eq('phone_number', normalizedJid)
          .limit(1)
          .maybeSingle();
        if (target?.id) {
          targetId = String(target.id);
        }

        await supabase.from('message_logs').insert({
          schedule_id: null,
          feed_item_id: null,
          target_id: targetId,
          template_id: null,
          message_content: normalizedMessage,
          status: 'sent',
          error_message: null,
          whatsapp_message_id: messageId || null,
          sent_at: new Date().toISOString()
        });
      }
    } catch {
      // Best effort only: test-message logging should not fail the send endpoint.
    }

    res.json({ ok: true, messageId, confirmation });
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
        await assertSafeOutboundUrl(imageUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'imageUrl is not allowed'));
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

    await persistOutgoingChatSnapshot({
      messageId: result?.key?.id || null,
      remoteJid: 'status@broadcast',
      text: String(message || ''),
      mediaUrl: imageUrl || null,
      mediaType: imageUrl ? 'image' : 'text',
      messageTimestamp: result?.messageTimestamp,
      source: 'send-status'
    });

    res.json({ ok: true, messageId: result?.key?.id });
  }));

  // Get recent outbox: messages the client believes it sent (for debugging ordering/media)
  router.get('/outbox', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp) {
      return res.json({ messages: [], statuses: [] });
    }
    const recentSent: Map<string, unknown> = whatsapp.recentSentMessages || new Map();
    const recentStatuses: Map<string, unknown> = whatsapp.recentMessageStatuses || new Map();
    const messages = Array.from(recentSent.entries()).map(([id, msg]) => {
      const m = msg as Record<string, unknown>;
      const key = m.key as Record<string, unknown> | undefined;
      const message = m.message as Record<string, unknown> | undefined;
      return {
        id,
        remoteJid: key?.remoteJid ?? null,
        fromMe: key?.fromMe ?? null,
        timestamp: m.messageTimestamp ?? null,
        hasImage: Boolean(message?.imageMessage),
        hasText: Boolean(message?.conversation || message?.extendedTextMessage),
        hasCaption: Boolean((message?.imageMessage as Record<string,unknown>)?.caption)
      };
    });
    const statuses = Array.from(recentStatuses.entries()).map(([id, snap]) => {
      const s = snap as Record<string, unknown>;
      return {
        id,
        status: s.status ?? null,
        statusLabel: s.statusLabel ?? null,
        remoteJid: s.remoteJid ?? null,
        updatedAtMs: s.updatedAtMs ?? null
      };
    });
    res.json({ messages, statuses });
  }));

  return router;
};

module.exports = whatsappRoutes;
