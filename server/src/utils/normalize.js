const normalizeText = (value = '') => {
  return value
    .toString()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
};

const normalizeUrl = (value = '') => {
  return value
    .toString()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .trim();
};

module.exports = {
  normalizeText,
  normalizeUrl
};
