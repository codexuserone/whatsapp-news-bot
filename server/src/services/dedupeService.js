const { fuzzy } = require('fast-fuzzy');
const FeedItem = require('../models/FeedItem');
const ChatMessage = require('../models/ChatMessage');
const { normalizeText, normalizeUrl } = require('../utils/normalize');

const isDuplicateFeedItem = async ({ title, url, threshold, since }) => {
  const normalizedTitle = normalizeText(title);
  const normalizedUrl = normalizeUrl(url);

  const exact = await FeedItem.findOne({
    $or: [{ normalizedUrl }, { normalizedTitle }],
    createdAt: { $gte: since }
  });

  if (exact) return true;

  const recent = await FeedItem.find({ createdAt: { $gte: since } }).select('normalizedTitle');
  return recent.some((item) => fuzzy(normalizedTitle, item.normalizedTitle) >= threshold);
};

const isDuplicateInChat = async ({ jid, title, url, threshold, since }) => {
  const normalizedUrl = normalizeUrl(url);
  const normalizedTitle = normalizeText(title);

  if (normalizedUrl) {
    const match = await ChatMessage.findOne({ jid, normalizedUrl, createdAt: { $gte: since } });
    if (match) return true;
  }

  const recent = await ChatMessage.find({ jid, createdAt: { $gte: since } }).select('normalizedText');
  return recent.some((entry) => fuzzy(normalizedTitle, entry.normalizedText || '') >= threshold);
};

module.exports = {
  isDuplicateFeedItem,
  isDuplicateInChat
};
