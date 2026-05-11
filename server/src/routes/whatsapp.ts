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
const settingsService = require('../services/settingsService');
const { ensureFreshStatusRecipients, getStatusRecipientSnapshot, refreshStatusRecipients } = require('../services/statusAudienceService');
const { isNewsletterJid, prepareNewsletterImage, prepareNewsletterVideo } = require('../utils/whatsappMedia');
const { buildDefaultUserAgent } = require('../utils/httpClientIdentity');
const { normalizeChannelJid, isValidChannelJid } = require('../utils/targetJid');
const { WHATSAPP_STATUS_ENABLED, WHATSAPP_STATUS_DISABLED_REASON } = require('../config/features');

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DIRECT_MEDIA_SEND_TIMEOUT_MS = 60000;
const GROUP_SEND_TIMEOUT_MS = 60000;
const GROUP_MEDIA_SEND_TIMEOUT_MS = 90000;
const STATUS_AUDIENCE_REFRESH_TIMEOUT_MS = 15000;
const STATUS_SEND_TIMEOUT_MS = 90000;
const STATUS_CONFIRM_TIMEOUT_MS = 95000;
const STATUS_FAILURE_GRACE_MS = 15000;
const NEWSLETTER_CONFIRM_FETCH_TIMEOUT_TEXT_MS = Math.max(
  1000,
  Math.min(Number(process.env.WHATSAPP_NEWSLETTER_CONFIRM_FETCH_TIMEOUT_TEXT_MS || 8000), 30000)
);
const NEWSLETTER_CONFIRM_FETCH_TIMEOUT_MEDIA_MS = Math.max(
  NEWSLETTER_CONFIRM_FETCH_TIMEOUT_TEXT_MS,
  Math.min(Number(process.env.WHATSAPP_NEWSLETTER_CONFIRM_FETCH_TIMEOUT_MEDIA_MS || 12000), 45000)
);
const DEFAULT_USER_AGENT = buildDefaultUserAgent();
const SUPPORTED_WHATSAPP_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

type TestSendConfirmation = {
  ok: boolean;
  via: string;
  status?: number | null;
  statusLabel?: string | null;
  error?: string | null;
  unsupported?: boolean;
};

