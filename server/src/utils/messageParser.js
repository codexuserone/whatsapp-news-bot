const extractText = (message = {}) => {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ''
  );
};

const extractUrls = (text = '') => {
  const regex = /https?:\/\/[^\s]+/gi;
  return text.match(regex) || [];
};

module.exports = {
  extractText,
  extractUrls
};
