const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../utils/logger');

let mongoServer: { getUri: () => string } | null = null;

const connectDb = async () => {
  mongoose.set('strictQuery', true);

  if (env.USE_IN_MEMORY_DB || !env.MONGO_URI) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const server = mongoServer ?? (await MongoMemoryServer.create());
    mongoServer = server;
    const uri = server.getUri();
    await mongoose.connect(uri, { autoIndex: true });
    logger.info('MongoDB connected (in-memory)');
    return;
  }

  await mongoose.connect(env.MONGO_URI, { autoIndex: true });
  logger.info('MongoDB connected');
};

module.exports = connectDb;
export {};
