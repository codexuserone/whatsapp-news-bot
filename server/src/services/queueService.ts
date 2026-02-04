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

const applyTemplate = (templateBody: string, data: Record<string, unknown>): string => {
  return templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = data[key];
    return value != null ? String(value) : '';
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
  if (isHttpUrl(existing)) {
    return { url: existing, source: feedItem.image_source || 'feed', scraped: false, error: null };
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
    try {
      const { buffer, mimetype } = await downloadImageBuffer(resolved.url, feedItem.link);
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
        media: { type: 'image', url: resolved.url, sent: true, error: null }
      };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn({ error, jid, imageUrl: resolved.url }, 'Failed to send image, falling back to text');
      const response = await sendText();
      return {
        response,
        text,
        media: { type: 'image', url: resolved.url, sent: false, error: message }
      };
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
  active?: boolean;
};

const queueSinceLastRunForSchedule = async (
  supabase: SupabaseClient,
  schedule: Schedule,
  targets: Target[]
): Promise<{ queued: number; feedItemCount: number }> => {
  if (!schedule.feed_id) return { queued: 0, feedItemCount: 0 };
  if (!schedule.last_run_at) return { queued: 0, feedItemCount: 0 };
  if (!targets.length) return { queued: 0, feedItemCount: 0 };

  const maxItems = 100;
  const { data: items, error: itemsError } = await supabase
    .from('feed_items')
    .select('id')
    .eq('feed_id', schedule.feed_id)
    .gt('created_at', schedule.last_run_at)
    .order('created_at', { ascending: true })
    .limit(maxItems);

  if (itemsError) {
    logger.warn({ scheduleId: schedule.id, error: itemsError }, 'Failed to load feed items since last run');
    return { queued: 0, feedItemCount: 0 };
  }

  const feedItemIds = (items || []).map((i: { id?: string }) => i.id).filter(Boolean) as string[];
  if (!feedItemIds.length) return { queued: 0, feedItemCount: 0 };

  const targetIds = targets.map((t) => t.id).filter(Boolean) as string[];
  if (!targetIds.length) return { queued: 0, feedItemCount: feedItemIds.length };

  const toUpsert: Array<Record<string, unknown>> = [];
  for (const feedItemId of feedItemIds) {
    for (const targetId of targetIds) {
      toUpsert.push({
        feed_item_id: feedItemId,
        target_id: targetId,
        schedule_id: schedule.id,
        template_id: schedule.template_id,
        status: 'pending'
      });
    }
  }

  if (!toUpsert.length) return { queued: 0, feedItemCount: feedItemIds.length };

  const { data: insertedRows, error: upsertError } = await supabase
    .from('message_logs')
    .upsert(toUpsert, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
    .select('id');

  if (upsertError) {
    logger.warn({ scheduleId: schedule.id, error: upsertError }, 'Failed to queue items since last run');
    return { queued: 0, feedItemCount: feedItemIds.length };
  }

  return { queued: insertedRows?.length || 0, feedItemCount: feedItemIds.length };
};

type QueueLatestResult = {
  queued: number;
  inserted: number;
  revived: number;
  skipped: number;
  reason?: string;
  feedItemId?: string;
  feedItemTitle?: string | null;
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
    .select('id, title')
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
    feedItemTitle: latestFeedItem.title || null
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

    let queuedCount = 0;
    if (schedule.last_run_at) {
      const sinceResult = await queueSinceLastRunForSchedule(supabase, schedule, targets);
      queuedCount += sinceResult.queued;
    } else {
      const latestResult = await queueLatestForSchedule(scheduleId, { schedule, targets });
      queuedCount += latestResult.queued;
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
        const { data: claimed, error: claimError } = await supabase
          .from('message_logs')
          .update({ status: 'processing', processing_started_at: new Date().toISOString() })
          .eq('id', log.id)
          .eq('status', 'pending')
          .select('id')
          .single();

        if (claimError) {
          logger.warn({ scheduleId, logId: log.id, error: claimError }, 'Failed to claim message log');
          continue;
        }

        if (!claimed) {
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

          const errorMessage = getErrorMessage(error);
          const nonRetryable = [
            'Template rendered empty message',
            'Target phone number missing',
            'Group ID invalid',
            'Channel ID invalid',
            'Phone number invalid'
          ].some((needle) => errorMessage.includes(needle));

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
    const nextRunAt = schedule.cron_expression ? computeNextRunAt(schedule.cron_expression, schedule.timezone) : null;
    await supabase
      .from('schedules')
      .update({ last_run_at: lastRunAt, next_run_at: nextRunAt })
      .eq('id', scheduleId);

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
