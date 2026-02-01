const { getSupabaseClient } = require('../db/supabase');
const { isCurrentlyShabbos } = require('./shabbosService');
const logger = require('../utils/logger');

const applyTemplate = (templateBody, data) => {
  if (!templateBody) return '';
  return templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => (data[key] != null ? data[key] : ''));
};

const buildMessageData = (feedItem) => ({
  title: feedItem?.title,
  url: feedItem?.link,
  link: feedItem?.link,
  description: feedItem?.description,
  content: feedItem?.content,
  author: feedItem?.author,
  image_url: feedItem?.image_url,
  imageUrl: feedItem?.image_url,
  pub_date: feedItem?.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  publishedAt: feedItem?.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
  categories: Array.isArray(feedItem?.categories) ? feedItem.categories.join(', ') : ''
});

const getScheduleDiagnostics = async (scheduleId, whatsappClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: 'Database not available' };
  }

  const diagnostics = {
    scheduleId,
    blockingReasons: [],
    warnings: []
  };

  try {
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();

    if (scheduleError || !schedule) {
      diagnostics.blockingReasons.push('Schedule not found');
      return { ok: false, ...diagnostics };
    }

    diagnostics.schedule = {
      id: schedule.id,
      name: schedule.name,
      active: schedule.active,
      feed_id: schedule.feed_id,
      template_id: schedule.template_id,
      target_ids: schedule.target_ids || [],
      cron_expression: schedule.cron_expression || null,
      timezone: schedule.timezone || 'UTC',
      last_run_at: schedule.last_run_at || null
    };

    if (!schedule.active) {
      diagnostics.blockingReasons.push('Schedule is inactive');
    }

    if (!schedule.feed_id) {
      diagnostics.blockingReasons.push('Schedule has no feed_id');
    }

    const whatsappStatus = whatsappClient?.getStatus?.() || { status: 'unknown' };
    diagnostics.whatsapp = whatsappStatus;
    if (whatsappStatus.status !== 'connected') {
      diagnostics.blockingReasons.push('WhatsApp is not connected');
    }

    const shabbosStatus = await isCurrentlyShabbos();
    diagnostics.shabbos = shabbosStatus;
    if (shabbosStatus.isShabbos) {
      diagnostics.blockingReasons.push('Shabbos mode active');
    }

    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', schedule.template_id)
      .single();

    if (templateError || !template) {
      diagnostics.blockingReasons.push('Template not found');
    } else {
      diagnostics.template = {
        id: template.id,
        name: template.name,
        active: template.active
      };
    }

    const { data: targets, error: targetsError } = await supabase
      .from('targets')
      .select('*')
      .in('id', schedule.target_ids || []);

    if (targetsError) {
      diagnostics.warnings.push('Failed to load targets');
      logger.warn({ scheduleId, error: targetsError }, 'Diagnostics failed to fetch targets');
    }

    const activeTargets = (targets || []).filter((target) => target.active);
    diagnostics.targets = {
      total: targets?.length || 0,
      active: activeTargets.length,
      inactive: (targets?.length || 0) - activeTargets.length
    };

    if (!activeTargets.length) {
      diagnostics.blockingReasons.push('No active targets on schedule');
    }

    const { data: pendingLogs } = await supabase
      .from('message_logs')
      .select('id', { count: 'exact' })
      .eq('schedule_id', scheduleId)
      .eq('status', 'pending');

    const { data: sentLogs } = await supabase
      .from('message_logs')
      .select('id', { count: 'exact' })
      .eq('schedule_id', scheduleId)
      .eq('status', 'sent');

    const { data: failedLogs } = await supabase
      .from('message_logs')
      .select('id', { count: 'exact' })
      .eq('schedule_id', scheduleId)
      .eq('status', 'failed');

    diagnostics.logs = {
      pending: pendingLogs?.length || 0,
      sent: sentLogs?.length || 0,
      failed: failedLogs?.length || 0
    };

    if (diagnostics.logs.pending === 0) {
      diagnostics.warnings.push('No pending message logs for schedule');
    }

    if (schedule.feed_id) {
      const { data: latestFeedItem } = await supabase
        .from('feed_items')
        .select('*')
        .eq('feed_id', schedule.feed_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!latestFeedItem) {
        diagnostics.blockingReasons.push('No feed items found for schedule feed');
      } else {
        diagnostics.latestFeedItem = {
          id: latestFeedItem.id,
          title: latestFeedItem.title,
          created_at: latestFeedItem.created_at
        };

        if (template?.content) {
          const rendered = applyTemplate(template.content, buildMessageData(latestFeedItem)).trim();
          diagnostics.templatePreview = {
            length: rendered.length,
            empty: rendered.length === 0
          };
          if (!rendered.length) {
            diagnostics.blockingReasons.push('Template renders empty message');
          }
        }
      }
    }

    return { ok: diagnostics.blockingReasons.length === 0, ...diagnostics };
  } catch (error) {
    logger.error({ error, scheduleId }, 'Diagnostics failed');
    return { ok: false, error: error.message };
  }
};

module.exports = {
  getScheduleDiagnostics
};
