import type { NextFunction, Request, Response } from 'express';

const logger = require('../utils/logger');

const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const isProd = process.env.NODE_ENV === 'production';
  type NormalizedError = { status?: number; code?: string; message?: string; details?: unknown; stack?: string };
  const normalized: NormalizedError = err as NormalizedError;

  const status = typeof normalized.status === 'number' ? normalized.status : 500;
  const code = typeof normalized.code === 'string' ? normalized.code : 'internal_error';
  const message = typeof normalized.message === 'string' ? normalized.message : 'Internal Server Error';
  const requestId = res.locals.requestId;

  // Centralized server-side error logging (never leak stacks to clients in prod).
  if (status >= 500) {
    logger.error({ err, requestId }, 'Unhandled error');
  } else {
    logger.warn({ err, requestId }, 'Request error');
  }

  res.status(status).json({
    error: message,
    code,
    details: normalized.details,
    requestId,
    ...(isProd ? {} : { stack: normalized.stack })
  });
};

module.exports = errorHandler;
export {};
