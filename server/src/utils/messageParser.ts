type ParsedMessage = {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  documentMessage?: { caption?: string };
};

const extractText = (message: ParsedMessage = {}) => {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ''
  );
};

const extractUrls = (text: string = '') => {
  const regex = /https?:\/\/[^\s]+/gi;
  return text.match(regex) || [];
};

module.exports = {
  extractText,
  extractUrls
};
export {};
