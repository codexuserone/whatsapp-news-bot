import { describe, it, expect, jest } from '@jest/globals';

const {
  ensureWhatsAppConnected,
  ensureWhatsAppReadyForOutbound,
  isManualPairingRequired
} = require('../src/services/whatsappConnection');

describe('whatsappConnection recovery helpers', () => {
  it('should not escalate qr-ready state into destructive recovery', async () => {
    const reconnect = jest.fn(async () => {});
    const takeoverLease = jest.fn(async () => ({ ok: true, supported: true, ownerId: 'me', expiresAt: 'future' }));
    const getStatus = jest.fn(() => ({ status: 'qr_ready' }));

    const ready = await ensureWhatsAppReadyForOutbound(
      { getStatus, reconnect, takeoverLease },
      { attempts: 2, delayMs: 10, triggerReconnect: true, triggerTakeover: true, logContext: 'test' }
    );

    expect(ready).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
    expect(takeoverLease).not.toHaveBeenCalled();
  });

  it('should retry reconnect/takeover for disconnected outbound recovery without hard refresh', async () => {
    const reconnect = jest.fn(async () => {});
    const takeoverLease = jest.fn(async () => ({ ok: true, supported: true, ownerId: 'me', expiresAt: 'future' }));
    const getStatus = jest
      .fn()
      .mockReturnValueOnce({ status: 'disconnected' })
      .mockReturnValueOnce({ status: 'disconnected' })
      .mockReturnValue({ status: 'connected' });

    const ready = await ensureWhatsAppReadyForOutbound(
      { getStatus, reconnect, takeoverLease },
      { attempts: 1, delayMs: 10, triggerReconnect: true, triggerTakeover: true, logContext: 'test' }
    );

    expect(ready).toBe(true);
    expect(reconnect).toHaveBeenCalled();
    expect(takeoverLease).toHaveBeenCalled();
  });

  it('should not keep retrying when WhatsApp requires a fresh manual pairing', async () => {
    const reconnect = jest.fn(async () => {});
    const takeoverLease: any = jest.fn(async () => ({ ok: true, supported: true, ownerId: 'me', expiresAt: 'future' }));
    const getStatus = jest.fn(() => ({
      status: 'error',
      lastError: 'Fresh pairing required. Automatic recovery could not open a WhatsApp login code.'
    }));

    const ready = await ensureWhatsAppReadyForOutbound(
      { getStatus, reconnect, takeoverLease },
      { attempts: 4, delayMs: 10, triggerReconnect: true, triggerTakeover: true, logContext: 'test' }
    );

    expect(ready).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
    expect(takeoverLease).not.toHaveBeenCalled();
  });

  it('should classify pairing bootstrap failures as manual pairing required', () => {
    expect(
      isManualPairingRequired({
        status: 'error',
        lastError: 'WhatsApp pairing bootstrap failed before authentication completed'
      })
    ).toBe(true);
    expect(isManualPairingRequired({ status: 'disconnected', lastError: 'Connection closed' })).toBe(false);
  });

  it('should report connected immediately when already connected', async () => {
    const ready = await ensureWhatsAppConnected(
      { getStatus: () => ({ status: 'connected' }) },
      { attempts: 1, delayMs: 10, triggerReconnect: true, triggerTakeover: true, logContext: 'test' }
    );

    expect(ready).toBe(true);
  });

  it('should preserve client binding when calling takeoverLease', async () => {
    const client = {
      ownerId: 'lease-owner',
      reconnect: jest.fn(async () => {}),
      getStatus: jest
        .fn()
        .mockReturnValueOnce({ status: 'conflict' })
        .mockReturnValue({ status: 'connected' }),
      async takeoverLease(ttlMs?: number) {
        expect(this.ownerId).toBe('lease-owner');
        expect(ttlMs).toBe(60_000);
        return { ok: true, supported: true, ownerId: this.ownerId, expiresAt: 'future' };
      }
    };

    const ready = await ensureWhatsAppConnected(client, {
      attempts: 1,
      delayMs: 10,
      triggerReconnect: true,
      triggerTakeover: true,
      logContext: 'test'
    });

    expect(ready).toBe(false);
  });

  it('should use the configured lease ttl for recovery takeover attempts', async () => {
    const originalTtl = process.env.WHATSAPP_LEASE_TTL_MS;
    process.env.WHATSAPP_LEASE_TTL_MS = '45000';

    const takeoverLease = jest.fn(async () => ({ ok: true, supported: true, ownerId: 'me', expiresAt: 'future' }));
    const client = {
      reconnect: jest.fn(async () => {}),
      getStatus: jest
        .fn()
        .mockReturnValueOnce({ status: 'conflict' })
        .mockReturnValue({ status: 'connected' }),
      takeoverLease
    };

    try {
      const ready = await ensureWhatsAppConnected(client, {
        attempts: 1,
        delayMs: 10,
        triggerReconnect: false,
        triggerTakeover: true,
        logContext: 'test'
      });

      expect(ready).toBe(false);
      expect(takeoverLease as any).toHaveBeenCalledWith(45_000);
    } finally {
      if (originalTtl === undefined) {
        delete process.env.WHATSAPP_LEASE_TTL_MS;
      } else {
        process.env.WHATSAPP_LEASE_TTL_MS = originalTtl;
      }
    }
  });
});
