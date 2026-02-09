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
const { ensureWhatsAppConnected } = require('../services/whatsappConnection');

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT =
  process.env.MEDIA_FETCH_USER_AGENT ||
  process.env.FEED_USER_AGENT ||
  'Mozilla/5.0 (compatible; AnashNewsBot/1.0; +https://whatsapp-news-bot-3-69qh.onrender.com)';
const SUPPORTED_WHATSAPP_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const detectImageMimeTypeFromBuffer = (value: Buffer): string | null => {
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    value.length >= 8 &&
    value[0] === 0x89 &&
    value[1] === 0x50 &&
    value[2] === 0x4e &&
    value[3] === 0x47 &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    value.length >= 12 &&
    value.slice(0, 4).toString('ascii') === 'RIFF' &&
    value.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
};

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
  const detectedMime = detectImageMimeTypeFromBuffer(buffer);
  if (!detectedMime || !SUPPORTED_WHATSAPP_IMAGE_MIME.has(detectedMime)) {
    throw new Error('Unsupported or corrupt image data for WhatsApp upload');
  }
  return { buffer, mimetype: detectedMime };
};

const parseImageDataUrl = (value: string) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match || !match[1] || !match[2]) {
    throw badRequest('imageDataUrl must be a valid base64 image data URL');
  }

  const mimetype = String(match[1]).toLowerCase();
  const base64 = String(match[2]).replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  if (!buffer.length) {
    throw badRequest('imageDataUrl is empty');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw badRequest(`Image too large (${buffer.length} bytes)`);
  }

  const detectedMime = detectImageMimeTypeFromBuffer(buffer);
  if (!detectedMime || !SUPPORTED_WHATSAPP_IMAGE_MIME.has(detectedMime)) {
    throw badRequest('imageDataUrl must be a valid jpeg/png/webp image');
  }

  return { buffer, mimetype: detectedMime || mimetype };
};

const parseVideoDataUrl = (value: string) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(video\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match || !match[1] || !match[2]) {
    throw badRequest('videoDataUrl must be a valid base64 video data URL');
  }

  const mimetype = String(match[1]).toLowerCase();
  const base64 = String(match[2]).replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
  if (!buffer.length) {
    throw badRequest('videoDataUrl is empty');
  }
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw badRequest(`Video too large (${buffer.length} bytes)`);
  }
  return { buffer, mimetype };
};

