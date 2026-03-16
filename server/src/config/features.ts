const normalizeBooleanEnv = (value: unknown, fallback: boolean) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
};

const WHATSAPP_STATUS_ENABLED = normalizeBooleanEnv(process.env.WHATSAPP_STATUS_ENABLED, false);
const WHATSAPP_STATUS_DISABLED_REASON =
  'WhatsApp Status is disabled during the current stabilization pass.';

module.exports = {
  WHATSAPP_STATUS_ENABLED,
  WHATSAPP_STATUS_DISABLED_REASON
};

export { };
