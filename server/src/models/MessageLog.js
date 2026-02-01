const { createModel } = require('../db/store');

module.exports = createModel('message_logs', {
  dateFields: ['sentAt']
});