const normalizeChannelJid = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw.toLowerCase().includes('@newsletter')) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  return digits ? `${digits}@newsletter` : raw;
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
    const supabase = getSupabaseClient();
    // Try to get from WhatsApp first
    const groups = await whatsapp?.getGroups() || [];
    
    // If no groups returned and WhatsApp is not connected, fallback to database
    if (!groups.length && whatsapp?.getStatus?.().status !== 'connected' && supabase) {
      const { data: dbGroups } = await supabase
        .from('targets')
        .select('*')
        .eq('type', 'group')
        .eq('active', true);
      
      const fallbackGroups = (dbGroups || []).map((t: { id?: string; name?: string; phone_number?: string; notes?: string }) => ({
        id: t.phone_number,
        jid: t.phone_number,
        name: t.name,
        size: Number(String(t.notes || '').match(/\d+/)?.[0] || 0)
      }));
      
      return res.json(fallbackGroups);
    }
    
    res.json(groups);
  }));

  router.get('/channels', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const supabase = getSupabaseClient();
    const channelsByJid = new Map<string, {
      id: string;
      jid: string;
      name: string;
      subscribers: number;
      source: 'live' | 'saved';
    }>();
    const isConnected = whatsapp?.getStatus?.().status === 'connected';
    
    if (whatsapp && isConnected) {
      const enriched =
        typeof whatsapp.getChannelsWithDiagnostics === 'function'
          ? await whatsapp.getChannelsWithDiagnostics()
          : null;
      const liveChannels = enriched?.channels || await whatsapp.getChannels?.() || [];
      for (const channel of liveChannels) {
        const jid = normalizeChannelJid(String(channel?.jid || '').trim());
        if (!jid) continue;
        channelsByJid.set(jid.toLowerCase(), {
          id: jid,
          jid,
          name: String(channel?.name || jid),
          subscribers: Number(channel?.subscribers || 0),
          source: 'live'
        });
      }
    }
    
    // Always merge saved channel targets as a fallback source.
    // This keeps channels selectable even when live channel discovery is unavailable.
    if (supabase) {
      const { data: dbChannels } = await supabase
        .from('targets')
        .select('*')
        .eq('type', 'channel')
        .eq('active', true);
      
      for (const target of (dbChannels || []) as Array<{ id?: string; name?: string; phone_number?: string; notes?: string }>) {
        const jid = normalizeChannelJid(String(target.phone_number || target.id || '').trim());
        if (!jid) continue;
        const key = jid.toLowerCase();
        if (channelsByJid.has(key)) continue;
        channelsByJid.set(key, {
          id: jid,
          jid,
          name: String(target.name || jid),
          subscribers: Number(String(target.notes || '').match(/\d+/)?.[0] || 0),
          source: 'saved'
        });
      }
    }

    const channels = Array.from(channelsByJid.values()).sort((a, b) => a.name.localeCompare(b.name));
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

  router.post('/hard-refresh', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    await whatsapp?.hardRefresh();
    res.json({ ok: true });
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
    await whatsapp.clearSenderKeys();
    res.json({ ok: true });
  }));

  const normalizeTestJid = (jid: string) => {
    const raw = String(jid || '').trim();
    if (!raw) return raw;
    if (raw.toLowerCase().includes('@newsletter')) return raw;
    if (raw.includes('@')) return raw;
    return `${raw.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  };

  const isStatusBroadcast = (jid: string) => jid === 'status@broadcast';

  const ensureConnectedForSend = async (
    whatsapp: {
      hardRefresh?: () => Promise<void> | void;
    } | null | undefined,
    context: string
  ) => {
    const fastPath = await ensureWhatsAppConnected(whatsapp, {
      attempts: 8,
      delayMs: 900,
      triggerReconnect: true,
      triggerTakeover: true,
      logContext: context
    });
    if (fastPath) return true;

    try {
      await Promise.resolve(whatsapp?.hardRefresh?.());
    } catch {
      // Best effort only.
    }

    return ensureWhatsAppConnected(whatsapp, {
      attempts: 20,
      delayMs: 1000,
      triggerReconnect: true,
      triggerTakeover: true,
      logContext: `${context} (post hard-refresh)`
    });
  };

  // Send a test message
  router.post('/send-test', validate(schemas.testMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const payload = req.body as {
      jid?: string | null;
      jids?: string[] | null;
      message?: string | null;
      linkUrl?: string | null;
      imageUrl?: string | null;
      imageDataUrl?: string | null;
      videoDataUrl?: string | null;
      includeCaption?: boolean;
      disableLinkPreview?: boolean;
      confirm?: boolean;
    };

    const requestedJids = Array.from(
      new Set(
        [
          ...(Array.isArray(payload.jids) ? payload.jids : []),
          String(payload.jid || '')
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    );

    if (!requestedJids.length) {
      throw badRequest('jid or jids is required');
    }

    const normalizedJids = Array.from(new Set(requestedJids.map((jid) => normalizeTestJid(jid)).filter(Boolean)));
    const normalizedMessage = normalizeMessageText(String(payload.message || ''));
    const normalizedLink = String(payload.linkUrl || '').trim();
    const imageUrl = payload.imageUrl ? String(payload.imageUrl).trim() : null;
    const imageDataUrl = payload.imageDataUrl ? String(payload.imageDataUrl).trim() : null;
    const videoDataUrl = payload.videoDataUrl ? String(payload.videoDataUrl).trim() : null;
    const disableLinkPreview = payload.disableLinkPreview === true;
    const confirm = payload.confirm;
    const includeCaption = payload.includeCaption !== false;
    const captionText = [normalizedMessage, normalizedLink].filter(Boolean).join('\n').trim();

    if (!captionText && !imageUrl && !imageDataUrl && !videoDataUrl) {
      throw badRequest('message, linkUrl, imageUrl, imageDataUrl, or videoDataUrl is required');
    }

    const connected = await ensureConnectedForSend(whatsapp, 'send-test route');
    if (!connected) {
      throw badRequest('WhatsApp is not connected');
    }

    let content: Record<string, unknown>;
    if (videoDataUrl) {
      const { buffer, mimetype } = parseVideoDataUrl(videoDataUrl);
      content = includeCaption && captionText
        ? { video: buffer, mimetype, caption: captionText }
        : { video: buffer, mimetype };
    } else if (imageDataUrl) {
      const { buffer, mimetype } = parseImageDataUrl(imageDataUrl);
      content = includeCaption && captionText
        ? { image: buffer, mimetype, caption: captionText }
        : { image: buffer, mimetype };
    } else if (imageUrl) {
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
        content = includeCaption && captionText
          ? (mimetype
            ? { image: buffer, mimetype, caption: captionText }
            : { image: buffer, caption: captionText })
          : (mimetype
            ? { image: buffer, mimetype }
            : { image: buffer });
      } catch (error) {
        // Fall back to URL sending (Baileys will attempt to download)
        content = includeCaption && captionText
          ? { image: { url: imageUrl }, caption: captionText }
          : { image: { url: imageUrl } };
      }
    } else {
      content = disableLinkPreview ? { text: captionText, linkPreview: null } : { text: captionText };
    }

    const results: Array<{
      jid: string;
      ok: boolean;
      messageId?: string | null;
      confirmation?: { ok: boolean; via: string; status?: number | null; statusLabel?: string | null } | null;
      error?: string;
    }> = [];

    for (const normalizedJid of normalizedJids) {
      try {
        const sendPromise = isStatusBroadcast(normalizedJid)
          ? whatsapp.sendStatusBroadcast(content)
          : whatsapp.sendMessage(normalizedJid, content);
        const result = await withTimeout(
          sendPromise,
          DEFAULT_SEND_TIMEOUT_MS,
          'Timed out sending test message'
        );

        const messageId = result?.key?.id || null;
        let confirmation: { ok: boolean; via: string; status?: number | null; statusLabel?: string | null } | null = null;
        if (confirm && messageId && whatsapp?.confirmSend) {
          const timeouts = (imageUrl || imageDataUrl || videoDataUrl)
            ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
            : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 };
          confirmation = await whatsapp.confirmSend(messageId, timeouts);
        }

        results.push({ jid: normalizedJid, ok: true, messageId, confirmation });
      } catch (error) {
        results.push({ jid: normalizedJid, ok: false, error: getErrorMessage(error) });
      }
    }

    const successful = results.filter((entry) => entry.ok);
    if (!successful.length) {
      const firstError = results.find((entry) => !entry.ok)?.error || 'Failed to send test message';
      throw badRequest(firstError);
    }

    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        const { data: targetRows } = await supabase
          .from('targets')
          .select('id,phone_number')
          .in('phone_number', normalizedJids);

        const targetIdByJid = new Map<string, string>();
        for (const row of targetRows || []) {
          const jid = String((row as { phone_number?: string }).phone_number || '').trim();
          const id = String((row as { id?: string }).id || '').trim();
          if (jid && id) targetIdByJid.set(jid, id);
        }

        const sentAt = new Date().toISOString();
        const rowsToInsert = successful.map((entry) => ({
          schedule_id: null,
          feed_item_id: null,
          target_id: targetIdByJid.get(entry.jid) || null,
          template_id: null,
          message_content: captionText || null,
          status: 'sent',
          error_message: null,
          whatsapp_message_id: entry.messageId || null,
          sent_at: sentAt
        }));

        if (rowsToInsert.length) {
          await supabase.from('message_logs').insert(rowsToInsert);
        }
      }
    } catch {
      // Best effort only: test-message logging should not fail the send endpoint.
    }

    if (normalizedJids.length === 1) {
      const first = successful[0];
      return res.json({
        ok: results.every((entry) => entry.ok),
        sent: successful.length,
        failed: results.length - successful.length,
        messageId: first?.messageId || null,
        confirmation: first?.confirmation || null,
        results
      });
    }

    res.json({
      ok: results.every((entry) => entry.ok),
      sent: successful.length,
      failed: results.length - successful.length,
      results
    });
  }));

  // Send to status broadcast
  router.post('/send-status', validate(schemas.statusMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const { message, imageUrl } = req.body;

    if (!message && !imageUrl) {
      throw badRequest('message or imageUrl is required');
    }

    const connected = await ensureConnectedForSend(whatsapp, 'send-status route');

    if (!connected) {
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
