import type { Request, Response } from 'express';

const express = require('express');
const analyticsService = require('../services/analyticsService');
const { getSupabaseClient } = require('../db/supabase');
const { initSchedulers } = require('../services/schedulerService');
const { serviceUnavailable, notFound, badRequest } = require('../core/errors');
const { getErrorMessage, getErrorStatus } = require('../utils/errorUtils');

const toOptionalString = (value: unknown) => {
  const normalized = String(value || '').trim();
  return normalized || undefined;
};

const toOptionalNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseReportOptions = (req: Request) => ({
  targetId: toOptionalString(req.query.target_id),
  lookbackDays: toOptionalNumber(req.query.days),
  contentType: toOptionalString(req.query.content_type),
  tzOffsetMinutes: toOptionalNumber(req.query.tz_offset_min),
  forceRefresh: String(req.query.force || '').toLowerCase() === 'true'
});

const normalizeApplyMode = (value: unknown): 'auto' | 'cron' | 'batch' | 'both' => {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'cron') return 'cron';
  if (mode === 'batch') return 'batch';
  if (mode === 'both') return 'both';
  return 'auto';
};

const getDb = () => {
  const supabase = getSupabaseClient();
  if (!supabase) throw serviceUnavailable('Database not available');
  return supabase;
};

const analyticsRoutes = () => {
  const router = express.Router();

  const runAsync = (label: string, work: () => Promise<void>) => {
    setImmediate(() => {
      work().catch((error) => {
        console.warn(`${label} failed:`, error);
      });
    });
  };

  const refreshSchedulers = (whatsappClient: unknown) =>
    runAsync('Scheduler refresh from analytics', () => initSchedulers(whatsappClient));

  router.get('/report', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json(report);
    } catch (error) {
      console.error('Error building analytics report:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/overview', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json({
        generatedAt: report.generatedAt,
        lookbackDays: report.lookbackDays,
        filters: report.filters,
        totals: report.totals,
        rates: report.rates,
        dataQuality: report.dataQuality,
        model: report.model,
        recommendations: report.recommendations,
        audience: {
          totalAudienceLatest: report.audience.totalAudienceLatest,
          latestByTarget: report.audience.latestByTarget
        }
      });
    } catch (error) {
      console.error('Error building analytics overview:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/windows', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json(report.windows);
    } catch (error) {
      console.error('Error building analytics windows:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/recommendation', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json(report.recommendations);
    } catch (error) {
      console.error('Error building analytics recommendation:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/timeline', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json(report.timeline);
    } catch (error) {
      console.error('Error building analytics timeline:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/targets', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json(report.targetRisks);
    } catch (error) {
      console.error('Error building analytics target risks:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/schedule-recommendations', async (req: Request, res: Response) => {
    try {
      const result = await analyticsService.buildScheduleRecommendations({
        lookbackDays: toOptionalNumber(req.query.days)
      });
      res.json(result);
    } catch (error) {
      console.error('Error building schedule recommendations:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/schedule-recommendations/:id/apply', async (req: Request, res: Response) => {
    try {
      const scheduleId = String(req.params.id || '').trim();
      if (!scheduleId) throw badRequest('schedule id is required');

      const mode = normalizeApplyMode((req.body as Record<string, unknown> | undefined)?.mode);
      const dryRun = Boolean((req.body as Record<string, unknown> | undefined)?.dry_run);
      const lookbackDays = toOptionalNumber((req.body as Record<string, unknown> | undefined)?.days) || toOptionalNumber(req.query.days);

      const recommendationReport = await analyticsService.buildScheduleRecommendations({ lookbackDays: lookbackDays || undefined });
      const recommended = recommendationReport.schedules.find((item: { schedule_id?: string }) => String(item.schedule_id || '') === scheduleId);
      if (!recommended) throw notFound('Schedule recommendation not found');

      const deliveryMode = String((recommended as { delivery_mode?: unknown }).delivery_mode || 'immediate').toLowerCase();
      const autoMode: 'cron' | 'batch' =
        deliveryMode === 'batch' || deliveryMode === 'batched'
          ? 'batch'
          : 'cron';

      const shouldApplyCron =
        mode === 'cron' ||
        mode === 'both' ||
        (mode === 'auto' && autoMode === 'cron' && Boolean(recommended.recommended_cron));
      const shouldApplyBatch =
        mode === 'batch' ||
        mode === 'both' ||
        (mode === 'auto' && autoMode === 'batch' && recommended.recommended_batch_times.length > 0);
      const shouldClearCron = mode === 'auto' && autoMode === 'batch';

      const patch: Record<string, unknown> = {};
      if (shouldApplyCron) {
        patch.cron_expression = recommended.recommended_cron || null;
      } else if (shouldClearCron) {
        patch.cron_expression = null;
      }
      if (shouldApplyBatch) {
        patch.batch_times = recommended.recommended_batch_times;
      }

      if (!Object.keys(patch).length) {
        throw badRequest('No applicable recommendation to apply');
      }

      if (dryRun) {
        return res.json({
          ok: true,
          dry_run: true,
          schedule_id: scheduleId,
          mode,
          patch,
          recommended
        });
      }

      const supabase = getDb();
      const { data: updated, error } = await supabase
        .from('schedules')
        .update(patch)
        .eq('id', scheduleId)
        .select('*')
        .single();
      if (error) throw error;

      refreshSchedulers(req.app.locals.whatsapp);

      res.json({
        ok: true,
        dry_run: false,
        schedule_id: scheduleId,
        mode,
        patch,
        recommended,
        updated
      });
    } catch (error) {
      console.error('Error applying schedule recommendation:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.get('/audience', async (req: Request, res: Response) => {
    try {
      const report = await analyticsService.buildAnalyticsReport(parseReportOptions(req));
      res.json(report.audience);
    } catch (error) {
      console.error('Error fetching analytics audience snapshots:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  router.post('/audience/snapshot', async (req: Request, res: Response) => {
    try {
      const capture = await analyticsService.captureAudienceSnapshots(req.app.locals.whatsapp);
      const report = await analyticsService.buildAnalyticsReport({
        targetId: toOptionalString(req.query.target_id),
        lookbackDays: toOptionalNumber(req.query.days),
        forceRefresh: true
      });

      res.json({
        capture,
        audience: report.audience
      });
    } catch (error) {
      console.error('Error capturing analytics audience snapshot:', error);
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  });

  return router;
};

module.exports = analyticsRoutes;
