const pino = require('pino');
const env = require('../config/env');

const serializeError = (value: unknown) => {
  if (value instanceof Error) {
    return pino.stdSerializers.err(value);
  }
  return value;
};

const logger = pino({
  level: env.LOG_LEVEL,
  serializers: {
    err: pino.stdSerializers.err,
    error: serializeError
  }
});

module.exports = logger;
export {};
