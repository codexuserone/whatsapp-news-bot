const { getSupabaseClient } = require('../db/supabase');
const { fetchFeedItemsWithMeta } = require('./feedFetcher');
const { normalizeText, normalizeUrl, hashContent } = require('../utils/normalize');
const { isDuplicateFeedItem } = require('./dedupeService');
const { isScheduleRunning } = require('./scheduleState');
const settingsService = require('./settingsService');
const { getErrorMessage } = require('../utils/errorUtils');
const { normalizeFeedMedia } = require('../utils/feedMedia');

type FeedConfig = {
  id: string;
  url: string;
  type?: 'rss' | 'atom' | 'json' | 'html';
  active?: boolean;
  fetch_interval?: number;
  last_fetched_at?: string | null;
  etag?: string | null;
  last_modified?: string | null;
  consecutive_failures?: number | null;
  parseConfig?: Record<string, unknown>;
  parse_config?: Record<string, unknown>;
  cleaning?: { stripUtm?: boolean; decodeEntities?: boolean; removePhrases?: string[] };
};

type FeedItemInput = {
  guid?: string;
  title?: string;
  url?: string;
  description?: string;
  content?: string;
  author?: string;
  imageUrl?: string;
  mediaUrl?: string;
  mediaKind?: 'image' | 'video' | 'audio' | 'document';
  mediaMime?: string;
  mediaFilename?: string;
  publishedAt?: string | Date;
  categories?: string[];
  raw?: Record<string, unknown>;
};

type FeedItemRecord = { id: string } & Record<string, unknown>;

const DEFAULT_MAX_AUTO_QUEUE_ITEM_AGE_HOURS = Math.max(Number(process.env.MAX_AUTO_QUEUE_ITEM_AGE_HOURS || 24), 1);

type TemplateSendMode =
  | 'auto_media'
  | 'media_only'
  | 'text_preview'
  | 'text_only'
  | 'image'
  | 'image_only'
  | 'link_preview'
  | null;

type TemplateRecord = {
  id?: string;
  content?: string | null;
  active?: boolean | null;
  send_images?: boolean | null;
  send_mode?: TemplateSendMode;
  sequence_steps?: TemplateSequenceStep[] | null;
};

type TemplateSequenceStep = {
  label?: string | null;
  content?: string | null;
  send_mode?: TemplateSendMode;
  delay_seconds?: number | string | null;
  active?: boolean | null;
};

type TemplateQueueStep = {
  index: number;
  label: string | null;
  delaySeconds: number;
};

const isFeedItemFreshEnoughForAutoQueue = (
  item: Record<string, unknown>,
  maxAgeHours = DEFAULT_MAX_AUTO_QUEUE_ITEM_AGE_HOURS,
  nowMs = Date.now()
) => {
  const maxAgeMs = Math.max(Number(maxAgeHours) || DEFAULT_MAX_AUTO_QUEUE_ITEM_AGE_HOURS, 1) * 60 * 60 * 1000;
  const preferredTimestamp = String(item.pub_date || '').trim() || String(item.created_at || '').trim();
  if (!preferredTimestamp) return true;
  const timestampMs = Date.parse(preferredTimestamp);
  if (!Number.isFinite(timestampMs)) return true;
  return nowMs - timestampMs <= maxAgeMs;
};

