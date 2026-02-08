import type { Request, Response } from 'express';

const express = require('express');
const analyticsService = require('../services/analyticsService');
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

const analyticsRoutes = () => {
  const router = express.Router();

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
