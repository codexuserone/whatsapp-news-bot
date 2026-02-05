import type { SupabaseClient } from '@supabase/supabase-js';
const { getSupabaseClient } = require('../db/supabase');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('./feedProcessor');
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

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const AUTH_ERROR_HINT =
  'WhatsApp auth state corrupted. Clear sender keys or re-scan the QR code, then retry.';

const DEFAULT_BATCH_TIMES = ['07:00', '15:00', '22:00'];

const parseTimeOfDay = (value: string): { hour: number; minute: number } | null => {
  const raw = String(value || '').trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
};

const normalizeBatchTimes = (value: unknown): string[] => {
  const times = Array.isArray(value) ? value : [];
  const normalized = times
    .map((entry) => String(entry || '').trim())
    .filter((entry) => Boolean(parseTimeOfDay(entry)));
  return normalized.length ? normalized : DEFAULT_BATCH_TIMES;
};

const timeOfDayToCronExpression = (value: string): string | null => {
  const parsed = parseTimeOfDay(value);
  if (!parsed) return null;
  return `${parsed.minute} ${parsed.hour} * * *`;
};

const pickEarliestIso = (values: Array<string | null | undefined>): string | null => {
  const candidates = values
    .map((v) => (v ? String(v) : ''))
    .filter(Boolean)
    .map((iso) => ({ iso, ts: Date.parse(iso) }))
    .filter((entry) => Number.isFinite(entry.ts));
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.ts - b.ts);
  return candidates[0]?.iso ?? null;
};

const getZonedParts = (date: Date, timeZone?: string | null) => {
  const resolveParts = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = resolveParts(timeZone || 'UTC');
  } catch {
    parts = resolveParts('UTC');
  }

  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  if (!lookup.year || !lookup.month || !lookup.day || !lookup.hour || !lookup.minute) {
    return null;
  }

  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute
  };
};

const getBatchWindowKey = (date: Date, timeZone?: string | null) => {
  const parts = getZonedParts(date, timeZone);
  if (!parts) return null;
  const time = `${parts.hour}:${parts.minute}`;
  return {
    time,
    key: `${parts.year}-${parts.month}-${parts.day} ${time}`
  };
};

const getBatchWindowStatus = (options: {
  now: Date;
  timezone?: string | null;
  batchTimes?: unknown;
  lastDispatchedAt?: string | null;
}) => {
  const times = normalizeBatchTimes(options.batchTimes);
  const current = getBatchWindowKey(options.now, options.timezone);
  if (!current) {
    return { allowed: true, windowKey: null };
  }

  if (!times.includes(current.time)) {
    return { allowed: false, reason: 'Outside batch window', windowKey: current.key };
  }

  if (options.lastDispatchedAt) {
    const last = getBatchWindowKey(new Date(options.lastDispatchedAt), options.timezone);
    if (last?.key === current.key) {
      return { allowed: false, reason: 'Already dispatched for batch window', windowKey: current.key };
    }
  }

  return { allowed: true, windowKey: current.key };
};

const computeNextBatchRunAt = (batchTimes: unknown, timezone?: string | null): string | null => {
  const times = normalizeBatchTimes(batchTimes);
  const candidates = times
    .map((time) => timeOfDayToCronExpression(time))
    .filter(Boolean)
    .map((expr) => computeNextRunAt(expr as string, timezone));
  return pickEarliestIso(candidates);
};

let globalSendChain: Promise<void> = Promise.resolve();
let globalLastSentAtMs = 0;
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

  const minBetweenAnyMs = Math.max(messageDelayMs, interTargetDelayMs, 0);
  const minBetweenSameTargetMs = Math.max(messageDelayMs, intraTargetDelayMs, 0);

  const now = Date.now();
  const sinceGlobal = globalLastSentAtMs ? now - globalLastSentAtMs : Number.POSITIVE_INFINITY;
  const lastTargetSent = globalLastSentByTargetId.get(targetId) || 0;
  const sinceTarget = lastTargetSent ? now - lastTargetSent : Number.POSITIVE_INFINITY;

  const waitGlobal = Number.isFinite(sinceGlobal) ? Math.max(minBetweenAnyMs - sinceGlobal, 0) : 0;
  const waitTarget = Number.isFinite(sinceTarget) ? Math.max(minBetweenSameTargetMs - sinceTarget, 0) : 0;
  const waitMs = Math.max(waitGlobal, waitTarget);
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