const extractWordpressNumericId = (value?: string) => {
  if (!value) return null;
  const text = String(value);
  const queryMatch = text.match(/[?&]p=(\d+)/i);
  if (queryMatch?.[1]) {
    const parsed = Number(queryMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const statusMatch = text.match(/\/status\/(\d+)(?:\/|$)/i);
  if (statusMatch?.[1]) {
    const parsed = Number(statusMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type FeedProcessResult = {
  items: FeedItemRecord[];
  updatedItems: FeedItemRecord[];
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  duplicateCount: number;
  errorCount: number;
};

const emptyResult = (): FeedProcessResult => ({
  items: [],
  updatedItems: [],
  fetchedCount: 0,
  insertedCount: 0,
  updatedCount: 0,
  duplicateCount: 0,
  errorCount: 0
});

const collapseWhitespace = (value: string) => String(value || '').replace(/\s+/g, ' ').trim();

const makeSnippet = (value: string, maxLen = 280) => {
  const normalized = collapseWhitespace(value);
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(maxLen - 1, 1)).trim()}…`;
};

const normalizeIso = (value?: string | Date | null) => {
  if (!value) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  return parsed.toISOString();
};

const normalizeComparableText = (value: unknown) => collapseWhitespace(String(value || ''));

const normalizeComparableList = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => collapseWhitespace(String(entry || '')))
    .filter(Boolean)
    .sort();
};

const getTemplateQueueSteps = (template?: TemplateRecord | null): TemplateQueueStep[] => {
  const rawSteps = Array.isArray(template?.sequence_steps) ? template.sequence_steps : [];
  const steps: TemplateQueueStep[] = [];

  rawSteps.forEach((step, index) => {
    const content = collapseWhitespace(String(step?.content || ''));
    if (!content || step?.active === false) return;
    const label = collapseWhitespace(String(step?.label || `Step ${index + 1}`));
    const delaySeconds = Number(step?.delay_seconds);
    steps.push({
      index,
      label: label || `Step ${index + 1}`,
      delaySeconds: Number.isFinite(delaySeconds) ? Math.min(Math.max(Math.floor(delaySeconds), 0), 3600) : 0
    });
  });

  return steps.length
    ? steps
    : [
      {
        index: 0,
        label: null,
        delaySeconds: 0
      }
    ];
};

const buildDispatchKey = (feedItemId?: unknown, targetId?: unknown, sequenceStepIndex?: unknown) => {
  const normalizedFeedItemId = String(feedItemId || '').trim();
  const normalizedTargetId = String(targetId || '').trim();
  if (!normalizedFeedItemId || !normalizedTargetId) return null;
  const normalizedStepIndex = Math.max(0, Math.floor(Number(sequenceStepIndex || 0)));
  return `${normalizedFeedItemId}:${normalizedTargetId}:${normalizedStepIndex}`;
};

const buildDispatchRowsForSteps = (options: {
  feedItemId: string;
  targetId: string;
  schedule: Record<string, unknown>;
  steps: TemplateQueueStep[];
  status: string;
  baseTimeMs: number;
}) => {
  let cumulativeDelaySeconds = 0;

  return options.steps.map((step, position) => {
    if (position > 0) {
      cumulativeDelaySeconds += step.delaySeconds;
    }
    return {
      feed_item_id: options.feedItemId,
      target_id: options.targetId,
      schedule_id: options.schedule.id,
      template_id: options.schedule.template_id,
      sequence_step_index: step.index,
      sequence_step_label: step.label,
      scheduled_for:
        cumulativeDelaySeconds > 0
          ? new Date(options.baseTimeMs + cumulativeDelaySeconds * 1000).toISOString()
          : null,
      status: options.status,
      approved_at: null,
      approved_by: null
    };
  });
};

const loadTemplateStepsById = async (supabase: any, schedules: Array<Record<string, unknown>>) => {
  const templateIds = Array.from(
    new Set(
      schedules
        .map((schedule) => String(schedule.template_id || '').trim())
        .filter(Boolean)
    )
  );
  const stepsByTemplateId = new Map<string, TemplateQueueStep[]>();

  for (const templateId of templateIds) {
    stepsByTemplateId.set(templateId, []);
  }
  if (!templateIds.length) return stepsByTemplateId;

  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .in('id', templateIds);

  if (error) {
    console.error('Error loading template sequence steps:', error);
    return stepsByTemplateId;
  }

  for (const template of (data || []) as TemplateRecord[]) {
    const templateId = String(template?.id || '').trim();
    if (!templateId) continue;
    stepsByTemplateId.set(templateId, template.active === false ? [] : getTemplateQueueSteps(template));
  }

  return stepsByTemplateId;
};

const fetchAndProcessFeed = async (feed: FeedConfig): Promise<FeedProcessResult> => {
  const supabase = getSupabaseClient();
  if (!supabase || !feed.active) return emptyResult();

  try {
    const parsedConfig =
      (feed.parseConfig && typeof feed.parseConfig === 'object' ? feed.parseConfig : null) ||
      (feed.parse_config && typeof feed.parse_config === 'object' ? feed.parse_config : null);

    const normalizedFeed: FeedConfig = parsedConfig
      ? { ...feed, parseConfig: parsedConfig }
      : { ...feed };

    const settings = await settingsService.getSettings();
    const now = new Date();
    const nowIso = now.toISOString();
    const retentionDays = Number(settings.log_retention_days ?? settings.retentionDays ?? 14);
    const bootstrapLimitRaw = Number(settings.initial_fetch_limit);
    const bootstrapLimit = Number.isFinite(bootstrapLimitRaw) ? Math.max(1, Math.floor(bootstrapLimitRaw)) : 1;
    const processWindowRaw = Number(
      settings.feed_process_window_limit ?? process.env.FEED_PROCESS_WINDOW_LIMIT ?? 500
    );
    const processWindowLimit = Number.isFinite(processWindowRaw) ? Math.max(0, Math.floor(processWindowRaw)) : 500;
    const since = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const { items, meta } = await fetchFeedItemsWithMeta(normalizedFeed);

    const byMostRecent = [...items].sort((a: FeedItemInput, b: FeedItemInput) => {
      const aTs = a?.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bTs = b?.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bTs - aTs;
    });

    const isFirstFetch = !feed.last_fetched_at;

    const sourceItems = isFirstFetch
      ? [...byMostRecent.slice(0, bootstrapLimit)].reverse()
      : (() => {
        // Process a large rolling window each poll to avoid silently skipping bursts.
        // 0 means "process full parsed feed result".
        const candidates =
          processWindowLimit > 0 ? byMostRecent.slice(0, processWindowLimit) : byMostRecent;
        if (processWindowLimit > 0 && byMostRecent.length > processWindowLimit) {
          console.info(
            `Feed window for ${feed.url}: processing ${candidates.length}/${byMostRecent.length} items (limit=${processWindowLimit})`
          );
        }
        return candidates.reverse();
      })();

    if (isFirstFetch && items.length > sourceItems.length) {
      console.info(
        `Initial fetch for ${feed.url}: limiting inserts to ${sourceItems.length}/${items.length} latest item(s)`
      );
    }

    const newItems: FeedItemRecord[] = [];
    const updatedItems: FeedItemRecord[] = [];
    const fetchedCount = Array.isArray(sourceItems) ? sourceItems.length : 0;
    let duplicateCount = 0;
    let errorCount = 0;
    let feedMissing = false;

    for (const item of sourceItems as FeedItemInput[]) {
      // Generate a unique GUID if not provided
      const guid = item.guid || item.url || `${feed.id}-${Date.now()}-${Math.random()}`;

      const normalizedTitle = normalizeText(item.title || '');
      const normalizedUrlValue = normalizeUrl(item.url || '');
      const contentHash = hashContent(item.title || '', item.url || '');

      const rawInput =
        item.raw && typeof item.raw === 'object'
          ? (item.raw as Record<string, unknown>)
          : {};

      const rawData: Record<string, unknown> = {
        normalizedTitle,
        normalizedUrl: normalizedUrlValue,
        hash: contentHash
      };

      const normalizedDescription = collapseWhitespace(String(item.description || ''));
      const normalizedContent = collapseWhitespace(String(item.content || ''));
      const fallbackSnippet = makeSnippet(normalizedContent, 280);
      const descriptionForStorage = normalizedDescription || fallbackSnippet;
      const normalizedCategories = Array.isArray(item.categories)
        ? item.categories.map((entry) => String(entry || '')).filter(Boolean)
        : [];
      const normalizedPubDate = normalizeIso(item.publishedAt);
      const normalizedMedia = normalizeFeedMedia({
        mediaUrl: item.mediaUrl,
        mediaKind: item.mediaKind,
        mediaMime: item.mediaMime,
        mediaFilename: item.mediaFilename,
        imageUrl: item.imageUrl,
        rawData: rawInput
      });
      if (normalizedMedia.mediaUrl) rawData.media_url = normalizedMedia.mediaUrl;
      if (normalizedMedia.mediaKind) rawData.media_kind = normalizedMedia.mediaKind;
      if (normalizedMedia.mediaMime) rawData.media_mime = normalizedMedia.mediaMime;
      if (normalizedMedia.mediaFilename) rawData.media_filename = normalizedMedia.mediaFilename;
      if (normalizedMedia.imageUrl) rawData.image_url = normalizedMedia.imageUrl;

      for (const [key, value] of Object.entries(rawInput)) {
        if (value == null) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          rawData[key] = value;
        }
      }

      const incomingPayload: Record<string, unknown> = {
        guid,
        title: item.title || null,
        link: item.url || null,
        description: descriptionForStorage || null,
        image_url: normalizedMedia.imageUrl || null,
        media_url: normalizedMedia.mediaUrl || null,
        media_kind: normalizedMedia.mediaKind || null,
        media_mime: normalizedMedia.mediaMime || null,
        media_filename: normalizedMedia.mediaFilename || null,
        image_source: normalizedMedia.mediaUrl ? 'feed' : null,
        pub_date: normalizedPubDate,
        normalized_url: normalizedUrlValue || null,
        content_hash: contentHash || null,
        raw_data: rawData,
        content: item.content || null,
        author: item.author || null,
        categories: normalizedCategories
      };

      let existingItem: FeedItemRecord | null = null;
      if (guid) {
        const { data: existingByGuid } = await supabase
          .from('feed_items')
          .select('*')
          .eq('feed_id', feed.id)
          .eq('guid', guid)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        existingItem = (existingByGuid as FeedItemRecord | null) || null;
      }

      if (!existingItem && normalizedUrlValue) {
        const { data: existingByUrl } = await supabase
          .from('feed_items')
          .select('*')
          .eq('feed_id', feed.id)
          .eq('normalized_url', normalizedUrlValue)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        existingItem = (existingByUrl as FeedItemRecord | null) || null;
      }

      if (!existingItem) {
        const duplicate = await isDuplicateFeedItem({
          title: item.title,
          url: item.url,
          threshold: settings.dedupeThreshold,
          since,
          feedId: feed.id
        });

        if (duplicate) {
          duplicateCount += 1;
          continue;
        }
      }

      if (existingItem) {
        const existingRecord = existingItem as Record<string, unknown>;
        const existingRawData =
          existingRecord.raw_data && typeof existingRecord.raw_data === 'object'
            ? (existingRecord.raw_data as Record<string, unknown>)
            : {};
        const hasChanges =
          normalizeComparableText(existingRecord.title) !== normalizeComparableText(incomingPayload.title) ||
          normalizeComparableText(existingRecord.link) !== normalizeComparableText(incomingPayload.link) ||
          normalizeComparableText(existingRecord.description) !== normalizeComparableText(incomingPayload.description) ||
          normalizeComparableText(existingRecord.content) !== normalizeComparableText(incomingPayload.content) ||
          normalizeComparableText(existingRecord.author) !== normalizeComparableText(incomingPayload.author) ||
          normalizeComparableText(existingRecord.image_url) !== normalizeComparableText(incomingPayload.image_url) ||
          normalizeComparableText(existingRecord.media_url) !== normalizeComparableText(incomingPayload.media_url) ||
          normalizeComparableText(existingRecord.media_kind) !== normalizeComparableText(incomingPayload.media_kind) ||
          normalizeComparableText(existingRecord.media_mime) !== normalizeComparableText(incomingPayload.media_mime) ||
          normalizeComparableText(existingRecord.media_filename) !== normalizeComparableText(incomingPayload.media_filename) ||
          normalizeComparableText(existingRawData.media_url) !== normalizeComparableText(rawData.media_url) ||
          normalizeComparableText(existingRawData.media_kind) !== normalizeComparableText(rawData.media_kind) ||
          normalizeIso(existingRecord.pub_date as string | Date | null | undefined) !== normalizeIso(normalizedPubDate) ||
          normalizeComparableText(existingRecord.content_hash) !== normalizeComparableText(incomingPayload.content_hash) ||
          normalizeComparableList(existingRecord.categories).join('|') !==
            normalizeComparableList(incomingPayload.categories).join('|');

        if (hasChanges) {
          const { data: updatedItem, error: updateError } = await supabase
            .from('feed_items')
            .update(incomingPayload)
            .eq('id', String(existingItem.id))
            .select('*')
            .single();

          if (updateError) {
            errorCount += 1;
            console.error('Error updating feed item:', updateError);
          } else if (updatedItem) {
            updatedItems.push(updatedItem as FeedItemRecord);
          }
        } else {
          duplicateCount += 1;
        }
        continue;
      }

      const { data: feedItem, error } = await supabase
        .from('feed_items')
        .insert({
          feed_id: feed.id,
          ...incomingPayload
        })
        .select()
        .single();

      if (error) {
        // Skip duplicates (UNIQUE constraint violation)
        if (error.code === '23505') {
          duplicateCount += 1;
          continue;
        }

        // Feed deleted while processing; stop noisy insert retries for this run.
        if (error.code === '23503' && String(error.message || '').includes('feed_items_feed_id_fkey')) {
          feedMissing = true;
          errorCount += 1;
          console.info('Feed deleted during processing, aborting current feed run', {
            feedId: feed.id,
            reason: 'feed_missing_fk'
          });
          break;
        }

        errorCount += 1;
        console.error('Error inserting feed item:', error);
        continue;
      }

      newItems.push(feedItem);
    }

    if (!feedMissing) {
      const feedUpdate: Record<string, unknown> = {
        last_fetched_at: nowIso,
        last_success_at: nowIso,
        last_error: null,
        consecutive_failures: 0
      };
      if (meta?.detectedType && meta.detectedType !== feed.type) {
        feedUpdate.type = meta.detectedType;
      }
      if (meta?.etag) {
        feedUpdate.etag = meta.etag;
      }
      if (meta?.lastModified) {
        feedUpdate.last_modified = meta.lastModified;
      }
      await supabase.from('feeds').update(feedUpdate).eq('id', feed.id);
    }

    return {
      items: newItems,
      updatedItems,
      fetchedCount,
      insertedCount: newItems.length,
      updatedCount: updatedItems.length,
      duplicateCount,
      errorCount
    };
  } catch (error) {
    console.error('Error processing feed:', error);
    const nowIso = new Date().toISOString();
    let failures = Number(feed.consecutive_failures || 0);
    try {
      const { data } = await supabase
        .from('feeds')
        .select('consecutive_failures')
        .eq('id', feed.id)
        .single();
      failures = Number((data as { consecutive_failures?: number } | null)?.consecutive_failures || failures);
    } catch {
      // ignore
    }
    // Update feed with error
    await supabase
      .from('feeds')
      .update({
        last_error: getErrorMessage(error),
        last_fetched_at: nowIso,
        consecutive_failures: failures + 1
      })
      .eq('id', feed.id);
    return emptyResult();
  }
};

const queueFeedItemsForSchedules = async (feedId: string, items: FeedItemRecord[]) => {
  const supabase = getSupabaseClient();
  if (!supabase || !items.length) return [];

  const queueableItems = items.filter((item) => isFeedItemFreshEnoughForAutoQueue(item));
  if (!queueableItems.length) return [];

  const feedItemIds = queueableItems.map((item) => item.id).filter(Boolean) as string[];
  if (!feedItemIds.length) return [];

  try {
    // Find schedules that use this feed
    const { data: schedules, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('feed_id', feedId);

    if (scheduleError) throw scheduleError;
    const runningSchedules = (schedules || []).filter((schedule: Record<string, unknown>) => isScheduleRunning(schedule));
    if (!runningSchedules.length) return [];

    const stepsByTemplateId = await loadTemplateStepsById(supabase, runningSchedules);
    const logs: Array<Record<string, unknown>> = [];
    const baseTimeMs = Date.now();

    for (const schedule of runningSchedules) {
      const targetIds = Array.isArray(schedule.target_ids) ? schedule.target_ids : [];

      if (!targetIds.length) continue;

      const queuedStatus = schedule.approval_required === true ? 'awaiting_approval' : 'pending';
      const templateId = String(schedule.template_id || '').trim();
      const templateSteps = stepsByTemplateId.get(templateId) || getTemplateQueueSteps(null);

      const { data: existingLogs, error: existingLogsError } = await supabase
        .from('message_logs')
        .select('feed_item_id,target_id,sequence_step_index')
        .eq('schedule_id', schedule.id)
        .in('feed_item_id', feedItemIds)
        .in('target_id', targetIds);

      if (existingLogsError) {
        console.error('Error checking existing logs:', existingLogsError);
      }

      const existingKeys = new Set(
        (existingLogs || [])
          .map((entry: { feed_item_id?: string; target_id?: string; sequence_step_index?: unknown }) =>
            buildDispatchKey(entry.feed_item_id, entry.target_id, entry.sequence_step_index)
          )
          .filter(Boolean) as string[]
      );

      for (const item of queueableItems) {
        const feedItemId = String(item.id || '').trim();
        if (!feedItemId) continue;
        for (const targetId of targetIds) {
          const rows = buildDispatchRowsForSteps({
            feedItemId,
            targetId,
            schedule,
            steps: templateSteps,
            status: queuedStatus,
            baseTimeMs
          });
          for (const row of rows) {
            const key = buildDispatchKey(feedItemId, targetId, row.sequence_step_index);
            if (key && existingKeys.has(key)) continue;
            logs.push(row);
          }
        }
      }
    }

    if (logs.length) {
      const { error } = await supabase
        .from('message_logs')
        .upsert(logs, { onConflict: 'schedule_id,feed_item_id,target_id,sequence_step_index', ignoreDuplicates: true });

      if (error) throw error;
    }

    return logs;
  } catch (error) {
    console.error('Error queueing feed items:', error);
    return [];
  }
};

const processAllFeeds = async () => {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  try {
    const { data: feeds, error } = await supabase
      .from('feeds')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    const results = [];
    for (const feed of feeds) {
      const result = await fetchAndProcessFeed(feed);
      results.push({
        feedId: feed.id,
        fetchedCount: result.fetchedCount,
        insertedCount: result.insertedCount,
        updatedCount: result.updatedCount,
        duplicateCount: result.duplicateCount,
        errorCount: result.errorCount,
        queuedCount: 0
      });
    }
    return results;
  } catch (error) {
    console.error('Error processing all feeds:', error);
    return [];
  }
};

module.exports = {
  fetchAndProcessFeed,
  processAllFeeds,
  queueFeedItemsForSchedules
};
export {};
