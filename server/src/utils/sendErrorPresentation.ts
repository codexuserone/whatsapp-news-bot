const FALSE_ACCEPTED_PREFIX =
  /WhatsApp accepted the send, but no delivery receipt has arrived yet\.\s*/gi;
const UNCONFIRMED_SEND_MESSAGE = 'WhatsApp did not confirm this send. It was not counted as sent.';
const UNCONFIRMED_SEND_PATTERNS = [
  /send result is uncertain/i,
  /message send not confirmed/i,
  /server ack(?: was)? not observed/i,
  /no upsert\/ack/i,
  /no delivery receipt/i
];

const sanitizeSendErrorForApi = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const isUnconfirmedSend = UNCONFIRMED_SEND_PATTERNS.some((pattern) => pattern.test(raw));
  const text = raw.replace(FALSE_ACCEPTED_PREFIX, '').replace(/\s+/g, ' ').trim();
  if (!text) return isUnconfirmedSend ? UNCONFIRMED_SEND_MESSAGE : null;
  if (isUnconfirmedSend && UNCONFIRMED_SEND_PATTERNS.some((pattern) => pattern.test(text))) {
    return UNCONFIRMED_SEND_MESSAGE;
  }
  return text;
};

module.exports = { sanitizeSendErrorForApi };
export {};
