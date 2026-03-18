import type { Request, Response } from 'express';
const express = require('express');
const { validate, schemas } = require('../middleware/validation');
const asyncHandler = require('../middleware/asyncHandler');
const { badRequest, conflict } = require('../core/errors');
const withTimeout = require('../utils/withTimeout');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { safeAxiosRequest } = require('../utils/safeAxios');
const { getErrorMessage } = require('../utils/errorUtils');
const { getSupabaseClient } = require('../db/supabase');
const { normalizeMessageText } = require('../utils/messageText');
const { ensureWhatsAppConnected, ensureWhatsAppReadyForOutbound } = require('../services/whatsappConnection');
const { ensureFreshStatusRecipients, getStatusRecipientSnapshot, refreshStatusRecipients } = require('../services/statusAudienceService');
const { isNewsletterJid, prepareNewsletterImage, prepareNewsletterVideo } = require('../utils/whatsappMedia');
const { buildDefaultUserAgent } = require('../utils/httpClientIdentity');
const { normalizeChannelJid, isValidChannelJid } = require('../utils/targetJid');
const { WHATSAPP_STATUS_ENABLED, WHATSAPP_STATUS_DISABLED_REASON } = require('../config/features');

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const GROUP_SEND_TIMEOUT_MS = 60000;
const GROUP_MEDIA_SEND_TIMEOUT_MS = 90000;
const DEFAULT_USER_AGENT = buildDefaultUserAgent();
const SUPPORTED_WHATSAPP_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

type TestSendConfirmation = {
  ok: boolean;
  via: string;
  status?: number | null;
  statusLabel?: string | null;
};

type TestSendLogResolution = {
  status: 'sent' | 'delivered' | 'read' | 'played' | 'uncertain';
  errorMessage: string | null;
  sentAt: string | null;
};

const setNoStoreHeaders = (res: Response) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
};

const buildUncertainSendMessage = (value: unknown) => {
  const message = String(value || '').trim();
  if (!message) {
    return 'Send result is uncertain. Verifying delivery before retrying.';
  }
  return `Send result is uncertain. Verifying delivery before retrying. ${message}`.trim();
};

const resolveTestSendLogResolution = (options: {
  messageId?: string | null;
  confirmRequested?: boolean;
  confirmation?: TestSendConfirmation | null;
  confirmedAt?: string;
}) => {
  const messageId = String(options.messageId || '').trim();
  const confirmRequested = options.confirmRequested !== false;
  const confirmation = options.confirmation || null;
  const confirmedAt = String(options.confirmedAt || new Date().toISOString());

  if (!messageId) {
    return {
      status: 'uncertain',
      errorMessage: buildUncertainSendMessage('Missing WhatsApp message id'),
      sentAt: null
    } satisfies TestSendLogResolution;
  }

  if (confirmation?.ok) {
    const statusLabel = String(confirmation.statusLabel || '').trim().toLowerCase();
    return {
      status:
        statusLabel === 'delivered' || statusLabel === 'read' || statusLabel === 'played'
          ? (statusLabel as 'delivered' | 'read' | 'played')
          : 'sent',
      errorMessage: null,
      sentAt: confirmedAt
    } satisfies TestSendLogResolution;
  }

  if (!confirmRequested) {
    return {
      status: 'uncertain',
      errorMessage: buildUncertainSendMessage('Confirmation check was skipped'),
      sentAt: null
    } satisfies TestSendLogResolution;
  }

  const statusLabel = String(confirmation?.statusLabel || '').trim();
  const via = String(confirmation?.via || '').trim();
  const detail = statusLabel
    ? `No confirmation yet (${statusLabel})`
    : via
      ? `No confirmation yet (${via})`
      : 'No confirmation yet';

  return {
    status: 'uncertain',
    errorMessage: buildUncertainSendMessage(detail),
    sentAt: null
  } satisfies TestSendLogResolution;
};

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

const isGroupJid = (value: string) => String(value || '').trim().endsWith('@g.us');

const resolveSendTestTimeoutMs = (jid: string, mediaType: string | null) => {
  if (!isGroupJid(jid)) return DEFAULT_SEND_TIMEOUT_MS;
  return mediaType ? GROUP_MEDIA_SEND_TIMEOUT_MS : GROUP_SEND_TIMEOUT_MS;
};

