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

  const missingScheduleColumn = (error: unknown, column: string) => {
    const message = String((error as { message?: unknown; details?: unknown })?.message || (error as { details?: unknown })?.details || error || '').toLowerCase();
    const needle = String(column || '').toLowerCase();
    if (!needle) return false;

    const codeRaw = (error as { code?: unknown })?.code;
    const code = typeof codeRaw === 'string' ? codeRaw.toUpperCase() : '';
    if (code === 'PGRST204' && message.includes(needle)) {
      return true;
    }
    if (code === '42703' && message.includes(needle)) {
      return true;
    }
    return (
      message.includes(`could not find the '${needle}' column`) ||
      message.includes(`could not find the \"${needle}\" column`) ||
      message.includes(`could not find the ${needle} column`) ||
      (message.includes(needle) && message.includes('schema cache')) ||
      (message.includes(needle) && message.includes('does not exist'))
    );
  };

  const stripUnsupportedScheduleFields = (payload: Record<string, unknown>, error: unknown) => {
    const cleaned = { ...payload };
    const maybeStrip = (column: string) => {
      if (missingScheduleColumn(error, column)) {
        delete (cleaned as Record<string, unknown>)[column];
      }
    };
    maybeStrip('delivery_mode');
    maybeStrip('batch_times');
    maybeStrip('last_dispatched_at');
    maybeStrip('last_queued_at');
    return cleaned;
  };
  
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
      // Do NOT set last_queued_at on creation - let first dispatch queue existing items
      const payload: Record<string, unknown> = {
        ...req.body
      };

      const supabase = getDb();
      let schedule: Record<string, unknown> | null = null;
      let attemptPayload: Record<string, unknown> = payload;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const { data, error } = await supabase.from('schedules').insert(attemptPayload).select().single();
        if (!error) {
          schedule = data;
          break;
        }

        const cleaned = stripUnsupportedScheduleFields(attemptPayload, error);
        const changed = Object.keys(attemptPayload).some((key) => !(key in cleaned));
        if (!changed) {
          throw error;
        }
        attemptPayload = cleaned;
      }

      if (!schedule) {
        throw new Error('Failed to create schedule');
      }
      refreshSchedulers(req.app.locals.whatsapp);
      res.json(schedule);
    } catch (error) {
      console.error('Error creating schedule:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.put('/:id', validate(schemas.schedule), async (req: Request, res: Response) => {
    try {
      const supabase = getDb();
      let schedule: Record<string, unknown> | null = null;
      let attemptPayload: Record<string, unknown> = req.body;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const { data, error } = await supabase
          .from('schedules')
          .update(attemptPayload)
          .eq('id', req.params.id)
          .select()
          .single();

        if (!error) {
          schedule = data;
          break;
        }

        const cleaned = stripUnsupportedScheduleFields(attemptPayload, error);
        const changed = Object.keys(attemptPayload).some((key) => !(key in cleaned));
        if (!changed) {
          throw error;
        }
        attemptPayload = cleaned;
      }

      if (!schedule) {
        throw new Error('Failed to update schedule');
      }
      refreshSchedulers(req.app.locals.whatsapp);
      res.json(schedule);
    } catch (error) {
      console.error('Error updating schedule:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const { error } = await getDb()
        .from('schedules')
        .delete()
        .eq('id', req.params.id);
      
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
