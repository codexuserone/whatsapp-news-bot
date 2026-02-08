import type { SupabaseClient } from '@supabase/supabase-js';
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed } = require('./feedProcessor');
const settingsService = require('./settingsService');
const { isCurrentlyShabbos } = require('./shabbosService');
const axios = require('axios');
const cheerio = require('cheerio');
const sleep = require('../utils/sleep');
const logger = require('../utils/logger');
const withTimeout = require('../utils/withTimeout');
const { getErrorMessage } = require('../utils/errorUtils');
const { computeNextRunAt } = require('../utils/cron');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { normalizeMessageText } = require('../utils/messageText');
const { generateVideoThumbnailFromBuffer } = require('../utils/videoThumbnail');

type Target = {
  id?: string;
  phone_number: string;
  type: 'individual' | 'group' | 'channel' | 'status';
  name?: string;
  active?: boolean;
};

type Template = {
  id?: string;
  content: string;
  send_images?: boolean | null;
  send_mode?: 'image' | 'link_preview' | 'text_only' | null;
};

type FeedItem = {
  id?: string;
  title?: string;
  link?: string;
  description?: string;
  content?: string;
  author?: string;
  image_url?: string;
  image_source?: string | null;
  image_scraped_at?: string | Date | null;
  image_scrape_error?: string | null;
  created_at?: string | Date | null;
  pub_date?: string | Date;
  categories?: string[];
  raw_data?: Record<string, unknown> | null;
};

type WhatsAppClient = {
  getStatus: () => { status: string };
  sendMessage: (jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
  sendStatusBroadcast: (content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
  waitForMessage?: (messageId: string, timeoutMs?: number) => Promise<any>;
  confirmSend?: (
    messageId: string,
    options?: { upsertTimeoutMs?: number; ackTimeoutMs?: number }
  ) => Promise<{ ok: boolean; via: 'upsert' | 'ack' | 'none'; status?: number | null; statusLabel?: string | null }>;
  getGroupInfo?: (
    jid: string,
    timeoutMs?: number
  ) => Promise<{ announce: boolean; me: { isAdmin: boolean } } | null>;
  getChannelInfo?: (
    jid: string,
    timeoutMs?: number
  ) => Promise<{ jid: string; name: string; subscribers: number; viewerRole: string | null; canSend: boolean | null } | null>;
};

const DEFAULT_SEND_TIMEOUT_MS = 45000;
const AUTH_ERROR_HINT =
  'WhatsApp auth state corrupted. Clear sender keys or re-scan the QR code, then retry.';

let globalSendChain: Promise<void> = Promise.resolve();
let globalLastSentAtMs = 0;
let globalLastTargetId: string | null = null;
const globalLastSentByTargetId = new Map<string, number>();

const withGlobalSendLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = globalSendChain;
  let release!: () => void;
  globalSendChain = new Promise<void>((resolve) => {
    release = () => resolve(undefined);
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
};

const waitForDelays = async (
  targetId: string,
  settings: Record<string, unknown>
) => {
  const messageDelayMs = Number(settings.message_delay_ms || 0);
  const interTargetDelayMs = Number(settings.defaultInterTargetDelaySec || 0) * 1000;
  const intraTargetDelayMs = Number(settings.defaultIntraTargetDelaySec || 0) * 1000;

  const minBetweenAnyMs = Math.max(messageDelayMs, 0);
  const minBetweenSameTargetMs = Math.max(messageDelayMs, intraTargetDelayMs, 0);

  const now = Date.now();
  const sinceGlobal = globalLastSentAtMs ? now - globalLastSentAtMs : Number.POSITIVE_INFINITY;
  const lastTargetSent = globalLastSentByTargetId.get(targetId) || 0;
  const sinceTarget = lastTargetSent ? now - lastTargetSent : Number.POSITIVE_INFINITY;

  const waitGlobal = Number.isFinite(sinceGlobal) ? Math.max(minBetweenAnyMs - sinceGlobal, 0) : 0;
  const waitSameTarget = Number.isFinite(sinceTarget) ? Math.max(minBetweenSameTargetMs - sinceTarget, 0) : 0;
  const switchedTargets = Boolean(globalLastTargetId && globalLastTargetId !== targetId);
  const waitSwitchTarget = switchedTargets && Number.isFinite(sinceGlobal)
    ? Math.max(interTargetDelayMs - sinceGlobal, 0)
    : 0;
  const waitMs = Math.max(waitGlobal, waitSameTarget, waitSwitchTarget);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
};

const isAuthStateError = (message: string) => {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) return false;
  return [
    'senderkeyrecord.deserialize',
    'sender key record',
    'not valid json',
    'incorrect private key length',
    'session corrupted',
    'bad key material',
    'no session record'
  ].some((needle) => normalized.includes(needle));
};

const applyTemplate = (templateBody: string, data: Record<string, unknown>): string => {
  const rendered = templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = data[key];
    return value != null ? String(value) : '';
  });
  return normalizeMessageText(rendered);
};

const isHttpUrl = (value?: string | null) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const isVideoUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v', '.3gp'];
  return videoExtensions.some((ext) => hasExt(ext));
};

// Check if URL points to an image (not video/audio)
const isImageUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);

  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg'];
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v', '.3gp'];
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'];
  const otherNonImageExtensions = ['.pdf', '.zip', '.rar', '.7z', '.gz', '.tar'];
  
  // Explicitly exclude videos and audio
  if (videoExtensions.some((ext) => hasExt(ext))) return false;
  if (audioExtensions.some((ext) => hasExt(ext))) return false;
  if (otherNonImageExtensions.some((ext) => hasExt(ext))) return false;
  
  // If extension is clearly an image, accept immediately.
  if (imageExtensions.some((ext) => hasExt(ext))) return true;

  // Many image CDNs use extension-less URLs. Allow and verify content-type during download.
  return true;
};

const DEFAULT_USER_AGENT =
  process.env.MEDIA_FETCH_USER_AGENT ||
  process.env.FEED_USER_AGENT ||
  'Mozilla/5.0 (compatible; AnashNewsBot/1.0; +https://whatsapp-news-bot-3-69qh.onrender.com)';

const normalizeUrlCandidate = (candidate?: string | null, baseUrl?: string | null) => {
  const raw = String(candidate || '').trim();
  if (!raw) return undefined;

  // protocol-relative
  if (raw.startsWith('//')) {
    const value = `https:${raw}`;
    return isHttpUrl(value) ? value : undefined;
  }

  if (isHttpUrl(raw)) return raw;
  if (!baseUrl || !isHttpUrl(baseUrl)) return undefined;

  try {
    const resolved = new URL(raw, baseUrl).toString();
    return isHttpUrl(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
};

const pickFromSrcset = (srcset?: string | null) => {
  const value = String(srcset || '').trim();
  if (!value) return undefined;
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/)[0])
    .filter(Boolean);
  return entries.length ? entries[entries.length - 1] : undefined;
};

const isLikelyDecorativeImageUrl = (value: string) => {
  const lower = String(value || '').toLowerCase();
  const blockedHints = ['logo', 'sprite', 'icon', 'avatar', 'gravatar', 'emoji', 'pixel'];
  return blockedHints.some((hint) => lower.includes(hint));
};

const normalizeImageCandidate = (candidate?: string | null, baseUrl?: string | null) => {
  const resolved = normalizeUrlCandidate(candidate, baseUrl);
  if (!resolved) return undefined;
  if (!isImageUrl(resolved)) return undefined;
  if (isLikelyDecorativeImageUrl(resolved)) return undefined;
  return resolved;
};

const appendStructuredDataImageCandidates = (node: unknown, output: string[]) => {
  if (node == null) return;
  if (typeof node === 'string') {
    output.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      appendStructuredDataImageCandidates(entry, output);
    }
    return;
  }
  if (typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const imageLikeKeys = ['image', 'thumbnailUrl', 'contentUrl', 'primaryImageOfPage'];
  for (const key of imageLikeKeys) {
    appendStructuredDataImageCandidates(record[key], output);
  }

  if (record['@graph']) {
    appendStructuredDataImageCandidates(record['@graph'], output);
  }
};

