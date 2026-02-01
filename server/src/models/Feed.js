const { createModel } = require('../db/store');

module.exports = createModel('feeds', {
  dateFields: ['lastFetchedAt']
});
