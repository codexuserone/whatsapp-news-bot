const { createModel } = require('../db/store');

module.exports = createModel('schedules', {
  dateFields: ['lastRunAt'],
  arrayFields: ['feedIds', 'targetIds']
});
