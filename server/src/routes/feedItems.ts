import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');
const { isScheduleRunning } = require('../services/scheduleState');

const MANUAL_POST_PAUSE_REASON = 'Paused for this post';

const feedItemRoutes = () => {
  const router = express.Router();
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  // Get feed items with delivery summary
  // Default scope is automation-only so the list matches what can actually be sent.
  router.get('/', async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const scope = String(req.query.scope || 'automation').toLowerCase();
      const includeAllFeeds = scope === 'all';
      const dedupe = String(req.query.dedupe || 'true').toLowerCase() !== 'false';

      const { data: schedules, error: schedulesError } = await supabase
        .from('schedules')
        .select('feed_id,active,state');

      if (schedulesError) throw schedulesError;

      const runningAutomationCountByFeedId = new Map<string, number>();
      for (const schedule of (schedules || []) as Array<{ feed_id?: string | null; active?: boolean | null; state?: string | null }>) {
        const feedId = String(schedule.feed_id || '').trim();
        if (!feedId) continue;
        if (!isScheduleRunning(schedule)) continue;
        runningAutomationCountByFeedId.set(feedId, (runningAutomationCountByFeedId.get(feedId) || 0) + 1);
      }

      const activeAutomationFeedIds = Array.from(runningAutomationCountByFeedId.keys());
      if (!includeAllFeeds && !activeAutomationFeedIds.length) {
        return res.json([]);
      }

      let itemsQuery = supabase
        .from('feed_items')
        .select(`
          *,
          feed:feeds(id, name, url, type)
        `)
        .order('pub_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(200);

      if (!includeAllFeeds) {
        itemsQuery = itemsQuery.in('feed_id', activeAutomationFeedIds);
      }

      const { data: fetchedItems, error } = await itemsQuery;
      if (error) throw error;

      const seenKeys = new Set<string>();
      const items = (fetchedItems || []).filter((item: Record<string, unknown>) => {
        if (!dedupe) return true;
        const key =
          String(item.normalized_url || '').trim().toLowerCase() ||
          String(item.link || '').trim().toLowerCase() ||
          String(item.guid || '').trim().toLowerCase() ||
          `${String(item.feed_id || '').trim()}:${String(item.title || '').trim().toLowerCase()}:${String(item.pub_date || '').trim()}`;

        if (!key) return true;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      const ids = (items || []).map((item: { id?: string }) => item.id).filter(Boolean) as string[];
      const deliveryByItem = new Map<
        string,
        { pending: number; processing: number; sent: number; failed: number; skipped: number; manual_paused: number }
      >();

      if (ids.length) {
        const { data: logs, error: logsError } = await supabase
          .from('message_logs')
          .select('feed_item_id,status,error_message')
          .in('feed_item_id', ids);

        if (logsError) {
          console.warn('Error fetching message log summaries:', logsError);
        }

        for (const row of (logs || []) as Array<{ feed_item_id?: string; status?: string; error_message?: string | null }>) {
          const feedItemId = row.feed_item_id;
          const status = row.status;
          if (!feedItemId || !status) continue;

          const current = deliveryByItem.get(feedItemId) || {
            pending: 0,
            processing: 0,
            sent: 0,
            failed: 0,
            skipped: 0,
            manual_paused: 0
          };

          if (status === 'pending') current.pending += 1;
          else if (status === 'processing') current.processing += 1;
          else if (status === 'sent' || status === 'delivered' || status === 'read') current.sent += 1;
          else if (status === 'failed') current.failed += 1;
          else if (status === 'skipped') {
            current.skipped += 1;
            if (String(row.error_message || '') === MANUAL_POST_PAUSE_REASON) {
              current.manual_paused += 1;
            }
          }

          deliveryByItem.set(feedItemId, current);
        }
      }

      const enriched = (items || []).map((item: Record<string, unknown>) => {
        const id = String(item.id || '');
        const delivery = deliveryByItem.get(id) || {
          pending: 0,
          processing: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
          manual_paused: 0
        };
        const queued = delivery.pending + delivery.processing;
        const total = delivery.pending + delivery.processing + delivery.sent + delivery.failed + delivery.skipped;
        const hasQueued = queued > 0;
        const hasSent = delivery.sent > 0;
        const hasFailed = delivery.failed > 0;
        const hasManualPause = delivery.manual_paused > 0;
        const feedId = String(item.feed_id || '').trim();
        const activeAutomationCount = runningAutomationCountByFeedId.get(feedId) || 0;
        const delivery_status =
          hasManualPause && hasQueued
            ? 'paused_with_queue'
            : hasManualPause
              ? 'paused'
              : hasQueued && hasSent && hasFailed
            ? 'mixed'
            : hasQueued && hasSent
              ? 'partially_sent'
              : hasQueued && hasFailed
                ? 'retrying'
                : hasQueued
                  ? 'queued'
                  : hasSent && hasFailed
                    ? 'partially_sent'
                    : hasSent
                      ? 'sent'
                      : hasFailed
                        ? 'failed'
                        : activeAutomationCount > 0
                          ? 'not_queued'
                          : 'no_automation';
        return {
          ...item,
          sent: Boolean(item.sent) || delivery.sent > 0,
          delivery: { ...delivery, total },
          delivery_status,
          routing: {
            active_automations: activeAutomationCount
          }
        };
      });

      res.json(enriched);
    } catch (error) {
      console.error('Error fetching feed items:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get feed items by feed ID
  router.get('/by-feed/:feedId', async (req: Request, res: Response) => {
    try {
      const { data: items, error } = await getDb()
        .from('feed_items')
        .select('*')
        .eq('feed_id', req.params.feedId)
        .order('pub_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      res.json(items);
    } catch (error) {
      console.error('Error fetching feed items by feed:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/pause', async (req: Request, res: Response) => {
    try {
      const feedItemId = String(req.params.id || '').trim();
      if (!feedItemId) {
        return res.status(400).json({ error: 'Feed item id is required' });
      }

      const supabase = getDb();
      const { data: feedItem, error: feedItemError } = await supabase
        .from('feed_items')
        .select('id,feed_id')
        .eq('id', feedItemId)
        .single();

      if (feedItemError || !feedItem) {
        return res.status(404).json({ error: 'Feed item not found' });
      }

      const { data: schedules, error: schedulesError } = await supabase
        .from('schedules')
        .select('id,target_ids,template_id')
        .eq('feed_id', feedItem.feed_id);

      if (schedulesError) throw schedulesError;

      const scheduleIds = (schedules || [])
        .map((schedule: { id?: string }) => String(schedule.id || ''))
        .filter(Boolean);

      let updatedExisting = 0;
      if (scheduleIds.length) {
        const { data: updatedRows, error: updateError } = await supabase
          .from('message_logs')
          .update({
            status: 'skipped',
            error_message: MANUAL_POST_PAUSE_REASON,
            processing_started_at: null
          })
          .eq('feed_item_id', feedItemId)
          .in('schedule_id', scheduleIds)
          .in('status', ['pending', 'processing', 'failed'])
          .select('id');

        if (updateError) throw updateError;
        updatedExisting = updatedRows?.length || 0;
      }

      const suppressionRows: Array<Record<string, unknown>> = [];
      for (const schedule of schedules || []) {
        const scheduleId = schedule?.id ? String(schedule.id) : '';
        if (!scheduleId) continue;
        const targetIds = Array.isArray(schedule.target_ids) ? schedule.target_ids : [];
        for (const targetIdRaw of targetIds) {
          const targetId = String(targetIdRaw || '').trim();
          if (!targetId) continue;
          suppressionRows.push({
            schedule_id: scheduleId,
            feed_item_id: feedItemId,
            target_id: targetId,
            template_id: schedule.template_id || null,
            status: 'skipped',
            error_message: MANUAL_POST_PAUSE_REASON
          });
        }
      }

      let insertedSuppressions = 0;
      if (suppressionRows.length) {
        const { data: insertedRows, error: insertError } = await supabase
          .from('message_logs')
          .upsert(suppressionRows, { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true })
          .select('id');
        if (insertError) throw insertError;
        insertedSuppressions = insertedRows?.length || 0;
      }

      return res.json({
        ok: true,
        feed_item_id: feedItemId,
        schedule_count: scheduleIds.length,
        updated_existing: updatedExisting,
        inserted_suppressions: insertedSuppressions
      });
    } catch (error) {
      console.error('Error pausing feed item:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/resume', async (req: Request, res: Response) => {
    try {
      const feedItemId = String(req.params.id || '').trim();
      if (!feedItemId) {
        return res.status(400).json({ error: 'Feed item id is required' });
      }

      const supabase = getDb();
      const { data: resumedRows, error: resumeError } = await supabase
        .from('message_logs')
        .update({
          status: 'pending',
          error_message: null,
          retry_count: 0,
          processing_started_at: null
        })
        .eq('feed_item_id', feedItemId)
        .eq('status', 'skipped')
        .eq('error_message', MANUAL_POST_PAUSE_REASON)
        .select('id');

      if (resumeError) throw resumeError;

      return res.json({
        ok: true,
        feed_item_id: feedItemId,
        resumed: resumedRows?.length || 0
      });
    } catch (error) {
      console.error('Error resuming feed item:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  // Get available fields/variables from feed items for template usage
  router.get('/available-fields', async (_req: Request, res: Response) => {
    try {
      // Get a sample of recent feed items to extract available fields
      const { data: items, error } = await getDb()
        .from('feed_items')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (error) throw error;
      
      // Extract all unique fields from items
      const fields = new Set(['title', 'description', 'content', 'link', 'author', 'pub_date', 'image_url']);
      
      items.forEach((item: Record<string, unknown>) => {
        // Add fields from raw_data if available
        if (item.raw_data && typeof item.raw_data === 'object') {
          Object.keys(item.raw_data).forEach(key => fields.add(key));
        }
        // Add categories if available
        const categories = item.categories as unknown;
        if (Array.isArray(categories) && categories.length > 0) {
          fields.add('categories');
        }
      });
      
      res.json(Array.from(fields).sort());
    } catch (error) {
      console.error('Error fetching available fields:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = feedItemRoutes;