type TestSendLogResolution = {
  status: 'sent' | 'delivered' | 'read' | 'played' | 'failed' | 'awaiting_approval';
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

const buildMissingMessageIdSendMessage = (value: unknown) => {
  const message = String(value || '').trim();
  if (!message) {
    return 'WhatsApp did not return a message id.';
  }
  return `WhatsApp did not return a message id. ${message}`.trim();
};

const normalizeConfirmationForOperator = (
  confirmation: TestSendConfirmation | null | undefined,
  jid?: string | null
): TestSendConfirmation | null => {
  if (!confirmation) return null;
  if (String(jid || '').trim() === 'status@broadcast' && confirmation.ok && confirmation.via === 'ack') {
    return {
      ...confirmation,
      statusLabel: 'server_ack'
    };
  }
  return confirmation;
};

const getStatusAudienceExplicitSourceCount = (snapshot: Record<string, any> | null | undefined) => {
  const sources = snapshot?.sources || {};
  return (
    Math.max(0, Math.floor(Number(sources.env || 0))) +
    Math.max(0, Math.floor(Number(sources.activeIndividualTargets || 0))) +
    Math.max(0, Math.floor(Number(sources.recentSuccessfulDirectRecipients || 0)))
  );
};

const getStatusAudiencePrivateSourceCount = (snapshot: Record<string, any> | null | undefined) => {
  const sources = snapshot?.sources || {};
  return (
    Math.max(0, Math.floor(Number(sources.contactsCache || 0))) +
    Math.max(0, Math.floor(Number(sources.storeContacts || 0))) +
    Math.max(0, Math.floor(Number(sources.storeChats || 0))) +
    Math.max(0, Math.floor(Number(sources.env || 0))) +
    Math.max(0, Math.floor(Number(sources.activeIndividualTargets || 0))) +
    Math.max(0, Math.floor(Number(sources.recentSuccessfulDirectRecipients || 0)))
  );
};

const getStatusAudienceMappedSourceCount = (snapshot: Record<string, any> | null | undefined) => {
  const sources = snapshot?.sources || {};
  return Math.max(0, Math.floor(Number(sources.lidMappings || 0)));
};

const getStatusAudienceGroupSourceCount = (snapshot: Record<string, any> | null | undefined) => {
  const sources = snapshot?.sources || {};
  return Math.max(0, Math.floor(Number(sources.groupMetadata || 0)));
};

const isTruthyEnvFlag = (value: unknown) =>
  ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const isGroupStatusAudienceAllowed = () =>
  isTruthyEnvFlag(process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS) &&
  ['1', 'true', 'yes', 'on', 'unsafe', 'force'].includes(
    String(process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE || '').trim().toLowerCase()
  );

const assertUsableStatusAudience = (snapshot: Record<string, any> | null | undefined) => {
  const recipients = Array.isArray(snapshot?.recipients) ? snapshot!.recipients : [];
  if (!recipients.length) {
    throw badRequest('No fresh status recipients are available for this status send.');
  }
  const privateSourceCount = getStatusAudiencePrivateSourceCount(snapshot);
  const groupAudienceAllowed = snapshot?.groupAudienceAllowed === true || isGroupStatusAudienceAllowed();
  if (getStatusAudienceGroupSourceCount(snapshot) > 0 && privateSourceCount <= 0 && !groupAudienceAllowed) {
    throw badRequest('WhatsApp Status requires explicit/private recipients; group participant-derived recipients are not safe for Status delivery.');
  }
  const lidCount = recipients.filter((recipient: unknown) => String(recipient || '').endsWith('@lid')).length;
  const phoneCount = recipients.filter((recipient: unknown) => String(recipient || '').endsWith('@s.whatsapp.net')).length;
  if (
      lidCount > 0 &&
      phoneCount === 0 &&
      getStatusAudienceExplicitSourceCount(snapshot) <= 0 &&
      !groupAudienceAllowed
    ) {
    throw badRequest('Status viewers only contain unresolved linked-device identities. Add private Status recipient phone numbers in Settings or wait for WhatsApp sync to finish.');
  }
  if (
    recipients.length <= 1 &&
    privateSourceCount <= 0 &&
    getStatusAudienceMappedSourceCount(snapshot) <= 0 &&
    !groupAudienceAllowed
  ) {
    throw badRequest('Status audience has no private viewers yet. Add or sync at least one private WhatsApp contact before sending Status.');
  }
};

const shouldAllowUnmappedStatusLids = (snapshot: Record<string, any> | null | undefined) =>
  snapshot?.groupAudienceAllowed === true || isGroupStatusAudienceAllowed();

const buildStatusAudienceResponse = (
  audience: Record<string, unknown>,
  options: { includeRecipients?: boolean; sampleSize?: number; stale?: boolean } = {}
) => {
  const recipients = Array.isArray(audience.recipients) ? audience.recipients.map((entry) => String(entry || '')).filter(Boolean) : [];
  const sampleSource = Array.isArray(audience.sample) ? audience.sample.map((entry) => String(entry || '')).filter(Boolean) : recipients;
  const sampleSize = Math.max(1, Math.min(Math.floor(Number(options.sampleSize || 25)), 200));
  const sample = sampleSource.slice(0, sampleSize);
  const { recipients: _recipients, sample: _sample, ...snapshot } = audience;
  const response: Record<string, unknown> = {
    ...snapshot,
    participantCount: Number(audience.participantCount || recipients.length || 0),
    sample,
    stale: Boolean(options.stale)
  };

  if (options.includeRecipients) {
    const recipientCount = Number(response.participantCount || recipients.length || 0);
    response.recipients = sample;
    response.recipientCount = recipientCount;
    response.recipientsTruncated = recipientCount > sample.length;
  }

  return response;
};

const inferMessageMediaType = (message: unknown) => {
  const record = (message || {}) as Record<string, unknown>;
  if (record.image || record.imageMessage) return 'image';
  if (record.video || record.videoMessage) return 'video';
  if (record.audio || record.audioMessage) return 'audio';
  if (record.document || record.documentMessage) return 'document';
  if (record.text || record.conversation || record.extendedTextMessage) return 'text';
  return null;
};

const assertRequestedMediaWasPrepared = (requestedMediaType: string | null, content: Record<string, unknown>) => {
  if (!requestedMediaType) return;
  const preparedMediaType = inferMessageMediaType(content);
  if (preparedMediaType !== requestedMediaType) {
    throw badRequest(`Requested ${requestedMediaType} could not be prepared; refusing to send a text fallback.`);
  }
};

const assertStatusMediaResponseMatches = (
  requestedMediaType: string | null,
  result: Record<string, any> | null | undefined
) => {
  if (requestedMediaType !== 'image' && requestedMediaType !== 'video') return;
  const actualMediaType = inferMessageMediaType(result?.message || null);
  if (actualMediaType !== requestedMediaType) {
    throw badRequest(
      `Status ${requestedMediaType} was not verified in the outgoing WhatsApp payload; refusing to claim it was sent.`
    );
  }
};

const parseProvidedStatusFont = (font: unknown) => {
  if (font === null || font === undefined || font === '') return null;
  const normalizedFont = Number(font);
  if (!Number.isInteger(normalizedFont) || normalizedFont < 0 || normalizedFont > 8) return null;
  return normalizedFont;
};

const buildTextStatusStyleOptions = (backgroundColor: unknown, font: unknown) => {
  const normalizedBackgroundColor = String(backgroundColor || '').trim();
  const normalizedFont = parseProvidedStatusFont(font);
  return {
    ...(normalizedBackgroundColor && /^#[0-9a-f]{6}$/i.test(normalizedBackgroundColor)
      ? { backgroundColor: normalizedBackgroundColor }
      : {}),
    ...(normalizedFont !== null
      ? { font: normalizedFont }
      : {})
  };
};

const isAck479Error = (value: unknown) =>
  /(?:ack|server rejected|rejected).*479|479.*(?:ack|server rejected|rejected)/i.test(String(value || ''));

const buildChannelMediaHoldMessage = (mediaType: string | null, errorMessage: unknown) => {
  const kind = String(mediaType || 'media').trim() || 'media';
  const reason = String(errorMessage || 'WhatsApp rejected the channel media send').trim();
  return `Channel ${kind} was rejected by WhatsApp (${reason}); held for review. No text/link fallback was sent.`;
};

const shouldHoldRejectedChannelMediaTestSend = (options: {
  jid?: string | null;
  requestedMediaType?: string | null;
  confirmation?: TestSendConfirmation | null;
}) => {
  const requestedMediaType = String(options.requestedMediaType || '').trim().toLowerCase();
  return (
    isNewsletterJid(String(options.jid || '')) &&
    (requestedMediaType === 'image' || requestedMediaType === 'video') &&
    isAck479Error(options.confirmation?.error)
  );
};

const resolveTestSendLogResolution = (options: {
  messageId?: string | null;
  confirmRequested?: boolean;
  confirmation?: TestSendConfirmation | null;
  confirmedAt?: string;
  holdReason?: string | null;
}) => {
  const holdReason = String(options.holdReason || '').trim();
  if (holdReason) {
    return {
      status: 'awaiting_approval',
      errorMessage: holdReason,
      sentAt: null
    } satisfies TestSendLogResolution;
  }

  const messageId = String(options.messageId || '').trim();
  const confirmRequested = options.confirmRequested !== false;
  const confirmation = options.confirmation || null;
  const confirmedAt = String(options.confirmedAt || new Date().toISOString());

  if (!messageId) {
    return {
      status: 'failed',
      errorMessage: buildMissingMessageIdSendMessage('Missing WhatsApp message id'),
      sentAt: null
    } satisfies TestSendLogResolution;
  }

  if (confirmation?.ok) {
    return {
      status: 'sent',
      errorMessage: null,
      sentAt: confirmedAt
    } satisfies TestSendLogResolution;
  }

  if (!confirmRequested) {
    return {
      status: 'sent',
      errorMessage: null,
      sentAt: confirmedAt
    } satisfies TestSendLogResolution;
  }

  const confirmationError = String(confirmation?.error || '').trim();
  if (isAck479Error(confirmationError)) {
    return {
      status: 'failed',
      errorMessage: confirmationError,
      sentAt: null
    } satisfies TestSendLogResolution;
  }

  return {
    status: 'sent',
    errorMessage: null,
    sentAt: confirmedAt
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
  const normalizedJid = String(jid || '').trim();
  const hasMedia = Boolean(String(mediaType || '').trim());
  if (normalizedJid === 'status@broadcast') {
    return hasMedia ? STATUS_SEND_TIMEOUT_MS : Math.max(DEFAULT_SEND_TIMEOUT_MS, 30000);
  }
  if (isGroupJid(normalizedJid)) {
    return hasMedia ? GROUP_MEDIA_SEND_TIMEOUT_MS : GROUP_SEND_TIMEOUT_MS;
  }
  if (isNewsletterJid(normalizedJid)) {
    return hasMedia ? GROUP_MEDIA_SEND_TIMEOUT_MS : DEFAULT_SEND_TIMEOUT_MS;
  }
  return hasMedia ? DIRECT_MEDIA_SEND_TIMEOUT_MS : DEFAULT_SEND_TIMEOUT_MS;
};

const resolveTestSendConfirmationOptions = (jid: string, mediaType: string | null) => {
  const hasMedia = Boolean(String(mediaType || '').trim());
  const isStatus = String(jid || '').trim() === 'status@broadcast';
  const failureGraceMs = isStatus ? STATUS_FAILURE_GRACE_MS : isNewsletterJid(jid) ? 3000 : 0;
  const requireServerAck = true;
  return hasMedia
    ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000, requireServerAck, failureGraceMs }
    : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000, requireServerAck, failureGraceMs };
};

