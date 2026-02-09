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
  send_mode?: 'image' | 'image_only' | 'link_preview' | 'text_only' | null;
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
  pub_date?: string | Date;
  categories?: string[];
};

type WhatsAppClient = {
  getStatus: () => { status: string };
  sendMessage: (jid: string, content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
  sendStatusBroadcast: (content: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
  reconnect?: () => Promise<void> | void;
  waitForMessage?: (messageId: string, timeoutMs?: number) => Promise<any>;
  confirmSend?: (
    messageId: string,
    options?: { upsertTimeoutMs?: number; ackTimeoutMs?: number }
  ) => Promise<{ ok: boolean; via: 'upsert' | 'ack' | 'none'; status?: number | null; statusLabel?: string | null }>;
  getGroupInfo?: (
    jid: string,
    timeoutMs?: number
  ) => Promise<{ announce: boolean; me: { isAdmin: boolean } } | null>;
};

const DEFAULT_SEND_TIMEOUT_MS = 45000;
const AUTH_ERROR_HINT = 'WhatsApp auth state corrupted. Clear sender keys or re-scan the QR code, then retry.';
const MANUAL_POST_PAUSE_ERROR = 'Paused for this post';
const FEED_PAUSED_ERROR = 'Feed paused';
const NON_REVIVABLE_SKIP_ERRORS = new Set([MANUAL_POST_PAUSE_ERROR, FEED_PAUSED_ERROR]);

let globalLastTargetId: string | null = null;
let globalLastSentAtMs = 0;
const globalLastSentByTargetId = new Map<string, number>();



// Simple Mutex with Timeout to replace the fragile Promise chain
class SendMutex {
  private queue: Array<{ resolve: (release: () => void) => void; timer: NodeJS.Timeout }> = [];
  private locked = false;

  async run<T>(fn: () => Promise<T>, timeoutMs = 60000): Promise<T> {
    const acquire = new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue if timed out
        this.queue = this.queue.filter(item => item.timer !== timer);
        reject(new Error('Acquire send lock timeout'));
      }, timeoutMs);

      if (!this.locked) {
        this.locked = true;
        clearTimeout(timer);
        resolve(() => this.release());
      } else {
        this.queue.push({ resolve: (release) => { clearTimeout(timer); resolve(release); }, timer });
      }
    });

    let release: () => void;
    try {
      release = await acquire;
    } catch (e) {
      logger.warn({ error: e }, 'Failed to acquire send lock, skipping item');
      throw e;
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next.resolve(() => this.release());
    } else {
      this.locked = false;
    }
  }
}

const sendMutex = new SendMutex();


// Replaces withGlobalSendLock
const withGlobalSendLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  return sendMutex.run(fn, 120000); // 2 minute max wait to acquire lock
};

