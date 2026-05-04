const sleep = require('../utils/sleep');
const logger = require('../utils/logger');

type WhatsAppLikeClient = {
  getStatus?: () => { status?: string; lastSeenAt?: Date | null; lastError?: string | null; requiresManualPairing?: boolean };
  reconnect?: () => Promise<void> | void;
  takeoverLease?: (
    ttlMs?: number,
    options?: { manual?: boolean }
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

const isManualPairingRequired = (snapshot?: {
  status?: string;
  lastError?: string | null;
  requiresManualPairing?: boolean;
}) => {
  if (!snapshot) return false;
  if (snapshot.requiresManualPairing === true) return true;

  const status = String(snapshot.status || '').toLowerCase();
  if (status !== 'error') return false;

  const lastError = String(snapshot.lastError || '').toLowerCase();
  return (
    lastError.includes('fresh pairing required') ||
    lastError.includes('automatic recovery could not open') ||
    lastError.includes('login handshake before a qr') ||
    lastError.includes('pairing bootstrap failed before authentication')
  );
};

const ensureWhatsAppConnected = async (
  whatsappClient?: WhatsAppLikeClient | null,
  options?: EnsureConnectedOptions
) => {
  if (!whatsappClient) return false;

  const attempts = Math.max(Number(options?.attempts || 1), 1);
  const delayMs = Math.max(Number(options?.delayMs || 1000), 250);
  const requestedTakeoverTtlMs = Number(options?.takeoverTtlMs || process.env.WHATSAPP_LEASE_TTL_MS || 60_000);
  const takeoverTtlMs = Number.isFinite(requestedTakeoverTtlMs)
    ? Math.max(Math.floor(requestedTakeoverTtlMs), 20_000)
    : 60_000;
  const logContext = String(options?.logContext || 'WhatsApp recovery');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const statusSnapshot = whatsappClient.getStatus?.() || {};
    const status = String(statusSnapshot.status || 'unknown');
    if (status === 'connected') {
      return true;
    }
    if (status === 'paused' || isManualPairingRequired(statusSnapshot)) {
      return false;
    }
    if (status === 'qr' || status === 'qr_ready') {
      // Cannot auto-recover; requires a human to scan the QR code.
      return false;
    }

    const shouldAttemptTakeover =
      options?.triggerTakeover &&
      typeof whatsappClient.takeoverLease === 'function' &&
      (status === 'conflict' || status === 'disconnected' || status === 'error' || status === 'unknown') &&
      (attempt === 1 || attempt % 3 === 0);

    if (shouldAttemptTakeover) {
      try {
        const takeover = await whatsappClient.takeoverLease?.(takeoverTtlMs);
        if (!takeover) {
          throw new Error('WhatsApp lease takeover returned no result');
        }
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

const ensureWhatsAppReadyForOutbound = async (
  whatsappClient?: WhatsAppLikeClient | null,
  options?: EnsureConnectedOptions
) => {
  if (!whatsappClient) return false;

  const fastPath = await ensureWhatsAppConnected(whatsappClient, options);
  if (fastPath) return true;

  const statusSnapshot = whatsappClient.getStatus?.() || {};
  const status = String(statusSnapshot.status || 'unknown');
  if (status === 'paused' || status === 'qr' || status === 'qr_ready' || isManualPairingRequired(statusSnapshot)) {
    return false;
  }

  return ensureWhatsAppConnected(whatsappClient, {
    ...options,
    attempts: Math.max(Number(options?.attempts || 1), 12),
    delayMs: Math.max(Number(options?.delayMs || 1000), 1000)
  });
};

module.exports = {
  ensureWhatsAppConnected,
  ensureWhatsAppReadyForOutbound,
  isManualPairingRequired
};