const resolveNewsletterConfirmFetchTimeoutMs = (mediaType: string | null) =>
  mediaType ? NEWSLETTER_CONFIRM_FETCH_TIMEOUT_MEDIA_MS : NEWSLETTER_CONFIRM_FETCH_TIMEOUT_TEXT_MS;

const toOriginOrUndefined = (value?: string | null) => {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

const downloadImageBuffer = async (url: string, refererUrl?: string | null) => {
  const MAX_IMAGE_BYTES = Math.max(1, Math.floor(Number(process.env.WHATSAPP_MAX_IMAGE_BYTES || 16 * 1024 * 1024)));
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

  let detectedMime = detectImageMimeTypeFromBuffer(buffer);

  const baseContentType = contentType.split(';')[0]?.trim() || '';
  const isProbablyImage =
    baseContentType.startsWith('image/') || baseContentType === '' || baseContentType === 'application/octet-stream';
  if (!detectedMime && !isProbablyImage) {
    throw new Error('URL did not return an image');
  }

  // CDNs often serve WebP bytes behind .jpg URLs. Normalize non-JPEG payloads before
  // upload so Android/Web linked devices receive a regular WhatsApp image, not a
  // format-dependent preview that can render blurry or fail to hydrate.
  if (detectedMime !== 'image/jpeg') {
    try {
      const prepared = await prepareNewsletterImage(buffer, { maxBytes: MAX_IMAGE_BYTES, jpegQuality: 92 });
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
  liveUpdates?: {
    attempted: number;
    subscribed: number;
    cached: number;
    failed: number;
    unsupported: boolean;
    failedJids: string[];
  };
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
    limitation: null,
    liveUpdates: { attempted: 0, subscribed: 0, cached: 0, failed: 0, unsupported: false, failedJids: [] }
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
          limitation: 'Channel discovery failed in this session.',
          liveUpdates: { attempted: 0, subscribed: 0, cached: 0, failed: 0, unsupported: false, failedJids: [] }
        },
        persisted: { candidates: 0 }
      });
    }
  }));

  router.get('/channels/:jid/messages', asyncHandler(async (req: Request, res: Response) => {
    const whatsapp = req.app.locals.whatsapp;
    if (!whatsapp || whatsapp.getStatus?.().status !== 'connected') {
      throw badRequest('WhatsApp is not connected');
    }
    if (typeof whatsapp.fetchNewsletterMessages !== 'function') {
      throw badRequest('Channel message fetch is not available in this Baileys session');
    }

    const jid = normalizeChannelJid(String(req.params.jid || '').trim());
    if (!jid || !isValidChannelJid(jid)) {
      throw badRequest('Channel JID invalid');
    }
    const count = Math.max(1, Math.min(Math.floor(Number(req.query.count || 10)), 50));
    const result = await whatsapp.fetchNewsletterMessages(jid, { count });
    res.json({
      ok: Boolean(result?.ok),
      unsupported: Boolean(result?.unsupported),
      error: result?.error || null,
      messages: result?.messages || []
    });
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
    const lease = await whatsapp.takeoverLease(undefined, { manual: true });
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
  const normalizeStatusAudienceRecipient = (value: unknown) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'status@broadcast') return '';
    if (raw.endsWith('@g.us') || raw.includes('@newsletter')) return '';

    const splitUser = (input: string) => String(input.split('@')[0] || '').split(':')[0] || '';
    if (raw.endsWith('@lid')) {
      const user = splitUser(raw).replace(/[^a-z0-9._-]/g, '');
      return user ? `${user}@lid` : '';
    }
    if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@c.us')) {
      const digits = splitUser(raw).replace(/[^0-9]/g, '');
      return digits.length >= 6 ? `${digits}@s.whatsapp.net` : '';
    }
    if (raw.includes('@')) return '';
    const digits = raw.replace(/[^0-9]/g, '');
    return digits.length >= 6 ? `${digits}@s.whatsapp.net` : '';
  };
  const normalizeExplicitStatusAudience = (values: unknown[]) =>
    Array.from(
      new Set(
        values
          .map((value) => normalizeStatusAudienceRecipient(value))
          .filter(Boolean)
      )
    );
  const resolveStatusIncludeSender = async () => {
    try {
      const settings = await settingsService.getSettings();
      return settings?.status_include_sender !== false;
    } catch {
      return true;
    }
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
      backgroundColor?: string | null;
      font?: number | null;
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
    const explicitStatusJidListRaw = Array.isArray(payload.statusJidList)
      ? payload.statusJidList.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const statusTextStyleOptions = buildTextStatusStyleOptions(payload.backgroundColor, payload.font);
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
    const explicitStatusJidList = normalizeExplicitStatusAudience(explicitStatusJidListRaw);
    if (explicitStatusJidListRaw.length && !explicitStatusJidList.length) {
      throw badRequest('Status audience must include at least one private recipient.');
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
      assertRequestedMediaWasPrepared(requestedMediaType, content);

	    const results: Array<{
	      jid: string;
	      ok: boolean;
	      messageId?: string | null;
	      confirmation?: TestSendConfirmation | null;
          held?: boolean;
          holdReason?: string | null;
	      warning?: string;
	      error?: string;
	    }> = [];

    for (const normalizedJid of normalizedJids) {
      try {
        if (isStatusBroadcast(normalizedJid) && (requestedMediaType === 'audio' || requestedMediaType === 'document')) {
          throw badRequest('Status only supports text, image, and video');
        }
        let effectiveContent: Record<string, unknown> = content;

        // Baileys uses a special raw-media path for newsletters; normalize media payloads before relay.
        if (isNewsletterJid(normalizedJid)) {
          const videoValue = (content as any)?.video;
          if (Buffer.isBuffer(videoValue)) {
            try {
              const prepared = await prepareNewsletterVideo(videoValue, { maxBytes: 32 * 1024 * 1024 });
              effectiveContent = {
                ...effectiveContent,
                video: prepared.buffer,
                mimetype: prepared.mimetype || (effectiveContent as any)?.mimetype,
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

        let statusOptions: Record<string, unknown> | null = null;
        if (isStatusBroadcast(normalizedJid)) {
          if (explicitStatusJidList.length) {
            assertUsableStatusAudience({
              recipients: explicitStatusJidList,
              sources: { env: explicitStatusJidList.length }
            });
            statusOptions = { statusJidList: explicitStatusJidList, includeSender: await resolveStatusIncludeSender() };
          } else {
            const snapshot = await withTimeout(
              ensureFreshStatusRecipients(whatsapp, { maxAgeMinutes: 10, sampleSize: 25 }),
              STATUS_AUDIENCE_REFRESH_TIMEOUT_MS,
              'Timed out refreshing status audience'
            );
            assertUsableStatusAudience(snapshot);
            statusOptions = {
              statusJidList: snapshot.recipients,
              includeSender: await resolveStatusIncludeSender()
            };
            if (shouldAllowUnmappedStatusLids(snapshot)) {
              statusOptions.allowUnmappedLidRecipients = true;
            }
          }
          if (!requestedMediaType) {
            statusOptions = {
              ...(statusOptions || {}),
              ...statusTextStyleOptions
            };
          }
        }
        const sendPromise = isStatusBroadcast(normalizedJid)
          ? whatsapp.sendStatusBroadcast(effectiveContent, statusOptions || {})
          : whatsapp.sendMessage(normalizedJid, effectiveContent);
        const result = await withTimeout(
          sendPromise,
          resolveSendTestTimeoutMs(normalizedJid, requestedMediaType),
          'Timed out sending test message'
        );
        if (isStatusBroadcast(normalizedJid)) {
          assertStatusMediaResponseMatches(requestedMediaType, result);
        }

        const messageId = result?.key?.id || null;
        let confirmation: TestSendConfirmation | null = null;
        if (confirmationRequired && !messageId) {
          throw new Error('Test message was not assigned a WhatsApp message id');
        }
        if (confirmationRequired && messageId && whatsapp?.confirmSend) {
          let channelConfirmation: TestSendConfirmation | null = null;
          if (isNewsletterJid(normalizedJid) && typeof whatsapp.confirmNewsletterMessage === 'function') {
            channelConfirmation = await whatsapp.confirmNewsletterMessage(normalizedJid, messageId, {
              timeoutMs: resolveNewsletterConfirmFetchTimeoutMs(requestedMediaType),
              count: 25
            });
            if (channelConfirmation?.ok) {
              confirmation = channelConfirmation;
            }
          }
          if (!confirmation) {
            const ackConfirmation = await whatsapp.confirmSend(
              messageId,
              resolveTestSendConfirmationOptions(normalizedJid, requestedMediaType)
            );
            confirmation = ackConfirmation?.ok || !channelConfirmation || channelConfirmation.unsupported
              ? ackConfirmation
              : channelConfirmation;
          }
          confirmation = normalizeConfirmationForOperator(confirmation, normalizedJid);
        }
        const held = shouldHoldRejectedChannelMediaTestSend({
          jid: normalizedJid,
          requestedMediaType,
          confirmation
        });
        const holdReason = held
          ? buildChannelMediaHoldMessage(requestedMediaType, confirmation?.error)
          : null;
        results.push({
          jid: normalizedJid,
          ok: true,
          messageId,
          confirmation,
          held,
          holdReason,
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
            confirmedAt,
            holdReason: entry.holdReason || null
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
            media_sent: Boolean(requestedMediaType && !mediaWarning && resolution.status === 'sent'),
            media_error: entry.holdReason || mediaWarning || (requestedMediaType ? String(entry.confirmation?.error || '').trim() || null : null)
          };
        });

        if (rowsToInsert.length) {
          await supabase.from('message_logs').insert(rowsToInsert);
        }
      }
    } catch {
      // Best effort only: test-message logging should not fail the send endpoint.
    }

    const heldCount = successful.filter((entry) => entry.held === true).length;
    const rejectedCount = successful.filter((entry) => isAck479Error(entry.confirmation?.error)).length;
    const sentCount = successful.length - heldCount - rejectedCount;
    const failedCount = results.length - successful.length + rejectedCount;

    if (normalizedJids.length === 1) {
      const first = successful[0];
      return res.json({
        ok: results.every((entry) => entry.ok) && heldCount === 0 && failedCount === 0,
        sent: sentCount,
        held: heldCount,
        failed: failedCount,
        messageId: first?.messageId || null,
        confirmation: first?.confirmation || null,
        results
      });
    }

    res.json({
      ok: results.every((entry) => entry.ok) && heldCount === 0 && failedCount === 0,
      sent: sentCount,
      held: heldCount,
      failed: failedCount,
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
        lidMappings: 0,
        activeIndividualTargets: 0,
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
    const connected = String((whatsapp as { getStatus?: () => { status?: string } } | null)?.getStatus?.()?.status || '')
      .trim()
      .toLowerCase() === 'connected';
    const audience = forceRefresh
      ? await refreshStatusRecipients(whatsapp, { sampleSize })
      : connected
        ? await ensureFreshStatusRecipients(whatsapp, { maxAgeMinutes: 10, sampleSize })
        : await getStatusRecipientSnapshot({ sampleSize });
    return res.json(buildStatusAudienceResponse(audience as Record<string, unknown>, {
      includeRecipients,
      sampleSize,
      stale: !connected
    }));
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
    const requestedStatusMediaType = normalizedVideoUrl || normalizedVideoDataUrl
      ? 'video'
      : normalizedImageUrl || normalizedImageDataUrl
        ? 'image'
        : null;
    assertRequestedMediaWasPrepared(requestedStatusMediaType, content);

    const explicitStatusJidsRaw = Array.isArray(statusJidList)
      ? statusJidList.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const explicitStatusJids = normalizeExplicitStatusAudience(explicitStatusJidsRaw);
    if (explicitStatusJidsRaw.length && !explicitStatusJids.length) {
      throw badRequest('Status audience must include at least one private recipient.');
    }
    const statusSnapshot = explicitStatusJids.length
      ? { recipients: explicitStatusJids, sources: { env: explicitStatusJids.length } }
      : await withTimeout(
          ensureFreshStatusRecipients(whatsapp, { maxAgeMinutes: 10, sampleSize: 25 }),
          STATUS_AUDIENCE_REFRESH_TIMEOUT_MS,
          'Timed out refreshing status audience'
        );
    assertUsableStatusAudience(statusSnapshot);
    const sendOptions: Record<string, unknown> = {};
    const strippedStatusStyleOptions: string[] = [];
    const providedStatusFont = parseProvidedStatusFont(font);
    if (statusSnapshot.recipients.length) sendOptions.statusJidList = statusSnapshot.recipients;
    sendOptions.includeSender = await resolveStatusIncludeSender();
    if (shouldAllowUnmappedStatusLids(statusSnapshot)) {
      sendOptions.allowUnmappedLidRecipients = true;
    }
    if (!requestedStatusMediaType && normalizedBackgroundColor) {
      sendOptions.backgroundColor = normalizedBackgroundColor.startsWith('#')
        ? normalizedBackgroundColor
        : `#${normalizedBackgroundColor}`;
    } else if (requestedStatusMediaType && normalizedBackgroundColor) {
      strippedStatusStyleOptions.push('backgroundColor');
    }
    if (!requestedStatusMediaType && providedStatusFont !== null) {
      sendOptions.font = providedStatusFont;
    } else if (requestedStatusMediaType && providedStatusFont !== null) {
      strippedStatusStyleOptions.push('font');
    }
    if (Number.isFinite(Number(mediaUploadTimeoutMs))) sendOptions.mediaUploadTimeoutMs = Number(mediaUploadTimeoutMs);

    const result = await withTimeout(
      whatsapp.sendStatusBroadcast(content, sendOptions),
      STATUS_SEND_TIMEOUT_MS,
      'Timed out sending status broadcast'
    );
    assertStatusMediaResponseMatches(requestedStatusMediaType, result);
    const messageId = String(result?.key?.id || '').trim() || null;
    const confirmation = messageId && whatsapp?.confirmSend
      ? await withTimeout(
          whatsapp.confirmSend(
            messageId,
            normalizedImageUrl || normalizedImageDataUrl || normalizedVideoUrl || normalizedVideoDataUrl
              ? { upsertTimeoutMs: 30000, ackTimeoutMs: 90000, requireServerAck: true, failureGraceMs: STATUS_FAILURE_GRACE_MS }
              : { upsertTimeoutMs: 5000, ackTimeoutMs: 60000, requireServerAck: true, failureGraceMs: STATUS_FAILURE_GRACE_MS }
          ),
          STATUS_CONFIRM_TIMEOUT_MS,
          'Timed out confirming status broadcast'
        )
      : null;
    const operatorConfirmation = normalizeConfirmationForOperator(confirmation, 'status@broadcast');
    const rejected = isAck479Error(operatorConfirmation?.error);
    res.json({
      ok: Boolean(messageId && !rejected),
      sent: Boolean(messageId && !rejected),
      failed: Boolean(rejected),
      messageId,
      confirmation: operatorConfirmation,
      audienceCount: statusSnapshot.recipients.length,
      ...(strippedStatusStyleOptions.length ? { strippedStatusStyleOptions } : {})
    });
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
        hasCaption: Boolean(
          (message?.imageMessage as Record<string,unknown>)?.caption ||
          (message?.videoMessage as Record<string,unknown>)?.caption
        )
      };
    });
    const statuses = Array.from(recentStatuses.entries()).map(([id, snap]) => {
      const s = snap as Record<string, unknown>;
      const remoteJid = String(s.remoteJid || '').trim();
      const statusLabel = remoteJid === 'status@broadcast' && s.statusLabel === 'read'
        ? 'server_ack'
        : s.statusLabel ?? null;
      return {
        id,
        status: s.status ?? null,
        statusLabel,
        remoteJid: remoteJid || null,
        updatedAtMs: s.updatedAtMs ?? null
      };
    });
    res.json({ messages, statuses });
  }));

  return router;
};

module.exports = whatsappRoutes;
module.exports.__testUtils = {
  assertUsableStatusAudience,
  buildStatusAudienceResponse,
  buildMissingMessageIdSendMessage,
  isGroupJid,
  buildTextStatusStyleOptions,
  normalizeConfirmationForOperator,
  resolveTestSendConfirmationOptions,
  resolveSendTestTimeoutMs,
  resolveTestSendLogResolution
};
