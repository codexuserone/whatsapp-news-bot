import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

const logger = require('../utils/logger');

const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  const start = Date.now();

  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info(
      {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs
      },
      'request'
    );
  });

  next();
};

module.exports = requestLogger;
export {};
