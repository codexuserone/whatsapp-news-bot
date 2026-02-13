import type { NextFunction, Request, Response } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';
const { z } = require('zod');
const { badRequest } = require('../core/errors');
const cron = require('node-cron');

const JID_PATTERN = /^([0-9+\s\-\(\)]+|status@broadcast|[0-9\-]+@g\.us|[0-9]+@s\.whatsapp\.net|[a-z0-9._-]+@newsletter(?:_[a-z0-9]+)?)$/i;

// Validation schemas
const normalizeOptional = (value: string | null | undefined) => (value === '' ? null : value);

const isValidIanaTimezone = (value: unknown) => {
  const tz = String(value || '').trim();
  if (!tz) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const schemas = {
  scheduleBatchTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Batch times must be HH:MM (24h)'),

  schedule: z.object({
    name: z.string().min(1).max(255),
    cron_expression: z.string().optional().nullable().transform(normalizeOptional),
    timezone: z.string().default('UTC').transform((value: string) => String(value || '').trim() || 'UTC'),
    feed_id: z.string().uuid(),
    target_ids: z.array(z.string().uuid()).min(1),
    template_id: z.string().uuid(),
    active: z.boolean().optional(),
    state: z.enum(['active', 'paused', 'stopped', 'draft']).optional(),
    delivery_mode: z.enum(['immediate', 'batch', 'batched']).default('immediate'),
    batch_times: z.array(z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/)).default(['07:00', '15:00', '22:00'])
  }).superRefine((value: {
    delivery_mode?: 'immediate' | 'batch' | 'batched';
    batch_times?: string[];
    timezone?: string;
    cron_expression?: string | null;
  }, ctx: { addIssue: (issue: { code: string; path: string[]; message: string }) => void }) => {
    const timezone = String(value.timezone || '').trim() || 'UTC';
    if (!isValidIanaTimezone(timezone)) {
      ctx.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: 'Invalid timezone (must be an IANA timezone like "America/New_York")'
      });
    }

    const cronExpression = String(value.cron_expression || '').trim().replace(/\s+/g, ' ');
    if (cronExpression && !cron.validate(cronExpression)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cron_expression'],
        message: 'Invalid cron expression'
      });
    }

    if (value.delivery_mode !== 'batch' && value.delivery_mode !== 'batched') return;
    const times = Array.isArray(value.batch_times) ? value.batch_times : [];
    if (!times.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['batch_times'],
        message: 'At least one batch time is required for batch delivery mode'
      });
      return;
    }

    const seen = new Set<string>();
    for (const time of times) {
      const normalized = String(time || '').trim();
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
        ctx.addIssue({
          code: 'custom',
          path: ['batch_times'],
          message: `Invalid batch time: ${time}`
        });
        continue;
      }
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: 'custom',
          path: ['batch_times'],
          message: `Duplicate batch time: ${normalized}`
        });
      }
      seen.add(normalized);
    }
  }),

  feed: z.object({
    name: z.string().min(1).max(255),
    url: z.string().url(),
    type: z.enum(['rss', 'atom', 'json', 'html']).optional(),
    active: z.boolean().optional(),
    fetch_interval: z.number().int().min(60).default(300),
    parse_config: z
      .object({
        itemsPath: z.string().max(255).optional().nullable().transform(normalizeOptional),
        titlePath: z.string().max(255).optional().nullable().transform(normalizeOptional),
        descriptionPath: z.string().max(255).optional().nullable().transform(normalizeOptional),
        linkPath: z.string().max(255).optional().nullable().transform(normalizeOptional),
        imagePath: z.string().max(255).optional().nullable().transform(normalizeOptional)
      })
      .partial()
      .optional(),
    cleaning: z
      .object({
        stripUtm: z.boolean().optional(),
        decodeEntities: z.boolean().optional(),
        removePhrases: z.array(z.string().max(500)).optional()
      })
      .partial()
      .optional()
  }),

  target: z.object({
    name: z.string().min(1).max(255),
    phone_number: z.string().regex(JID_PATTERN),
    type: z.enum(['individual', 'group', 'channel', 'status']),
    active: z.boolean().default(true),
    notes: z.string().max(1000).optional().nullable().transform(normalizeOptional)
  }),

  template: z.object({
    name: z.string().min(1).max(255),
    content: z.string().min(1).max(5000),
    description: z.string().max(1000).optional().nullable().transform(normalizeOptional),
    active: z.boolean().default(true),
    send_images: z.boolean().default(true),
    send_mode: z.enum(['image', 'image_only', 'link_preview', 'text_only']).optional().default('image')
  }),

  testMessage: z
    .object({
      jid: z.string().regex(JID_PATTERN).optional().nullable().transform(normalizeOptional),
      jids: z.array(z.string().regex(JID_PATTERN)).max(100).optional(),
      message: z.string().max(4096).optional().nullable().transform(normalizeOptional),
      linkUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      imageUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      imageDataUrl: z.string().max(12_000_000).optional().nullable().transform(normalizeOptional),
      // Base64 video payloads are large; keep this bounded even if JSON_BODY_LIMIT_LARGE is higher.
      videoDataUrl: z.string().max(35_000_000).optional().nullable().transform(normalizeOptional),
      includeCaption: z.boolean().optional().default(true),
      disableLinkPreview: z.boolean().optional().default(false),
      confirm: z.boolean().optional()
    })
    .refine(
      (value: {
        jid?: string | null;
        jids?: string[];
      }) => Boolean(value.jid || (Array.isArray(value.jids) && value.jids.length > 0)),
      {
        message: 'jid or jids is required'
      }
    )
    .refine(
      (value: {
        message?: string | null;
        linkUrl?: string | null;
        imageUrl?: string | null;
        imageDataUrl?: string | null;
        videoDataUrl?: string | null;
      }) => Boolean(value.message || value.linkUrl || value.imageUrl || value.imageDataUrl || value.videoDataUrl),
      {
        message: 'message, linkUrl, imageUrl, imageDataUrl, or videoDataUrl is required'
      }
    ),

  statusMessage: z
    .object({
      message: z.string().max(4096).optional().nullable().transform(normalizeOptional),
      imageUrl: z.string().url().optional().nullable().transform(normalizeOptional)
    })
    .refine(
      (value: { message?: string | null; imageUrl?: string | null }) => Boolean(value.message || value.imageUrl),
      {
        message: 'message or imageUrl is required'
      }
    ),

  settings: z.record(z.unknown())
};

// Validation middleware factory
const formatIssues = (issues: ZodIssue[]) =>
  issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));

const validate = (schema: ZodTypeAny) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(badRequest('Validation failed', formatIssues(result.error.issues)));
    }
    req.body = result.data;
    return next();
  };
};

// Sanitization helpers
const sanitizePhoneNumber = (phone: string) => {
  // Remove all non-numeric characters except + for international numbers
  return phone.replace(/[^0-9+]/g, '');
};

const sanitizeUrl = (url: string) => {
  // Basic URL sanitization
  const urlPattern = /^https?:\/\/.+/;
  if (!urlPattern.test(url)) {
    throw new Error('Invalid URL format');
  }
  return url;
};

const sanitizeHtml = (text: string) => {
  // Basic HTML sanitization - remove script tags and dangerous attributes
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
};

module.exports = {
  schemas,
  validate,
  sanitizePhoneNumber,
  sanitizeUrl,
  sanitizeHtml
};
