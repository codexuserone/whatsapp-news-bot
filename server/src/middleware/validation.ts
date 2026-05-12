import type { NextFunction, Request, Response } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';
const { z } = require('zod');
const { badRequest } = require('../core/errors');
const cron = require('node-cron');
const { DEFAULT_BATCH_TIMES } = require('../constants/scheduling');

const JID_PATTERN =
  /^([0-9+\s\-\(\)]+|status@broadcast|[0-9\-]+@g\.us|[0-9]+(?::[0-9]+)?@s\.whatsapp\.net|[a-z0-9._-]+(?::[0-9]+)?@lid|[a-z0-9._-]+@newsletter(?:_[a-z0-9]+)?)$/i;
const STATUS_AUDIENCE_JID_PATTERN =
  /^([0-9]{6,}|[0-9]+(?::[0-9]+)?@s\.whatsapp\.net|[a-z0-9._-]+(?::[0-9]+)?@lid)$/i;
const HEX_COLOR_PATTERN = /^#?[0-9a-f]{6}$/i;

// Validation schemas
const normalizeOptional = (value: string | null | undefined) => (value === '' ? null : value);
const normalizeNullableObject = (value: unknown) => (value === null ? undefined : value);
const normalizeOptionalLowerString = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  return normalized || undefined;
};
const normalizeOptionalInt = (value: unknown) => {
  if (value === '' || value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
};
const optionalInt = (min: number, max: number) =>
  z.preprocess(
    normalizeOptionalInt,
    z.number().int().min(min).max(max).nullable().optional()
  );

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
    batch_times: z.array(z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/)).default(DEFAULT_BATCH_TIMES),
    approval_required: z.boolean().optional().default(false)
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
    type: z.preprocess(normalizeOptionalLowerString, z.enum(['rss', 'atom', 'json', 'html']).optional()),
    active: z.boolean().optional(),
    fetch_interval: z.coerce.number().int().min(60).default(300),
    parse_config: z.preprocess(
      normalizeNullableObject,
      z
        .object({
          itemsPath: z.string().max(255).optional().nullable().transform(normalizeOptional),
          titlePath: z.string().max(255).optional().nullable().transform(normalizeOptional),
          descriptionPath: z.string().max(255).optional().nullable().transform(normalizeOptional),
          linkPath: z.string().max(255).optional().nullable().transform(normalizeOptional),
          imagePath: z.string().max(255).optional().nullable().transform(normalizeOptional)
        })
        .partial()
        .optional()
    ),
    cleaning: z.preprocess(
      normalizeNullableObject,
      z
        .object({
          stripUtm: z.boolean().optional(),
          decodeEntities: z.boolean().optional(),
          removePhrases: z.array(z.string().max(500)).optional()
        })
        .partial()
        .optional()
    )
  }),

  target: z.object({
    name: z.string().min(1).max(255),
    phone_number: z.string().regex(JID_PATTERN),
    type: z.enum(['individual', 'group', 'channel', 'status']),
    active: z.boolean().default(true),
    notes: z.string().max(1000).optional().nullable().transform(normalizeOptional),
    message_delay_ms_override: optionalInt(0, 60000),
    inter_target_delay_sec_override: optionalInt(0, 600),
    intra_target_delay_sec_override: optionalInt(0, 600)
  }),

  template: z.object({
    name: z.string().min(1).max(255),
    content: z.string().min(1).max(5000),
    description: z.string().max(1000).optional().nullable().transform(normalizeOptional),
    active: z.boolean().default(true),
    send_images: z.boolean().default(true),
    send_mode: z
      .enum(['auto_media', 'media_only', 'text_preview', 'text_only', 'image', 'image_only', 'link_preview'])
      .optional()
      .default('auto_media'),
    media_source: z.enum(['auto', 'image', 'video', 'featured_image', 'feed_video']).optional().default('auto'),
    sequence_steps: z
      .array(
        z.object({
          label: z.string().max(120).optional().nullable().transform(normalizeOptional),
          content: z.string().min(1).max(5000),
          send_mode: z
            .enum(['auto_media', 'media_only', 'text_preview', 'text_only', 'image', 'image_only', 'link_preview'])
            .optional()
            .default('auto_media'),
          media_source: z.enum(['auto', 'image', 'video', 'featured_image', 'feed_video']).optional().default('auto'),
          status_background_color: z
            .string()
            .regex(HEX_COLOR_PATTERN, 'status_background_color must be a hex color like #0f172a')
            .optional()
            .nullable()
            .transform(normalizeOptional),
          status_font: optionalInt(0, 8),
          delay_seconds: z.coerce.number().int().min(0).max(3600).optional().default(0),
          active: z.boolean().optional().default(true)
        })
      )
      .max(12)
      .optional()
      .default([]),
    status_background_color: z
      .string()
      .regex(HEX_COLOR_PATTERN, 'status_background_color must be a hex color like #0f172a')
      .optional()
      .nullable()
      .transform(normalizeOptional),
    status_font: optionalInt(0, 8)
  }),

  testMessage: z
    .object({
      jid: z.string().regex(JID_PATTERN).optional().nullable().transform(normalizeOptional),
      jids: z.array(z.string().regex(JID_PATTERN)).max(100).optional(),
      message: z.string().max(4096).optional().nullable().transform(normalizeOptional),
      linkUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      imageUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      videoUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      audioUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      documentUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      imageDataUrl: z.string().max(12_000_000).optional().nullable().transform(normalizeOptional),
      // Base64 video payloads are large; keep this bounded even if JSON_BODY_LIMIT_LARGE is higher.
      videoDataUrl: z.string().max(35_000_000).optional().nullable().transform(normalizeOptional),
      audioDataUrl: z.string().max(25_000_000).optional().nullable().transform(normalizeOptional),
      documentDataUrl: z.string().max(35_000_000).optional().nullable().transform(normalizeOptional),
      documentFilename: z.string().max(255).optional().nullable().transform(normalizeOptional),
      documentMime: z.string().max(255).optional().nullable().transform(normalizeOptional),
      statusJidList: z.array(z.string().regex(STATUS_AUDIENCE_JID_PATTERN)).max(2000).optional(),
      backgroundColor: z
        .string()
        .regex(HEX_COLOR_PATTERN, 'backgroundColor must be a hex color like #0f172a')
        .optional()
        .nullable()
        .transform(normalizeOptional),
      font: optionalInt(0, 8),
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
        videoUrl?: string | null;
        audioUrl?: string | null;
        documentUrl?: string | null;
        imageDataUrl?: string | null;
        videoDataUrl?: string | null;
        audioDataUrl?: string | null;
        documentDataUrl?: string | null;
      }) =>
        Boolean(
          value.message ||
          value.linkUrl ||
          value.imageUrl ||
          value.videoUrl ||
          value.audioUrl ||
          value.documentUrl ||
          value.imageDataUrl ||
          value.videoDataUrl ||
          value.audioDataUrl ||
          value.documentDataUrl
        ),
      {
        message:
          'message, linkUrl, imageUrl, videoUrl, audioUrl, documentUrl, imageDataUrl, videoDataUrl, audioDataUrl, or documentDataUrl is required'
      }
    ),

  statusMessage: z
    .object({
      message: z.string().max(4096).optional().nullable().transform(normalizeOptional),
      imageUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      imageDataUrl: z.string().max(12_000_000).optional().nullable().transform(normalizeOptional),
      videoUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      videoDataUrl: z.string().max(35_000_000).optional().nullable().transform(normalizeOptional),
      backgroundColor: z
        .string()
        .regex(HEX_COLOR_PATTERN, 'backgroundColor must be a hex color like #0f172a')
        .optional()
        .nullable()
        .transform(normalizeOptional),
      font: optionalInt(0, 8),
      mediaUploadTimeoutMs: optionalInt(1000, 180000),
      statusJidList: z.array(z.string().regex(STATUS_AUDIENCE_JID_PATTERN)).max(2000).optional()
    })
    .refine(
      (value: {
        message?: string | null;
        imageUrl?: string | null;
        imageDataUrl?: string | null;
        videoUrl?: string | null;
        videoDataUrl?: string | null;
      }) => Boolean(value.message || value.imageUrl || value.imageDataUrl || value.videoUrl || value.videoDataUrl),
      {
        message: 'message, imageUrl, imageDataUrl, videoUrl, or videoDataUrl is required'
      }
    )
    .refine(
      (value: {
        imageUrl?: string | null;
        imageDataUrl?: string | null;
        videoUrl?: string | null;
        videoDataUrl?: string | null;
      }) => {
        const imageCount = Number(Boolean(value.imageUrl)) + Number(Boolean(value.imageDataUrl));
        const videoCount = Number(Boolean(value.videoUrl)) + Number(Boolean(value.videoDataUrl));
        return imageCount + videoCount <= 1;
      },
      {
        message: 'Provide at most one media source (image or video)'
      }
    ),

  manualPost: z
    .object({
      target_id: z.string().uuid().optional().nullable().transform(normalizeOptional),
      target_ids: z.array(z.string().uuid()).max(50).optional(),
      message: z.string().max(4096).optional().nullable().transform(normalizeOptional),
      imageUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      videoUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      audioUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      documentUrl: z.string().url().optional().nullable().transform(normalizeOptional),
      imageDataUrl: z.string().max(12_000_000).optional().nullable().transform(normalizeOptional),
      videoDataUrl: z.string().max(35_000_000).optional().nullable().transform(normalizeOptional),
      audioDataUrl: z.string().max(25_000_000).optional().nullable().transform(normalizeOptional),
      documentDataUrl: z.string().max(35_000_000).optional().nullable().transform(normalizeOptional),
      disableLinkPreview: z.boolean().optional().default(false),
      includeCaption: z.boolean().optional().default(true),
      documentFilename: z.string().max(255).optional().nullable().transform(normalizeOptional),
      documentMime: z.string().max(255).optional().nullable().transform(normalizeOptional)
    })
    .refine(
      (value: { target_id?: string | null; target_ids?: string[] }) =>
        Boolean(String(value.target_id || '').trim()) || (Array.isArray(value.target_ids) && value.target_ids.length > 0),
      {
        message: 'target_id or target_ids is required'
      }
    )
    .refine(
      (value: {
        message?: string | null;
        imageUrl?: string | null;
        videoUrl?: string | null;
        audioUrl?: string | null;
        documentUrl?: string | null;
        imageDataUrl?: string | null;
        videoDataUrl?: string | null;
        audioDataUrl?: string | null;
        documentDataUrl?: string | null;
      }) =>
        Boolean(
          value.message ||
          value.imageUrl ||
          value.videoUrl ||
          value.audioUrl ||
          value.documentUrl ||
          value.imageDataUrl ||
          value.videoDataUrl ||
          value.audioDataUrl ||
          value.documentDataUrl
        ),
      {
        message: 'message or attachment is required'
      }
    )
    .refine(
      (value: {
        imageUrl?: string | null;
        videoUrl?: string | null;
        audioUrl?: string | null;
        documentUrl?: string | null;
        imageDataUrl?: string | null;
        videoDataUrl?: string | null;
        audioDataUrl?: string | null;
        documentDataUrl?: string | null;
      }) =>
        [
          value.imageUrl,
          value.videoUrl,
          value.audioUrl,
          value.documentUrl,
          value.imageDataUrl,
          value.videoDataUrl,
          value.audioDataUrl,
          value.documentDataUrl
        ].filter(Boolean).length <= 1,
      {
        message: 'Provide at most one media source'
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

const formatIssueSummary = (issues: Array<{ field: string; message: string }>) =>
  issues
    .map((issue) => {
      const field = String(issue.field || '').trim();
      const message = String(issue.message || '').trim();
      if (!field && !message) return '';
      return field ? `${field}: ${message || 'Invalid value'}` : message;
    })
    .filter(Boolean)
    .join('; ');

const validate = (schema: ZodTypeAny) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = formatIssues(result.error.issues);
      const summary = formatIssueSummary(issues);
      return next(badRequest(summary ? `Validation failed: ${summary}` : 'Validation failed', issues));
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
