import type { Request, Response } from 'express';
const express = require('express');
const { getSupabaseClient } = require('../db/supabase');
const { sendQueuedForSchedule, queueLatestForSchedule } = require('../services/queueService');
const { initSchedulers } = require('../services/schedulerService');
const { getScheduleDiagnostics } = require('../services/diagnosticsService');
const { validate, schemas } = require('../middleware/validation');
const { serviceUnavailable } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const scheduleRoutes = () => {
  const router = express.Router();

  const runAsync = (label: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch((error) => {
        console.warn(`${label} failed:`, error);
      });
    });
  };

  const refreshSchedulers = (whatsappClient: unknown) =>
    runAsync('Scheduler refresh', () => initSchedulers(whatsappClient));

  const normalizeBatchTimes = (value: unknown): string[] => {
    const seen = new Set<string>();
    const items = Array.isArray(value) ? value : [];
    for (const item of items) {
      const normalized = String(item || '').trim();
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) continue;
      seen.add(normalized);
    }
    return Array.from(seen).sort();
  };

<<<<<<< HEAD
  const normalizeCronExpression = (value: unknown): string | null => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return raw.replace(/\s+/g, ' ');
  };

=======
>>>>>>> a89c5c6 (CRITICAL FIX: Feed processing, encoding, and queue deadlocks)
  const normalizeSchedulePayload = (payload: Record<string, unknown>, options?: { forInsert?: boolean }) => {
    const next = { ...payload } as Record<string, unknown>;
    const mode = next.delivery_mode === 'batch' || next.delivery_mode === 'batched' ? 'batched' : 'immediate';
    const defaultBatchTimes = ['07:00', '15:00', '22:00'];
    const batchTimes = normalizeBatchTimes(next.batch_times);
<<<<<<< HEAD
    const cronExpression = normalizeCronExpression(next.cron_expression);

    next.delivery_mode = mode;
    next.batch_times = batchTimes.length ? batchTimes : defaultBatchTimes;
    next.cron_expression = cronExpression;
=======

    next.delivery_mode = mode;
    next.batch_times = batchTimes.length ? batchTimes : defaultBatchTimes;
>>>>>>> a89c5c6 (CRITICAL FIX: Feed processing, encoding, and queue deadlocks)

    if (options?.forInsert && mode === 'batched') {
      next.last_queued_at = new Date().toISOString();
    }

    return next;
  };

  const dispatchImmediate = (scheduleId: string, whatsappClient: unknown) =>
    runAsync(`Dispatch schedule ${scheduleId}`, async () => {
      await sendQueuedForSchedule(scheduleId, whatsappClient as never);
    });
  
  const getDb = () => {
    const supabase = getSupabaseClient();
    if (!supabase) throw serviceUnavailable('Database not available');
    return supabase;
  };

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const supabase = getDb();
      const { data: schedules, error } = await supabase
        .from('schedules')
        .select(`
          *,
          feed:feeds(id, name, url),
          template:templates(id, name, content)
        `)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      // Fetch targets for each schedule
      const schedulesWithTargets = await Promise.all(
        schedules.map(async (schedule: Record<string, unknown>) => {
          if (Array.isArray(schedule.target_ids) && schedule.target_ids.length > 0) {
            const { data: targets } = await getDb()
              .from('targets')
              .select('id, name, phone_number, type')
              .in('id', schedule.target_ids);
            return { ...schedule, targets: targets || [] };
          }
          return { ...schedule, targets: [] };
        })
      );
      
      res.json(schedulesWithTargets);
    } catch (error) {
      console.error('Error fetching schedules:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/', validate(schemas.schedule), async (req: Request, res: Response) => {
    try {
      const payload = normalizeSchedulePayload(req.body, { forInsert: true });
      const { data: schedule, error } = await getDb()
        .from('schedules')
        .insert(payload)
        .select()
        .single();
      
      if (error) throw error;
      refreshSchedulers(req.app.locals.whatsapp);

      // For immediate schedules, queue+send once so the system shows activity
      if (
        schedule?.active &&
        !schedule?.cron_expression &&
        schedule?.delivery_mode !== 'batched' &&
        schedule?.delivery_mode !== 'batch'
      ) {
        dispatchImmediate(schedule.id, req.app.locals.whatsapp);
      }
      res.json(schedule);
    } catch (error) {
      console.error('Error creating schedule:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.schedule), async (req: Request, res: Response) => {
    try {
      const payload = normalizeSchedulePayload(req.body);
      const { data: schedule, error } = await getDb()
        .from('schedules')
        .update(payload)
        .eq('id', req.params.id)
        .select()
        .single();
      
      if (error) throw error;
      refreshSchedulers(req.app.locals.whatsapp);

      if (
        schedule?.active &&
        !schedule?.cron_expression &&
        schedule?.delivery_mode !== 'batched' &&
        schedule?.delivery_mode !== 'batch'
      ) {
        dispatchImmediate(schedule.id, req.app.locals.whatsapp);
      }
      res.json(schedule);
    } catch (error) {
      console.error('Error updating schedule:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const scheduleId = req.params.id;

      // Prevent orphaned unsent queue items when a schedule is removed.
      // Sent logs can remain for audit history (they will become schedule_id = null via FK).
      const { error: unsentCleanupError } = await getDb()
        .from('message_logs')
        .delete()
        .eq('schedule_id', scheduleId)
        .in('status', ['pending', 'processing', 'failed', 'skipped']);
      if (unsentCleanupError) throw unsentCleanupError;

      const { error } = await getDb()
        .from('schedules')
        .delete()
        .eq('id', scheduleId);
      
      if (error) throw error;
      refreshSchedulers(req.app.locals.whatsapp);
      res.json({ ok: true });
    } catch (error) {
      console.error('Error deleting schedule:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/dispatch', async (req: Request, res: Response) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const result = await sendQueuedForSchedule(req.params.id, whatsapp);
      if (result?.error) {
        return res.status(500).json(result);
      }
      res.json(result);
    } catch (error) {
      console.error('Error dispatching schedule:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/:id/queue-latest', async (req: Request, res: Response) => {
    try {
      const result = await queueLatestForSchedule(req.params.id);
      if (result?.reason && result.queued === 0) {
        return res.status(200).json({ ok: false, ...result });
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error('Error queueing latest item:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/dispatch-all', async (req: Request, res: Response) => {
    try {
      const whatsapp = req.app.locals.whatsapp;
      const supabase = getDb();
      const { data: schedules, error } = await supabase.from('schedules').select('id').eq('active', true);
      if (error) throw error;

      const ids = (schedules || []).map((s: { id?: string }) => s.id).filter(Boolean) as string[];
      let sent = 0;
      let queued = 0;
      const results: Array<Record<string, unknown>> = [];

      for (const id of ids) {
        const result = await sendQueuedForSchedule(id, whatsapp);
        if (result?.sent) sent += result.sent;
        if (result?.queued) queued += result.queued;
        results.push({ scheduleId: id, ...result });
      }

      res.json({ sent, queued, schedules: ids.length, results });
    } catch (error) {
      console.error('Error dispatching all schedules:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/:id/diagnostics', async (req: Request, res: Response) => {
    try {
      const diagnostics = await getScheduleDiagnostics(req.params.id, req.app.locals.whatsapp);
      if (!diagnostics.ok) {
        return res.status(400).json(diagnostics);
      }
      res.json(diagnostics);
    } catch (error) {
      console.error('Error generating schedule diagnostics:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = scheduleRoutes;
