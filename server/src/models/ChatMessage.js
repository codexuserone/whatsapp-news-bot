const { createModel } = require('../db/store');

module.exports = createModel('chat_messages', {
  dateFields: ['timestamp']
});
