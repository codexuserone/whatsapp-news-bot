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

const buildFriendlyChannelName = (name: string, jid: string) => {
  const normalizedJid = normalizeChannelJid(jid);
  const rawName = String(name || '').trim();
  if (!rawName || rawName === normalizedJid) return '';
  if (/^channel\s+\d+$/i.test(rawName)) return '';
  return rawName;
};

type DiscoveredTargetCandidate = {
  name: string;
  phone_number: string;
  type: 'group' | 'channel' | 'status';
  active: boolean;
  notes?: string | null;
};

type ResolveTargetType = 'auto' | 'group' | 'channel' | 'individual' | 'status';

const upsertDiscoveredTargets = async (
  supabase: ReturnType<typeof getSupabaseClient> | null,
  candidates: DiscoveredTargetCandidate[],
  options?: { deactivateMissingTypes?: Array<'group' | 'channel' | 'status'> }
) => {
  if (!supabase || !Array.isArray(candidates)) return;

  const deduped = new Map<string, DiscoveredTargetCandidate>();
  for (const candidate of candidates) {
    const type = candidate?.type;
    const rawPhone = String(candidate?.phone_number || '').trim();
    const phone = type === 'channel' ? normalizeChannelJid(rawPhone) : rawPhone;
    if (!phone) continue;
    deduped.set(phone, {
      ...candidate,
      phone_number: phone,
      name: String(candidate?.name || phone).trim() || phone,
      active: true,
      notes: candidate?.notes || null
    });
  }

  const phoneNumbers = Array.from(deduped.keys());
  if (phoneNumbers.length) {
    const { data: existingRows, error: existingError } = await supabase
      .from('targets')
      .select('id,name,phone_number,type,active,notes')
      .in('phone_number', phoneNumbers);

    if (existingError) {
      return;
    }

    const existingByPhone = new Map<string, {
      id: string;
      name?: string;
      phone_number?: string;
      type?: string;
      active?: boolean;
      notes?: string | null;
    }>();

    for (const row of (existingRows || []) as Array<{
      id?: string;
      name?: string;
      phone_number?: string;
      type?: string;
      active?: boolean;
      notes?: string | null;
    }>) {
      const phone = String(row.phone_number || '').trim();
      const id = String(row.id || '').trim();
      if (!phone || !id) continue;
      existingByPhone.set(phone, { ...row, id, phone_number: phone });
    }

    for (const candidate of deduped.values()) {
      const current = existingByPhone.get(candidate.phone_number);
      if (!current) {
        await supabase.from('targets').insert(candidate);
        continue;
      }

      const patch: Record<string, unknown> = {};
      if (String(current.name || '') !== String(candidate.name || '')) patch.name = candidate.name;
      if (String(current.type || '') !== String(candidate.type || '')) patch.type = candidate.type;
      if (current.active !== true) patch.active = true;
      if (String(current.notes || '') !== String(candidate.notes || '')) patch.notes = candidate.notes || null;

      if (!Object.keys(patch).length) continue;
      await supabase.from('targets').update(patch).eq('id', current.id);
    }
  }

  const deactivateTypes = Array.isArray(options?.deactivateMissingTypes)
    ? options?.deactivateMissingTypes || []
    : [];

  if (!deactivateTypes.length) return;

  const { data: activeRows, error: activeRowsError } = await supabase
    .from('targets')
    .select('id,phone_number,type')
    .eq('active', true)
    .in('type', deactivateTypes);

  if (activeRowsError || !Array.isArray(activeRows)) return;

  const discoveredByType = new Map<'group' | 'channel' | 'status', Set<string>>([
    ['group', new Set<string>()],
    ['channel', new Set<string>()],
    ['status', new Set<string>()]
  ]);
  for (const candidate of deduped.values()) {
    const key =
      candidate.type === 'channel'
        ? normalizeChannelJid(String(candidate.phone_number || '').trim())
        : String(candidate.phone_number || '').trim();
    if (!key || !discoveredByType.has(candidate.type)) continue;
    discoveredByType.get(candidate.type)?.add(key);
  }

  const idsToDeactivate: string[] = [];
  for (const row of activeRows as Array<{ id?: string; phone_number?: string; type?: string }>) {
    const id = String(row.id || '').trim();
    if (!id) continue;
    const type = String(row.type || '').trim();
    if (type !== 'group' && type !== 'channel' && type !== 'status') continue;
    const jidRaw = String(row.phone_number || '').trim();
    const jid = type === 'channel' ? normalizeChannelJid(jidRaw) : jidRaw;
    if (!jid) continue;
    const discovered = discoveredByType.get(type);
    if (discovered?.has(jid)) continue;
    idsToDeactivate.push(id);
  }

  if (!idsToDeactivate.length) return;
  await supabase.from('targets').update({ active: false }).in('id', idsToDeactivate);
};

