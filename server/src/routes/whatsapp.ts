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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const VIDEO_URL_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v', '.3gp'];
const IMAGE_URL_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'];
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

const downloadVideoBuffer = async (url: string) => {
  await assertSafeOutboundUrl(url);
  const response = await axios.get(url, {
    timeout: DEFAULT_SEND_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxContentLength: MAX_VIDEO_BYTES,
    maxBodyLength: MAX_VIDEO_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'video/*,*/*;q=0.8'
    }
  });
  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  const data = response.data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!contentType.startsWith('video/')) {
    throw new Error(`URL did not return a video (content-type: ${contentType || 'unknown'})`);
  }
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(`Video too large (${buffer.length} bytes)`);
  }
  return { buffer, mimetype: contentType };
};

const extensionFromUrl = (value: string) => {
  const lower = String(value || '').toLowerCase();
  return lower.split(/[?#]/)[0] || lower;
};

const inferMediaTypeFromUrl = (value: string): 'image' | 'video' => {
  const normalized = extensionFromUrl(value);
  if (VIDEO_URL_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
    return 'video';
  }
  if (IMAGE_URL_EXTENSIONS.some((ext) => normalized.endsWith(ext))) {
    return 'image';
  }
  return 'image';
};

type OutgoingMediaType = 'image' | 'video';

const buildOutgoingContent = async (params: {
  message: string;
  mediaUrl: string | null;
  mediaType: OutgoingMediaType | null;
  thumbnailUrl?: string | null;
}) => {
  const normalizedMessage = normalizeMessageText(String(params.message || ''));
  if (!params.mediaUrl) {
    return {
      content: { text: normalizedMessage },
      mediaUrl: null,
      mediaType: 'text' as const,
      text: normalizedMessage
    };
  }

  const mediaUrl = String(params.mediaUrl || '').trim();
  if (!isHttpUrl(mediaUrl)) {
    throw badRequest('mediaUrl must be an http(s) URL');
  }

  try {
    await assertSafeOutboundUrl(mediaUrl);
  } catch (error) {
    throw badRequest(getErrorMessage(error, 'mediaUrl is not allowed'));
  }

  const effectiveType: OutgoingMediaType = params.mediaType || inferMediaTypeFromUrl(mediaUrl);
  if (effectiveType === 'video') {
    let jpegThumbnail: Buffer | undefined;
    const rawThumbnailUrl = String(params.thumbnailUrl || '').trim();
    if (rawThumbnailUrl) {
      if (!isHttpUrl(rawThumbnailUrl)) {
        throw badRequest('thumbnailUrl must be an http(s) URL');
      }
      try {
        await assertSafeOutboundUrl(rawThumbnailUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'thumbnailUrl is not allowed'));
      }
      try {
        const downloadedThumbnail = await downloadImageBuffer(rawThumbnailUrl);
        jpegThumbnail = downloadedThumbnail.buffer;
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'thumbnailUrl could not be downloaded as an image'));
      }
    }

    try {
      const { buffer, mimetype } = await downloadVideoBuffer(mediaUrl);
      const content: Record<string, unknown> = mimetype
        ? { video: buffer, mimetype, caption: normalizedMessage || '' }
        : { video: buffer, caption: normalizedMessage || '' };
      if (jpegThumbnail) {
        content.jpegThumbnail = jpegThumbnail;
      }
      return { content, mediaUrl, mediaType: 'video' as const, text: normalizedMessage };
    } catch {
      const content: Record<string, unknown> = { video: { url: mediaUrl }, caption: normalizedMessage || '' };
      if (jpegThumbnail) {
        content.jpegThumbnail = jpegThumbnail;
      }
      return {
        content,
        mediaUrl,
        mediaType: 'video' as const,
        text: normalizedMessage
      };
    }
  }

  try {
    const { buffer, mimetype } = await downloadImageBuffer(mediaUrl);
    const content = mimetype
      ? { image: buffer, mimetype, caption: normalizedMessage || '' }
      : { image: buffer, caption: normalizedMessage || '' };
    return { content, mediaUrl, mediaType: 'image' as const, text: normalizedMessage };
  } catch {
    return {
      content: { image: { url: mediaUrl }, caption: normalizedMessage || '' },
      mediaUrl,
      mediaType: 'image' as const,
      text: normalizedMessage
    };
  }
};

