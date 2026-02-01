const { fuzzy } = require('fast-fuzzy');
const { getSupabaseClient } = require('../db/supabase');
const { normalizeText, normalizeUrl } = require('../utils/normalize');

const isDuplicateFeedItem = async ({ title, url, threshold, since }) => {
  const supabase = getSupabaseClient();
  if (!supabase) return false;
  
  try {
    const normalizedTitle = normalizeText(title);
    const normalizedUrlValue = normalizeUrl(url);

    // Check for exact URL or title match in raw_data
    const { data: recentItems, error } = await supabase
      .from('feed_items')
      .select('raw_data')
      .gte('created_at', since.toISOString());

    if (error) {
      console.error('Error checking for duplicates:', error);
      return false;
    }

    // Check for exact matches
    const exact = recentItems.some(item => {
      const rawData = item.raw_data || {};
      return rawData.normalizedUrl === normalizedUrlValue || 
             rawData.normalizedTitle === normalizedTitle;
    });

    if (exact) return true;

    // Check for fuzzy title matches
    return recentItems.some((item) => {
      const rawData = item.raw_data || {};
      if (!rawData.normalizedTitle) return false;
      return fuzzy(normalizedTitle, rawData.normalizedTitle) >= threshold;
    });
  } catch (error) {
    console.error('Error in isDuplicateFeedItem:', error);
    return false;
  }
};

const isDuplicateInChat = async ({ jid, title, url, threshold, since }) => {
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

    return recentMessages.some((entry) => {
      if (!entry.content) return false;
      return fuzzy(normalizedTitle, normalizeText(entry.content)) >= threshold;
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