const dedupeTargets = <T extends { jid?: string; id?: string }>(targets: T[]) => {
  const byJid = new Map<string, T>();
  for (const item of targets || []) {
    const jid = String(item?.jid || item?.id || '').trim().toLowerCase();
    if (!jid) continue;
    if (!byJid.has(jid)) byJid.set(jid, item);
  }
  return Array.from(byJid.values());
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
    const isConnected = whatsapp?.getStatus?.().status === 'connected';
    if (!isConnected) {
      return res.json([]);
    }

    const groups = dedupeTargets(await whatsapp?.getGroups() || []);
    if (supabase) {
      await upsertDiscoveredTargets(
        supabase,
        groups.map(
          (group: {
            jid?: string;
            name?: string;
            size?: number;
            participantCount?: number;
            announce?: boolean;
            restrict?: boolean;
            me?: { isAdmin?: boolean };
          }) => {
            const noteParts: string[] = [];
            if (Number.isFinite(group?.size)) {
              noteParts.push(`${Number(group?.size || 0)} members`);
            } else if (Number.isFinite(group?.participantCount)) {
              noteParts.push(`${Number(group?.participantCount || 0)} members`);
            }
            if (group?.me?.isAdmin) {
              noteParts.push('you are admin');
            }
            if (group?.announce) {
              noteParts.push('admin-only messages');
            }
            if (group?.restrict) {
              noteParts.push('admin-only settings');
            }
            return {
              name: String(group?.name || group?.jid || '').trim() || String(group?.jid || ''),
              phone_number: String(group?.jid || '').trim(),
              type: 'group' as const,
              active: true,
              notes: noteParts.length ? noteParts.join(' | ') : null
            };
          }
        ),
        { deactivateMissingTypes: ['group'] }
      );
    }
    
    res.json(groups);
  }));

  router.get('/channels', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const supabase = getSupabaseClient();
    const seededChannelJids = new Set<string>();
    const channelsByJid = new Map<string, {
      id: string;
      jid: string;
      name: string;
      subscribers: number;
      role: string | null;
      canPost: boolean;
      source: 'live' | 'verified_target';
    }>();
    const discoveredChannelCandidates: DiscoveredTargetCandidate[] = [];
    const isConnected = whatsapp?.getStatus?.().status === 'connected';
    if (!isConnected) {
      return res.json([]);
    }

    if (supabase) {
      const { data: savedChannelRows } = await supabase
        .from('targets')
        .select('phone_number')
        .eq('type', 'channel');
      for (const row of (savedChannelRows || []) as Array<{ phone_number?: string }>) {
        const jid = normalizeChannelJid(String(row?.phone_number || '').trim());
        if (!jid) continue;
        seededChannelJids.add(jid);
      }
    }
    
    if (whatsapp) {
      const enriched =
        typeof whatsapp.getChannelsWithDiagnostics === 'function'
          ? await whatsapp.getChannelsWithDiagnostics(Array.from(seededChannelJids))
          : null;
      const liveChannels = enriched?.channels || await whatsapp.getChannels?.(Array.from(seededChannelJids)) || [];
      for (const channel of liveChannels) {
        const jid = normalizeChannelJid(String(channel?.jid || '').trim());
        if (!jid) continue;
        const sourceTag = String((channel as { source?: string })?.source || '').toLowerCase();
        if (sourceTag === 'seed') continue;
        const friendlyName = buildFriendlyChannelName(String(channel?.name || ''), jid);
        if (!friendlyName) continue;
        const role = String((channel as { role?: string | null })?.role || '').trim() || null;
        const canPost = (channel as { canPost?: boolean })?.canPost === true;
        const isSeeded = seededChannelJids.has(jid);
        channelsByJid.set(jid.toLowerCase(), {
          id: jid,
          jid,
          name: friendlyName,
          subscribers: Number(channel?.subscribers || 0),
          role,
          canPost,
          source: isSeeded && sourceTag === 'metadata' ? 'verified_target' : 'live'
        });
        const noteParts: string[] = [];
        if (Number.isFinite(channel?.subscribers)) {
          noteParts.push(`${Number(channel?.subscribers || 0)} subscribers`);
        }
        if (role) {
          noteParts.push(`role: ${role.toLowerCase()}`);
        }
        if (canPost) {
          noteParts.push('can post');
        }
        discoveredChannelCandidates.push({
          name: friendlyName,
          phone_number: jid,
          type: 'channel',
          active: true,
          notes: noteParts.length ? noteParts.join(' | ') : null
        });
      }

      if (supabase) {
        await upsertDiscoveredTargets(supabase, discoveredChannelCandidates);
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
          sourceCounts: { api: 0, cache: 0, metadata: 0, store: 0 },
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
        sourceCounts: { api: 0, cache: 0, metadata: 0, store: 0 },
        limitation: channels.length ? null : 'Channel diagnostics are unavailable in this server build.'
      }
    });
  }));

  router.post('/resolve-target', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw badRequest('Database is not available');
    }

    const rawValue = String((req.body as { value?: unknown })?.value || '').trim();
    if (!rawValue) {
      throw badRequest('value is required');
    }

    const rawType = String((req.body as { type?: unknown })?.type || 'auto').trim().toLowerCase();
    const allowedTypes: ResolveTargetType[] = ['auto', 'group', 'channel', 'individual', 'status'];
    const requestedType: ResolveTargetType = allowedTypes.includes(rawType as ResolveTargetType)
      ? (rawType as ResolveTargetType)
      : 'auto';

    const isConnected = whatsapp?.getStatus?.().status === 'connected';
    if (!isConnected) {
      throw badRequest('WhatsApp is not connected');
    }

    const resolved =
      typeof whatsapp?.resolveDestination === 'function'
        ? await whatsapp.resolveDestination(rawValue, requestedType)
        : null;

    if (!resolved || !resolved.jid || !resolved.type) {
      throw badRequest('Could not resolve this WhatsApp link/JID in the current session');
    }

    if (resolved.type === 'individual' && resolved.exists === false) {
      throw badRequest('This number is not on WhatsApp');
    }

    const targetType =
      resolved.type === 'group' || resolved.type === 'channel' || resolved.type === 'status' || resolved.type === 'individual'
        ? resolved.type
        : null;

    if (!targetType) {
      throw badRequest('Unsupported destination type');
    }

    const notesParts: string[] = [];
    if (resolved.type === 'group') {
      if (Number.isFinite(Number(resolved.size))) {
        notesParts.push(`${Number(resolved.size || 0)} members`);
      } else if (Number.isFinite(Number(resolved.participantCount))) {
        notesParts.push(`${Number(resolved.participantCount || 0)} members`);
      }
      if (resolved?.me?.isAdmin) {
        notesParts.push('you are admin');
      }
      if (resolved.announce) {
        notesParts.push('admin-only messages');
      }
      if (resolved.restrict) {
        notesParts.push('admin-only settings');
      }
    } else if (resolved.type === 'channel') {
      if (Number.isFinite(Number(resolved.subscribers))) {
        notesParts.push(`${Number(resolved.subscribers || 0)} subscribers`);
      }
      if (resolved.role) {
        notesParts.push(`role: ${String(resolved.role).toLowerCase()}`);
      }
      if (resolved.canPost) {
        notesParts.push('can post');
      }
    } else if (resolved.type === 'status') {
      notesParts.push('Posts to your WhatsApp Status');
    }

    const payload = {
      name: String(resolved.name || resolved.jid).trim() || String(resolved.jid).trim(),
      phone_number: String(resolved.jid).trim(),
      type: targetType,
      active: true,
      notes: notesParts.length ? notesParts.join(' | ') : null
    };

    const { data: existingRows, error: existingError } = await supabase
      .from('targets')
      .select('*')
      .eq('phone_number', payload.phone_number)
      .order('created_at', { ascending: false });

    if (existingError) throw existingError;

    const existingList = Array.isArray(existingRows) ? existingRows : [];
    const primaryExisting = existingList[0] as { id?: string } | undefined;
    let targetRecord: Record<string, unknown> | null = null;

    if (primaryExisting?.id) {
      const { data: updated, error: updateError } = await supabase
        .from('targets')
        .update(payload)
        .eq('id', primaryExisting.id)
        .select()
        .single();
      if (updateError) throw updateError;
      targetRecord = updated || null;

      const duplicateIds = existingList
        .slice(1)
        .map((row: { id?: string }) => String(row.id || '').trim())
        .filter(Boolean);
      if (duplicateIds.length) {
        await supabase.from('targets').update({ active: false }).in('id', duplicateIds);
      }
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('targets')
        .insert(payload)
        .select()
        .single();
      if (insertError) throw insertError;
      targetRecord = inserted || null;
    }

    res.json({
      ok: true,
      resolved,
      target: targetRecord
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