const normalizeChannelJid = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('whatsapp.com/channel/')) return '';

  if (raw.endsWith('@newsletter')) {
    const base = raw.slice(0, -'@newsletter'.length);
    const digits = base.replace(/[^0-9]/g, '');
    return digits ? `${digits}@newsletter` : '';
  }

  if (raw.includes('@')) return '';

  if (/^[a-z0-9]{10,}$/.test(raw) && /[a-z]/.test(raw)) return '';

  const numericLike = raw.replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(numericLike)) return '';
  return `${numericLike}@newsletter`;
};

const extractChannelInviteCode = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase().includes('@newsletter')) return '';

  const directMatch = raw.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
  if (directMatch?.[1]) return String(directMatch[1] || '').trim();

  if ((raw.startsWith('http://') || raw.startsWith('https://')) && raw.includes('/channel/')) {
    try {
      const parsed = new URL(raw);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const channelIndex = parts.findIndex((part) => part.toLowerCase() === 'channel');
      if (channelIndex >= 0) {
        const candidate = String(parts[channelIndex + 1] || '').trim();
        if (/^[A-Za-z0-9]{10,}$/.test(candidate)) return candidate;
      }
    } catch {
      // ignore invalid url
    }
  }

  if (/^[A-Za-z0-9]{10,}$/.test(raw) && /[A-Za-z]/.test(raw)) {
    return raw;
  }

  return '';
};

const normalizeChannelReference = (value: unknown) => {
  const jid = normalizeChannelJid(value);
  const inviteCode = extractChannelInviteCode(value);
  return {
    jid: jid || null,
    inviteCode: inviteCode || null
  };
};

const parseSubscribersFromNotes = (notes: unknown) => {
  const text = String(notes || '').trim();
  if (!text) return 0;
  const match = text.match(/([0-9][0-9,]*)\s*subscribers?/i);
  if (!match || !match[1]) return 0;
  const parsed = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};

const mergeChannels = (
  primary: Array<{
    id?: string;
    jid?: string;
    name?: string;
    subscribers?: number;
    viewerRole?: string | null;
    canSend?: boolean | null;
  }>,
  secondary: Array<{
    id?: string;
    jid?: string;
    name?: string;
    subscribers?: number;
    viewerRole?: string | null;
    canSend?: boolean | null;
  }>
) => {
  const byJid = new Map<
    string,
    { id: string; jid: string; name: string; subscribers: number; viewerRole: string | null; canSend: boolean | null }
  >();

  const upsert = (candidate: {
    id?: string;
    jid?: string;
    name?: string;
    subscribers?: number;
    viewerRole?: string | null;
    canSend?: boolean | null;
  }) => {
    const jid = normalizeChannelJid(candidate?.jid || candidate?.id);
    if (!jid) return;

    const existing = byJid.get(jid);
    const name = String(candidate?.name || '').trim();
    const subscribers = Number(candidate?.subscribers || 0);
    const viewerRole = String(candidate?.viewerRole || '').trim() || existing?.viewerRole || null;
    const canSend =
      typeof candidate?.canSend === 'boolean'
        ? candidate.canSend
        : typeof existing?.canSend === 'boolean'
          ? existing.canSend
          : null;

    byJid.set(jid, {
      id: jid,
      jid,
      name: name || existing?.name || jid,
      subscribers: Number.isFinite(subscribers)
        ? Math.max(Math.round(subscribers), existing?.subscribers || 0, 0)
        : existing?.subscribers || 0,
      viewerRole,
      canSend
    });
  };

  for (const row of primary || []) upsert(row);
  for (const row of secondary || []) upsert(row);

  return Array.from(byJid.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const loadSavedChannelTargets = async (): Promise<Array<{
  id: string;
  jid: string;
  name: string;
  subscribers: number;
  viewerRole: string | null;
  canSend: boolean | null;
}>> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return [] as Array<{
      id: string;
      jid: string;
      name: string;
      subscribers: number;
      viewerRole: string | null;
      canSend: boolean | null;
    }>;
  }

  const { data, error } = await supabase
    .from('targets')
    .select('id,name,phone_number,notes,active,type')
    .eq('type', 'channel')
    .eq('active', true)
    .order('name', { ascending: true });

  if (error) {
    return [] as Array<{
      id: string;
      jid: string;
      name: string;
      subscribers: number;
      viewerRole: string | null;
      canSend: boolean | null;
    }>;
  }

  const mapped: Array<{
    id: string;
    jid: string;
    name: string;
    subscribers: number;
    viewerRole: string | null;
    canSend: boolean | null;
  } | null> = ((data || []) as Array<Record<string, unknown>>)
    .map((row) => {
      const jid = normalizeChannelJid(row.phone_number);
      if (!jid) return null;
      return {
        id: jid,
        jid,
        name: String(row.name || jid),
        subscribers: parseSubscribersFromNotes(row.notes),
        viewerRole: null,
        canSend: null
      };
    });

  return mapped.filter(
    (row): row is { id: string; jid: string; name: string; subscribers: number; viewerRole: string | null; canSend: boolean | null } =>
      row != null
  );
};

