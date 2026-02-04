type AppErrorOptions = {
  status?: number;
  code?: string;
  details?: unknown;
};

const DEFAULT_STATUS = 500;
const DEFAULT_CODE = 'internal_error';

const createOptions = (options: AppErrorOptions = {}): { status: number; code: string; details?: unknown } => ({
  status: options.status ?? DEFAULT_STATUS,
  code: options.code ?? DEFAULT_CODE,
  details: options.details
});

class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    const normalized = createOptions(options);
    this.status = normalized.status;
    this.code = normalized.code;
    this.details = normalized.details;
  }
}

const badRequest = (message: string, details?: unknown) =>
  new AppError(message, { status: 400, code: 'bad_request', details });
const unauthorized = (message: string = 'Unauthorized') =>
  new AppError(message, { status: 401, code: 'unauthorized' });
const forbidden = (message: string = 'Forbidden') =>
  new AppError(message, { status: 403, code: 'forbidden' });
const notFound = (message: string = 'Not found') =>
  new AppError(message, { status: 404, code: 'not_found' });
const conflict = (message: string, details?: unknown) =>
  new AppError(message, { status: 409, code: 'conflict', details });
const serviceUnavailable = (message: string = 'Service unavailable') =>
  new AppError(message, { status: 503, code: 'service_unavailable' });

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  serviceUnavailable
};
export {};
