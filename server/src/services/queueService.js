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

  if (!whatsappClient || whatsappClient.getStatus().status !== 'connected') {
    throw new Error('WhatsApp not connected');
  }

  // Format phone number as JID
  const jid = target.phone_number.includes('@') 
    ? target.phone_number 
    : `${target.phone_number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  if (feedItem.image_url) {
    return whatsappClient.sendMessage(jid, { image: { url: feedItem.image_url }, caption: text });
  }

  return whatsappClient.sendMessage(jid, { text });
};

const sendQueuedForSchedule = async (scheduleId, whatsappClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.error({ scheduleId }, 'Database not available - cannot send messages');
    return { sent: 0, error: 'Database not available' };
  }
  
  try {
    logger.info({ scheduleId }, 'Starting dispatch for schedule');
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
      logger.warn({ scheduleId, error: scheduleError?.message, schedule, active: schedule?.active }, 
        'Schedule not found or inactive');
      return { sent: 0 };
    }

    // Check if schedule has feed_id - if not, it's a manual dispatch only
    if (!schedule.feed_id) {
      logger.warn({ scheduleId }, 'Schedule has no feed_id - manual dispatch only');
      // For manual dispatch, we need to look for pending logs without feed items
      const { data: manualLogs, error: manualLogsError } = await supabase
        .from('message_logs')
        .select('*')
        .eq('schedule_id', scheduleId)
        .eq('status', 'pending')
        .is('feed_item_id', null);

      if (manualLogsError) throw manualLogsError;
      
      if (!manualLogs || manualLogs.length === 0) {
        logger.info({ scheduleId }, 'No pending manual messages to send');
        return { sent: 0 };
      }

      // For manual dispatch, we can't proceed without feed items
      logger.warn({ scheduleId, count: manualLogs.length }, 
        'Pending manual logs found but no feed items - cannot send');
      return { sent: 0, error: 'Manual dispatch requires feed items' };
    }

    const settings = await settingsService.getSettings();
    const messageDelay = settings.message_delay_ms || 2000;
    
    // Rate limiting: check if we sent messages too recently
    const minDelayBetweenSends = settings.defaultInterTargetDelaySec ? settings.defaultInterTargetDelaySec * 1000 : messageDelay;
    const recentSends = await supabase
      .from('message_logs')
      .select('sent_at')
      .eq('status', 'sent')
      .gte('sent_at', new Date(Date.now() - minDelayBetweenSends).toISOString())
      .limit(1);
    
    if (recentSends.data && recentSends.data.length > 0) {
      const lastSent = new Date(recentSends.data[0].sent_at);
      const timeSinceLastSend = Date.now() - lastSent.getTime();
      if (timeSinceLastSend < minDelayBetweenSends) {
        const waitTime = Math.ceil((minDelayBetweenSends - timeSinceLastSend) / 1000);
        logger.info({ scheduleId, waitTime }, 'Rate limiting - waiting before sending');
        await sleep(minDelayBetweenSends - timeSinceLastSend);
      }
    }

    // Get targets
    const { data: targets, error: targetsError } = await supabase
      .from('targets')
      .select('*')
      .in('id', schedule.target_ids || [])
      .eq('active', true);

    if (targetsError) {
      logger.error({ scheduleId, error: targetsError }, 'Failed to fetch targets');
      throw targetsError;
    }
    logger.info({ scheduleId, targetCount: targets?.length || 0 }, 'Found targets for schedule');

    // Get template
    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', schedule.template_id)
      .single();

    if (templateError || !template) {
      logger.error({ scheduleId, templateId: schedule.template_id, error: templateError }, 
        'Template not found for schedule');
      throw new Error('Template not found for schedule');
    }
    logger.info({ scheduleId, templateId: template.id }, 'Found template for schedule');

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
          
          // Validate rendered message before sending
          if (!messageContent || messageContent.trim().length === 0) {
            logger.warn({ scheduleId, feedItemId: feedItem.id, targetId: target.id }, 
              'Template rendered empty message - skipping');
            await supabase
              .from('message_logs')
              .update({ status: 'failed', error_message: 'Template rendered empty message' })
              .eq('id', log.id);
            continue;
          }
          
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
          
          sentCount += 1;

          if (whatsappClient.waitForMessage) {
            await whatsappClient.waitForMessage(response.key.id);
          }
        } catch (error) {
          logger.error({ error, scheduleId, feedItemId: feedItem.id, targetId: target.id }, 'Failed to send message');
          
          // Check if we should retry
          const maxRetries = settings.max_retries || 3;
          const currentRetry = log.retry_count || 0;
          
          if (currentRetry < maxRetries) {
            // Calculate exponential backoff delay
            const retryDelay = Math.min(1000 * Math.pow(2, currentRetry), 30000);
            logger.info({ 
              scheduleId, 
              feedItemId: feedItem.id, 
              targetId: target.id, 
              retry: currentRetry + 1, 
              maxRetries,
              retryDelay 
            }, 'Retrying failed message');
            
            // Update retry count and keep as pending
            await supabase
              .from('message_logs')
              .update({ 
                status: 'pending', 
                error_message: `Retry ${currentRetry + 1}/${maxRetries}: ${error.message}`,
                retry_count: currentRetry + 1
              })
              .eq('id', log.id);
            
            // Wait before retrying
            await sleep(retryDelay);
            continue; // Skip to next iteration to retry this message
          }
          
          // Max retries reached, mark as failed
          await supabase
            .from('message_logs')
            .update({ 
              status: 'failed', 
              error_message: `Max retries (${maxRetries}) exceeded: ${error.message}` 
            })
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

    logger.info({ scheduleId, sentCount }, 'Dispatch completed successfully');
    return { sent: sentCount };
  } catch (error) {
    logger.error({ error, scheduleId }, 'Failed to send queued messages');
    return { sent: 0, error: error.message };
  }
};

module.exports = {
  sendQueuedForSchedule
};
