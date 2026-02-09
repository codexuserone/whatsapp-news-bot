const sleep = require('../utils/sleep');
const logger = require('../utils/logger');

type WhatsAppLikeClient = {
  getStatus?: () => { status?: string };
  reconnect?: () => Promise<void> | void;
  takeoverLease?: (
    ttlMs?: number
  ) => Promise<{ ok: boolean; supported: boolean; ownerId: string | null; expiresAt: string | null; reason?: string }>;
};

type EnsureConnectedOptions = {
  attempts?: number;
  delayMs?: number;
  triggerReconnect?: boolean;
  triggerTakeover?: boolean;
  takeoverTtlMs?: number;
  logContext?: string;
};

const ensureWhatsAppConnected = async (
  whatsappClient?: WhatsAppLikeClient | null,
  options?: EnsureConnectedOptions
) => {
  if (!whatsappClient) return false;

  const attempts = Math.max(Number(options?.attempts || 1), 1);
  const delayMs = Math.max(Number(options?.delayMs || 1000), 250);
  const takeoverTtlMs = Math.max(Number(options?.takeoverTtlMs || 90_000), 30_000);
  const logContext = String(options?.logContext || 'WhatsApp recovery');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = String(whatsappClient.getStatus?.().status || 'unknown');
    if (status === 'connected') {
      return true;
    }

    const takeoverLease = whatsappClient.takeoverLease;
    const shouldAttemptTakeover =
      options?.triggerTakeover &&
      status === 'conflict' &&
      typeof takeoverLease === 'function' &&
      (attempt === 1 || attempt % 3 === 0);

    if (shouldAttemptTakeover) {
      try {
        const takeover = await takeoverLease(takeoverTtlMs);
        if (takeover.ok) {
          logger.info(
            { ownerId: takeover.ownerId, expiresAt: takeover.expiresAt, attempt, status, context: logContext },
            'Acquired WhatsApp lease while waiting for connected state'
          );
        }
      } catch (error) {
        logger.warn({ error, attempt, status, context: logContext }, 'Failed to take over WhatsApp lease');
      }
    }

    const shouldAttemptReconnect =
      options?.triggerReconnect &&
      (attempt === 1 || attempt % 3 === 0) &&
      (status === 'conflict' || status === 'disconnected' || status === 'error' || status === 'unknown');

    if (shouldAttemptReconnect) {
      try {
        await Promise.resolve(whatsappClient.reconnect?.());
      } catch (error) {
        logger.warn({ error, attempt, status, context: logContext }, 'Failed to trigger WhatsApp reconnect');
      }
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return false;
};

module.exports = {
  ensureWhatsAppConnected
};
