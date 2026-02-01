const mongoose = require('mongoose');

const feedSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true, unique: true },
    type: { type: String, enum: ['rss', 'atom', 'json'], required: true },
    enabled: { type: Boolean, default: true },
    fetchIntervalMinutes: { type: Number, default: 15 },
    lastFetchedAt: { type: Date },
    parseConfig: {
      itemsPath: { type: String },
      titlePath: { type: String },
      linkPath: { type: String },
      descriptionPath: { type: String },
      imagePath: { type: String },
      videoPath: { type: String },
      audioPath: { type: String },
      mediaTypePath: { type: String }
    },
    cleaning: {
      removePhrases: { type: [String], default: [] },
      stripUtm: { type: Boolean, default: true },
      decodeEntities: { type: Boolean, default: true }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Feed', feedSchema);
