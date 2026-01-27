const MessageLog = require('../models/MessageLog');
const FeedItem = require('../models/FeedItem');
const Target = require('../models/Target');
const Template = require('../models/Template');
const Schedule = require('../models/Schedule');
const settingsService = require('./settingsService');
const { isDuplicateInChat } = require('./dedupeService');
const sleep = require('../utils/sleep');
const logger = require('../utils/logger');

const applyTemplate = (templateBody, data) => {
  return templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => (data[key] !== undefined ? data[key] : ''));
};

const buildMessageData = (feedItem) => ({
  title: feedItem.title,
  url: feedItem.url,
  description: feedItem.description,
  imageUrl: feedItem.imageUrl,
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

  if (feedItem.imageUrl) {
    if (target.type === 'status') {
      return socket.sendMessage('status@broadcast', { image: { url: feedItem.imageUrl }, caption: text }, { statusJidList: [target.jid] });
    }
    return socket.sendMessage(target.jid, { image: { url: feedItem.imageUrl }, caption: text });
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