const loadKnownChannelsFromMessages = async (): Promise<Array<{
  id: string;
  jid: string;
  name: string;
  subscribers: number;
  viewerRole: string | null;
  canSend: boolean | null;
}>> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from('chat_messages')
    .select('remote_jid')
    .like('remote_jid', '%@newsletter')
    .order('timestamp', { ascending: false })
    .limit(1000);

  if (error) {
    return [];
  }

  const seen = new Set<string>();
  const channels: Array<{
    id: string;
    jid: string;
    name: string;
    subscribers: number;
    viewerRole: string | null;
    canSend: boolean | null;
  }> = [];

  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const jid = normalizeChannelJid(row.remote_jid);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    channels.push({
      id: jid,
      jid,
      name: jid,
      subscribers: 0,
      viewerRole: null,
      canSend: null
    });
  }

  return channels;
};

const enrichChannelsWithMetadata = async (
  whatsapp: unknown,
  channels: Array<{
    id: string;
    jid: string;
    name: string;
    subscribers: number;
    viewerRole: string | null;
    canSend: boolean | null;
  }>
) => {
  const resolver =
    whatsapp && typeof (whatsapp as { getChannelInfo?: unknown }).getChannelInfo === 'function'
      ? (whatsapp as { getChannelInfo: (jid: string) => Promise<Record<string, unknown> | null> }).getChannelInfo
      : null;
  if (!resolver || !channels.length) {
    return channels;
  }

  const capped = channels.slice(0, 80);
  const out = [...channels];
  for (let index = 0; index < capped.length; index += 1) {
    const candidate = capped[index];
    if (!candidate?.jid) continue;
    try {
      const enriched = await resolver(candidate.jid);
      if (!enriched) continue;
      const normalizedJid = normalizeChannelJid(enriched.jid || candidate.jid);
      if (!normalizedJid) continue;
      const existingIndex = out.findIndex((item) => item.jid === normalizedJid);
      if (existingIndex < 0) continue;
      const existing = out[existingIndex];
      if (!existing) continue;
      out[existingIndex] = {
        id: normalizedJid,
        jid: normalizedJid,
        name: String(enriched.name || existing.name || normalizedJid),
        subscribers: Math.max(0, Math.round(Number(enriched.subscribers || existing.subscribers || 0))),
        viewerRole: String(enriched.viewerRole || existing.viewerRole || '') || null,
        canSend:
          typeof enriched.canSend === 'boolean'
            ? enriched.canSend
            : typeof existing.canSend === 'boolean'
              ? existing.canSend
              : null
      };
    } catch {
      // best effort
    }
  }

  return out;
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
    const discovered = enriched?.channels || await whatsapp?.getChannels() || [];
    const savedTargets = await loadSavedChannelTargets();
    const knownFromMessages = await loadKnownChannelsFromMessages();
    const merged = mergeChannels(mergeChannels(discovered, savedTargets), knownFromMessages);
    res.json(await enrichChannelsWithMetadata(whatsapp, merged));
  }));

  router.get('/channels/diagnostics', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const savedTargets = await loadSavedChannelTargets();
    const knownFromMessages = await loadKnownChannelsFromMessages();
    if (!whatsapp) {
      const channels = mergeChannels(savedTargets, knownFromMessages);
      return res.json({
        channels,
        diagnostics: {
          methodsTried: [
            ...(savedTargets.length ? [`targets:${savedTargets.length}`] : []),
            ...(knownFromMessages.length ? [`chat_messages:${knownFromMessages.length}`] : [])
          ],
          methodErrors: [],
          sourceCounts: { api: 0, cache: channels.length, metadata: 0 },
          limitation: channels.length
            ? 'WhatsApp is not connected. Showing channels from saved targets and local message history.'
            : 'WhatsApp is not connected.'
        }
      });
    }

    if (typeof whatsapp.getChannelsWithDiagnostics === 'function') {
      const result = await whatsapp.getChannelsWithDiagnostics();
      const channels = await enrichChannelsWithMetadata(
        whatsapp,
        mergeChannels(mergeChannels(result.channels || [], savedTargets), knownFromMessages)
      );
      return res.json({
        channels,
        diagnostics: {
          methodsTried: [
            ...(result?.diagnostics?.methodsTried || []),
            ...(savedTargets.length ? [`targets:${savedTargets.length}`] : []),
            ...(knownFromMessages.length ? [`chat_messages:${knownFromMessages.length}`] : [])
          ],
          methodErrors: result?.diagnostics?.methodErrors || [],
          sourceCounts: {
            api: Number(result?.diagnostics?.sourceCounts?.api || 0),
            cache: Number(result?.diagnostics?.sourceCounts?.cache || 0) + savedTargets.length + knownFromMessages.length,
            metadata: Number(result?.diagnostics?.sourceCounts?.metadata || 0)
          },
          limitation:
            channels.length > 0
              ? null
              : result?.diagnostics?.limitation || 'No channels discovered for this WhatsApp session yet.'
        }
      });
    }

    const channels = await whatsapp.getChannels?.() || [];
    const merged = await enrichChannelsWithMetadata(
      whatsapp,
      mergeChannels(mergeChannels(channels, savedTargets), knownFromMessages)
    );
    return res.json({
      channels: merged,
      diagnostics: {
        methodsTried: [
          ...(savedTargets.length ? [`targets:${savedTargets.length}`] : []),
          ...(knownFromMessages.length ? [`chat_messages:${knownFromMessages.length}`] : [])
        ],
        methodErrors: [],
        sourceCounts: { api: channels.length, cache: savedTargets.length + knownFromMessages.length, metadata: 0 },
        limitation: merged.length ? null : 'Channel diagnostics are unavailable in this server build.'
      }
    });
  }));

  router.post('/channels/resolve', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const isConnected = Boolean(whatsapp && whatsapp?.getStatus?.()?.status === 'connected');

    const body = (req.body || {}) as Record<string, unknown>;
    const rawInput = body.channel || body.jid || body.id;
    const reference = normalizeChannelReference(rawInput);
    if (!reference.jid && !reference.inviteCode) {
      throw badRequest('channel id is required (numeric id, @newsletter jid, invite code, or whatsapp.com/channel URL)');
    }

    let channel: {
      id?: string;
      jid?: string;
      name?: string;
      subscribers?: number;
      viewerRole?: string | null;
      canSend?: boolean | null;
    } | null = null;

    if (isConnected && typeof whatsapp.getChannelInfo === 'function') {
      channel = await whatsapp.getChannelInfo(reference.jid || reference.inviteCode);
    }

    if (!channel && isConnected && typeof whatsapp.resolveChannel === 'function') {
      channel = await whatsapp.resolveChannel(reference.jid || reference.inviteCode);
    }

    if (!channel && isConnected && typeof whatsapp.getChannelsWithDiagnostics === 'function') {
      const discovered = await whatsapp.getChannelsWithDiagnostics();
      channel = (discovered?.channels || []).find((entry: { jid?: string }) => entry?.jid === reference.jid) || null;
    }

    if (!channel && reference.jid) {
      const savedTargets = await loadSavedChannelTargets();
      channel = savedTargets.find((entry) => entry.jid === reference.jid) || null;
    }

    if (!channel && reference.jid) {
      const knownFromMessages = await loadKnownChannelsFromMessages();
      channel = knownFromMessages.find((entry) => entry.jid === reference.jid) || null;
    }

    if (!channel && reference.inviteCode) {
      throw badRequest('Could not resolve this channel invite code. Make sure WhatsApp is connected and this account can access the channel.');
    }

    const fallbackName = String(body.name || '').trim();
    const output = channel
      ? {
          id: channel.jid || reference.jid || '',
          jid: channel.jid || reference.jid || '',
          name: String(channel.name || reference.jid || ''),
          subscribers: Math.max(0, Math.round(Number(channel.subscribers || 0))),
          viewerRole: channel.viewerRole || null,
          canSend: typeof channel.canSend === 'boolean' ? channel.canSend : null
        }
      : {
          id: reference.jid || '',
          jid: reference.jid || '',
          name: fallbackName || reference.jid || '',
          subscribers: 0,
          viewerRole: null,
          canSend: null
        };

    res.json({ found: Boolean(channel), channel: output });
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
    const { jid, message, imageUrl, videoUrl, mediaUrl, mediaType, thumbnailUrl, confirm } = req.body;
    const selectedMediaUrl = String(mediaUrl || videoUrl || imageUrl || '').trim() || null;
    const selectedMediaType: OutgoingMediaType | null =
      mediaType || (videoUrl ? 'video' : imageUrl ? 'image' : null);
    const normalizedMessage = normalizeMessageText(String(message || ''));

    if (!jid) {
      throw badRequest('jid is required');
    }

    if (whatsapp?.getStatus()?.status !== 'connected') {
      throw badRequest('WhatsApp is not connected');
    }

    const normalizedJid = normalizeTestJid(jid);
    const payload = await buildOutgoingContent({
      message: normalizedMessage,
      mediaUrl: selectedMediaUrl,
      mediaType: selectedMediaType,
      thumbnailUrl: thumbnailUrl || null
    });

    const sendPromise = isStatusBroadcast(normalizedJid)
      ? whatsapp.sendStatusBroadcast(payload.content)
      : whatsapp.sendMessage(normalizedJid, payload.content);
    const result = await withTimeout(
      sendPromise,
      DEFAULT_SEND_TIMEOUT_MS,
      'Timed out sending test message'
    );

    const messageId = result?.key?.id;
    let confirmation: { ok: boolean; via: string; status?: number | null; statusLabel?: string | null } | null = null;
    if (confirm && messageId && whatsapp?.confirmSend) {
      const timeouts = payload.mediaType !== 'text'
        ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
        : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 };
      confirmation = await whatsapp.confirmSend(messageId, timeouts);
    }

    await persistOutgoingChatSnapshot({
      messageId: messageId || null,
      remoteJid: normalizedJid,
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaType: payload.mediaType,
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
          media_url: payload.mediaUrl,
          media_type: payload.mediaType === 'text' ? null : payload.mediaType,
          media_sent: payload.mediaType !== 'text',
          media_error: null,
          sent_at: new Date().toISOString()
        });
      }
    } catch {
      // Best effort only: test-message logging should not fail the send endpoint.
    }

    res.json({ ok: true, messageId, mediaType: payload.mediaType, confirmation });
  }));

  // Send to status broadcast
  router.post('/send-status', validate(schemas.statusMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const { message, imageUrl, videoUrl, mediaUrl, mediaType, thumbnailUrl } = req.body;
    const selectedMediaUrl = String(mediaUrl || videoUrl || imageUrl || '').trim() || null;
    const selectedMediaType: OutgoingMediaType | null =
      mediaType || (videoUrl ? 'video' : imageUrl ? 'image' : null);
    const normalizedMessage = normalizeMessageText(String(message || ''));

    if (!normalizedMessage && !selectedMediaUrl) {
      throw badRequest('message or media URL is required');
    }

    if (whatsapp?.getStatus()?.status !== 'connected') {
      throw badRequest('WhatsApp is not connected');
    }

    const payload = await buildOutgoingContent({
      message: normalizedMessage,
      mediaUrl: selectedMediaUrl,
      mediaType: selectedMediaType,
      thumbnailUrl: thumbnailUrl || null
    });

    const result = await whatsapp.sendStatusBroadcast(payload.content);

    await persistOutgoingChatSnapshot({
      messageId: result?.key?.id || null,
      remoteJid: 'status@broadcast',
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaType: payload.mediaType,
      messageTimestamp: result?.messageTimestamp,
      source: 'send-status'
    });

    res.json({ ok: true, messageId: result?.key?.id, mediaType: payload.mediaType });
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
        hasVideo: Boolean(message?.videoMessage),
        hasText: Boolean(message?.conversation || message?.extendedTextMessage),
        hasVideoThumbnail: Boolean(
          (message?.videoMessage as Record<string, unknown>)?.jpegThumbnail ||
          (message?.videoMessage as Record<string, unknown>)?.thumbnailDirectPath
        ),
        hasCaption: Boolean(
          (message?.imageMessage as Record<string, unknown>)?.caption ||
          (message?.videoMessage as Record<string, unknown>)?.caption
        )
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
