import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies
jest.mock('../src/whatsapp/baileys', () => ({
    loadBaileys: jest.fn().mockResolvedValue({
        makeWASocket: jest.fn().mockReturnValue({
            ev: { on: jest.fn(), removeAllListeners: jest.fn() },
            end: jest.fn()
        }),
        DisconnectReason: { loggedOut: 401, restartRequired: 415 },
        fetchLatestWaWebVersion: jest.fn().mockResolvedValue({ version: [2, 24, 1] }),
        fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 24, 1] }),
        Browsers: { windows: jest.fn() }
    })
}));

jest.mock('../src/whatsapp/authStore', () => {
    return jest.fn().mockResolvedValue({
        state: {},
        saveCreds: jest.fn(),
        clearState: jest.fn(),
        updateStatus: jest.fn(),
        acquireLease: jest.fn().mockResolvedValue({ ok: true, supported: true, ownerId: 'me', expiresAt: 'future' }),
        renewLease: jest.fn().mockResolvedValue({ ok: true, supported: true, ownerId: 'me' })
    });
});

const WhatsAppClient = require('../src/whatsapp/client');

describe('WhatsAppClient', () => {
    let client: any;

    beforeEach(() => {
        jest.clearAllMocks();
        client = WhatsAppClient();
    });

    it('should instantiate with default values', () => {
        expect(client).toBeDefined();
        expect(client.status).toBe('disconnected');
        expect(client.instanceId).toBeDefined();
    });

    it('should have a clean initial state', () => {
        expect(client.qrCode).toBeNull();
        expect(client.lastError).toBeNull();
    });
});
