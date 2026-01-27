const ChatMessage = require('../models/ChatMessage');
const { normalizeText, normalizeUrl } = require('../utils/normalize');
const { extractText, extractUrls } = require('../utils/messageParser');

const saveIncomingMessages = async (messages = []) => {
  const entries = [];
  for (const message of messages) {
    if (!message?.key?.remoteJid || !message?.key?.id) {
      continue;
    }

    const jid = message.key.remoteJid;
    const text = extractText(message.message);
    const urls = extractUrls(text);
    const base = {
      jid,
      messageId: message.key.id,
      senderJid: message.key.participant || message.participant,
      fromMe: Boolean(message.key.fromMe),
      text,
      normalizedText: normalizeText(text),
      timestamp: message.messageTimestamp ? new Date(Number(message.messageTimestamp) * 1000) : new Date()
    };

    if (urls.length === 0) {
      entries.push(base);
    } else {
      urls.forEach((url) => {
        entries.push({
          ...base,
          url,
          normalizedUrl: normalizeUrl(url)
        });
      });
    }
  }

  if (entries.length) {
    await ChatMessage.insertMany(entries, { ordered: false }).catch(() => undefined);
  }
};

const hasRecentUrl = async (jid, normalizedUrl) => {
  if (!normalizedUrl) return false;
  const existing = await ChatMessage.findOne({ jid, normalizedUrl });
  return Boolean(existing);
};

module.exports = {
  saveIncomingMessages,
  hasRecentUrl
};
