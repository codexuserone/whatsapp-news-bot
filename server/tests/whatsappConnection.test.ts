import { describe, it, expect, jest } from '@jest/globals';

const {
  ensureWhatsAppConnected,
  ensureWhatsAppReadyForOutbound
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
        expect(ttlMs).toBe(90_000);
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
});