const collectStructuredDataImageCandidates = ($: any) => {
  const candidates: string[] = [];
  $('script[type="application/ld+json"]').each((_: number, element: unknown) => {
    try {
      const raw = String($(element).contents().text() || '').trim();
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      appendStructuredDataImageCandidates(parsed, candidates);
    } catch {
      // Ignore malformed structured data blocks.
    }
  });
  return candidates;
};

const collectDomImageCandidates = ($: any) => {
  const selectors = [
    'article img',
    'main img',
    '.entry-content img',
    '.post-content img',
    '.article-content img',
    '.story-body img',
    'img'
  ];

  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    candidates.push(normalized);
  };

  for (const selector of selectors) {
    const elements = $(selector).slice(0, 8);
    elements.each((_: number, element: unknown) => {
      const img = $(element);
      const srcset = img.attr('data-srcset') || img.attr('srcset');
      pushCandidate(pickFromSrcset(srcset));
      pushCandidate(img.attr('data-src'));
      pushCandidate(img.attr('data-lazy-src'));
      pushCandidate(img.attr('data-original'));
      pushCandidate(img.attr('data-image'));
      pushCandidate(img.attr('src'));
    });
    if (candidates.length >= 20) break;
  }

  return candidates;
};

const scrapeImageFromPage = async (pageUrl: string) => {
  await assertSafeOutboundUrl(pageUrl);
  const response = await axios.get(pageUrl, {
    timeout: 12000,
    maxContentLength: 2 * 1024 * 1024,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const html = String(response.data || '');
  const $ = cheerio.load(html);

  const metaCandidates = [
    $('meta[property="og:image:secure_url"]').attr('content'),
    $('meta[property="og:image"]').attr('content'),
    $('meta[property="og:image:url"]').attr('content'),
    $('meta[name="og:image"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
    $('meta[itemprop="image"]').attr('content'),
    $('link[rel="image_src"]').attr('href')
  ];

  for (const raw of metaCandidates) {
    const resolved = normalizeImageCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  const structuredDataCandidates = collectStructuredDataImageCandidates($);
  for (const raw of structuredDataCandidates) {
    const resolved = normalizeImageCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  const domCandidates = collectDomImageCandidates($);
  for (const raw of domCandidates) {
    const resolved = normalizeImageCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  return null;
};

const downloadImageBuffer = async (imageUrl: string, refererUrl?: string | null) => {
  await assertSafeOutboundUrl(imageUrl);
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const response = await axios.get(imageUrl, {
    timeout: 15000,
    responseType: 'arraybuffer',
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(refererUrl ? { Referer: refererUrl } : {})
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

const downloadVideoBuffer = async (videoUrl: string, refererUrl?: string | null) => {
  await assertSafeOutboundUrl(videoUrl);
  const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
  const response = await axios.get(videoUrl, {
    timeout: 20000,
    responseType: 'arraybuffer',
    maxContentLength: MAX_VIDEO_BYTES,
    maxBodyLength: MAX_VIDEO_BYTES,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'video/*,*/*;q=0.8',
      ...(refererUrl ? { Referer: refererUrl } : {})
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

const maybeUpdateFeedItemImage = async (
  supabase: SupabaseClient | undefined,
  feedItemId: string | undefined,
  patch: Record<string, unknown>
) => {
  if (!supabase || !feedItemId) return;
  try {
    await supabase.from('feed_items').update(patch).eq('id', feedItemId);
  } catch (error) {
    logger.warn({ error, feedItemId }, 'Failed to update feed item image fields');
  }
};

const resolveMediaForFeedItem = async (
  supabase: SupabaseClient | undefined,
  feedItem: FeedItem,
  allowRichMedia: boolean
): Promise<{
  url: string | null;
  mediaType: 'image' | 'video' | null;
  thumbnailUrl: string | null;
  source: string | null;
  scraped: boolean;
  error: string | null;
}> => {
  if (!allowRichMedia) {
    return { url: null, mediaType: null, thumbnailUrl: null, source: null, scraped: false, error: null };
  }

  const rawData =
    typeof (feedItem as unknown as { raw_data?: unknown }).raw_data === 'object' &&
    (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      ? ((feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data as Record<string, unknown>)
      : {};

  const collectRawCandidates = (keys: string[]) =>
    keys
      .map((key) => rawData[key])
      .map((value) => String(value || '').trim())
      .filter((value) => Boolean(value) && isHttpUrl(value));

  const videoCandidates = collectRawCandidates([
    'video_url',
    'videoUrl',
    'media_url',
    'mediaUrl',
    'content_url',
    'contentUrl',
    'enclosure_url',
    'enclosureUrl',
    'video'
  ]);
  const thumbnailCandidates = collectRawCandidates([
    'thumbnail_url',
    'thumbnailUrl',
    'poster',
    'preview_image',
    'previewImage',
    'image_url',
    'imageUrl'
  ]).filter((candidate) => isImageUrl(candidate));

  const pickSafeThumbnail = async (link?: string | null) => {
    for (const candidate of thumbnailCandidates) {
      try {
        await assertSafeOutboundUrl(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }

    const pageUrl = String(link || '').trim();
    if (pageUrl && isHttpUrl(pageUrl)) {
      try {
        const scrapedThumb = await scrapeImageFromPage(pageUrl);
        if (scrapedThumb) {
          await assertSafeOutboundUrl(scrapedThumb);
          return scrapedThumb;
        }
      } catch {
        // best effort only
      }
    }

    return null;
  };

  let existingUrlIssue: string | null = null;
  const existing = typeof feedItem.image_url === 'string' ? feedItem.image_url : null;
  const mediaCandidates = [...videoCandidates, existing].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of mediaCandidates) {
    if (!isHttpUrl(candidate)) continue;
    const existingType = isVideoUrl(candidate) ? 'video' : isImageUrl(candidate) ? 'image' : null;
    if (existingType) {
      try {
        await assertSafeOutboundUrl(candidate);
        const thumbnailUrl = existingType === 'video' ? await pickSafeThumbnail(feedItem.link) : null;
        return {
          url: candidate,
          mediaType: existingType,
          thumbnailUrl,
          source: candidate === existing ? feedItem.image_source || 'feed' : 'raw',
          scraped: false,
          error: null
        };
      } catch (error) {
        existingUrlIssue = getErrorMessage(error);
      }
    } else {
      existingUrlIssue = 'Feed media URL is unsupported for WhatsApp send';
    }
  }

  const link = typeof feedItem.link === 'string' ? feedItem.link : null;
  if (!link || !isHttpUrl(link)) {
    return { url: null, mediaType: null, thumbnailUrl: null, source: null, scraped: false, error: existingUrlIssue };
  }

  const scrapedAt = feedItem.image_scraped_at ? new Date(feedItem.image_scraped_at).getTime() : 0;
  const recentlyScraped = scrapedAt && !Number.isNaN(scrapedAt) && Date.now() - scrapedAt < 24 * 60 * 60 * 1000;
  if (recentlyScraped) {
    return {
      url: null,
      mediaType: null,
      thumbnailUrl: null,
      source: null,
      scraped: false,
      error: feedItem.image_scrape_error || existingUrlIssue || null
    };
  }

  try {
    const scraped = await scrapeImageFromPage(link);
    const nowIso = new Date().toISOString();
    if (scraped) {
      try {
        await assertSafeOutboundUrl(scraped);
      } catch (error) {
        const message = getErrorMessage(error);
        feedItem.image_scraped_at = nowIso;
        feedItem.image_scrape_error = message;
        await maybeUpdateFeedItemImage(supabase, feedItem.id, {
          image_scraped_at: nowIso,
          image_scrape_error: message
        });
        return { url: null, mediaType: null, thumbnailUrl: null, source: null, scraped: true, error: message };
      }

      feedItem.image_url = scraped;
      feedItem.image_source = 'page';
      feedItem.image_scraped_at = nowIso;
      feedItem.image_scrape_error = null;
      await maybeUpdateFeedItemImage(supabase, feedItem.id, {
        image_url: scraped,
        image_source: 'page',
        image_scraped_at: nowIso,
        image_scrape_error: null
      });
      return { url: scraped, mediaType: 'image', thumbnailUrl: null, source: 'page', scraped: true, error: null };
    }

    feedItem.image_scraped_at = nowIso;
    feedItem.image_scrape_error = 'No image found on page';
    await maybeUpdateFeedItemImage(supabase, feedItem.id, {
      image_scraped_at: nowIso,
      image_scrape_error: 'No image found on page'
    });
    return { url: null, mediaType: null, thumbnailUrl: null, source: null, scraped: true, error: 'No image found on page' };
  } catch (error) {
    const message = getErrorMessage(error);
    const nowIso = new Date().toISOString();
    feedItem.image_scraped_at = nowIso;
    feedItem.image_scrape_error = message;
    await maybeUpdateFeedItemImage(supabase, feedItem.id, {
      image_scraped_at: nowIso,
      image_scrape_error: message
    });
    return { url: null, mediaType: null, thumbnailUrl: null, source: null, scraped: true, error: message };
  }
};

const normalizeTargetJid = (target: Target) => {
  if (!target?.phone_number) {
    throw new Error('Target phone number missing');
  }

  const raw = String(target.phone_number).trim();
  const lower = raw.toLowerCase();
  if (lower === 'status@broadcast') {
    return 'status@broadcast';
  }
  if (lower.includes('@g.us') || lower.includes('@newsletter') || lower.includes('@s.whatsapp.net')) {
    return raw;
  }
  if (target.type === 'status') {
    return 'status@broadcast';
  }

  if (target.type === 'group') {
    const groupId = raw.replace(/[^0-9-]/g, '');
    if (!groupId) {
      throw new Error('Group ID invalid');
    }
    return `${groupId}@g.us`;
  }

  if (target.type === 'channel') {
    const channelId = raw.replace(/[^0-9]/g, '');
    if (!channelId) {
      throw new Error('Channel ID invalid');
    }
    return `${channelId}@newsletter`;
  }

  const phoneDigits = raw.replace(/[^0-9]/g, '');
  if (!phoneDigits) {
    throw new Error('Phone number invalid');
  }
  return `${phoneDigits}@s.whatsapp.net`;
};

const buildMessageData = (feedItem: FeedItem) => {
  const normalizedDescription = String(feedItem.description || '').trim();
  const normalizedContent = String(feedItem.content || '').trim();
  const fallbackDescription = normalizedDescription || normalizedContent.slice(0, 280);

  return {
    id: feedItem.id,
    guid: (feedItem as unknown as { guid?: string }).guid,
    title: feedItem.title,
    url: feedItem.link,
    link: feedItem.link,
    description: fallbackDescription,
    content: feedItem.content,
    author: feedItem.author,
    image_url: feedItem.image_url,
    imageUrl: feedItem.image_url,
    normalized_url: (feedItem as unknown as { normalized_url?: string }).normalized_url,
    normalizedUrl: (feedItem as unknown as { normalized_url?: string }).normalized_url,
    content_hash: (feedItem as unknown as { content_hash?: string }).content_hash,
    contentHash: (feedItem as unknown as { content_hash?: string }).content_hash,
    pub_date: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
    publishedAt: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
    categories: Array.isArray(feedItem.categories) ? feedItem.categories.join(', ') : '',
    ...(typeof (feedItem as unknown as { raw_data?: unknown }).raw_data === 'object' &&
    (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      ? Object.fromEntries(
          Object.entries((feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data || {}).map(
            ([key, value]) => {
              if (value == null) return [key, ''];
              if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [key, value];
              try {
                return [key, JSON.stringify(value)];
              } catch {
                return [key, String(value)];
              }
            }
          )
        )
      : {})
  };
};

const hasHttpUrl = (value: string) => /https?:\/\/[^\s]+/i.test(String(value || ''));

const ensurePreviewLink = (value: string, link?: string | null) => {
  const text = String(value || '').trim();
  const normalizedLink = String(link || '').trim();
  if (!normalizedLink) return text;
  if (hasHttpUrl(text)) return text;
  if (!text) return normalizedLink;
  return `${text}\n${normalizedLink}`;
};

const getTemplateSendMode = (template: Template) => {
  if (template?.send_mode === 'image' || template?.send_mode === 'link_preview' || template?.send_mode === 'text_only') {
    return template.send_mode;
  }
  return template?.send_images === false ? 'link_preview' : 'image';
};

type SendWithMediaResult = {
  response: any;
  text: string;
  media: {
    type: string | null;
    url: string | null;
    sent: boolean;
    error: string | null;
  };
};

const toTimestampIso = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'object' && value && 'low' in (value as Record<string, unknown>)) {
    const low = Number((value as Record<string, unknown>).low);
    if (Number.isFinite(low) && low > 0) {
      return new Date(low * 1000).toISOString();
    }
  }
  return new Date().toISOString();
};

const persistOutgoingChatMessage = async (
  supabase: SupabaseClient,
  params: {
    messageId: string;
    remoteJid: string;
    text: string;
    mediaUrl: string | null;
    mediaType: string | null;
    messageTimestamp: unknown;
    scheduleId: string;
    feedItemId: string;
  }
) => {
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
            source: 'dispatch',
            schedule_id: params.scheduleId,
            feed_item_id: params.feedItemId,
            media_type: params.mediaType,
            media_url: params.mediaUrl
          }
        },
        { onConflict: 'whatsapp_id' }
      );
  } catch (error) {
    logger.warn({ error, messageId: params.messageId }, 'Failed to persist outgoing chat message snapshot');
  }
};

const sendMessageWithTemplate = async (
  whatsappClient: WhatsAppClient,
  target: Target,
  template: Template,
  feedItem: FeedItem,
  options?: { sendImages?: boolean; supabase?: SupabaseClient; sendTimeoutMs?: number }
): Promise<SendWithMediaResult> => {
  const payload = buildMessageData(feedItem);
  const renderedText = applyTemplate(template.content, payload).trim();
  if (!renderedText) {
    throw new Error('Template rendered empty message');
  }

  if (!whatsappClient || whatsappClient.getStatus().status !== 'connected') {
    throw new Error('WhatsApp not connected');
  }

  if (!target?.phone_number) {
    throw new Error('Target phone number missing');
  }

  const jid = normalizeTargetJid(target);
  const sendMode = getTemplateSendMode(template);
  const allowRichMedia = options?.sendImages !== false && sendMode === 'image';
  const sendTimeoutMs = Math.max(Number(options?.sendTimeoutMs || DEFAULT_SEND_TIMEOUT_MS), 10000);

  const sendText = async (text: string, modeOptions?: { disableLinkPreview?: boolean }) => {
    const content: Record<string, unknown> = modeOptions?.disableLinkPreview
      ? { text, linkPreview: null }
      : { text };
    if (target.type === 'status') {
      return withTimeout(
        whatsappClient.sendStatusBroadcast(content),
        sendTimeoutMs,
        'Timed out sending status message'
      );
    }
    return withTimeout(
      whatsappClient.sendMessage(jid, content),
      sendTimeoutMs,
      'Timed out sending message'
    );
  };

  const textWithPreview = ensurePreviewLink(renderedText, feedItem.link);
  if (sendMode === 'text_only') {
    const response = await sendText(renderedText, { disableLinkPreview: true });
    return {
      response,
      text: renderedText,
      media: { type: null, url: null, sent: false, error: null }
    };
  }

  if (sendMode === 'link_preview') {
    const response = await sendText(textWithPreview);
    return {
      response,
      text: textWithPreview,
      media: { type: null, url: null, sent: false, error: null }
    };
  }

  const resolved = await resolveMediaForFeedItem(options?.supabase, feedItem, allowRichMedia);
  if (allowRichMedia && resolved.url && resolved.mediaType) {
    const mediaType = resolved.mediaType;
    let safeUrl: string;
    try {
      safeUrl = (await assertSafeOutboundUrl(resolved.url)).toString();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn({ error, jid, mediaUrl: resolved.url, mediaType }, 'Blocked unsafe media URL');
      const response = await sendText(textWithPreview);
      return {
        response,
        text: textWithPreview,
        media: { type: mediaType, url: resolved.url, sent: false, error: message }
      };
    }

    let videoThumbnailBuffer: Buffer | null = null;
    if (mediaType === 'video' && resolved.thumbnailUrl) {
      try {
        const safeThumbnailUrl = (await assertSafeOutboundUrl(resolved.thumbnailUrl)).toString();
        const downloadedThumbnail = await downloadImageBuffer(safeThumbnailUrl, feedItem.link);
        videoThumbnailBuffer = downloadedThumbnail.buffer;
      } catch (thumbError) {
        logger.warn(
          { thumbError, jid, mediaUrl: safeUrl, thumbnailUrl: resolved.thumbnailUrl },
          'Failed to fetch video thumbnail; sending without custom thumbnail'
        );
      }
    }

    const sendMediaContent = async (content: Record<string, unknown>, kind: 'buffer' | 'url') => {
      const timeoutLabel = kind === 'buffer'
        ? `Timed out sending ${mediaType} message`
        : `Timed out sending ${mediaType} message`;
      return target.type === 'status'
        ? withTimeout(whatsappClient.sendStatusBroadcast(content), sendTimeoutMs, timeoutLabel)
        : withTimeout(whatsappClient.sendMessage(jid, content), sendTimeoutMs, timeoutLabel);
    };

    try {
      const downloaded = mediaType === 'video'
        ? await downloadVideoBuffer(safeUrl, feedItem.link)
        : await downloadImageBuffer(safeUrl, feedItem.link);

      if (mediaType === 'video' && !videoThumbnailBuffer) {
        videoThumbnailBuffer = await generateVideoThumbnailFromBuffer(downloaded.buffer);
      }

      const content: Record<string, unknown> = mediaType === 'video'
        ? { video: downloaded.buffer, caption: renderedText }
        : { image: downloaded.buffer, caption: renderedText };
      if (downloaded.mimetype) {
        content.mimetype = downloaded.mimetype;
      }
      if (mediaType === 'video' && videoThumbnailBuffer) {
        content.jpegThumbnail = videoThumbnailBuffer;
      }

      const response = await sendMediaContent(content, 'buffer');

      return {
        response,
        text: renderedText,
        media: { type: mediaType, url: safeUrl, sent: true, error: null }
      };
    } catch (error) {
      const bufferErrorMessage = getErrorMessage(error);
      logger.warn(
        { error, jid, mediaUrl: safeUrl, mediaType },
        'Failed to download/send media buffer; trying URL-based send'
      );

      try {
        const content: Record<string, unknown> = mediaType === 'video'
          ? { video: { url: safeUrl }, caption: renderedText }
          : { image: { url: safeUrl }, caption: renderedText };
        if (mediaType === 'video' && videoThumbnailBuffer) {
          content.jpegThumbnail = videoThumbnailBuffer;
        }
        const response = await sendMediaContent(content, 'url');

        return {
          response,
          text: renderedText,
          media: { type: mediaType, url: safeUrl, sent: true, error: null }
        };
      } catch (urlError) {
        const urlErrorMessage = getErrorMessage(urlError);
        logger.warn(
          { error: urlError, jid, mediaUrl: safeUrl, mediaType, bufferError: bufferErrorMessage },
          'Failed to send media by URL, falling back to text'
        );
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: {
            type: mediaType,
            url: safeUrl,
            sent: false,
            error: `${bufferErrorMessage}; url-send: ${urlErrorMessage}`
          }
        };
      }
    }
  }

  const response = await sendText(textWithPreview);
  return {
    response,
    text: textWithPreview,
    media: {
      type: null,
      url: resolved.url || feedItem.image_url || null,
      sent: false,
      error: resolved.error || 'No usable media found for feed item; sent text with preview fallback'
    }
  };
};

type Schedule = {
  id: string;
  feed_id?: string | null;
  template_id?: string | null;
  target_ids?: string[];
  delivery_mode?: 'immediate' | 'batched' | 'batch' | null;
  batch_times?: string[] | null;
  cron_expression?: string | null;
  timezone?: string | null;
  last_run_at?: string | null;
  last_queued_at?: string | null;
  last_dispatched_at?: string | null;
  created_at?: string | null;
  active?: boolean;
};

type SendQueuedOptions = {
  skipFeedRefresh?: boolean;
};

const parseBatchTimes = (value: unknown): string[] => {
  const seen = new Set<string>();
  const times = Array.isArray(value) ? value : [];
  for (const time of times) {
    const normalized = String(time || '').trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) continue;
    seen.add(normalized);
  }
  return Array.from(seen).sort();
};

const toDailyCronExpression = (time: string) => {
  const [hour, minute] = time.split(':').map((part) => Number(part));
  return `${minute} ${hour} * * *`;
};

const computeNextBatchRunAt = (times: string[], timezone?: string | null) => {
  let nextValue: string | null = null;
  for (const time of times) {
    const expression = toDailyCronExpression(time);
    const candidate = computeNextRunAt(expression, timezone || 'UTC');
    if (!candidate) continue;
    if (!nextValue || new Date(candidate).getTime() < new Date(nextValue).getTime()) {
      nextValue = candidate;
    }
  }
  return nextValue;
};

const queueSinceLastRunForSchedule = async (
  supabase: SupabaseClient,
  schedule: Schedule,
  targets: Target[]
): Promise<{ queued: number; feedItemCount: number; cursorAt: string | null }> => {
  if (!schedule.feed_id) return { queued: 0, feedItemCount: 0, cursorAt: null };
  const sinceIso = schedule.last_queued_at || schedule.last_run_at;
  if (!sinceIso) return { queued: 0, feedItemCount: 0, cursorAt: null };
  if (!targets.length) return { queued: 0, feedItemCount: 0, cursorAt: null };

  const targetIds = targets.map((t) => t.id).filter(Boolean) as string[];
  if (!targetIds.length) return { queued: 0, feedItemCount: 0, cursorAt: null };

  const FEED_PAGE_SIZE = 200;
  const LOG_BATCH_SIZE = 1000;

  let cursorAt = sinceIso;
  let cursorId: string | null = null;
  let totalQueued = 0;
  let totalFeedItems = 0;

  const flushBatch = async (batch: Array<Record<string, unknown>>) => {
    if (!batch.length) return 0;
    const { data: insertedRows, error: upsertError } = await supabase
      .from('message_logs')
      .upsert(batch, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
      .select('id');
    if (upsertError) {
      logger.warn({ scheduleId: schedule.id, error: upsertError }, 'Failed to queue items since last run');
      return 0;
    }
    return insertedRows?.length || 0;
  };

  while (true) {
    let query = supabase
      .from('feed_items')
      .select('id, created_at')
      .eq('feed_id', schedule.feed_id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(FEED_PAGE_SIZE);

    if (cursorId) {
      query = query.or(`created_at.gt.${cursorAt},and(created_at.eq.${cursorAt},id.gt.${cursorId})`);
    } else {
      query = query.gt('created_at', cursorAt);
    }

    const { data: page, error: itemsError } = await query;
    if (itemsError) {
      logger.warn({ scheduleId: schedule.id, error: itemsError }, 'Failed to load feed items since last queued');
      break;
    }

    const items = (page || []) as Array<{ id?: string; created_at?: string }>;
    if (!items.length) {
      break;
    }

    totalFeedItems += items.length;

    let batch: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const feedItemId = item?.id ? String(item.id) : null;
      if (!feedItemId) continue;
      for (const targetId of targetIds) {
        batch.push({
          feed_item_id: feedItemId,
          target_id: targetId,
          schedule_id: schedule.id,
          template_id: schedule.template_id,
          status: 'pending'
        });
        if (batch.length >= LOG_BATCH_SIZE) {
          totalQueued += await flushBatch(batch);
          batch = [];
        }
      }
    }
    if (batch.length) {
      totalQueued += await flushBatch(batch);
    }

    const last = items[items.length - 1];
    if (last?.created_at) {
      cursorAt = String(last.created_at);
    }
    if (last?.id) {
      cursorId = String(last.id);
    }
  }

  return { queued: totalQueued, feedItemCount: totalFeedItems, cursorAt: cursorAt || null };
};

const queueRecentMissingForSchedule = async (
  supabase: SupabaseClient,
  schedule: Schedule,
  targets: Target[],
  lookbackHours: number
): Promise<number> => {
  if (!schedule.feed_id) return 0;
  if (!Array.isArray(targets) || !targets.length) return 0;
  if (!schedule.last_run_at && !schedule.last_queued_at) return 0;

  const lookback = Math.min(Math.max(Number(lookbackHours) || 0, 1), 72);
  const sinceIso = new Date(Date.now() - lookback * 60 * 60 * 1000).toISOString();

  const { data: recentItems, error: itemsError } = await supabase
    .from('feed_items')
    .select('id')
    .eq('feed_id', schedule.feed_id)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(400);

  if (itemsError || !recentItems?.length) {
    if (itemsError) {
      logger.warn({ scheduleId: schedule.id, error: itemsError }, 'Failed loading recent feed items for reconciliation');
    }
    return 0;
  }

  const targetIds = targets.map((target) => target.id).filter(Boolean) as string[];
  if (!targetIds.length) return 0;

  const pendingRows: Array<Record<string, unknown>> = [];
  for (const item of recentItems as Array<{ id?: string }>) {
    const feedItemId = item?.id ? String(item.id) : null;
    if (!feedItemId) continue;
    for (const targetId of targetIds) {
      pendingRows.push({
        feed_item_id: feedItemId,
        target_id: targetId,
        schedule_id: schedule.id,
        template_id: schedule.template_id,
        status: 'pending'
      });
    }
  }

  if (!pendingRows.length) return 0;

  const { data: insertedRows, error: insertError } = await supabase
    .from('message_logs')
    .upsert(pendingRows, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
    .select('id');

  if (insertError) {
    logger.warn({ scheduleId: schedule.id, error: insertError }, 'Failed reconciling recent queue items');
    return 0;
  }

  const inserted = insertedRows?.length || 0;
  if (inserted > 0) {
    logger.info({ scheduleId: schedule.id, inserted, lookbackHours: lookback }, 'Reconciled missing recent queue items');
  }
  return inserted;
};

type QueueLatestResult = {
  queued: number;
  inserted: number;
  revived: number;
  skipped: number;
  reason?: string;
  feedItemId?: string;
  feedItemTitle?: string | null;
  cursorAt?: string | null;
};

const queueLatestForSchedule = async (
  scheduleId: string,
  options?: { schedule?: Schedule; targets?: Target[] }
): Promise<QueueLatestResult> => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'Database not available' };
  }

  let schedule: Schedule | null = options?.schedule ?? null;
  if (!schedule) {
    const { data } = await supabase.from('schedules').select('*').eq('id', scheduleId).single();
    schedule = (data as Schedule | null) ?? null;
  }

  if (!schedule || !schedule.active) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'Schedule not found or inactive' };
  }

  if (!schedule.feed_id) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'Schedule has no feed' };
  }

  let targets: Target[] = options?.targets ?? [];
  if (!targets.length) {
    const { data } = await supabase
      .from('targets')
      .select('*')
      .in('id', Array.isArray(schedule.target_ids) ? schedule.target_ids : [])
      .eq('active', true);
    targets = data || [];
  }

  if (!targets.length) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'No active targets' };
  }

  const { data: latestFeedItem } = await supabase
    .from('feed_items')
    .select('id, title, created_at')
    .eq('feed_id', schedule.feed_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!latestFeedItem?.id) {
    return { queued: 0, inserted: 0, revived: 0, skipped: 0, reason: 'No feed items found' };
  }

  const targetIds = targets.map((target) => target.id).filter(Boolean) as string[];
  const { data: existingLogs, error: existingLogsError } = await supabase
    .from('message_logs')
    .select('id, target_id, status')
    .eq('schedule_id', schedule.id)
    .eq('feed_item_id', latestFeedItem.id)
    .in('target_id', targetIds);

  if (existingLogsError) {
    logger.warn({ scheduleId: schedule.id, error: existingLogsError }, 'Failed to check existing logs');
  }

  type ExistingLogRow = { id: string; target_id: string; status: string };
  const existingByTarget = new Map<string, ExistingLogRow>();
  for (const row of (existingLogs || []) as Array<Partial<ExistingLogRow>>) {
    if (!row?.id || !row?.target_id || !row?.status) continue;
    existingByTarget.set(String(row.target_id), {
      id: String(row.id),
      target_id: String(row.target_id),
      status: String(row.status)
    });
  }

  const toInsert: Array<Record<string, unknown>> = [];
  const toRevive: string[] = [];
  let skipped = 0;

  for (const targetId of targetIds) {
    const existing = existingByTarget.get(targetId);
    if (!existing) {
      toInsert.push({
        feed_item_id: latestFeedItem.id,
        target_id: targetId,
        schedule_id: schedule.id,
        template_id: schedule.template_id,
        status: 'pending'
      });
      continue;
    }

    if (existing.status === 'sent' || existing.status === 'processing' || existing.status === 'pending') {
      skipped += 1;
      continue;
    }

    if (existing.status === 'failed' || existing.status === 'skipped') {
      toRevive.push(existing.id);
      continue;
    }
  }

  let revived = 0;
  if (toRevive.length) {
    const { data: revivedRows } = await supabase
      .from('message_logs')
      .update({ status: 'pending', error_message: null, retry_count: 0, processing_started_at: null })
      .in('id', toRevive)
      .select('id');
    revived = revivedRows?.length || 0;
  }

  let inserted = 0;
  if (toInsert.length) {
    const { data: insertedRows, error: insertError } = await supabase
      .from('message_logs')
      .upsert(toInsert, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
      .select('id');
    if (insertError) {
      logger.warn({ scheduleId: schedule.id, error: insertError }, 'Failed to queue latest feed item');
    } else {
      inserted = insertedRows?.length || 0;
    }
  }

  return {
    queued: inserted + revived,
    inserted,
    revived,
    skipped,
    feedItemId: latestFeedItem.id,
    feedItemTitle: latestFeedItem.title || null,
    cursorAt: latestFeedItem.created_at ? String(latestFeedItem.created_at) : null
  };
};

const sendQueuedForSchedule = async (
  scheduleId: string,
  whatsappClient?: WhatsAppClient | null,
  options?: SendQueuedOptions
) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.error({ scheduleId }, 'Database not available - cannot send messages');
    return { sent: 0, error: 'Database not available' };
  }
  
  try {
    logger.info({ scheduleId }, 'Starting dispatch for schedule');
    // Get schedule
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();

    if (scheduleError || !schedule || !schedule.active) {
      logger.warn({ scheduleId, error: scheduleError?.message, schedule, active: schedule?.active }, 
        'Schedule not found or inactive');
      return { sent: 0, queued: 0 };
    }

    const deliveryMode = schedule.delivery_mode === 'batch' || schedule.delivery_mode === 'batched' ? 'batched' : 'immediate';

    // Check if schedule has feed_id - if not, it's a manual dispatch only
    if (!schedule.feed_id) {
      const shabbosStatus = await isCurrentlyShabbos();
      if (shabbosStatus.isShabbos) {
        logger.info({ scheduleId, reason: shabbosStatus.reason, endsAt: shabbosStatus.endsAt }, 
          'Skipping message send - Shabbos/Yom Tov active');
        return { 
          sent: 0, 
          queued: 0,
          skipped: true, 
          reason: shabbosStatus.reason,
          resumeAt: shabbosStatus.endsAt 
        };
      }

      if (!whatsappClient) {
        logger.warn({ scheduleId }, 'Skipping send - WhatsApp client not available');
        return { sent: 0, queued: 0, skipped: true, reason: 'WhatsApp not connected' };
      }

      const whatsappStatus = whatsappClient.getStatus();
      if (!whatsappStatus || whatsappStatus.status !== 'connected') {
        logger.warn({ scheduleId, whatsappStatus: whatsappStatus?.status || 'unknown' }, 
          'Skipping send - WhatsApp not connected');
        return { sent: 0, queued: 0, skipped: true, reason: 'WhatsApp not connected' };
      }

      logger.warn({ scheduleId }, 'Schedule has no feed_id - manual dispatch only');
      // For manual dispatch, we need to look for pending logs without feed items
      const { data: manualLogs, error: manualLogsError } = await supabase
        .from('message_logs')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('status', 'pending')
        .is('feed_item_id', null);

      if (manualLogsError) throw manualLogsError;
      
      if (!manualLogs || manualLogs.length === 0) {
        logger.info({ scheduleId }, 'No pending manual messages to send');
        return { sent: 0, queued: 0 };
      }

      // For manual dispatch, we can't proceed without feed items
      logger.warn({ scheduleId, count: manualLogs.length }, 
        'Pending manual logs found but no feed items - cannot send');
      return { sent: 0, queued: 0, error: 'Manual dispatch requires feed items' };
    }

    // Get targets
    const targetIds = Array.isArray(schedule.target_ids) ? schedule.target_ids : [];

    const { data: targets, error: targetsError } = await supabase
      .from('targets')
      .select('*')
      .in('id', targetIds)
      .eq('active', true);

    if (targetsError) {
      logger.error({ scheduleId, error: targetsError }, 'Failed to fetch targets');
      throw targetsError;
    }
    logger.info({ scheduleId, targetCount: targets?.length || 0 }, 'Found targets for schedule');

    const settings = await settingsService.getSettings();

    if (!options?.skipFeedRefresh) {
      try {
        const { data: feed } = await supabase.from('feeds').select('*').eq('id', schedule.feed_id).single();
        if (feed) {
          await fetchAndProcessFeed(feed);
        }
      } catch (error) {
        logger.warn({ scheduleId, feedId: schedule.feed_id, error }, 'Failed to refresh feed during dispatch');
      }
    }

    let queuedCount = 0;
    let queueCursorAt: string | null = null;

    if (deliveryMode === 'batched') {
      const initialCursor =
        schedule.last_queued_at ||
        schedule.last_run_at ||
        schedule.created_at ||
        new Date().toISOString();

      const scheduleForQueue: Schedule =
        schedule.last_queued_at || schedule.last_run_at
          ? schedule
          : { ...schedule, last_queued_at: initialCursor };

      const sinceResult = await queueSinceLastRunForSchedule(supabase, scheduleForQueue, targets);
      queuedCount += sinceResult.queued;
      queueCursorAt = sinceResult.cursorAt || initialCursor;
    } else if (schedule.last_queued_at || schedule.last_run_at) {
      const sinceResult = await queueSinceLastRunForSchedule(supabase, schedule, targets);
      queuedCount += sinceResult.queued;
      queueCursorAt = sinceResult.cursorAt;
    } else {
      const latestResult = await queueLatestForSchedule(scheduleId, { schedule, targets });
      queuedCount += latestResult.queued;
      queueCursorAt = latestResult.cursorAt || null;
    }

    if (deliveryMode !== 'batched') {
      const lookbackHours = Math.max(Number(settings.reconcile_queue_lookback_hours || 12), 1);
      queuedCount += await queueRecentMissingForSchedule(supabase, schedule, targets, lookbackHours);
    }

    // Persist the queue cursor even if we skip sending (e.g. WhatsApp disconnected or Shabbos).
    // This avoids re-scanning the same feed items on every retry.
    if (queueCursorAt) {
      const { error: queueCursorError } = await supabase
        .from('schedules')
        .update({ last_queued_at: queueCursorAt })
        .eq('id', scheduleId);
      if (queueCursorError) {
        const msg = String((queueCursorError as { message?: unknown })?.message || queueCursorError);
        const missingQueueCursorColumn =
          msg.toLowerCase().includes('last_queued_at') && msg.toLowerCase().includes('does not exist');
        if (missingQueueCursorColumn) {
          logger.warn(
            { scheduleId, error: queueCursorError },
            'Schedule queue cursor columns missing; run SQL migrations (scripts/012_schedule_queue_cursor.sql)'
          );
        } else {
          logger.warn({ scheduleId, error: queueCursorError }, 'Failed to update schedule queue cursor');
        }
      }
    }

    const shabbosStatus = await isCurrentlyShabbos();
    if (shabbosStatus.isShabbos) {
      logger.info({ scheduleId, reason: shabbosStatus.reason, endsAt: shabbosStatus.endsAt }, 
        'Skipping message send - Shabbos/Yom Tov active');
      return { 
        sent: 0, 
        queued: queuedCount,
        skipped: true, 
        reason: shabbosStatus.reason,
        resumeAt: shabbosStatus.endsAt 
      };
    }

    if (!whatsappClient) {
      logger.warn({ scheduleId }, 'Skipping send - WhatsApp client not available');
      return { sent: 0, queued: queuedCount, skipped: true, reason: 'WhatsApp not connected' };
    }

    const whatsappStatus = whatsappClient.getStatus();
    if (!whatsappStatus || whatsappStatus.status !== 'connected') {
      logger.warn({ scheduleId, whatsappStatus: whatsappStatus?.status || 'unknown' }, 
        'Skipping send - WhatsApp not connected');
      return { sent: 0, queued: queuedCount, skipped: true, reason: 'WhatsApp not connected' };
    }

    const maxPendingAgeHours = Math.max(Number(settings.max_pending_age_hours || 48), 1);
    const staleCutoffMs = Date.now() - maxPendingAgeHours * 60 * 60 * 1000;
    const maxFeedItemAgeHours = Math.max(Number(settings.max_feed_item_age_hours || 72), 1);
    const staleFeedItemCutoffMs = Date.now() - maxFeedItemAgeHours * 60 * 60 * 1000;

    // Get template
    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', schedule.template_id)
      .single();

    if (templateError || !template) {
      logger.error({ scheduleId, templateId: schedule.template_id, error: templateError }, 
        'Template not found for schedule');
      throw new Error('Template not found for schedule');
    }
    logger.info({ scheduleId, templateId: template.id }, 'Found template for schedule');

    let sentCount = 0;

    for (const target of targets || []) {
      const pendingReadRetries = Math.max(Number(settings.dispatch_pending_read_retries || 8), 0);
      const pendingReadDelayMs = Math.max(Number(settings.dispatch_pending_read_delay_ms || 500), 50);

      // Recently upserted queue rows can be briefly invisible to an immediate follow-up SELECT.
      // Retry pending reads to avoid returning sent=0 while rows exist.
      let logs: Array<{
        id?: string;
        created_at?: string | null;
        feed_item_id?: string | null;
        retry_count?: number | null;
      }> = [];
      let logsError: unknown = null;

      for (let attempt = 0; attempt <= pendingReadRetries; attempt += 1) {
        const result = await supabase
          .from('message_logs')
          .select('*')
          .eq('schedule_id', scheduleId)
          .eq('target_id', target.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });

        logs =
          ((result.data || []) as Array<{
            id?: string;
            created_at?: string | null;
            feed_item_id?: string | null;
            retry_count?: number | null;
          }>) || [];
        logsError = result.error;

        if (logsError) {
          break;
        }

        if (logs.length > 0 || queuedCount <= 0 || attempt >= pendingReadRetries) {
          break;
        }

        logger.info(
          {
            scheduleId,
            targetId: target.id,
            attempt: attempt + 1,
            retries: pendingReadRetries,
            queuedCount,
            pendingReadDelayMs
          },
          'Pending logs not visible yet; retrying pending read'
        );
        await sleep(pendingReadDelayMs);
      }

      if (logsError) {
        logger.warn({ scheduleId, targetId: target.id, error: logsError }, 'Failed reading pending logs for target');
        continue;
      }

      if (!logs.length) {
        continue;
      }

      const staleLogIds = (logs || [])
        .filter((entry: { id?: string; created_at?: string | null }) => {
          const createdAt = entry?.created_at ? new Date(entry.created_at).getTime() : 0;
          return Boolean(entry?.id) && Number.isFinite(createdAt) && createdAt > 0 && createdAt < staleCutoffMs;
        })
        .map((entry: { id?: string }) => entry.id)
        .filter(Boolean) as string[];

      if (staleLogIds.length) {
        await supabase
          .from('message_logs')
          .update({
            status: 'skipped',
            processing_started_at: null,
            error_message: `Skipped stale queued item (> ${maxPendingAgeHours}h old)`,
            media_url: null,
            media_type: null,
            media_sent: false,
            media_error: null
          })
          .in('id', staleLogIds);
      }

      const runnableLogs = (logs || []).filter(
        (entry: { id?: string }) => Boolean(entry?.id) && !staleLogIds.includes(String(entry.id))
      );

      if (!runnableLogs.length) {
        continue;
      }

      if (target.type === 'group' && whatsappClient.getGroupInfo) {
        try {
          const jid = normalizeTargetJid(target);
          const info = await whatsappClient.getGroupInfo(jid);
          if (info?.announce && !info?.me?.isAdmin) {
            const reason = 'Group is admin-only (announce mode) and this WhatsApp account is not an admin';
            const ids = (runnableLogs || []).map((l: { id?: string }) => l.id).filter(Boolean) as string[];
            if (ids.length) {
              await supabase
                .from('message_logs')
                .update({
                  status: 'failed',
                  processing_started_at: null,
                  error_message: reason,
                  media_url: null,
                  media_type: null,
                  media_sent: false,
                  media_error: null
                })
                .in('id', ids);
            }
            continue;
          }
        } catch (error) {
          logger.warn({ scheduleId, targetId: target.id, error }, 'Failed to check group send policy');
        }
      }

      if (target.type === 'channel' && whatsappClient.getChannelInfo) {
        try {
          const jid = normalizeTargetJid(target);
          const info = await whatsappClient.getChannelInfo(jid);
          if (info?.canSend === false) {
            const reason = info.viewerRole
              ? `Channel posting is not allowed for this WhatsApp account (role: ${info.viewerRole})`
              : 'Channel posting is not allowed for this WhatsApp account';
            const ids = (runnableLogs || []).map((l: { id?: string }) => l.id).filter(Boolean) as string[];
            if (ids.length) {
              await supabase
                .from('message_logs')
                .update({
                  status: 'failed',
                  processing_started_at: null,
                  error_message: reason,
                  media_url: null,
                  media_type: null,
                  media_sent: false,
                  media_error: null
                })
                .in('id', ids);
            }
            continue;
          }
        } catch (error) {
          const message = getErrorMessage(error).toLowerCase();
          const channelNotFound =
            message.includes('not found') ||
            message.includes('404') ||
            message.includes('newsletter') ||
            message.includes('invalid jid');

          if (channelNotFound) {
            const reason = `Channel validation failed: ${getErrorMessage(error)}`;
            const ids = (runnableLogs || []).map((l: { id?: string }) => l.id).filter(Boolean) as string[];
            if (ids.length) {
              await supabase
                .from('message_logs')
                .update({
                  status: 'failed',
                  processing_started_at: null,
                  error_message: reason,
                  media_url: null,
                  media_type: null,
                  media_sent: false,
                  media_error: null
                })
                .in('id', ids);
            }
            continue;
          }

          logger.warn({ scheduleId, targetId: target.id, error }, 'Failed to validate channel send policy');
        }
      }

      const runnableIds = (runnableLogs || [])
        .map((log: { id?: string }) => String(log?.id || ''))
        .filter(Boolean);

      const claimedAt = new Date().toISOString();
      const { data: claimedRows, error: claimError } = await supabase
        .from('message_logs')
        .update({ status: 'processing', processing_started_at: claimedAt })
        .in('id', runnableIds)
        .eq('status', 'pending')
        .select('*');

      if (claimError) {
        logger.warn({ scheduleId, targetId: target.id, error: claimError }, 'Failed to claim pending logs for target');
        continue;
      }

      const claimedLogs = ((claimedRows || []) as Array<{
        id?: string;
        feed_item_id?: string | null;
        retry_count?: number | null;
        created_at?: string | null;
      }>)
        .filter((row) => Boolean(row?.id))
        .sort((a, b) => {
          const aTime = a?.created_at ? new Date(a.created_at).getTime() : 0;
          const bTime = b?.created_at ? new Date(b.created_at).getTime() : 0;
          if (aTime !== bTime) return aTime - bTime;
          return String(a?.id || '').localeCompare(String(b?.id || ''));
        });

      const claimMisses = Math.max(runnableIds.length - claimedLogs.length, 0);
      if (!claimedLogs.length) {
        logger.info(
          {
            scheduleId,
            targetId: target.id,
            pendingCount: logs.length,
            runnableCount: runnableLogs.length,
            claimMisses,
            sentCount: 0
          },
          'Dispatch target summary'
        );
        continue;
      }

      let targetSentCount = 0;

      for (const log of claimedLogs) {
        // Get feed item
        const { data: feedItem, error: feedItemError } = await supabase
          .from('feed_items')
          .select('*')
          .eq('id', log.feed_item_id)
          .single();

        if (feedItemError || !feedItem) {
          await supabase
            .from('message_logs')
            .update({
              status: 'failed',
              error_message: 'Feed item missing',
              processing_started_at: null,
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
          continue;
        }

        const feedItemPublishedAtMs = feedItem?.pub_date ? new Date(feedItem.pub_date).getTime() : NaN;
        const feedItemCreatedAtMs = feedItem?.created_at ? new Date(feedItem.created_at).getTime() : NaN;
        const feedItemAgeMs = Number.isFinite(feedItemPublishedAtMs)
          ? feedItemPublishedAtMs
          : Number.isFinite(feedItemCreatedAtMs)
            ? feedItemCreatedAtMs
            : NaN;

        if (Number.isFinite(feedItemAgeMs) && feedItemAgeMs < staleFeedItemCutoffMs) {
          await supabase
            .from('message_logs')
            .update({
              status: 'skipped',
              processing_started_at: null,
              error_message: `Skipped stale feed item (> ${maxFeedItemAgeHours}h old by publish/create timestamp)`,
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
          continue;
        }

        try {
          const sendResult = await withGlobalSendLock(async () => {
            await waitForDelays(String(target.id), settings);
            const result = await sendMessageWithTemplate(whatsappClient, target, template, feedItem, {
              sendImages: template?.send_images !== false,
              supabase,
              sendTimeoutMs: Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS)
            });
            const nowMs = Date.now();
            globalLastSentAtMs = nowMs;
            globalLastTargetId = String(target.id);
            globalLastSentByTargetId.set(String(target.id), nowMs);
            if (globalLastSentByTargetId.size > 1000) {
              globalLastSentByTargetId.clear();
            }
            return result;
          });
          const response = sendResult?.response;

          const messageId = response?.key?.id;
          if (messageId) {
            const remoteJid =
              (response?.key?.remoteJid ? String(response.key.remoteJid) : null) ||
              normalizeTargetJid(target);

            await persistOutgoingChatMessage(supabase, {
              messageId: String(messageId),
              remoteJid,
              text: String(sendResult?.text || ''),
              mediaUrl: sendResult?.media?.url || null,
              mediaType: sendResult?.media?.type || null,
              messageTimestamp: response?.messageTimestamp,
              scheduleId,
              feedItemId: String(feedItem.id)
            });

            if (whatsappClient.confirmSend) {
              const isMediaSend =
                (sendResult?.media?.type === 'image' || sendResult?.media?.type === 'video') &&
                Boolean(sendResult?.media?.sent);
              const confirmation = await whatsappClient.confirmSend(
                messageId,
                isMediaSend
                  ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
                  : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 }
              );
              if (!confirmation?.ok) {
                throw new Error('Message send not confirmed (no upsert/ack)');
              }
            } else if (whatsappClient.waitForMessage) {
              const observed = await whatsappClient.waitForMessage(messageId, 15000);
              if (!observed) {
                throw new Error('Message send not confirmed (no local upsert)');
              }
            }
          }
           
          await supabase
            .from('message_logs')
            .update({ 
              status: 'sent', 
              sent_at: new Date().toISOString(), 
              processing_started_at: null,
              error_message: null,
              message_content: sendResult?.text || null,
              whatsapp_message_id: messageId,
              media_url: sendResult?.media?.url || null,
              media_type: sendResult?.media?.type || null,
              media_sent: Boolean(sendResult?.media?.sent),
              media_error: sendResult?.media?.error || null
            })
            .eq('id', log.id);

          const { error: markSentError } = await supabase
            .from('feed_items')
            .update({ sent: true, sent_at: new Date().toISOString() })
            .eq('id', feedItem.id)
            .eq('sent', false);
          if (markSentError) {
            logger.warn({ scheduleId, feedItemId: feedItem.id, error: markSentError }, 'Failed to mark feed item as sent');
          }
          
          sentCount += 1;
          targetSentCount += 1;
        } catch (error) {
          logger.error({ error, scheduleId, feedItemId: feedItem.id, targetId: target.id }, 'Failed to send message');

          const rawErrorMessage = getErrorMessage(error);
          const authError = isAuthStateError(rawErrorMessage);
          const errorMessage = authError
            ? `${AUTH_ERROR_HINT} (${rawErrorMessage || 'unknown auth error'})`
            : rawErrorMessage;
          const timeoutUnknownDelivery = /timed out sending/i.test(rawErrorMessage);
          const normalizedErrorMessage = rawErrorMessage.toLowerCase();
          const nonRetryable = [
            'Template rendered empty message',
            'Target phone number missing',
            'Group ID invalid',
            'Channel ID invalid',
            'Phone number invalid',
            'channel posting is not allowed',
            'cannot post to that channel',
            'forbidden',
            'not-authorized'
          ].some((needle) => normalizedErrorMessage.includes(needle.toLowerCase()));

          const shouldNotRetry = nonRetryable || timeoutUnknownDelivery;

          if (shouldNotRetry) {
            const finalErrorMessage = timeoutUnknownDelivery
              ? `Timed out while sending (delivery may have succeeded). Not auto-retrying to avoid duplicates. ${errorMessage}`
              : errorMessage;
            await supabase
              .from('message_logs')
              .update({
                status: 'failed',
                processing_started_at: null,
                error_message: finalErrorMessage,
                media_url: null,
                media_type: null,
                media_sent: false,
                media_error: null
              })
              .eq('id', log.id);
            continue;
          }
          
          // Check if we should retry
          const maxRetries = Number(settings.max_retries || 3);
          const currentRetry = log.retry_count || 0;
          
          if (currentRetry < maxRetries) {
            logger.info({ 
              scheduleId, 
              feedItemId: feedItem.id, 
              targetId: target.id, 
              retry: currentRetry + 1, 
              maxRetries
            }, 'Retrying failed message');
            
            // Update retry count and keep as pending
            await supabase
              .from('message_logs')
              .update({ 
                status: 'pending',
                processing_started_at: null,
                error_message: `Retry ${currentRetry + 1}/${maxRetries}: ${errorMessage}`,
                retry_count: currentRetry + 1,
                media_url: null,
                media_type: null,
                media_sent: false,
                media_error: null
              })
              .eq('id', log.id);
            
            continue;
          }
          
          // Max retries reached, mark as failed
          await supabase
            .from('message_logs')
            .update({ 
              status: 'failed',
              processing_started_at: null,
              error_message: `Max retries (${maxRetries}) exceeded: ${errorMessage}`,
              media_url: null,
              media_type: null,
              media_sent: false,
              media_error: null
            })
            .eq('id', log.id);
        }

        // Delay is handled via waitForDelays() under a global send lock.
      }

      logger.info(
        {
          scheduleId,
          targetId: target.id,
          pendingCount: logs.length,
          runnableCount: runnableLogs.length,
          claimMisses,
          sentCount: targetSentCount
        },
        'Dispatch target summary'
      );
    }

    const lastRunAt = new Date().toISOString();
    let nextRunAt: string | null = null;
    if (deliveryMode === 'batched') {
      const batchTimes = parseBatchTimes(schedule.batch_times);
      nextRunAt = computeNextBatchRunAt(batchTimes, schedule.timezone || 'UTC');
    } else if (schedule.cron_expression) {
      nextRunAt = computeNextRunAt(schedule.cron_expression, schedule.timezone);
    }
    const scheduleUpdates: Record<string, unknown> = { last_run_at: lastRunAt, next_run_at: nextRunAt };
    if (queueCursorAt) {
      scheduleUpdates.last_queued_at = queueCursorAt;
    }
    if (deliveryMode === 'batched') {
      scheduleUpdates.last_dispatched_at = lastRunAt;
    }
    const { error: scheduleUpdateError } = await supabase.from('schedules').update(scheduleUpdates).eq('id', scheduleId);
    if (scheduleUpdateError) {
      const msg = String((scheduleUpdateError as { message?: unknown })?.message || scheduleUpdateError);
      const missingQueueCursorColumn =
        msg.toLowerCase().includes('last_queued_at') && msg.toLowerCase().includes('does not exist');
      if (missingQueueCursorColumn) {
        logger.warn(
          { scheduleId, error: scheduleUpdateError },
          'Schedule queue cursor columns missing; run SQL migrations (scripts/012_schedule_queue_cursor.sql)'
        );
        await supabase.from('schedules').update({ last_run_at: lastRunAt, next_run_at: nextRunAt }).eq('id', scheduleId);
      } else {
        logger.warn({ scheduleId, error: scheduleUpdateError }, 'Failed to update schedule run timestamps');
      }
    }

    logger.info({ scheduleId, sentCount }, 'Dispatch completed successfully');
    return { sent: sentCount, queued: queuedCount };
  } catch (error) {
    logger.error({ error, scheduleId }, 'Failed to send queued messages');
    return { sent: 0, queued: 0, error: getErrorMessage(error) };
  }
};

const sendPendingForAllSchedules = async (whatsappClient?: WhatsAppClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.error('Database not available - cannot send pending messages');
    return { sent: 0, schedules: 0, error: 'Database not available' };
  }

  try {
    const { data: orphanPendingRows, error: orphanPendingError } = await supabase
      .from('message_logs')
      .select('id')
      .is('schedule_id', null)
      .eq('status', 'pending');
    if (orphanPendingError) throw orphanPendingError;

    const orphanPendingIds = (orphanPendingRows || [])
      .map((row: { id?: string }) => row.id)
      .filter(Boolean) as string[];
    if (orphanPendingIds.length) {
      const { error: cleanupError } = await supabase
        .from('message_logs')
        .delete()
        .in('id', orphanPendingIds);
      if (cleanupError) {
        logger.warn({ error: cleanupError, orphanPendingCount: orphanPendingIds.length }, 'Failed cleaning orphan pending logs');
      } else {
        logger.info({ orphanPendingCount: orphanPendingIds.length }, 'Cleaned orphan pending logs');
      }
    }

    const { data: pendingLogs, error: pendingLogsError } = await supabase
      .from('message_logs')
      .select('schedule_id')
      .eq('status', 'pending');

    if (pendingLogsError) {
      throw pendingLogsError;
    }

    const scheduleIds = [...new Set((pendingLogs || []).map((log: { schedule_id?: string }) => log.schedule_id).filter(Boolean))] as string[];
    const { data: scheduleRows } = await supabase
      .from('schedules')
      .select('id,delivery_mode')
      .in('id', scheduleIds);

    const batchScheduleIds = new Set(
      (scheduleRows || [])
        .filter((row: { id?: string; delivery_mode?: string | null }) => row?.delivery_mode === 'batched' || row?.delivery_mode === 'batch')
        .map((row: { id?: string }) => String(row.id || ''))
        .filter(Boolean)
    );

    let totalSent = 0;
    let totalQueued = 0;
    let skippedBatch = 0;

    for (const scheduleId of scheduleIds) {
      if (batchScheduleIds.has(scheduleId)) {
        skippedBatch += 1;
        continue;
      }
      const result = await sendQueuedForSchedule(scheduleId, whatsappClient);
      if (result?.sent) {
        totalSent += result.sent;
      }
      if (result?.queued) {
        totalQueued += result.queued;
      }
    }

    logger.info(
      { scheduleCount: scheduleIds.length, skippedBatch, totalSent, totalQueued },
      'Processed pending schedules after reconnect'
    );
    return { sent: totalSent, queued: totalQueued, schedules: scheduleIds.length };
  } catch (error) {
      logger.error({ error }, 'Failed to send pending schedules after reconnect');
      return { sent: 0, queued: 0, schedules: 0, error: getErrorMessage(error) };
    }
  };

module.exports = {
  sendQueuedForSchedule,
  sendPendingForAllSchedules,
  queueLatestForSchedule
};
