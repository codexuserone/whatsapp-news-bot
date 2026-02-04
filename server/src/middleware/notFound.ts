import type { NextFunction, Request, Response } from 'express';

const { notFound } = require('../core/errors');

const notFoundHandler = (_req: Request, _res: Response, next: NextFunction) => {
  next(notFound('Route not found'));
};

module.exports = notFoundHandler;
export {};
