const { getSupabaseClient } = require('../db/supabase');
const { isCurrentlyShabbos } = require('./shabbosService');
const logger = require('../utils/logger');
const { getErrorMessage } = require('../utils/errorUtils');
const { normalizeMessageText } = require('../utils/messageText');

type FeedItem = {
  id?: string;
  guid?: string;
  title?: string;
  link?: string;
  description?: string;
  content?: string;
  author?: string;
  image_url?: string;
  pub_date?: string | Date;
  categories?: string[];
  normalized_url?: string;
  content_hash?: string;
  raw_data?: Record<string, unknown>;
};

type WhatsAppClient = { getStatus?: () => { status: string } };

const applyTemplate = (templateBody: string, data: Record<string, unknown>): string => {
  if (!templateBody) return '';
  const rendered = templateBody.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = data[key];
    return value != null ? String(value) : '';
  });
  return normalizeMessageText(rendered);
};

const buildMessageData = (feedItem: FeedItem) => {
  const normalizedDescription = String(feedItem?.description || '').trim();
  const normalizedContent = String(feedItem?.content || '').trim();
  const fallbackDescription = normalizedDescription || normalizedContent.slice(0, 280);

  return {
    id: feedItem?.id,
    guid: (feedItem as unknown as { guid?: string }).guid,
    title: feedItem?.title,
    url: feedItem?.link,
    link: feedItem?.link,
    description: fallbackDescription,
    content: feedItem?.content,
    author: feedItem?.author,
    image_url: feedItem?.image_url,
    imageUrl: feedItem?.image_url,
    normalized_url: (feedItem as unknown as { normalized_url?: string }).normalized_url,
    normalizedUrl: (feedItem as unknown as { normalized_url?: string }).normalized_url,
    content_hash: (feedItem as unknown as { content_hash?: string }).content_hash,
    contentHash: (feedItem as unknown as { content_hash?: string }).content_hash,
    pub_date: feedItem?.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
    publishedAt: feedItem?.pub_date ? new Date(feedItem.pub_date).toISOString() : '',
    categories: Array.isArray(feedItem?.categories) ? feedItem.categories.join(', ') : '',
    ...(typeof (feedItem as unknown as { raw_data?: unknown }).raw_data === 'object' &&
    (feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data
      ? Object.fromEntries(
          Object.entries((feedItem as unknown as { raw_data?: Record<string, unknown> }).raw_data || {}).map(
            ([key, value]) => {
              if (value == null) return [key, ''];
              if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [key, value];
              try {
                return [key, JSON.stringify(value)];
              } catch {
                return [key, String(value)];
              }
            }
          )
        )
      : {})
  };
};

const getScheduleDiagnostics = async (scheduleId: string, whatsappClient?: WhatsAppClient) => {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, error: 'Database not available' };
  }

  const diagnostics: {
    scheduleId: string;
    blockingReasons: string[];
    warnings: string[];
    [key: string]: unknown;
  } = {
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
      target_ids: Array.isArray(schedule.target_ids) ? schedule.target_ids : [],
      delivery_mode: schedule.delivery_mode || 'immediate',
      batch_times: Array.isArray(schedule.batch_times) ? schedule.batch_times : [],
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
      .in('id', Array.isArray(schedule.target_ids) ? schedule.target_ids : []);

    if (targetsError) {
      diagnostics.warnings.push('Failed to load targets');
      logger.warn({ scheduleId, error: targetsError }, 'Diagnostics failed to fetch targets');
    }

    const activeTargets = (targets || []).filter((target: { active?: boolean }) => target.active);
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

    const logsSummary = {
      pending: pendingLogs?.length || 0,
      sent: sentLogs?.length || 0,
      failed: failedLogs?.length || 0
    };

    diagnostics.logs = logsSummary;

    if (logsSummary.pending === 0) {
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
    return { ok: false, error: getErrorMessage(error) };
  }
};

module.exports = {
  getScheduleDiagnostics
};
export {};
