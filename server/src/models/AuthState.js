const { createModel } = require('../db/store');

module.exports = createModel('auth_states', {
  dateFields: ['updatedAt']
});
