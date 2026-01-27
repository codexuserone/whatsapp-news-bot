const mongoose = require('mongoose');

const feedItemSchema = new mongoose.Schema(
  {
    feedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Feed', required: true },
    guid: { type: String },
    title: { type: String, required: true },
    url: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String },
    publishedAt: { type: Date },
    normalizedTitle: { type: String, index: true },
    normalizedUrl: { type: String, index: true },
    hash: { type: String, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FeedItem', feedItemSchema);
