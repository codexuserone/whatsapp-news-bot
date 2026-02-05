const { getSupabaseClient } = require('../db/supabase');
const { fetchFeedItemsWithMeta } = require('./feedFetcher');
const { normalizeText, normalizeUrl, hashContent } = require('../utils/normalize');
const { isDuplicateFeedItem } = require('./dedupeService');
const settingsService = require('./settingsService');
const { getErrorMessage } = require('../utils/errorUtils');

type FeedConfig = {
  id: string;
  url: string;
  type?: 'rss' | 'atom' | 'json';
  active?: boolean;
  fetch_interval?: number;
  etag?: string | null;
  last_modified?: string | null;
  consecutive_failures?: number | null;
  parseConfig?: Record<string, unknown>;
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
  publishedAt?: string | Date;
  categories?: string[];
  raw?: Record<string, unknown>;
};

type FeedItemRecord = { id: string } & Record<string, unknown>;

type FeedProcessResult = {
  items: FeedItemRecord[];
  fetchedCount: number;
  insertedCount: number;
  duplicateCount: number;
  errorCount: number;
};

const emptyResult = (): FeedProcessResult => ({
  items: [],
  fetchedCount: 0,
  insertedCount: 0,
  duplicateCount: 0,
  errorCount: 0
});

const fetchAndProcessFeed = async (feed: FeedConfig): Promise<FeedProcessResult> => {
  const supabase = getSupabaseClient();
  if (!supabase || !feed.active) return emptyResult();
  
  try {
    const settings = await settingsService.getSettings();
    const now = new Date();
    const nowIso = now.toISOString();
    const retentionDays = Number(settings.log_retention_days ?? settings.retentionDays ?? 14);
    const since = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const { items, meta } = await fetchFeedItemsWithMeta(feed);
    const newItems: FeedItemRecord[] = [];
    const fetchedCount = Array.isArray(items) ? items.length : 0;
    let duplicateCount = 0;
    let errorCount = 0;

    for (const item of items as FeedItemInput[]) {
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

      // Generate a unique GUID if not provided
      const guid = item.guid || item.url || `${feed.id}-${Date.now()}-${Math.random()}`;

      const normalizedTitle = normalizeText(item.title || '');
      const normalizedUrlValue = normalizeUrl(item.url || '');
      const contentHash = hashContent(item.title || '', item.url || '');

      const extraRaw = item.raw && typeof item.raw === 'object' ? item.raw : null;

      const { data: feedItem, error } = await supabase
        .from('feed_items')
        .insert({
          feed_id: feed.id,
          guid,
          title: item.title,
          link: item.url,
          description: item.description,
          image_url: item.imageUrl,
          image_source: item.imageUrl ? 'feed' : null,
          pub_date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          normalized_url: normalizedUrlValue || null,
          content_hash: contentHash || null,
          raw_data: {
            normalizedTitle: normalizedTitle,
            normalizedUrl: normalizedUrlValue,
            hash: contentHash,
            ...(extraRaw ? extraRaw : {})
          },
          content: item.content,
          author: item.author,
          categories: item.categories || []
        })
        .select()
        .single();

      if (error) {
        // Skip duplicates (UNIQUE constraint violation)
        if (error.code === '23505') {
          duplicateCount += 1;
          continue;
        }
        errorCount += 1;
        console.error('Error inserting feed item:', error);
        continue;
      }

      newItems.push(feedItem);
    }

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

    return {
      items: newItems,
      fetchedCount,
      insertedCount: newItems.length,
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

  const feedItemIds = items.map((item) => item.id).filter(Boolean) as string[];
  if (!feedItemIds.length) return [];
  
  try {
    // Find schedules that use this feed
    const { data: schedules, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('feed_id', feedId)
      .eq('active', true);

    if (scheduleError) throw scheduleError;
    if (!schedules || !schedules.length) return [];

    const logs: Array<Record<string, unknown>> = [];

    for (const schedule of schedules) {
      const targetIds = Array.isArray(schedule.target_ids) ? schedule.target_ids : [];

      if (!targetIds.length) continue;

      const { data: existingLogs, error: existingLogsError } = await supabase
        .from('message_logs')
        .select('feed_item_id,target_id')
        .eq('schedule_id', schedule.id)
        .in('feed_item_id', feedItemIds)
        .in('target_id', targetIds);

      if (existingLogsError) {
        console.error('Error checking existing logs:', existingLogsError);
      }

      const existingKeys = new Set(
        (existingLogs || [])
          .map((entry: { feed_item_id?: string; target_id?: string }) =>
            entry.feed_item_id && entry.target_id ? `${entry.feed_item_id}:${entry.target_id}` : null
          )
          .filter(Boolean) as string[]
      );

      for (const feedItemId of feedItemIds) {
        for (const targetId of targetIds) {
          const key = `${feedItemId}:${targetId}`;
          if (existingKeys.has(key)) continue;
          logs.push({
            feed_item_id: feedItemId,
            target_id: targetId,
            schedule_id: schedule.id,
            template_id: schedule.template_id,
            status: 'pending'
          });
        }
      }
    }

    if (logs.length) {
      const { error } = await supabase
        .from('message_logs')
        .upsert(logs, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true });
      
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
      const queuedLogs = await queueFeedItemsForSchedules(feed.id, result.items);
      results.push({
        feedId: feed.id,
        fetchedCount: result.fetchedCount,
        insertedCount: result.insertedCount,
        duplicateCount: result.duplicateCount,
        errorCount: result.errorCount,
        queuedCount: queuedLogs.length
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
