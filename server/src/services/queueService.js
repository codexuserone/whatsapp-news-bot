const { getSupabaseClient } = require('../db/supabase');
const settingsService = require('./settingsService');
const { isCurrentlyShabbos } = require('./shabbosService');
const sleep = require('../utils/sleep');
const logger = require('../utils/logger');

const applyTemplate = (templateBody, data) => {
  return templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => (data[key] !== undefined ? data[key] : ''));
};

const buildMessageData = (feedItem) => ({
  title: feedItem.title,
  url: feedItem.link,
  link: feedItem.link,
  description: feedItem.description,
  content: feedItem.content,
  author: feedItem.author,
  image_url: feedItem.image_url,
  imageUrl: feedItem.image_url,
  pub_date: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  publishedAt: feedItem.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  categories: Array.isArray(feedItem.categories) ? feedItem.categories.join(', ') : ''
});

const sendMessageWithTemplate = async (whatsappClient, target, template, feedItem) => {
  const payload = buildMessageData(feedItem);
  const text = applyTemplate(template.content, payload).trim();
  if (!text) {
    throw new Error('Template rendered empty message');
  }

  const socket = whatsappClient.socket;
  if (!socket) {
    throw new Error('WhatsApp socket not connected');
  }

  // Format phone number as JID
  const jid = target.phone_number.includes('@') 
    ? target.phone_number 
    : `${target.phone_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  if (feedItem.image_url) {
    if (target.type === 'group') {
      return socket.sendMessage(jid, { image: { url: feedItem.image_url }, caption: text });
    }
    return socket.sendMessage(jid, { image: { url: feedItem.image_url }, caption: text });
  }

  return socket.sendMessage(jid, { text });
};

const queueExistingItemsForSchedule = async (scheduleId, { limit = 50 } = {}) => {
  const supabase = getSupabaseClient();
  if (!supabase) return { queued: 0 };

  try {
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();

    if (scheduleError || !schedule || !schedule.active) {
      return { queued: 0 };
    }

    if (!schedule.feed_id || !Array.isArray(schedule.target_ids) || schedule.target_ids.length === 0) {
      return { queued: 0 };
    }

    const { data: feedItems, error: feedItemsError } = await supabase
      .from('feed_items')
      .select('id')
      .eq('feed_id', schedule.feed_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (feedItemsError) throw feedItemsError;
    if (!feedItems || feedItems.length === 0) {
      return { queued: 0 };
    }

    const feedItemIds = feedItems.map((item) => item.id);
    const { data: existingLogs, error: logsError } = await supabase
      .from('message_logs')
      .select('feed_item_id, target_id')
      .eq('schedule_id', schedule.id)
      .in('feed_item_id', feedItemIds)
      .in('target_id', schedule.target_ids);

    if (logsError) throw logsError;

    const existingSet = new Set(
      (existingLogs || []).map((log) => `${log.feed_item_id}:${log.target_id}`)
    );

    const pendingLogs = [];
    for (const feedItemId of feedItemIds) {
      for (const targetId of schedule.target_ids) {
        const key = `${feedItemId}:${targetId}`;
        if (existingSet.has(key)) continue;
        pendingLogs.push({
          feed_item_id: feedItemId,
          target_id: targetId,
          schedule_id: schedule.id,
          template_id: schedule.template_id,
          status: 'pending'
        });
      }
    }

    if (pendingLogs.length) {
      const { error: insertError } = await supabase
        .from('message_logs')
        .insert(pendingLogs);
      if (insertError) throw insertError;
    }

    return { queued: pendingLogs.length };
  } catch (error) {
    logger.error({ error, scheduleId }, 'Failed to queue existing feed items');
    return { queued: 0, error: error.message };
  }
};

const sendQueuedForSchedule = async (scheduleId, whatsappClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) return { sent: 0 };
  
  try {
    // Check if currently Shabbos/Yom Tov - if so, skip sending but keep messages queued
    const shabbosStatus = await isCurrentlyShabbos();
    if (shabbosStatus.isShabbos) {
      logger.info({ scheduleId, reason: shabbosStatus.reason, endsAt: shabbosStatus.endsAt }, 
        'Skipping message send - Shabbos/Yom Tov active');
      return { 
        sent: 0, 
        skipped: true, 
        reason: shabbosStatus.reason,
        resumeAt: shabbosStatus.endsAt 
      };
    }
    
    // Get schedule
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();

    if (scheduleError || !schedule || !schedule.active) {
      return { sent: 0 };
    }

    const settings = await settingsService.getSettings();
    const messageDelay = settings.message_delay_ms || 2000;

    // Get targets
    const { data: targets, error: targetsError } = await supabase
      .from('targets')
      .select('*')
      .in('id', schedule.target_ids || [])
      .eq('active', true);

    if (targetsError) throw targetsError;

    // Get template
    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', schedule.template_id)
      .single();

    if (templateError || !template) {
      throw new Error('Template not found for schedule');
    }

    let sentCount = 0;

    for (const target of targets || []) {
      // Get pending message logs for this target and schedule
      const { data: logs, error: logsError } = await supabase
        .from('message_logs')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('target_id', target.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (logsError) continue;

      for (const log of logs || []) {
        // Get feed item
        const { data: feedItem, error: feedItemError } = await supabase
          .from('feed_items')
          .select('*')
          .eq('id', log.feed_item_id)
          .single();

        if (feedItemError || !feedItem) {
          await supabase
            .from('message_logs')
            .update({ status: 'failed', error_message: 'Feed item missing' })
            .eq('id', log.id);
          continue;
        }

        const since = new Date(Date.now() - (settings.log_retention_days || 30) * 24 * 60 * 60 * 1000);
        const jid = target.phone_number.includes('@') 
          ? target.phone_number 
          : `${target.phone_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

        // Check for duplicate based on feed item + target combination
        const { data: existingSent } = await supabase
          .from('message_logs')
          .select('id')
          .eq('feed_item_id', feedItem.id)
          .eq('target_id', target.id)
          .eq('status', 'sent')
          .single();

        if (existingSent) {
          await supabase
            .from('message_logs')
            .update({ status: 'failed', error_message: 'Already sent to this target' })
            .eq('id', log.id);
          continue;
        }

        try {
          const messageContent = applyTemplate(template.content, buildMessageData(feedItem));
          const response = await sendMessageWithTemplate(whatsappClient, target, template, feedItem);
          
          await supabase
            .from('message_logs')
            .update({ 
              status: 'sent', 
              sent_at: new Date().toISOString(), 
              error_message: null,
              message_content: messageContent,
              whatsapp_message_id: response?.key?.id
            })
            .eq('id', log.id);

          await supabase
            .from('feed_items')
            .update({
              sent: true,
              sent_at: feedItem.sent_at || new Date().toISOString()
            })
            .eq('id', feedItem.id);
          
          sentCount += 1;

          if (whatsappClient.waitForMessage) {
            await whatsappClient.waitForMessage(response.key.id);
          }
        } catch (error) {
          logger.error({ error }, 'Failed to send message');
          await supabase
            .from('message_logs')
            .update({ status: 'failed', error_message: error.message })
            .eq('id', log.id);
        }

        await sleep(messageDelay);
      }
    }

    // Update schedule last run time
    await supabase
      .from('schedules')
      .update({ last_run_at: new Date().toISOString() })
      .eq('id', scheduleId);

    return { sent: sentCount };
  } catch (error) {
    logger.error({ error, scheduleId }, 'Failed to send queued messages');
    return { sent: 0, error: error.message };
  }
};

module.exports = {
  sendQueuedForSchedule,
  queueExistingItemsForSchedule
};