const tokenizeTemplatePath = (value: string): Array<string | number> => {
  const tokens: Array<string | number> = [];
  const input = String(value || '').trim();
  if (!input) return tokens;
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    if (match[1]) {
      tokens.push(match[1]);
    } else if (match[2]) {
      tokens.push(Number(match[2]));
    }
  }
  return tokens;
};

const getTemplateValue = (data: Record<string, unknown>, key: string): unknown => {
  if (!key) return undefined;
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    return data[key];
  }
  const tokens = tokenizeTemplatePath(key);
  let current: any = data;
  for (const token of tokens) {
    if (current == null) return undefined;
    current = current[token as any];
  }
  return current;
};

const formatTemplateValue = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const applyTemplate = (templateBody: string, data: Record<string, unknown>): string => {
  if (!templateBody) return '';
  return templateBody.replace(/{{\s*([^{}\s]+)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey || '').trim();
    return formatTemplateValue(getTemplateValue(data, key));
  });
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
  const lower = url.toLowerCase();
  // Check file extensions
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
  'Mozilla/5.0 (compatible; WhatsAppNewsBot/0.2; +https://example.invalid)';

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
    $('meta[name="twitter:image"]').attr('content'),
    $('meta[name="twitter:image:src"]').attr('content'),
    $('link[rel="image_src"]').attr('href')
  ];

  for (const raw of metaCandidates) {
    const resolved = normalizeUrlCandidate(raw, pageUrl);
    if (resolved) return resolved;
  }

  const img = $('article img, .entry-content img, .post-content img, img').first();
  const srcset = img.attr('data-srcset') || img.attr('srcset');
  const src =
    pickFromSrcset(srcset) ||
    img.attr('data-src') ||
    img.attr('data-lazy-src') ||
    img.attr('data-original') ||
    img.attr('src');

  return normalizeUrlCandidate(src, pageUrl);
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

  const existing = typeof feedItem.image_url === 'string' ? feedItem.image_url : null;
  if (existing && isHttpUrl(existing)) {
    // Skip video URLs - they can't be sent as images
    if (!isImageUrl(existing)) {
      return { url: null, source: null, scraped: false, error: 'URL is not an image (possibly video)' };
    }
    try {
      await assertSafeOutboundUrl(existing);
      return { url: existing, source: feedItem.image_source || 'feed', scraped: false, error: null };
    } catch (error) {
      const message = getErrorMessage(error);
      return { url: null, source: null, scraped: false, error: message };
    }
  }

  const link = typeof feedItem.link === 'string' ? feedItem.link : null;
  if (!link || !isHttpUrl(link)) {
    return { url: null, source: null, scraped: false, error: null };
  }

  const scrapedAt = feedItem.image_scraped_at ? new Date(feedItem.image_scraped_at).getTime() : 0;
  const recentlyScraped = scrapedAt && !Number.isNaN(scrapedAt) && Date.now() - scrapedAt < 24 * 60 * 60 * 1000;
  if (recentlyScraped) {
    return { url: null, source: null, scraped: false, error: feedItem.image_scrape_error || null };
  }

  try {
    const scraped = await scrapeImageFromPage(link);
    const nowIso = new Date().toISOString();
    if (scraped) {
      if (!isImageUrl(scraped)) {
        feedItem.image_scraped_at = nowIso;
        feedItem.image_scrape_error = 'Scraped URL is not an image (possibly video/audio)';
        await maybeUpdateFeedItemImage(supabase, feedItem.id, {
          image_scraped_at: nowIso,
          image_scrape_error: feedItem.image_scrape_error
        });
        return {
          url: null,
          source: null,
          scraped: true,
          error: feedItem.image_scrape_error
        };
      }

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

const sanitizeText = (text: string | null | undefined): string => {
  if (!text) return '';
  // Fix common encoding issues - replace problematic characters with safe equivalents
  return String(text)
    .replace(/[\u0080-\u009F]/g, '') // Remove C1 control characters
    .replace(/\uFFFD/g, '') // Remove replacement characters (question mark boxes)
    .replace(/â€™/g, "'") // Curly apostrophe
    .replace(/â€œ/g, '"') // Left double quote
    .replace(/â€/g, '"') // Right double quote
    .replace(/â€"/g, '-') // Em dash
    .replace(/â€"/g, '-') // En dash
    .replace(/Ã©/g, 'é') // é
    .replace(/Ã¨/g, 'è') // è
    .replace(/Ã´/g, 'ô') // ô
    .replace(/Ã®/g, 'î') // î
    .replace(/Ã§/g, 'ç') // ç
    .replace(/Ã /g, 'à') // à
    .replace(/Ã¢/g, 'â') // â
    .replace(/Ã«/g, 'ë') // ë
    .replace(/Ã¯/g, 'ï') // ï
    .replace(/Ã¼/g, 'ü') // ü
    .replace(/Ã¶/g, 'ö') // ö
    .replace(/Ã¤/g, 'ä') // ä
    .replace(/Ã±/g, 'ñ') // ñ
    .trim();
};

const buildMessageData = (feedItem: FeedItem) => ({
  id: feedItem.id,
  guid: (feedItem as unknown as { guid?: string }).guid,
  title: sanitizeText(feedItem.title),
  url: feedItem.link,
  link: feedItem.link,
  description: sanitizeText(feedItem.description || feedItem.content),
  content: sanitizeText(feedItem.content || feedItem.description),
  author: sanitizeText(feedItem.author),
  image_url: feedItem.image_url,
  imageUrl: feedItem.image_url,
  normalized_url: (feedItem as unknown as { normalized_url?: string }).normalized_url,
  normalizedUrl: (feedItem as unknown as { normalized_url?: string }).normalized_url,
  content_hash: (feedItem as unknown as { content_hash?: string }).content_hash,
  contentHash: (feedItem as unknown as { content_hash?: string }).content_hash,
  pub_date: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  publishedAt: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  categories: Array.isArray(feedItem.categories) ? feedItem.categories.join(', ') : '',
  raw_data:
    typeof (feedItem as unknown as { raw_data?: unknown }).raw_data === 'object' &&
    (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      ? (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      : {},
  raw:
    typeof (feedItem as unknown as { raw_data?: unknown }).raw_data === 'object' &&
    (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      ? (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      : {},
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
  options?: { sendImages?: boolean; supabase?: SupabaseClient }
): Promise<SendWithMediaResult> => {
  const payload = buildMessageData(feedItem);
  const text = applyTemplate(template.content, payload).trim();
  if (!text) {
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

  const sendText = async () => {
    if (target.type === 'status') {
      return withTimeout(
        whatsappClient.sendStatusBroadcast({ text }),
        DEFAULT_SEND_TIMEOUT_MS,
        'Timed out sending status message'
      );
    }
    return withTimeout(
      whatsappClient.sendMessage(jid, { text }),
      DEFAULT_SEND_TIMEOUT_MS,
      'Timed out sending message'
    );
  };

  const resolved = await resolveImageUrlForFeedItem(options?.supabase, feedItem, allowImages);
  if (allowImages && resolved.url) {
    let safeUrl: string;
    try {
      safeUrl = (await assertSafeOutboundUrl(resolved.url)).toString();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn({ error, jid, imageUrl: resolved.url }, 'Blocked unsafe image URL');
      const response = await sendText();
      return {
        response,
        text,
        media: { type: 'image', url: resolved.url, sent: false, error: message }
      };
    }

    try {
      const { buffer, mimetype } = await downloadImageBuffer(safeUrl, feedItem.link);
      const content: Record<string, unknown> = {
        image: buffer,
        caption: text
      };
      if (mimetype) {
        content.mimetype = mimetype;
      }

      const response =
        target.type === 'status'
          ? await withTimeout(
              whatsappClient.sendStatusBroadcast(content),
              DEFAULT_SEND_TIMEOUT_MS,
              'Timed out sending image status message'
            )
          : await withTimeout(
              whatsappClient.sendMessage(jid, content),
              DEFAULT_SEND_TIMEOUT_MS,
              'Timed out sending image message'
            );

      return {
        response,
        text,
        media: { type: 'image', url: safeUrl, sent: true, error: null }
      };
    } catch (error) {
      const bufferErrorMessage = getErrorMessage(error);
      logger.warn(
        { error, jid, imageUrl: safeUrl },
        'Failed to download/send image buffer; trying URL-based send'
      );

      try {
        const content: Record<string, unknown> = {
          image: { url: safeUrl },
          caption: text
        };
        const response =
          target.type === 'status'
            ? await withTimeout(
                whatsappClient.sendStatusBroadcast(content),
                DEFAULT_SEND_TIMEOUT_MS,
                'Timed out sending image status message'
              )
            : await withTimeout(
                whatsappClient.sendMessage(jid, content),
                DEFAULT_SEND_TIMEOUT_MS,
                'Timed out sending image message'
              );

        return {
          response,
          text,
          media: { type: 'image', url: safeUrl, sent: true, error: null }
        };
      } catch (urlError) {
        const urlErrorMessage = getErrorMessage(urlError);
        logger.warn(
          { error: urlError, jid, imageUrl: safeUrl, bufferError: bufferErrorMessage },
          'Failed to send image by URL, falling back to text'
        );
        const response = await sendText();
        return {
          response,
          text,
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

  const response = await sendText();
  return {
    response,
    text,
    media: { type: null, url: null, sent: false, error: null }
  };
};

type Schedule = {
  id: string;
  feed_id?: string | null;
  template_id?: string | null;
  target_ids?: string[];
  cron_expression?: string | null;
  timezone?: string | null;
  last_run_at?: string | null;
  last_queued_at?: string | null;
  delivery_mode?: string | null;
  batch_times?: string[] | null;
  last_dispatched_at?: string | null;
  active?: boolean;
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

    if (existing.status === 'sent' || existing.status === 'processing') {
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

const sendQueuedForSchedule = async (scheduleId: string, whatsappClient?: WhatsAppClient | null) => {
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

    const deliveryMode = String(schedule.delivery_mode || 'immediate');
    let queuedCount = 0;
    let queueCursorAt: string | null = null;

    // Check if schedule has feed_id - if not, it's a manual dispatch only
    if (!schedule.feed_id) {
      if (deliveryMode === 'batched') {
        const windowStatus = getBatchWindowStatus({
          now: new Date(),
          timezone: schedule.timezone,
          batchTimes: schedule.batch_times,
          lastDispatchedAt: schedule.last_dispatched_at
        });

        if (!windowStatus.allowed) {
          const nextRunAt = computeNextBatchRunAt(schedule.batch_times, schedule.timezone);
          if (nextRunAt) {
            const { error: nextRunAtError } = await supabase
              .from('schedules')
              .update({ next_run_at: nextRunAt })
              .eq('id', scheduleId);
            if (nextRunAtError) {
              logger.warn(
                { scheduleId, error: nextRunAtError },
                'Failed to update next run time for batched schedule'
              );
            }
          }

          logger.info(
            { scheduleId, reason: windowStatus.reason, window: windowStatus.windowKey },
            'Skipping batched schedule send'
          );
          return {
            sent: 0,
            queued: queuedCount,
            skipped: true,
            reason: windowStatus.reason,
            nextRunAt
          };
        }
      }

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

    try {
      const { data: feed } = await supabase.from('feeds').select('*').eq('id', schedule.feed_id).single();
      if (feed) {
        const refreshResult = await fetchAndProcessFeed(feed);
        if (refreshResult.items.length) {
          await queueFeedItemsForSchedules(feed.id, refreshResult.items);
        }
      }
    } catch (error) {
      logger.warn({ scheduleId, feedId: schedule.feed_id, error }, 'Failed to refresh feed during dispatch');
    }

    if (schedule.last_queued_at || schedule.last_run_at) {
      const sinceResult = await queueSinceLastRunForSchedule(supabase, schedule, targets);
      queuedCount += sinceResult.queued;
      queueCursorAt = sinceResult.cursorAt;
    } else {
      // New schedule with no cursor - queue only items from last 48 hours (not all historical items)
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const recentSchedule = { ...schedule, last_queued_at: since48h };
      const recentResult = await queueSinceLastRunForSchedule(supabase, recentSchedule, targets);
      queuedCount += recentResult.queued;
      queueCursorAt = recentResult.cursorAt;
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

    if (deliveryMode === 'batched') {
      const windowStatus = getBatchWindowStatus({
        now: new Date(),
        timezone: schedule.timezone,
        batchTimes: schedule.batch_times,
        lastDispatchedAt: schedule.last_dispatched_at
      });

      if (!windowStatus.allowed) {
        const nextRunAt = computeNextBatchRunAt(schedule.batch_times, schedule.timezone);
        if (nextRunAt) {
          const { error: nextRunAtError } = await supabase
            .from('schedules')
            .update({ next_run_at: nextRunAt })
            .eq('id', scheduleId);
          if (nextRunAtError) {
            logger.warn(
              { scheduleId, error: nextRunAtError },
              'Failed to update next run time for batched schedule'
            );
          }
        }

        logger.info(
          { scheduleId, reason: windowStatus.reason, window: windowStatus.windowKey },
          'Skipping batched schedule send'
        );
        return {
          sent: 0,
          queued: queuedCount,
          skipped: true,
          reason: windowStatus.reason,
          nextRunAt
        };
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

    const settings = await settingsService.getSettings();

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
        .order('created_at', { ascending: true });

      if (logsError) continue;

      if (!logs || logs.length === 0) {
        continue;
      }

      if (target.type === 'group' && whatsappClient.getGroupInfo) {
        try {
          const jid = normalizeTargetJid(target);
          const info = await whatsappClient.getGroupInfo(jid);
          if (info?.announce && !info?.me?.isAdmin) {
            const reason = 'Group is admin-only (announce mode) and this WhatsApp account is not an admin';
            const ids = (logs || []).map((l: { id?: string }) => l.id).filter(Boolean) as string[];
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

      for (const log of logs || []) {
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
              supabase
            });
            const nowMs = Date.now();
            globalLastSentAtMs = nowMs;
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
          const nonRetryable = [
            'Template rendered empty message',
            'Target phone number missing',
            'Group ID invalid',
            'Channel ID invalid',
            'Phone number invalid'
          ].some((needle) => rawErrorMessage.includes(needle));

          if (nonRetryable) {
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
    const nextRunAt = schedule.cron_expression
      ? computeNextRunAt(schedule.cron_expression, schedule.timezone)
      : deliveryMode === 'batched'
        ? computeNextBatchRunAt(schedule.batch_times, schedule.timezone)
        : null;
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
      const missingDispatchedColumn =
        msg.toLowerCase().includes('last_dispatched_at') && msg.toLowerCase().includes('does not exist');
      if (missingQueueCursorColumn || missingDispatchedColumn) {
        const fallbackUpdates: Record<string, unknown> = { last_run_at: lastRunAt, next_run_at: nextRunAt };
        if (!missingQueueCursorColumn && queueCursorAt) {
          fallbackUpdates.last_queued_at = queueCursorAt;
        }
        if (!missingDispatchedColumn && deliveryMode === 'batched') {
          fallbackUpdates.last_dispatched_at = lastRunAt;
        }

        const missingColumns = [
          missingQueueCursorColumn ? 'last_queued_at' : null,
          missingDispatchedColumn ? 'last_dispatched_at' : null
        ].filter(Boolean);

        logger.warn(
          { scheduleId, error: scheduleUpdateError, missingColumns },
          'Schedule cursor columns missing; run SQL migrations (scripts/012_schedule_queue_cursor.sql, scripts/014_schedule_delivery_modes.sql)'
        );
        await supabase.from('schedules').update(fallbackUpdates).eq('id', scheduleId);
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
    const { data: pendingLogs, error: pendingLogsError } = await supabase
      .from('message_logs')
      .select('schedule_id')
      .eq('status', 'pending');

    if (pendingLogsError) {
      throw pendingLogsError;
    }

    const scheduleIds = [...new Set((pendingLogs || []).map((log: { schedule_id?: string }) => log.schedule_id).filter(Boolean))] as string[];
    let totalSent = 0;
    let totalQueued = 0;

    for (const scheduleId of scheduleIds) {
      const result = await sendQueuedForSchedule(scheduleId, whatsappClient);
      if (result?.sent) {
        totalSent += result.sent;
      }
      if (result?.queued) {
        totalQueued += result.queued;
      }
    }

    logger.info({ scheduleCount: scheduleIds.length, totalSent, totalQueued }, 'Processed pending schedules after reconnect');
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
