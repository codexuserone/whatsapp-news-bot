const cron = require('node-cron');
const { supabase } = require('../db/supabase');
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
  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('active', true)
      .eq('feed_id', feedId);

    if (error) throw error;

    // Filter for immediate mode schedules (cron_expression is null or empty)
    const immediateSchedules = (schedules || []).filter(s => !s.cron_expression);
    
    for (const schedule of immediateSchedules) {
      await sendQueuedForSchedule(schedule.id, whatsappClient);
    }
  } catch (error) {
    logger.error({ error, feedId }, 'Failed to trigger immediate schedules');
  }
};

const scheduleFeedPolling = async (whatsappClient) => {
  try {
    const { data: feeds, error } = await supabase
      .from('feeds')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    for (const feed of feeds || []) {
      // Convert fetch_interval from seconds to milliseconds, minimum 5 minutes
      const intervalMs = Math.max(feed.fetch_interval || 300, 300) * 1000;
      
      const handler = async () => {
        try {
          const items = await fetchAndProcessFeed(feed);
          await queueFeedItemsForSchedules(feed.id, items);
          if (items.length) {
            await triggerImmediateSchedules(feed.id, whatsappClient);
          }
        } catch (error) {
          logger.error({ error, feedId: feed.id }, 'Failed to fetch feed');
        }
      };

      await handler();
      feedIntervals.set(feed.id, setInterval(handler, intervalMs));
    }
  } catch (error) {
    logger.error({ error }, 'Failed to schedule feed polling');
  }
};

const scheduleSenders = async (whatsappClient) => {
  try {
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('*')
      .eq('active', true);

    if (error) throw error;

    for (const schedule of schedules || []) {
      // Handle cron expression based scheduling
      if (schedule.cron_expression) {
        try {
          const job = cron.schedule(
            schedule.cron_expression, 
            () => sendQueuedForSchedule(schedule.id, whatsappClient), 
            { timezone: schedule.timezone || 'UTC' }
          );
          scheduleJobs.set(schedule.id, job);
        } catch (cronError) {
          logger.error({ error: cronError, scheduleId: schedule.id }, 'Invalid cron expression');
        }
      }
    }
  } catch (error) {
    logger.error({ error }, 'Failed to schedule senders');
  }
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
