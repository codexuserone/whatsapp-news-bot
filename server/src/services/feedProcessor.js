const { getSupabaseClient } = require('../db/supabase');
const { fetchFeedItems } = require('./feedFetcher');
const { normalizeText, normalizeUrl } = require('../utils/normalize');
const { isDuplicateFeedItem } = require('./dedupeService');
const settingsService = require('./settingsService');

const fetchAndProcessFeed = async (feed) => {
  const supabase = getSupabaseClient();
  if (!supabase || !feed.active) return [];
  
  try {
    const settings = await settingsService.getSettings();
    const now = new Date();
    const retentionDays = Number(settings.retentionDays || 14);
    const since = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const items = await fetchFeedItems(feed);
    const newItems = [];

    for (const item of items) {
      const duplicate = await isDuplicateFeedItem({
        title: item.title,
        url: item.url,
        threshold: settings.dedupeThreshold,
        since
      });

      if (duplicate) {
        continue;
      }

      // Generate a unique GUID if not provided
      const guid = item.guid || item.url || `${feed.id}-${Date.now()}-${Math.random()}`;

      const { data: feedItem, error } = await supabase
        .from('feed_items')
        .insert({
          feed_id: feed.id,
          guid,
          title: item.title,
          link: item.url,
          description: item.description,
          image_url: item.imageUrl,
          pub_date: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
          raw_data: {
            normalizedTitle: normalizeText(item.title),
            normalizedUrl: normalizeUrl(item.url),
            hash: `${normalizeText(item.title)}|${normalizeUrl(item.url)}`
          }
        })
        .select()
        .single();

      if (error) {
        // Skip duplicates (UNIQUE constraint violation)
        if (error.code === '23505') continue;
        console.error('Error inserting feed item:', error);
        continue;
      }

      newItems.push(feedItem);
    }

    await supabase
      .from('feeds')
      .update({ last_fetched_at: new Date().toISOString() })
      .eq('id', feed.id);

    return newItems;
  } catch (error) {
    console.error('Error processing feed:', error);
    // Update feed with error
    await supabase
      .from('feeds')
      .update({ last_error: error.message })
      .eq('id', feed.id);
    return [];
  }
};

const queueFeedItemsForSchedules = async (feedId, items) => {
  const supabase = getSupabaseClient();
  if (!supabase || !items.length) return [];
  
  try {
    // Find schedules that use this feed
    const { data: schedules, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('feed_id', feedId)
      .eq('active', true);

    if (scheduleError) throw scheduleError;
    if (!schedules || !schedules.length) return [];

    const logs = [];

    for (const schedule of schedules) {
      const targetIds = schedule.target_ids || [];
      for (const feedItem of items) {
        if (!targetIds.length) continue;
        const { data: existingLogs, error: existingLogsError } = await supabase
          .from('message_logs')
          .select('target_id')
          .eq('schedule_id', schedule.id)
          .eq('feed_item_id', feedItem.id)
          .in('target_id', targetIds)
          .in('status', ['pending', 'sent']);

        if (existingLogsError) {
          console.error('Error checking existing logs:', existingLogsError);
        }

        const existingTargets = new Set((existingLogs || []).map((entry) => entry.target_id));
        for (const targetId of targetIds) {
          if (existingTargets.has(targetId)) continue;
          logs.push({
            feed_item_id: feedItem.id,
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
        .insert(logs);
      
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
      const items = await fetchAndProcessFeed(feed);
      await queueFeedItemsForSchedules(feed.id, items);
      results.push({ feedId: feed.id, items });
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
