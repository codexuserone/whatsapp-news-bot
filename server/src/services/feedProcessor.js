const Feed = require('../models/Feed');
const FeedItem = require('../models/FeedItem');
const Schedule = require('../models/Schedule');
const MessageLog = require('../models/MessageLog');
const { fetchFeedItems } = require('./feedFetcher');
const { normalizeText, normalizeUrl } = require('../utils/normalize');
const { isDuplicateFeedItem } = require('./dedupeService');
const settingsService = require('./settingsService');

const fetchAndProcessFeed = async (feed) => {
  if (!feed.enabled) return [];
  const settings = await settingsService.getSettings();
  const now = new Date();
  const since = new Date(now.getTime() - settings.retentionDays * 24 * 60 * 60 * 1000);
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

    const feedItem = await FeedItem.create({
      feedId: feed._id,
      guid: item.guid,
      title: item.title,
      url: item.url,
      description: item.description,
      imageUrl: item.imageUrl,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : undefined,
      normalizedTitle: normalizeText(item.title),
      normalizedUrl: normalizeUrl(item.url),
      hash: `${normalizeText(item.title)}|${normalizeUrl(item.url)}`
    });

    newItems.push(feedItem);
  }

  if (newItems.length) {
    await Feed.findByIdAndUpdate(feed._id, { lastFetchedAt: new Date() });
  }

  return newItems;
};

const queueFeedItemsForSchedules = async (feedId, items) => {
  if (!items.length) return [];
  const schedules = await Schedule.find({ feedIds: feedId, enabled: true });
  const logs = [];

  for (const schedule of schedules) {
    for (const feedItem of items) {
      for (const targetId of schedule.targetIds || []) {
        logs.push({
          feedItemId: feedItem._id,
          targetId,
          scheduleId: schedule._id,
          status: 'queued'
        });
      }
    }
  }

  if (logs.length) {
    await MessageLog.insertMany(logs);
  }

  return logs;
};

const processAllFeeds = async () => {
  const feeds = await Feed.find({ enabled: true });
  const results = [];
  for (const feed of feeds) {
    const items = await fetchAndProcessFeed(feed);
    await queueFeedItemsForSchedules(feed._id, items);
    results.push({ feedId: feed._id, items });
  }
  return results;
};

module.exports = {
  fetchAndProcessFeed,
  processAllFeeds,
  queueFeedItemsForSchedules
};