const toOriginOrUndefined = (value?: string | null) => {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const downloadImageBuffer = async (url: string, refererUrl?: string | null) => {
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const refererOrigin = toOriginOrUndefined(refererUrl);
  const response = await safeAxiosRequest(url, {
    timeout: DEFAULT_SEND_TIMEOUT_MS,
    responseType: 'arraybuffer',
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      // Prefer source JPEG/PNG files so CDNs do not transparently re-encode them to WebP.
      Accept: 'image/jpeg,image/png,image/apng,image/*;q=0.9,*/*;q=0.8',
      ...(refererOrigin ? { Referer: refererOrigin } : {})
    }
  });
  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  const data = response.data;
  let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buffer.length) {
    throw new Error('Image download returned empty body');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${buffer.length} bytes)`);
  }

  let preparedMime: string | null = null;
  try {
    const prepared = await prepareNewsletterImage(buffer, { maxBytes: MAX_IMAGE_BYTES });
    if (Buffer.isBuffer(prepared?.buffer) && prepared.buffer.length) {
      buffer = prepared.buffer;
    }
    preparedMime = String(prepared?.mimetype || '').trim().toLowerCase() || null;
  } catch {
    // Fall through to the raw detection checks below.
  }

  let detectedMime = preparedMime || detectImageMimeTypeFromBuffer(buffer);

  // Some sites return formats like AVIF/SVG/GIF even when we prefer jpeg/png/webp.
  // If sharp is available, transcode to JPEG so WhatsApp uploads work reliably.
  if (!detectedMime || !SUPPORTED_WHATSAPP_IMAGE_MIME.has(detectedMime)) {
    const baseContentType = contentType.split(';')[0]?.trim() || '';
    const isProbablyImage =
      baseContentType.startsWith('image/') || baseContentType === '' || baseContentType === 'application/octet-stream';
    if (!isProbablyImage) {
      throw new Error('URL did not return an image');
    }

    try {
      const prepared = await prepareNewsletterImage(buffer, { maxBytes: MAX_IMAGE_BYTES });
      buffer = prepared.buffer;
      detectedMime = prepared.mimetype;
    } catch {
      // fall through
    }
  }

  if (!detectedMime || !SUPPORTED_WHATSAPP_IMAGE_MIME.has(detectedMime)) {
    throw new Error('Unsupported or corrupt image data for WhatsApp upload');
  }

  return { buffer, mimetype: detectedMime };
};

const downloadVideoBuffer = async (url: string, refererUrl?: string | null) => {
  const MAX_VIDEO_BYTES = Math.max(
    1,
    Math.floor(Number(process.env.MAX_VIDEO_BYTES || process.env.WHATSAPP_MAX_VIDEO_BYTES || 32 * 1024 * 1024))
  );
  const refererOrigin = toOriginOrUndefined(refererUrl);
  const response = await safeAxiosRequest(url, {
    timeout: Math.max(DEFAULT_SEND_TIMEOUT_MS, 30000),
    responseType: 'arraybuffer',
    maxContentLength: MAX_VIDEO_BYTES,
    maxBodyLength: MAX_VIDEO_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      ...(refererOrigin ? { Referer: refererOrigin } : {})
    }
  });
  const data = response.data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buffer.length) {
    throw new Error('Video download returned empty body');
  }
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(`Video too large (${buffer.length} bytes)`);
  }

  // MP4 typically contains "ftyp" at offset 4.
  const hasMp4Signature = buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
  if (!hasMp4Signature) {
    throw new Error('Unsupported or corrupt video data for WhatsApp upload (expected mp4)');
  }

  return { buffer, mimetype: 'video/mp4' };
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

  // WhatsApp media uploads are strict; require an MP4 container signature to avoid sending junk
  // (or HTML error pages) as "video/*". MP4/MOV commonly contain "ftyp" at offset 4.
  const hasMp4Signature =
    buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
  if (!hasMp4Signature) {
    throw badRequest('videoDataUrl must be an mp4 video');
  }

  // Force mimetype to mp4 for consistency with WhatsApp expectations.
  const finalMime = mimetype === 'video/mp4' ? mimetype : 'video/mp4';
  return { buffer, mimetype: finalMime };
};

const parseAudioDataUrl = (value: string) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match || !match[1] || !match[2]) {
    throw badRequest('audioDataUrl must be a valid base64 audio data URL');
  }

  const mimetype = String(match[1]).toLowerCase();
  const base64 = String(match[2]).replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
  if (!buffer.length) {
    throw badRequest('audioDataUrl is empty');
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw badRequest(`Audio too large (${buffer.length} bytes)`);
  }
  return { buffer, mimetype };
};

const parseDocumentDataUrl = (value: string, fallbackFilename?: string | null) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([a-zA-Z0-9.+/-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match || !match[1] || !match[2]) {
    throw badRequest('documentDataUrl must be a valid base64 document data URL');
  }

  const mimetype = String(match[1]).toLowerCase();
  const base64 = String(match[2]).replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
  if (!buffer.length) {
    throw badRequest('documentDataUrl is empty');
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw badRequest(`Document too large (${buffer.length} bytes)`);
  }
  return {
    buffer,
    mimetype,
    fileName: String(fallbackFilename || 'attachment').trim() || 'attachment'
  };
};

const downloadAudioBuffer = async (url: string, refererUrl?: string | null) => {
  const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
  const refererOrigin = toOriginOrUndefined(refererUrl);
  const response = await safeAxiosRequest(url, {
    timeout: Math.max(DEFAULT_SEND_TIMEOUT_MS, 30000),
    responseType: 'arraybuffer',
    maxContentLength: MAX_AUDIO_BYTES,
    maxBodyLength: MAX_AUDIO_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'audio/*;q=0.9,*/*;q=0.8',
      ...(refererOrigin ? { Referer: refererOrigin } : {})
    }
  });
  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  if (!buffer.length) throw badRequest('Audio download returned empty body');
  if (buffer.length > MAX_AUDIO_BYTES) throw badRequest(`Audio too large (${buffer.length} bytes)`);
  const contentTypeHeader = String(response.headers?.['content-type'] || 'audio/mpeg');
  const mimetype = (contentTypeHeader.split(';')[0] || 'audio/mpeg').trim().toLowerCase() || 'audio/mpeg';
  if (!mimetype.startsWith('audio/')) throw badRequest('audioUrl did not return audio data');
  return { buffer, mimetype };
};

const downloadDocumentBuffer = async (url: string, refererUrl?: string | null) => {
  const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
  const refererOrigin = toOriginOrUndefined(refererUrl);
  const response = await safeAxiosRequest(url, {
    timeout: Math.max(DEFAULT_SEND_TIMEOUT_MS, 30000),
    responseType: 'arraybuffer',
    maxContentLength: MAX_DOCUMENT_BYTES,
    maxBodyLength: MAX_DOCUMENT_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/*,text/plain,text/csv;q=0.9,*/*;q=0.8',
      ...(refererOrigin ? { Referer: refererOrigin } : {})
    }
  });
  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  if (!buffer.length) throw badRequest('Document download returned empty body');
  if (buffer.length > MAX_DOCUMENT_BYTES) throw badRequest(`Document too large (${buffer.length} bytes)`);
  const contentTypeHeader = String(response.headers?.['content-type'] || 'application/octet-stream');
  const mimetype = (contentTypeHeader.split(';')[0] || 'application/octet-stream').trim().toLowerCase() || 'application/octet-stream';
  const filenameHeader = String(response.headers?.['content-disposition'] || '');
  const filenameMatch = filenameHeader.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  const fileName = filenameMatch?.[1] ? decodeURIComponent(filenameMatch[1]).replace(/"/g, '').trim() : 'attachment';
  return { buffer, mimetype, fileName };
};

const normalizeDisplayText = (value: unknown) => String(value || '').replace(/\s+/g, ' ').trim();

const stripTargetTypeTags = (value: string) =>
  String(value || '')
    .replace(/\((group|channel|status|individual)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasRawJidLabel = (value: string) =>
  /@(g\.us|newsletter(?:_[a-z0-9_-]+)?|s\.whatsapp\.net|lid)\b/i.test(String(value || '').trim());
const isNumericOnlyLabel = (value: string) => /^\d{6,}$/.test(String(value || '').trim());
const hasOnlyDigitsAndSeparators = (value: string) => /^[\d\s._-]{6,}$/.test(String(value || '').trim());
const isPlaceholderChannelName = (value: string) => /^channel[\s_-]*\d+$/i.test(String(value || '').trim());

const normalizeTargetName = (name: unknown, type: 'group' | 'channel' | 'status' | 'individual', fallback: string) => {
  const fallbackText = normalizeDisplayText(fallback);
  let cleaned = normalizeDisplayText(name);
  if (!cleaned) {
    return type === 'status' ? 'My Status' : fallbackText;
  }

  if (/\btarget\b/i.test(cleaned)) {
    const beforeTarget = normalizeDisplayText(cleaned.split(/\btarget\b/i)[0]);
    if (beforeTarget.length >= 3) {
      cleaned = beforeTarget;
    }
  }

  const repeatedTypeMentions = (cleaned.match(/\((group|channel|status|individual)\)/gi) || []).length;
  if (repeatedTypeMentions > 1) {
    const firstSegment = normalizeDisplayText(cleaned.split(/\((group|channel|status|individual)\)/i)[0]);
    if (firstSegment) {
      cleaned = firstSegment;
    }
  }

  cleaned = stripTargetTypeTags(cleaned);
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6) {
    const half = Math.floor(tokens.length / 2);
    const left = tokens.slice(0, half).join(' ').toLowerCase();
    const right = tokens.slice(half).join(' ').toLowerCase();
    if (left && left === right) {
      cleaned = tokens.slice(0, half).join(' ');
    }
  }
  if (!cleaned) {
    return type === 'status' ? 'My Status' : fallbackText;
  }

  if (type === 'channel') {
    if (isPlaceholderChannelName(cleaned)) return '';
    if (isNumericOnlyLabel(cleaned)) return '';
    if (hasOnlyDigitsAndSeparators(cleaned)) return '';
    if (hasRawJidLabel(cleaned)) return '';
  } else if (hasRawJidLabel(cleaned) && cleaned.toLowerCase() === fallbackText.toLowerCase()) {
    return type === 'status' ? 'My Status' : fallbackText;
  }

  return cleaned;
};

const buildFriendlyChannelName = (name: string, jid: string) => {
  const normalizedJid = normalizeChannelJid(jid);
  const normalized = normalizeTargetName(name, 'channel', normalizedJid);
  if (!normalized || normalized.toLowerCase() === normalizedJid.toLowerCase()) return '';
  return normalized;
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
    const normalizedName = normalizeTargetName(candidate?.name, type, phone);
    if (type === 'channel' && !normalizedName) continue;
    deduped.set(phone, {
      ...candidate,
      phone_number: phone,
      name: normalizedName || (type === 'status' ? 'My Status' : phone),
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

type ChannelDiscoveryDiagnostics = {
  methodsTried: string[];
  methodErrors: string[];
  sourceCounts: {
    api: number;
    cache: number;
    metadata: number;
    store: number;
  };
  seeded?: {
    provided?: number;
    verified?: number;
    failed?: number;
    failedJids?: string[];
  };
  limitation: string | null;
};

type ChannelDiscoveryResult = {
  channels: Array<{
    id: string;
    jid: string;
    name: string;
    subscribers: number;
    role: string | null;
    canPost: boolean;
    source: 'live' | 'verified_target';
  }>;
  diagnostics: ChannelDiscoveryDiagnostics;
  persisted: {
    candidates: number;
  };
};

const discoverChannelsForSession = async (
  whatsapp: any,
  supabase: ReturnType<typeof getSupabaseClient> | null,
  options?: { persistTargets?: boolean; strictDeactivateMissing?: boolean; liveOnly?: boolean }
): Promise<ChannelDiscoveryResult> => {
  const defaultDiagnostics: ChannelDiscoveryDiagnostics = {
    methodsTried: [],
    methodErrors: [],
    sourceCounts: { api: 0, cache: 0, metadata: 0, store: 0 },
    seeded: { provided: 0, verified: 0, failed: 0, failedJids: [] },
    limitation: null
  };
  const isConnected = whatsapp?.getStatus?.().status === 'connected';
  if (!isConnected) {
    return {
      channels: [],
      diagnostics: { ...defaultDiagnostics, limitation: 'WhatsApp is not connected.' },
      persisted: { candidates: 0 }
    };
  }

  const seededChannelJids = new Set<string>();
  const savedChannelByJid = new Map<string, { jid: string; name: string }>();
  if (supabase) {
    const { data: savedChannelRows } = await supabase
      .from('targets')
      .select('phone_number,name,active')
      .eq('type', 'channel')
      .eq('active', true);
    for (const row of (savedChannelRows || []) as Array<{ phone_number?: string; name?: string; active?: boolean }>) {
      const jid = normalizeChannelJid(String(row?.phone_number || '').trim());
      if (!jid || !isValidChannelJid(jid)) continue;
      seededChannelJids.add(jid);
      const savedName = buildFriendlyChannelName(String(row?.name || ''), jid);
      if (savedName) {
        savedChannelByJid.set(jid.toLowerCase(), { jid, name: savedName });
      }
    }
  }

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

  const enriched =
    typeof whatsapp?.getChannelsWithDiagnostics === 'function'
      ? await whatsapp.getChannelsWithDiagnostics(Array.from(seededChannelJids))
      : null;
  const liveChannels = enriched?.channels || await whatsapp?.getChannels?.(Array.from(seededChannelJids)) || [];

  for (const channel of liveChannels) {
    const jid = normalizeChannelJid(String(channel?.jid || '').trim());
    if (!jid || !isValidChannelJid(jid)) continue;
    const sourceTag = String((channel as { source?: string })?.source || '').toLowerCase();
    if (sourceTag === 'seed') continue;
    const savedFallback = savedChannelByJid.get(jid.toLowerCase())?.name || '';
    const friendlyName = buildFriendlyChannelName(String(channel?.name || ''), jid) || savedFallback;
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
      source:
        isSeeded && (sourceTag === 'metadata' || sourceTag === 'cache' || sourceTag === 'store')
          ? 'verified_target'
          : 'live'
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

  if (supabase && options?.persistTargets !== false) {
    const shouldDeactivateMissingChannels =
      options?.strictDeactivateMissing === true || discoveredChannelCandidates.length > 0;
    await upsertDiscoveredTargets(supabase, discoveredChannelCandidates, {
      deactivateMissingTypes: shouldDeactivateMissingChannels ? ['channel'] : []
    });
  }

  const allChannels = Array.from(channelsByJid.values()).sort((a, b) => a.name.localeCompare(b.name));
  const channels = options?.liveOnly
    ? allChannels.filter((channel) => channel.source === 'live')
    : allChannels;
  const diagnostics = (enriched?.diagnostics || defaultDiagnostics) as ChannelDiscoveryDiagnostics;
  if (channels.length > 0) {
    diagnostics.limitation = null;
  } else if (options?.liveOnly && allChannels.length > 0) {
    diagnostics.limitation = 'Only saved/verified channels were found. No live channel list is available in this session yet.';
  } else if (!diagnostics.limitation) {
    diagnostics.limitation = 'No channels discovered in this session yet. Open channels in WhatsApp, then run discovery again.';
  }

  return {
    channels,
    diagnostics,
    persisted: {
      candidates: discoveredChannelCandidates.length
    }
  };
};

const whatsappRoutes = () => {
  const router = express.Router();

  router.get('/status', asyncHandler(async (req: Request, res: Response) => {
    setNoStoreHeaders(res);
    const whatsapp = req.app.locals.whatsapp;
    res.json(whatsapp?.getStatus() || { status: 'disconnected' });
  }));

  router.get('/qr', asyncHandler(async (req: Request, res: Response) => {
    setNoStoreHeaders(res);
    const whatsapp = req.app.locals.whatsapp;
    res.json(
      whatsapp?.getQrState?.() || {
        qr: null,
        generatedAt: null,
        expiresAt: null,
        ttlMs: null,
        remainingMs: null
      }
    );
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
              name: normalizeTargetName(group?.name, 'group', String(group?.jid || '').trim()) || String(group?.jid || ''),
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
    try {
      // Return both live and verified saved channels so the UI does not appear empty
      // when this Baileys session cannot provide a full live channel list.
      const result = await discoverChannelsForSession(whatsapp, supabase, { persistTargets: true, liveOnly: false });
      res.json(result.channels);
    } catch (error) {
      console.warn('Channel discovery failed, returning empty list', error);
      res.json([]);
    }
  }));

  router.get('/channels/diagnostics', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const supabase = getSupabaseClient();
    try {
      const result = await discoverChannelsForSession(whatsapp, supabase, { persistTargets: false });
      res.json(result);
    } catch (error) {
      res.json({
        channels: [],
        diagnostics: {
          methodsTried: [],
          methodErrors: [getErrorMessage(error)],
          sourceCounts: { api: 0, cache: 0, metadata: 0, store: 0 },
          seeded: { provided: 0, verified: 0, failed: 0, failedJids: [] },
          limitation: 'Channel discovery failed in this session.'
        },
        persisted: { candidates: 0 }
      });
    }
  }));

  router.post('/channels/discover', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const supabase = getSupabaseClient();
    const result = await discoverChannelsForSession(whatsapp, supabase, {
      persistTargets: true,
      strictDeactivateMissing: true
    });
    res.json({
      ok: true,
      discovered: result.channels.length,
      persisted: result.persisted,
      channels: result.channels,
      diagnostics: result.diagnostics
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
      name: normalizeTargetName(resolved.name, targetType, String(resolved.jid || '').trim()) || String(resolved.jid).trim(),
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

  router.post('/pause', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.pause !== 'function') {
      throw badRequest('WhatsApp client not available');
    }
    await whatsapp.pause();
    res.json({ ok: true });
  }));

  router.post('/resume', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || typeof whatsapp.resume !== 'function') {
      throw badRequest('WhatsApp client not available');
    }
    await whatsapp.resume();
    res.json({ ok: true });
  }));

  router.post('/hard-refresh', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const force = Boolean((req.body as { force?: unknown } | undefined)?.force);
    const refreshState =
      typeof whatsapp?.getHardRefreshState === 'function'
        ? whatsapp.getHardRefreshState(force)
        : { allowed: true, reason: null };
    if (!refreshState.allowed) {
      throw conflict(refreshState.reason || 'Hard refresh is not allowed right now.');
    }
    await whatsapp?.hardRefresh({ force });
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
    if (raw.toLowerCase().includes('@newsletter')) return normalizeChannelJid(raw);
    if (raw.includes('@')) return raw;
    return `${raw.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  };

  const isStatusBroadcast = (jid: string) => jid === 'status@broadcast';

  // Send a test message
  router.post('/send-test', validate(schemas.testMessage), asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    const payload = req.body as {
      jid?: string | null;
      jids?: string[] | null;
      message?: string | null;
      linkUrl?: string | null;
      imageUrl?: string | null;
      videoUrl?: string | null;
      audioUrl?: string | null;
      documentUrl?: string | null;
      imageDataUrl?: string | null;
      videoDataUrl?: string | null;
      audioDataUrl?: string | null;
      documentDataUrl?: string | null;
      documentFilename?: string | null;
      documentMime?: string | null;
      statusJidList?: string[] | null;
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
    if (!WHATSAPP_STATUS_ENABLED && normalizedJids.some((jid) => isStatusBroadcast(jid))) {
      throw badRequest(WHATSAPP_STATUS_DISABLED_REASON);
    }
    const normalizedMessage = normalizeMessageText(String(payload.message || ''));
    const normalizedLink = String(payload.linkUrl || '').trim();
    const imageUrl = payload.imageUrl ? String(payload.imageUrl).trim() : null;
    const videoUrl = payload.videoUrl ? String(payload.videoUrl).trim() : null;
    const audioUrl = payload.audioUrl ? String(payload.audioUrl).trim() : null;
    const documentUrl = payload.documentUrl ? String(payload.documentUrl).trim() : null;
    const imageDataUrl = payload.imageDataUrl ? String(payload.imageDataUrl).trim() : null;
    const videoDataUrl = payload.videoDataUrl ? String(payload.videoDataUrl).trim() : null;
    const audioDataUrl = payload.audioDataUrl ? String(payload.audioDataUrl).trim() : null;
    const documentDataUrl = payload.documentDataUrl ? String(payload.documentDataUrl).trim() : null;
    const documentFilename = payload.documentFilename ? String(payload.documentFilename).trim() : null;
    const documentMime = payload.documentMime ? String(payload.documentMime).trim() : null;
    const explicitStatusJidList = Array.isArray(payload.statusJidList)
      ? payload.statusJidList.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const disableLinkPreview = payload.disableLinkPreview === true;
    const confirmationRequired = payload.confirm !== false;
	    const includeCaption = payload.includeCaption !== false;
	    const captionText = [normalizedMessage, normalizedLink].filter(Boolean).join('\n').trim();
	    if (!captionText && !imageUrl && !videoUrl && !audioUrl && !documentUrl && !imageDataUrl && !videoDataUrl && !audioDataUrl && !documentDataUrl) {
	      throw badRequest('message, linkUrl, imageUrl, videoUrl, audioUrl, documentUrl, imageDataUrl, videoDataUrl, audioDataUrl, or documentDataUrl is required');
	    }

	    const requestedMediaType =
        videoDataUrl || videoUrl
          ? 'video'
          : audioDataUrl || audioUrl
            ? 'audio'
            : documentDataUrl || documentUrl
              ? 'document'
              : imageDataUrl || imageUrl
                ? 'image'
                : null;
	    const requestedMediaUrl = videoUrl || audioUrl || documentUrl || imageUrl || null;
	    let mediaWarning: string | null = null;
	    const connected = await ensureWhatsAppReadyForOutbound(whatsapp, {
	      attempts: 8,
	      delayMs: 900,
	      triggerReconnect: true,
	      triggerTakeover: true,
	      logContext: 'send-test route'
	    });
	    if (!connected) {
	      throw badRequest('WhatsApp is not connected');
	    }

    let content: Record<string, unknown>;
    if (videoDataUrl) {
      const { buffer, mimetype } = parseVideoDataUrl(videoDataUrl);
      content = includeCaption && captionText
        ? { video: buffer, mimetype, caption: captionText }
        : { video: buffer, mimetype };
    } else if (videoUrl) {
      if (!isHttpUrl(videoUrl)) {
        throw badRequest('videoUrl must be an http(s) URL');
      }
      try {
        await assertSafeOutboundUrl(videoUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'videoUrl is not allowed'));
      }
      try {
        const { buffer, mimetype } = await downloadVideoBuffer(videoUrl, normalizedLink || null);
        content = includeCaption && captionText
          ? { video: buffer, mimetype, caption: captionText }
          : { video: buffer, mimetype };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to download videoUrl');
        if (!captionText) {
          throw badRequest(message);
        }
        mediaWarning = message;
        content = disableLinkPreview ? { text: captionText, linkPreview: null } : { text: captionText };
      }
    } else if (audioDataUrl) {
      const { buffer, mimetype } = parseAudioDataUrl(audioDataUrl);
      content = { audio: buffer, mimetype, ptt: false };
    } else if (audioUrl) {
      if (!isHttpUrl(audioUrl)) {
        throw badRequest('audioUrl must be an http(s) URL');
      }
      try {
        await assertSafeOutboundUrl(audioUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'audioUrl is not allowed'));
      }
      try {
        const { buffer, mimetype } = await downloadAudioBuffer(audioUrl, normalizedLink || null);
        content = { audio: buffer, mimetype, ptt: false };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to download audioUrl');
        if (!captionText) {
          throw badRequest(message);
        }
        mediaWarning = message;
        content = disableLinkPreview ? { text: captionText, linkPreview: null } : { text: captionText };
      }
    } else if (documentDataUrl) {
      const { buffer, mimetype, fileName } = parseDocumentDataUrl(documentDataUrl, documentFilename);
      content = {
        document: buffer,
        mimetype: documentMime || mimetype,
        fileName: documentFilename || fileName || 'attachment',
        ...(includeCaption && captionText ? { caption: captionText } : {})
      };
    } else if (documentUrl) {
      if (!isHttpUrl(documentUrl)) {
        throw badRequest('documentUrl must be an http(s) URL');
      }
      try {
        await assertSafeOutboundUrl(documentUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'documentUrl is not allowed'));
      }
      try {
        const { buffer, mimetype, fileName } = await downloadDocumentBuffer(documentUrl, normalizedLink || null);
        content = {
          document: buffer,
          mimetype: documentMime || mimetype,
          fileName: documentFilename || fileName || 'attachment',
          ...(includeCaption && captionText ? { caption: captionText } : {})
        };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to download documentUrl');
        if (!captionText) {
          throw badRequest(message);
        }
        mediaWarning = message;
        content = disableLinkPreview ? { text: captionText, linkPreview: null } : { text: captionText };
      }
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
	        const { buffer, mimetype } = await downloadImageBuffer(imageUrl, normalizedLink || null);
	        content = includeCaption && captionText
	          ? (mimetype
	            ? { image: buffer, mimetype, caption: captionText }
	            : { image: buffer, caption: captionText })
	          : (mimetype
	            ? { image: buffer, mimetype }
	            : { image: buffer });
	      } catch (error) {
	        const message = getErrorMessage(error, 'Failed to download imageUrl');
	        // Avoid URL-based sends: Baileys fetches without our headers and can end up uploading empty media.
	        if (!captionText) {
	          throw badRequest(message);
	        }
	        mediaWarning = message;
	        content = disableLinkPreview ? { text: captionText, linkPreview: null } : { text: captionText };
	      }
	    } else {
	      content = disableLinkPreview ? { text: captionText, linkPreview: null } : { text: captionText };
	    }

	    const results: Array<{
	      jid: string;
	      ok: boolean;
	      messageId?: string | null;
          confirmed?: boolean;
	      confirmation?: { ok: boolean; via: string; status?: number | null; statusLabel?: string | null } | null;
	      warning?: string;
	      error?: string;
	    }> = [];

    for (const normalizedJid of normalizedJids) {
      try {
        if (isStatusBroadcast(normalizedJid) && (requestedMediaType === 'audio' || requestedMediaType === 'document')) {
          throw badRequest('Status only supports text, image, and video');
        }
        let effectiveContent: Record<string, unknown> = content;

        // Baileys uses a special raw-media path for newsletters; in practice it is far pickier
        // about media payloads. Normalize newsletter media (image/video) and include thumbnails/dimensions.
        if (isNewsletterJid(normalizedJid)) {
          const videoValue = (content as any)?.video;
          if (Buffer.isBuffer(videoValue)) {
            try {
              const prepared = await prepareNewsletterVideo(videoValue, { maxBytes: 32 * 1024 * 1024 });
              effectiveContent = {
                ...effectiveContent,
                video: prepared.buffer,
                mimetype: prepared.mimetype || (effectiveContent as any)?.mimetype,
                ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
                ...(typeof prepared.seconds === 'number' ? { seconds: prepared.seconds } : {}),
                ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
                ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
              };
            } catch {
              // Best-effort only; fall back to the original payload.
              effectiveContent = effectiveContent;
            }
          }

          const imageValue = (content as any)?.image;
          if (Buffer.isBuffer(imageValue)) {
            try {
              const prepared = await prepareNewsletterImage(imageValue, { maxBytes: 8 * 1024 * 1024 });
              effectiveContent = {
                ...content,
                image: prepared.buffer,
                mimetype: prepared.mimetype || (content as any)?.mimetype,
                ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
                ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
                ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
              };
            } catch {
              // Best-effort only; fall back to the original payload.
              effectiveContent = content;
            }
          } else if (
            imageValue &&
            typeof imageValue === 'object' &&
            typeof (imageValue as any).url === 'string' &&
            isHttpUrl(String((imageValue as any).url))
          ) {
	            // If we reached a URL-send fallback, try to prefetch+normalize anyway for newsletters.
	            // This avoids Baileys' internal fetch (no referer/UA) which often fails on hotlink-protected CDNs.
	            try {
	              const { buffer } = await downloadImageBuffer(String((imageValue as any).url), normalizedLink || null);
	              const prepared = await prepareNewsletterImage(buffer, { maxBytes: 8 * 1024 * 1024 });
	              effectiveContent = {
	                ...content,
                image: prepared.buffer,
                mimetype: prepared.mimetype || (content as any)?.mimetype,
                ...(prepared.jpegThumbnail ? { jpegThumbnail: prepared.jpegThumbnail } : {}),
                ...(typeof prepared.width === 'number' ? { width: prepared.width } : {}),
                ...(typeof prepared.height === 'number' ? { height: prepared.height } : {})
              };
            } catch {
              // Keep URL-based fallback.
              effectiveContent = content;
            }
          }
        }

        const sendPromise = isStatusBroadcast(normalizedJid)
          ? whatsapp.sendStatusBroadcast(
            effectiveContent,
            explicitStatusJidList.length
              ? { statusJidList: explicitStatusJidList }
              : { statusJidList: (await ensureFreshStatusRecipients(whatsapp, { maxAgeMinutes: 10, sampleSize: 25 })).recipients }
          )
          : whatsapp.sendMessage(normalizedJid, effectiveContent);
        const result = await withTimeout(
          sendPromise,
          resolveSendTestTimeoutMs(normalizedJid, requestedMediaType),
          'Timed out sending test message'
        );

        const messageId = result?.key?.id || null;
        let confirmation: { ok: boolean; via: string; status?: number | null; statusLabel?: string | null } | null = null;
        if (confirmationRequired && !messageId) {
          throw new Error('Test message was not assigned a WhatsApp message id');
        }
        if (confirmationRequired && messageId && whatsapp?.confirmSend) {
          const timeouts = (imageUrl || videoUrl || imageDataUrl || videoDataUrl)
            ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
            : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 };
          confirmation = await whatsapp.confirmSend(messageId, timeouts);
        }
        results.push({
          jid: normalizedJid,
          ok: true,
          messageId,
          confirmation,
          confirmed: Boolean(confirmation?.ok),
          ...(mediaWarning ? { warning: mediaWarning } : {})
        });
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

        const confirmedAt = new Date().toISOString();
        const rowsToInsert = successful.map((entry) => {
          const resolution = resolveTestSendLogResolution({
            messageId: entry.messageId || null,
            confirmRequested: confirmationRequired,
            confirmation: confirmationRequired ? entry.confirmation || null : null,
            confirmedAt
          });
          return {
          schedule_id: null,
          feed_item_id: null,
          target_id: targetIdByJid.get(entry.jid) || null,
          template_id: null,
          message_content: captionText || null,
          status: resolution.status,
          error_message: resolution.errorMessage,
            whatsapp_message_id: entry.messageId || null,
            sent_at: resolution.sentAt,
            media_url: requestedMediaUrl && !requestedMediaUrl.startsWith('data:') ? requestedMediaUrl : null,
            media_type: requestedMediaType,
          media_sent: Boolean(
            requestedMediaType &&
            !mediaWarning &&
            (resolution.status === 'sent' ||
              resolution.status === 'delivered' ||
              resolution.status === 'read' ||
              resolution.status === 'played')
          ),
            media_error: mediaWarning
          };
        });

        if (rowsToInsert.length) {
          await supabase.from('message_logs').insert(rowsToInsert);
        }
      }
    } catch {
      // Best effort only: test-message logging should not fail the send endpoint.
    }

    const confirmedCount = successful.filter((entry) => entry.confirmed === true).length;
    const uncertainCount = successful.length - confirmedCount;

    if (normalizedJids.length === 1) {
      const first = successful[0];
      return res.json({
        ok: results.every((entry) => entry.ok),
        sent: successful.length,
        confirmed: confirmedCount,
        uncertain: uncertainCount,
        failed: results.length - successful.length,
        messageId: first?.messageId || null,
        confirmation: first?.confirmation || null,
        results
      });
    }

    res.json({
      ok: results.every((entry) => entry.ok),
      sent: successful.length,
      confirmed: confirmedCount,
      uncertain: uncertainCount,
      failed: results.length - successful.length,
      results
    });
  }));

  // Send to status broadcast
  router.get('/status-audience', asyncHandler(async (req: Request, res: Response) => {
    if (!WHATSAPP_STATUS_ENABLED) {
      return res.json({
        participantCount: 0,
        sample: [],
        refreshedAt: null,
        sources: {
          contactsCache: 0,
          storeContacts: 0,
          storeChats: 0,
          groupMetadata: 0,
          env: 0,
          me: 0,
          recentSuccessfulDirectRecipients: 0
        },
        warnings: [WHATSAPP_STATUS_DISABLED_REASON]
      });
    }
    const whatsapp = req.app.locals.whatsapp as {
      getStatusAudience?: (options?: { sampleSize?: number }) => Promise<unknown> | unknown;
    } | null;
    const rawSample = Number(req.query.sample || 25);
    const sampleSize = Number.isFinite(rawSample) ? Math.min(Math.max(Math.floor(rawSample), 1), 200) : 25;
    const forceRefresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const includeRecipients = String(req.query.include_recipients || '').toLowerCase() === 'true';
    const audience = forceRefresh
      ? await refreshStatusRecipients(whatsapp, { sampleSize })
      : await getStatusRecipientSnapshot({ sampleSize });
    if (includeRecipients) {
      return res.json(audience);
    }
    const { recipients: _recipients, ...snapshot } = audience as {
      recipients?: string[];
      participantCount: number;
      sample: string[];
      refreshedAt: string | null;
      sources: {
        contactsCache: number;
        storeContacts: number;
        storeChats: number;
        groupMetadata: number;
        env: number;
        me: number;
        recentSuccessfulDirectRecipients: number;
      };
      warnings: string[];
    };
    return res.json(snapshot);
  }));

  // Send to status broadcast
  router.post('/send-status', validate(schemas.statusMessage), asyncHandler(async (req: Request, res: Response) => {
    if (!WHATSAPP_STATUS_ENABLED) {
      throw badRequest(WHATSAPP_STATUS_DISABLED_REASON);
    }
    const whatsapp = req.app.locals.whatsapp;
    const {
      message,
      imageUrl,
      imageDataUrl,
      videoUrl,
      videoDataUrl,
      backgroundColor,
      font,
      mediaUploadTimeoutMs,
      statusJidList
    } = req.body as {
      message?: string | null;
      imageUrl?: string | null;
      imageDataUrl?: string | null;
      videoUrl?: string | null;
      videoDataUrl?: string | null;
      backgroundColor?: string | null;
      font?: number | null;
      mediaUploadTimeoutMs?: number | null;
      statusJidList?: string[] | null;
    };
    const normalizedMessage = normalizeMessageText(String(message || ''));

    const connected = await ensureWhatsAppReadyForOutbound(whatsapp, {
      attempts: 8,
      delayMs: 900,
      triggerReconnect: true,
      triggerTakeover: true,
      logContext: 'send-status route'
    });

    if (!connected) {
      throw badRequest('WhatsApp is not connected');
    }

    const normalizedImageUrl = String(imageUrl || '').trim();
    const normalizedImageDataUrl = String(imageDataUrl || '').trim();
    const normalizedVideoUrl = String(videoUrl || '').trim();
    const normalizedVideoDataUrl = String(videoDataUrl || '').trim();
    const normalizedBackgroundColor = String(backgroundColor || '').trim();

    const mediaModes = [
      Number(Boolean(normalizedImageUrl || normalizedImageDataUrl)),
      Number(Boolean(normalizedVideoUrl || normalizedVideoDataUrl))
    ].reduce((sum, value) => sum + value, 0);
    if (mediaModes > 1) {
      throw badRequest('Provide at most one media source (image or video)');
    }

    let content: Record<string, unknown>;
    if (normalizedVideoDataUrl) {
      const { buffer, mimetype } = parseVideoDataUrl(normalizedVideoDataUrl);
      content = normalizedMessage
        ? { video: buffer, mimetype, caption: normalizedMessage }
        : { video: buffer, mimetype };
    } else if (normalizedVideoUrl) {
      if (!isHttpUrl(normalizedVideoUrl)) {
        throw badRequest('videoUrl must be an http(s) URL');
      }
      try {
        await assertSafeOutboundUrl(normalizedVideoUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'videoUrl is not allowed'));
      }

      try {
        const { buffer, mimetype } = await downloadVideoBuffer(normalizedVideoUrl, null);
        content = normalizedMessage
          ? { video: buffer, mimetype, caption: normalizedMessage }
          : { video: buffer, mimetype };
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'Failed to download videoUrl'));
      }
    } else if (normalizedImageDataUrl) {
      const { buffer, mimetype } = parseImageDataUrl(normalizedImageDataUrl);
      content = normalizedMessage
        ? { image: buffer, mimetype, caption: normalizedMessage }
        : { image: buffer, mimetype };
    } else if (normalizedImageUrl) {
      if (!isHttpUrl(normalizedImageUrl)) {
        throw badRequest('imageUrl must be an http(s) URL');
      }
      try {
        await assertSafeOutboundUrl(normalizedImageUrl);
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'imageUrl is not allowed'));
      }
      try {
        const { buffer, mimetype } = await downloadImageBuffer(normalizedImageUrl, null);
        content = normalizedMessage
          ? (mimetype ? { image: buffer, mimetype, caption: normalizedMessage } : { image: buffer, caption: normalizedMessage })
          : (mimetype ? { image: buffer, mimetype } : { image: buffer });
      } catch (error) {
        throw badRequest(getErrorMessage(error, 'Failed to download imageUrl'));
      }
    } else if (normalizedMessage) {
      content = { text: normalizedMessage };
    } else {
      throw badRequest('message, imageUrl, imageDataUrl, videoUrl, or videoDataUrl is required');
    }

    const explicitStatusJids = Array.isArray(statusJidList)
      ? statusJidList.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const statusSnapshot = explicitStatusJids.length
      ? { recipients: explicitStatusJids }
      : await ensureFreshStatusRecipients(whatsapp, { maxAgeMinutes: 10, sampleSize: 25 });
    const sendOptions: Record<string, unknown> = {};
    if (statusSnapshot.recipients.length) sendOptions.statusJidList = statusSnapshot.recipients;
    if (normalizedBackgroundColor) {
      sendOptions.backgroundColor = normalizedBackgroundColor.startsWith('#')
        ? normalizedBackgroundColor
        : `#${normalizedBackgroundColor}`;
    }
    if (Number.isFinite(Number(font))) sendOptions.font = Number(font);
    if (Number.isFinite(Number(mediaUploadTimeoutMs))) sendOptions.mediaUploadTimeoutMs = Number(mediaUploadTimeoutMs);

    const result = await whatsapp.sendStatusBroadcast(content, sendOptions);
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
module.exports.__testUtils = {
  buildUncertainSendMessage,
  isGroupJid,
  resolveSendTestTimeoutMs,
  resolveTestSendLogResolution
};
