const shouldStartDatabaseBackedWorkers = (databaseConnected: boolean) => databaseConnected === true;
const shouldInitializeWhatsAppImmediately = (databaseConnected: boolean) => databaseConnected === true;

module.exports = {
  shouldStartDatabaseBackedWorkers,
  shouldInitializeWhatsAppImmediately
};
