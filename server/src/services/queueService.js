const MessageLog = require('../models/MessageLog');
const FeedItem = require('../models/FeedItem');
const Target = require('../models/Target');
const Template = require('../models/Template');
const Schedule = require('../models/Schedule');
const settingsService = require('./settingsService');
const { isDuplicateInChat } = require('./dedupeService');
const sleep = require('../utils/sleep');
const logger = require('../utils/logger');

const getPath = (obj, path) => {
  if (!path) return undefined;
  const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.');
  return parts.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
};

const formatTemplateValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatTemplateValue).filter(Boolean).join(', ');
  return JSON.stringify(value);
};

const applyTemplate = (templateBody, data) => {
  return templateBody.replace(/{{\s*([\w.\-\[\]]+)\s*}}/g, (_, key) => {
    const value = getPath(data, key);
    return formatTemplateValue(value);
  });
};

const buildMessageData = (feedItem) => ({
  ...(feedItem.variables || {}),
  title: feedItem.title,
  url: feedItem.url,
  description: feedItem.description,
  imageUrl: feedItem.imageUrl,
  videoUrl: feedItem.videoUrl,
  audioUrl: feedItem.audioUrl,
  mediaType: feedItem.mediaType,
  publishedAt: feedItem.publishedAt ? feedItem.publishedAt.toISOString() : ''
});

const sendMessageWithTemplate = async (whatsappClient, target, template, feedItem) => {
  const payload = buildMessageData(feedItem);
  const text = applyTemplate(template.body, payload).trim();
  if (!text) {
    throw new Error('Template rendered empty message');
  }

  const socket = whatsappClient.socket;
  if (!socket) {
    throw new Error('WhatsApp socket not connected');
  }

  if (feedItem.videoUrl) {
    if (target.type === 'status') {
      return socket.sendMessage(
        'status@broadcast',
        { video: { url: feedItem.videoUrl }, caption: text },
        { statusJidList: [target.jid] }
      );
    }
    return socket.sendMessage(target.jid, { video: { url: feedItem.videoUrl }, caption: text });
  }

  if (feedItem.imageUrl) {
    if (target.type === 'status') {
      return socket.sendMessage(
        'status@broadcast',
        { image: { url: feedItem.imageUrl }, caption: text },
        { statusJidList: [target.jid] }
      );
    }
    return socket.sendMessage(target.jid, { image: { url: feedItem.imageUrl }, caption: text });
  }

  if (feedItem.audioUrl) {
    if (target.type === 'status') {
      return socket.sendMessage('status@broadcast', { text }, { statusJidList: [target.jid] });
    }
    await socket.sendMessage(target.jid, { audio: { url: feedItem.audioUrl } });
    return socket.sendMessage(target.jid, { text });
  }

  if (target.type === 'status') {
    return socket.sendMessage('status@broadcast', { text }, { statusJidList: [target.jid] });
  }

  return socket.sendMessage(target.jid, { text });
};

const sendQueuedForSchedule = async (scheduleId, whatsappClient) => {
  const schedule = await Schedule.findById(scheduleId);
  if (!schedule || !schedule.enabled) return { sent: 0 };

  const settings = await settingsService.getSettings();
  const interDelay = settings.defaultInterTargetDelaySec * 1000;

  const targets = await Target.find({ _id: { $in: schedule.targetIds }, enabled: true });
  const template = await Template.findById(schedule.templateId);
  if (!template) {
    throw new Error('Template not found for schedule');
  }

  let sentCount = 0;

  for (const target of targets) {
    const logs = await MessageLog.find({
      scheduleId,
      targetId: target._id,
      status: 'queued'
    }).sort({ createdAt: 1 });

    for (const log of logs) {
      const feedItem = await FeedItem.findById(log.feedItemId);
      if (!feedItem) {
        await MessageLog.findByIdAndUpdate(log._id, { status: 'skipped', error: 'Feed item missing' });
        continue;
      }

      const since = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000);
      const duplicate = await isDuplicateInChat({
        jid: target.jid,
        title: feedItem.title,
        url: feedItem.url,
        threshold: settings.dedupeThreshold,
        since
      });

      if (duplicate) {
        await MessageLog.findByIdAndUpdate(log._id, { status: 'skipped', error: 'Duplicate in chat history' });
        continue;
      }

      try {
        const response = await sendMessageWithTemplate(whatsappClient, target, template, feedItem);
        await MessageLog.findByIdAndUpdate(log._id, { status: 'sent', sentAt: new Date(), error: null });
        sentCount += 1;

        if (whatsappClient.waitForMessage) {
          await whatsappClient.waitForMessage(response.key.id);
        }
      } catch (error) {
        logger.error({ error }, 'Failed to send message');
        await MessageLog.findByIdAndUpdate(log._id, { status: 'failed', error: error.message });
      }

      const intraDelay = (target.intraDelaySec || settings.defaultIntraTargetDelaySec) * 1000;
      await sleep(intraDelay);
    }

    await sleep(interDelay);
  }

  await Schedule.findByIdAndUpdate(scheduleId, { lastRunAt: new Date() });
  return { sent: sentCount };
};

module.exports = {
  sendQueuedForSchedule
};
