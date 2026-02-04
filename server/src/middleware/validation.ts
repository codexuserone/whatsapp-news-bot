import type { NextFunction, Request, Response } from 'express';
import type { ZodIssue, ZodTypeAny } from 'zod';
const { z } = require('zod');
const { badRequest } = require('../core/errors');

const JID_PATTERN = /^([0-9+\s\-\(\)]+|status@broadcast|[0-9\-]+@g\.us|[0-9]+@s\.whatsapp\.net|[0-9]+@newsletter)$/i;

// Validation schemas
const normalizeOptional = (value: string | null | undefined) => (value === '' ? null : value);

const schemas = {
  schedule: z.object({
    name: z.string().min(1).max(255),
    cron_expression: z.string().optional().nullable().transform(normalizeOptional),
    timezone: z.string().default('UTC'),
    feed_id: z.string().uuid(),
    target_ids: z.array(z.string().uuid()).min(1),
    template_id: z.string().uuid(),
    active: z.boolean().default(true)
  }),

  feed: z.object({
    name: z.string().min(1).max(255),
    url: z.string().url(),
    type: z.enum(['rss', 'atom', 'json']).optional(),
    active: z.boolean().default(true),
    fetch_interval: z.number().int().min(60).default(300)
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
    send_images: z.boolean().default(true)
  }),

  testMessage: z.object({
    jid: z.string().regex(JID_PATTERN),
    message: z.string().min(1).max(4096),
    imageUrl: z.string().url().optional().nullable().transform(normalizeOptional)
  }),

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
