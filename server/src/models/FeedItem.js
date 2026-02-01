const { createModel } = require('../db/store');

module.exports = createModel('feed_items', {
  dateFields: ['publishedAt']
});
