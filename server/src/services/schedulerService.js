const cron = require('node-cron');
const Feed = require('../models/Feed');
const Schedule = require('../models/Schedule');
const { fetchAndProcessFeed, queueFeedItemsForSchedules } = require('./feedProcessor');
const { sendQueuedForSchedule } = require('./queueService');
const logger = require('../utils/logger');

const feedIntervals = new Map();
const scheduleJobs = new Map();

const clearAll = () => {
  feedIntervals.forEach((interval) => clearInterval(interval));
  feedIntervals.clear();
  scheduleJobs.forEach((job) => job.stop());
  scheduleJobs.clear();
};

const triggerImmediateSchedules = async (feedId, whatsappClient) => {
  const schedules = await Schedule.find({ enabled: true, mode: 'immediate', feedIds: feedId });
  for (const schedule of schedules) {
    await sendQueuedForSchedule(schedule._id, whatsappClient);
  }
};

const scheduleFeedPolling = async (whatsappClient) => {
  const feeds = await Feed.find({ enabled: true });
  feeds.forEach(async (feed) => {
    const intervalMs = Math.max(feed.fetchIntervalMinutes || 15, 5) * 60 * 1000;
    const handler = async () => {
      try {
        const items = await fetchAndProcessFeed(feed);
        await queueFeedItemsForSchedules(feed._id, items);
        if (items.length) {
          await triggerImmediateSchedules(feed._id, whatsappClient);
        }
      } catch (error) {
        logger.error({ error, feedId: feed._id }, 'Failed to fetch feed');
      }
    };

    await handler();
    feedIntervals.set(feed._id.toString(), setInterval(handler, intervalMs));
  });
};

const scheduleSenders = async (whatsappClient) => {
  const schedules = await Schedule.find({ enabled: true });
  schedules.forEach((schedule) => {
    if (schedule.mode === 'interval' && schedule.intervalMinutes) {
      const intervalMs = schedule.intervalMinutes * 60 * 1000;
      const interval = setInterval(() => sendQueuedForSchedule(schedule._id, whatsappClient), intervalMs);
      scheduleJobs.set(schedule._id.toString(), { stop: () => clearInterval(interval) });
    }

    if (schedule.mode === 'times') {
      const times = Array.isArray(schedule.times) ? schedule.times : [];
      times.forEach((time) => {
        const [hour, minute] = time.split(':').map((value) => Number(value));
        if (Number.isNaN(hour) || Number.isNaN(minute)) return;
        const expression = `${minute} ${hour} * * *`;
        const job = cron.schedule(expression, () => sendQueuedForSchedule(schedule._id, whatsappClient), {
          timezone: schedule.timezone || 'UTC'
        });
        scheduleJobs.set(`${schedule._id.toString()}-${time}`, job);
      });
    }
  });
};

const initSchedulers = async (whatsappClient) => {
  clearAll();
  await scheduleFeedPolling(whatsappClient);
  await scheduleSenders(whatsappClient);
};

module.exports = {
  initSchedulers,
  triggerImmediateSchedules
};