const ensureWhatsAppConnected = async (
  whatsappClient?: WhatsAppClient | null,
  options?: { attempts?: number; delayMs?: number; triggerReconnect?: boolean }
) => {
  if (!whatsappClient) return false;

  const attempts = Math.max(Number(options?.attempts || 1), 1);
  const delayMs = Math.max(Number(options?.delayMs || 1000), 250);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = String(whatsappClient.getStatus?.().status || 'unknown');
    if (status === 'connected') {
      return true;
    }

    if (options?.triggerReconnect && attempt === 1 && (status === 'conflict' || status === 'disconnected')) {
      try {
        await Promise.resolve(whatsappClient.reconnect?.());
      } catch (error) {
        logger.warn({ error, status }, 'Failed to trigger WhatsApp reconnect while waiting for connected state');
      }
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return false;
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
  // Safety: If globalLastSentAtMs is in the future (bad clock?), reset it
  if (globalLastSentAtMs > now + 30000) globalLastSentAtMs = now;

  const sinceGlobal = globalLastSentAtMs ? now - globalLastSentAtMs : Number.POSITIVE_INFINITY;
  const lastTargetSent = globalLastSentByTargetId.get(targetId) || 0;
  const sinceTarget = lastTargetSent ? now - lastTargetSent : Number.POSITIVE_INFINITY;

  const waitGlobal = Number.isFinite(sinceGlobal) ? Math.max(minBetweenAnyMs - sinceGlobal, 0) : 0;
  const waitSameTarget = Number.isFinite(sinceTarget) ? Math.max(minBetweenSameTargetMs - sinceTarget, 0) : 0;

  const switchedTargets = Boolean(globalLastTargetId && globalLastTargetId !== targetId);
  const waitSwitchTarget = switchedTargets && Number.isFinite(sinceGlobal)
    ? Math.max(interTargetDelayMs - sinceGlobal, 0)
    : 0;

  const waitMs = Math.min(Math.max(waitGlobal, waitSameTarget, waitSwitchTarget), 30000); // Cap wait at 30s
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

// Check if URL points to an image (not video/audio)
const isImageUrl = (url: string): boolean => {
  const lower = String(url || '').toLowerCase();
  const hasExt = (ext: string) => new RegExp(`${ext.replace('.', '\\.')}([?#]|$)`).test(lower);

  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg'];
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v'];
  const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'];

  // Explicitly exclude videos and audio
  if (videoExtensions.some(ext => lower.includes(ext))) return false;
  if (audioExtensions.some(ext => lower.includes(ext))) return false;

  // Check if it's a known image extension
  return imageExtensions.some(ext => lower.includes(ext));
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
  const SUPPORTED_WHATSAPP_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const validUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const response = await axios.get(imageUrl, {
    timeout: 20000,
    responseType: 'arraybuffer',
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: {
      'User-Agent': validUserAgent,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': refererUrl ? new URL(refererUrl).origin : undefined,
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"'
    }
  });

  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  const data = response.data;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const detectMimeTypeFromBuffer = (value: Buffer): string | null => {
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

  if (!contentType.startsWith('image/')) {
    throw new Error(`URL did not return an image (content-type: ${contentType || 'unknown'})`);
  }
  const normalizedMimeType = contentType.split(';')[0]?.trim() || '';
  const detectedMimeType = detectMimeTypeFromBuffer(buffer);
  const finalMimeType = detectedMimeType || normalizedMimeType;
  if (!detectedMimeType) {
    throw new Error('Unsupported or corrupt image data for WhatsApp upload');
  }
  if (!SUPPORTED_WHATSAPP_IMAGE_MIME.has(finalMimeType)) {
    throw new Error(`Unsupported image MIME type for WhatsApp upload (${normalizedMimeType || 'unknown'})`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${buffer.length} bytes)`);
  }
  return { buffer, mimetype: finalMimeType };
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

const resolveImageUrlForFeedItem = async (
  supabase: SupabaseClient | undefined,
  feedItem: FeedItem,
  allowImages: boolean
): Promise<{ url: string | null; source: string | null; scraped: boolean; error: string | null }> => {
  if (!allowImages) {
    return { url: null, source: null, scraped: false, error: null };
  }

  let existingUrlIssue: string | null = null;
  const existing = typeof feedItem.image_url === 'string' ? feedItem.image_url : null;
  if (existing && isHttpUrl(existing)) {
    if (isImageUrl(existing)) {
      try {
        await assertSafeOutboundUrl(existing);
        return { url: existing, source: feedItem.image_source || 'feed', scraped: false, error: null };
      } catch (error) {
        existingUrlIssue = getErrorMessage(error);
      }
    } else {
      existingUrlIssue = 'Feed media URL is not an image';
    }
  }

  const link = typeof feedItem.link === 'string' ? feedItem.link : null;
  if (!link || !isHttpUrl(link)) {
    return { url: null, source: null, scraped: false, error: existingUrlIssue };
  }

  const scrapedAt = feedItem.image_scraped_at ? new Date(feedItem.image_scraped_at).getTime() : 0;
  const recentlyScraped = scrapedAt && !Number.isNaN(scrapedAt) && Date.now() - scrapedAt < 24 * 60 * 60 * 1000;
  if (recentlyScraped) {
    return {
      url: null,
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
        return { url: null, source: null, scraped: true, error: message };
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
      return { url: scraped, source: 'page', scraped: true, error: null };
    }

    feedItem.image_scraped_at = nowIso;
    feedItem.image_scrape_error = 'No image found on page';
    await maybeUpdateFeedItemImage(supabase, feedItem.id, {
      image_scraped_at: nowIso,
      image_scrape_error: 'No image found on page'
    });
    return { url: null, source: null, scraped: true, error: 'No image found on page' };
  } catch (error) {
    const message = getErrorMessage(error);
    const nowIso = new Date().toISOString();
    feedItem.image_scraped_at = nowIso;
    feedItem.image_scrape_error = message;
    await maybeUpdateFeedItemImage(supabase, feedItem.id, {
      image_scraped_at: nowIso,
      image_scrape_error: message
    });
    return { url: null, source: null, scraped: true, error: message };
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

const buildMessageData = (feedItem: FeedItem) => ({
  id: feedItem.id,
  guid: (feedItem as unknown as { guid?: string }).guid,
  title: feedItem.title,
  url: feedItem.link,
  link: feedItem.link,
  description: feedItem.description,
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
});

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
  if (template?.send_mode === 'image' && template?.send_images === false) {
    return 'image_only';
  }
  if (
    template?.send_mode === 'image' ||
    template?.send_mode === 'image_only' ||
    template?.send_mode === 'link_preview' ||
    template?.send_mode === 'text_only'
  ) {
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

const sendMessageWithTemplate = async (
  whatsappClient: WhatsAppClient,
  target: Target,
  template: Template,
  feedItem: FeedItem,
  options?: { sendImages?: boolean; supabase?: SupabaseClient; sendTimeoutMs?: number; overrideText?: string | null }
): Promise<SendWithMediaResult> => {
  const payload = buildMessageData(feedItem);
  const manualOverrideText = normalizeMessageText(String(options?.overrideText || '')).trim();
  const renderedText = (manualOverrideText || applyTemplate(template.content, payload)).trim();
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
  const allowImages = options?.sendImages !== false;
  const sendTimeoutMs = Math.max(Number(options?.sendTimeoutMs || DEFAULT_SEND_TIMEOUT_MS), 10000);
  const sendMode = getTemplateSendMode(template);
  const includeImageCaption = sendMode !== 'image_only';
  const allowTextFallback = sendMode !== 'image_only';

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

  const resolved = await resolveImageUrlForFeedItem(options?.supabase, feedItem, allowImages);
  if (sendMode === 'image_only' && !resolved.url) {
    throw new Error('Image-only mode requires an available image for this feed item');
  }

  if (allowImages && resolved.url) {
    let safeUrl: string;
    try {
      safeUrl = (await assertSafeOutboundUrl(resolved.url)).toString();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn({ error, jid, imageUrl: resolved.url }, 'Blocked unsafe image URL');
      if (!allowTextFallback) {
        throw new Error(`Image-only mode blocked unsafe image URL: ${message}`);
      }
      const response = await sendText(textWithPreview);
      return {
        response,
        text: textWithPreview,
        media: { type: 'image', url: resolved.url, sent: false, error: message }
      };
    }

    try {
      const { buffer, mimetype } = await downloadImageBuffer(safeUrl, feedItem.link);
      const content: Record<string, unknown> = includeImageCaption
        ? { image: buffer, caption: renderedText }
        : { image: buffer };
      if (mimetype) {
        content.mimetype = mimetype;
      }

      const response =
        target.type === 'status'
          ? await withTimeout(
            whatsappClient.sendStatusBroadcast(content),
            sendTimeoutMs,
            'Timed out sending image status message'
          )
          : await withTimeout(
            whatsappClient.sendMessage(jid, content),
            sendTimeoutMs,
            'Timed out sending image message'
          );

      return {
        response,
        text: includeImageCaption ? renderedText : '',
        media: { type: 'image', url: safeUrl, sent: true, error: null }
      };
    } catch (error) {
      const bufferErrorMessage = getErrorMessage(error);
      if (
        /Unsupported image MIME type for WhatsApp upload|Unsupported or corrupt image data for WhatsApp upload|URL did not return an image/i.test(
          bufferErrorMessage
        )
      ) {
        if (!allowTextFallback) {
          throw new Error(bufferErrorMessage);
        }
        logger.info(
          { jid, imageUrl: safeUrl, reason: bufferErrorMessage },
          'Skipping unsupported image type and falling back to text'
        );
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: { type: 'image', url: safeUrl, sent: false, error: bufferErrorMessage }
        };
      }

      logger.warn(
        { error, jid, imageUrl: safeUrl },
        'Image buffer send unavailable; trying URL-based send'
      );

      try {
        const content: Record<string, unknown> = includeImageCaption
          ? { image: { url: safeUrl }, caption: renderedText }
          : { image: { url: safeUrl } };
        const response =
          target.type === 'status'
            ? await withTimeout(
              whatsappClient.sendStatusBroadcast(content),
              sendTimeoutMs,
              'Timed out sending image status message'
            )
            : await withTimeout(
              whatsappClient.sendMessage(jid, content),
              sendTimeoutMs,
              'Timed out sending image message'
            );

        return {
          response,
          text: includeImageCaption ? renderedText : '',
          media: { type: 'image', url: safeUrl, sent: true, error: null }
        };
      } catch (urlError) {
        const urlErrorMessage = getErrorMessage(urlError);
        if (!allowTextFallback) {
          throw new Error(`${bufferErrorMessage}; url-send: ${urlErrorMessage}`);
        }
        logger.info(
          { error: urlError, jid, imageUrl: safeUrl, bufferError: bufferErrorMessage },
          'Image URL send rejected; using text fallback'
        );
        const response = await sendText(textWithPreview);
        return {
          response,
          text: textWithPreview,
          media: {
            type: 'image',
            url: safeUrl,
            sent: false,
            error: `${bufferErrorMessage}; url-send: ${urlErrorMessage}`
          }
        };
      }
    }
  }

  if (sendMode === 'image_only') {
    throw new Error('Image-only mode could not find an image to send');
  }

  const response = await sendText(textWithPreview);
  return {
    response,
    text: textWithPreview,
    media: { type: null, url: null, sent: false, error: null }
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

  // Pre-fetch existing combinations to avoid duplicates in batch
  const existingCombos = new Set<string>();
  const refreshExistingCombos = async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // Last 7 days
    const { data: existing } = await supabase
      .from('message_logs')
      .select('schedule_id,feed_item_id,target_id')
      .eq('schedule_id', schedule.id)
      .gte('created_at', since);
    
    existingCombos.clear();
    for (const row of (existing || [])) {
      const key = `${row.schedule_id}:${row.feed_item_id}:${row.target_id}`;
      existingCombos.add(key);
    }
  };
  
  await refreshExistingCombos();

  const flushBatch = async (batch: Array<Record<string, unknown>>) => {
    if (!batch.length) return 0;
    
    // Filter out any that we know already exist
    const filtered = batch.filter(item => {
      const key = `${item.schedule_id}:${item.feed_item_id}:${item.target_id}`;
      return !existingCombos.has(key);
    });
    
    if (!filtered.length) return 0;
    
    const { data: insertedRows, error: upsertError } = await supabase
      .from('message_logs')
      .upsert(filtered, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
      .select('id');
    if (upsertError) {
      logger.warn({ scheduleId: schedule.id, error: upsertError }, 'Failed to queue items since last run');
      return 0;
    }
    
    // Add newly inserted to our tracking set
    for (const item of filtered) {
      const key = `${item.schedule_id}:${item.feed_item_id}:${item.target_id}`;
      existingCombos.add(key);
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
    .select('id, target_id, status, error_message')
    .eq('schedule_id', schedule.id)
    .eq('feed_item_id', latestFeedItem.id)
    .in('target_id', targetIds);

  if (existingLogsError) {
    logger.warn({ scheduleId: schedule.id, error: existingLogsError }, 'Failed to check existing logs');
  }

  type ExistingLogRow = { id: string; target_id: string; status: string; error_message?: string | null };
  const existingByTarget = new Map<string, ExistingLogRow>();
  for (const row of (existingLogs || []) as Array<Partial<ExistingLogRow>>) {
    if (!row?.id || !row?.target_id || !row?.status) continue;
    existingByTarget.set(String(row.target_id), {
      id: String(row.id),
      target_id: String(row.target_id),
      status: String(row.status),
      error_message: row.error_message ? String(row.error_message) : null
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

    if (existing.status === 'sent' || existing.status === 'processing') {
      skipped += 1;
      continue;
    }

    if (existing.status === 'skipped' && NON_REVIVABLE_SKIP_ERRORS.has(String(existing.error_message || ''))) {
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

    const { data: feed, error: feedError } = await supabase
      .from('feeds')
      .select('*')
      .eq('id', schedule.feed_id)
      .single();

    if (feedError || !feed) {
      logger.warn({ scheduleId, feedId: schedule.feed_id, error: feedError }, 'Feed not found for schedule dispatch');
      return { sent: 0, queued: 0, skipped: true, reason: 'Feed not found' };
    }

    if (feed.active === false) {
      logger.info({ scheduleId, feedId: schedule.feed_id }, 'Skipping dispatch because feed is paused');
      return { sent: 0, queued: 0, skipped: true, reason: FEED_PAUSED_ERROR };
    }

    if (!options?.skipFeedRefresh) {
      try {
        await fetchAndProcessFeed(feed);
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
      // Get pending message logs for this target and schedule
      const { data: logs, error: logsError } = await supabase
        .from('message_logs')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('target_id', target.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });

      if (logsError) continue;

      if (!logs || logs.length === 0) {
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

      for (const log of runnableLogs || []) {
        const { data: claimedRows, error: claimError } = await supabase
          .from('message_logs')
          .update({ status: 'processing', processing_started_at: new Date().toISOString() })
          .eq('id', log.id)
          .eq('status', 'pending')
          .select('id');

        if (claimError) {
          logger.warn({ scheduleId, logId: log.id, error: claimError }, 'Failed to claim message log');
          continue;
        }

        if (!claimedRows || claimedRows.length === 0) {
          continue;
        }
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

        try {
          const sendResult = await withGlobalSendLock(async () => {
            await waitForDelays(String(target.id), settings);
            const result = await sendMessageWithTemplate(whatsappClient, target, template, feedItem, {
              sendImages: template?.send_images !== false,
              supabase,
              sendTimeoutMs: Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
              overrideText: typeof log.message_content === 'string' ? log.message_content : null
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
            if (whatsappClient.confirmSend) {
              const isImage = sendResult?.media?.type === 'image' && Boolean(sendResult?.media?.sent);
              const confirmation = await whatsappClient.confirmSend(
                messageId,
                isImage
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
        } catch (error) {
          logger.error({ error, scheduleId, feedItemId: feedItem.id, targetId: target.id }, 'Failed to send message');

          const rawErrorMessage = getErrorMessage(error);
          const authError = isAuthStateError(rawErrorMessage);
          const errorMessage = authError
            ? `${AUTH_ERROR_HINT} (${rawErrorMessage || 'unknown auth error'})`
            : rawErrorMessage;
          const timeoutUnknownDelivery = /timed out sending/i.test(rawErrorMessage);
          const nonRetryable = [
            'Template rendered empty message',
            'Target phone number missing',
            'Group ID invalid',
            'Channel ID invalid',
            'Phone number invalid',
            'Image-only mode'
          ].some((needle) => rawErrorMessage.includes(needle));

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

const sendQueueLogNow = async (logId: string, whatsappClient?: WhatsAppClient | null) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: 'Database not available' };
  }

  const connected = await ensureWhatsAppConnected(whatsappClient, {
    attempts: 8,
    delayMs: 1200,
    triggerReconnect: true
  });

  if (!connected) {
    return { ok: false, error: 'WhatsApp not connected' };
  }

  const activeWhatsappClient = whatsappClient;
  if (!activeWhatsappClient) {
    return { ok: false, error: 'WhatsApp not connected' };
  }

  try {
    const { data: logRow, error: logError } = await supabase
      .from('message_logs')
      .select('*')
      .eq('id', logId)
      .single();

    if (logError || !logRow) {
      return { ok: false, error: 'Queue item not found' };
    }

    const log = logRow as {
      id: string;
      status: string;
      schedule_id?: string | null;
      target_id?: string | null;
      feed_item_id?: string | null;
      template_id?: string | null;
      message_content?: string | null;
    };

    if (log.status === 'sent') {
      return { ok: false, error: 'Queue item is already sent' };
    }

    if (!log.schedule_id || !log.target_id || !log.feed_item_id) {
      return { ok: false, error: 'Queue item is missing schedule, target, or feed item' };
    }

    const { data: claimRows, error: claimError } = await supabase
      .from('message_logs')
      .update({ status: 'processing', processing_started_at: new Date().toISOString() })
      .eq('id', log.id)
      .in('status', ['pending', 'failed', 'skipped'])
      .select('id');

    if (claimError) {
      return { ok: false, error: getErrorMessage(claimError) };
    }

    if (!claimRows || claimRows.length === 0) {
      return { ok: false, error: 'Queue item is currently being processed by another worker' };
    }

    const [scheduleRes, targetRes, feedItemRes] = await Promise.all([
      supabase.from('schedules').select('*').eq('id', log.schedule_id).single(),
      supabase.from('targets').select('*').eq('id', log.target_id).single(),
      supabase.from('feed_items').select('*').eq('id', log.feed_item_id).single()
    ]);

    if (targetRes.error || !targetRes.data) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Target not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Target not found' };
    }

    if (feedItemRes.error || !feedItemRes.data) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Feed item not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Feed item not found' };
    }

    const templateId = (log.template_id || scheduleRes.data?.template_id) as string | null;
    if (!templateId) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Template not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Template not found' };
    }

    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: 'Template not found',
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);
      return { ok: false, error: 'Template not found' };
    }

    const settings = await settingsService.getSettings();
    try {
      const sendResult = await withGlobalSendLock(async () => {
        await waitForDelays(String(targetRes.data.id), settings);
        const result = await sendMessageWithTemplate(
          activeWhatsappClient,
          targetRes.data as Target,
          template as Template,
          feedItemRes.data as FeedItem,
          {
            sendImages: (template as Template).send_images !== false,
            supabase,
            sendTimeoutMs: Number(settings.send_timeout_ms || DEFAULT_SEND_TIMEOUT_MS),
            overrideText: typeof log.message_content === 'string' ? log.message_content : null
          }
        );
        const nowMs = Date.now();
        globalLastSentAtMs = nowMs;
        globalLastTargetId = String(targetRes.data.id);
        globalLastSentByTargetId.set(String(targetRes.data.id), nowMs);
        if (globalLastSentByTargetId.size > 1000) {
          globalLastSentByTargetId.clear();
        }
        return result;
      });

      const messageId = sendResult?.response?.key?.id;
      if (messageId) {
        if (activeWhatsappClient.confirmSend) {
          const isImage = sendResult?.media?.type === 'image' && Boolean(sendResult?.media?.sent);
          const confirmation = await activeWhatsappClient.confirmSend(
            messageId,
            isImage
              ? { upsertTimeoutMs: 30000, ackTimeoutMs: 60000 }
              : { upsertTimeoutMs: 5000, ackTimeoutMs: 15000 }
          );
          if (!confirmation?.ok) {
            throw new Error('Message send not confirmed (no upsert/ack)');
          }
        } else if (activeWhatsappClient.waitForMessage) {
          const observed = await activeWhatsappClient.waitForMessage(messageId, 15000);
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
          whatsapp_message_id: messageId || null,
          media_url: sendResult?.media?.url || null,
          media_type: sendResult?.media?.type || null,
          media_sent: Boolean(sendResult?.media?.sent),
          media_error: sendResult?.media?.error || null
        })
        .eq('id', log.id);

      await supabase
        .from('feed_items')
        .update({ sent: true, sent_at: new Date().toISOString() })
        .eq('id', String(feedItemRes.data.id || ''))
        .eq('sent', false);

      return { ok: true, messageId: messageId || null, mediaSent: Boolean(sendResult?.media?.sent) };
    } catch (error) {
      const rawErrorMessage = getErrorMessage(error);
      const authError = isAuthStateError(rawErrorMessage);
      const errorMessage = authError
        ? `${AUTH_ERROR_HINT} (${rawErrorMessage || 'unknown auth error'})`
        : rawErrorMessage;

      await supabase
        .from('message_logs')
        .update({
          status: 'failed',
          processing_started_at: null,
          error_message: errorMessage,
          media_url: null,
          media_type: null,
          media_sent: false,
          media_error: null
        })
        .eq('id', log.id);

      return { ok: false, error: errorMessage };
    }
  } catch (error) {
    logger.error({ error, logId }, 'Failed to send queue item now');
    return { ok: false, error: getErrorMessage(error) };
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
  queueLatestForSchedule,
  sendQueueLogNow
};
