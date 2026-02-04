const { fuzzy } = require('fast-fuzzy');
const { getSupabaseClient } = require('../db/supabase');
const { normalizeText, normalizeUrl, hashContent } = require('../utils/normalize');

type FeedDuplicateCheck = {
  title?: string;
  url?: string;
  threshold: number;
  since: Date;
  feedId?: string;
};

type ChatDuplicateCheck = {
  jid: string;
  title?: string;
  url?: string;
  threshold: number;
  since: Date;
};

const isDuplicateFeedItem = async ({ title, url, threshold, since, feedId }: FeedDuplicateCheck) => {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  
  try {
    const normalizedTitle = normalizeText(title || '');
    const normalizedUrlValue = normalizeUrl(url || '');
    const contentHash = hashContent(title || '', url || '');
    const thresholdValue = Number.isFinite(threshold) ? threshold : 0.88;

    let query = supabase
      .from('feed_items')
      .select('title, normalized_url, content_hash')
      .gte('created_at', since.toISOString());

    if (feedId) {
      query = query.eq('feed_id', feedId);
    }

    const { data: recentItems, error } = await query;

    if (error) {
      console.error('Error checking for duplicates:', error);
      return false;
    }

    const items: Array<{ normalized_url?: string; content_hash?: string; title?: string }> = recentItems || [];

    const exact = items.some((item) => {
      return item.normalized_url === normalizedUrlValue || item.content_hash === contentHash;
    });

    if (exact) return true;

    // Check for fuzzy title matches
    return items.some((item) => {
      if (!item.title) return false;
      return fuzzy(normalizedTitle, normalizeText(item.title)) >= thresholdValue;
    });
  } catch (error) {
    console.error('Error in isDuplicateFeedItem:', error);
    return false;
  }
};

const isDuplicateInChat = async ({ jid, title, url, threshold, since }: ChatDuplicateCheck) => {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  
  try {
    const normalizedUrlValue = normalizeUrl(url);
    const normalizedTitle = normalizeText(title);

    // Check for URL match in chat messages
    if (normalizedUrlValue) {
      const { data: urlMatch, error: urlError } = await supabase
        .from('chat_messages')
        .select('id')
        .eq('remote_jid', jid)
        .gte('created_at', since.toISOString())
        .ilike('content', `%${normalizedUrlValue}%`)
        .limit(1);

      if (!urlError && urlMatch && urlMatch.length > 0) {
        return true;
      }
    }

    // Check for fuzzy title matches
    const { data: recentMessages, error } = await supabase
      .from('chat_messages')
      .select('content')
      .eq('remote_jid', jid)
      .gte('created_at', since.toISOString());

    if (error) {
      console.error('Error checking chat duplicates:', error);
      return false;
    }

    const messages: Array<{ content?: string }> = recentMessages || [];

    const thresholdValue = Number.isFinite(threshold) ? threshold : 0.88;
    return messages.some((entry) => {
      if (!entry.content) return false;
      return fuzzy(normalizedTitle, normalizeText(entry.content)) >= thresholdValue;
    });
  } catch (error) {
    console.error('Error in isDuplicateInChat:', error);
    return false;
  }
};

module.exports = {
  isDuplicateFeedItem,
  isDuplicateInChat
};
export {};
