import type { NextFunction, Request, Response } from 'express';

const { AppError } = require('../core/errors');

const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  type NormalizedError = { status?: number; code?: string; message?: string; details?: unknown };
  const normalized: NormalizedError = err as NormalizedError;

  const status = normalized.status || 500;
  const code = normalized.code || 'internal_error';
  const message = normalized.message || 'Internal Server Error';

  res.status(status).json({
    error: {
      code,
      message,
      details: normalized.details
    }
  });
};

module.exports = errorHandler;
export {};
