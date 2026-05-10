const FALSE_ACCEPTED_PREFIX =
  /WhatsApp accepted the send, but no delivery receipt has arrived yet\.\s*/gi;

const sanitizeSendErrorForApi = (value: unknown) => {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.replace(FALSE_ACCEPTED_PREFIX, '').replace(/\s+/g, ' ').trim() || null;
};

module.exports = { sanitizeSendErrorForApi };
export {};
