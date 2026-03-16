import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies
jest.mock('../src/whatsapp/baileys', () => ({
    loadBaileys: jest.fn(async () => ({
        makeWASocket: jest.fn(() => ({
            ev: { on: jest.fn(), removeAllListeners: jest.fn() },
            end: jest.fn()
        })),
        DisconnectReason: { loggedOut: 401, restartRequired: 415 },
        fetchLatestWaWebVersion: jest.fn(async () => ({ version: [2, 24, 1] })),
        fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 24, 1] })),
        Browsers: { windows: jest.fn() }
    }))
}));

jest.mock('../src/whatsapp/authStore', () => {
    return jest.fn(async () => ({
        state: {},
        saveCreds: jest.fn(),
        clearState: jest.fn(),
        updateStatus: jest.fn(),
        acquireLease: jest.fn(async () => ({ ok: true, supported: true, ownerId: 'me', expiresAt: 'future' })),
        renewLease: jest.fn(async () => ({ ok: true, supported: true, ownerId: 'me' }))
    }));
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

    it('should default browser tuples to the configured device label', () => {
        const originalPlatform = process.env.WHATSAPP_BROWSER_PLATFORM;
        const originalBrowserName = process.env.WHATSAPP_BROWSER_NAME;
        const originalDeviceName = process.env.WHATSAPP_DEVICE_NAME;

        process.env.WHATSAPP_BROWSER_PLATFORM = 'ubuntu';
        delete process.env.WHATSAPP_BROWSER_NAME;
        process.env.WHATSAPP_DEVICE_NAME = 'Anash Bot';

        const tuple = WhatsAppClient.resolveBrowserTuple(
            {
                ubuntu: (name: string) => ['Ubuntu', name, '22.04.4']
            },
            String(process.env.WHATSAPP_DEVICE_NAME)
        );

        expect(tuple).toEqual(['Ubuntu', 'Anash Bot', '22.04.4']);

        if (originalPlatform === undefined) {
            delete process.env.WHATSAPP_BROWSER_PLATFORM;
        } else {
            process.env.WHATSAPP_BROWSER_PLATFORM = originalPlatform;
        }
        if (originalBrowserName === undefined) {
            delete process.env.WHATSAPP_BROWSER_NAME;
        } else {
            process.env.WHATSAPP_BROWSER_NAME = originalBrowserName;
        }
        if (originalDeviceName === undefined) {
            delete process.env.WHATSAPP_DEVICE_NAME;
        } else {
            process.env.WHATSAPP_DEVICE_NAME = originalDeviceName;
        }
    });

    it('should have a clean initial state', () => {
        expect(client.qrCode).toBeNull();
        expect(client.lastError).toBeNull();
    });

    it('should expose QR metadata for active QR state', () => {
        const now = Date.now();
        client.qrCode = 'data:image/png;base64,abc';
        client.qrGeneratedAtMs = now;
        client.qrExpiresAtMs = now + 60_000;

        const qrState = client.getQrState();

        expect(qrState.qr).toBe('data:image/png;base64,abc');
        expect(qrState.generatedAt).toBe(new Date(now).toISOString());
        expect(qrState.expiresAt).toBe(new Date(now + 60_000).toISOString());
        expect(qrState.ttlMs).toBe(60_000);
        expect(typeof qrState.remainingMs).toBe('number');
    });

    it('should use Baileys default QR lifetimes for initial and rotated codes', () => {
        expect(client.resolveIncomingQrTtlMs()).toBe(60_000);
        client.qrGenerationCount = 1;
        expect(client.resolveIncomingQrTtlMs()).toBe(20_000);
    });

    it('should clear expired QR state on read', () => {
        client.qrCode = 'data:image/png;base64,expired';
        client.qrGeneratedAtMs = Date.now() - 120_000;
        client.qrExpiresAtMs = Date.now() - 1_000;

        const qrState = client.getQrState();

        expect(qrState.qr).toBeNull();
        expect(client.qrCode).toBeNull();
        expect(client.qrGeneratedAtMs).toBeNull();
        expect(client.qrExpiresAtMs).toBeNull();
    });

    it('should resolve status audience from cache/store metadata and own jid', async () => {
        client.contactsCache.set('972501234567@s.whatsapp.net', {});
        client.groupMetadataCache.set('120363000000000000@g.us', {
            participants: [{ id: '972509999999@s.whatsapp.net' }]
        });

        client.socket = {
            store: {
                contacts: {
                    '972508888888@s.whatsapp.net': {}
                },
                chats: [{ id: '972507777777@s.whatsapp.net' }]
            },
            user: { id: '972506666666:12@s.whatsapp.net' }
        };

        const audience = await client.getStatusAudience({ sampleSize: 20 });
        expect(audience.participantCount).toBeGreaterThanOrEqual(5);
        expect(audience.sample).toContain('972501234567@s.whatsapp.net');
        expect(audience.sample).toContain('972506666666@s.whatsapp.net');
    });

    it('should match me participant when socket jid has a device suffix', () => {
        client.meJid = '972501111111:24@s.whatsapp.net';
        client.groupMetadataCache.set('120363000000000001@g.us', {
            participants: [{ id: '972501111111@s.whatsapp.net', admin: 'admin' }]
        });

        const groups = client.getGroupsFromMetadataCache();
        expect(groups[0]?.me?.isAdmin).toBe(true);
    });

    it('should normalize explicit statusJidList before sending status', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-1' } }));
        client.socket = { sendMessage };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            { statusJidList: ['972501234567', '972501234567@s.whatsapp.net', 'status@broadcast'] }
        );

        expect(sendMessage).toHaveBeenCalledWith(
            'status@broadcast',
            { text: 'hello' },
            expect.objectContaining({
                statusJidList: ['972501234567@s.whatsapp.net']
            })
        );
    });

    it('should preserve @lid recipients in explicit statusJidList when phone mapping is unavailable', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-3' } }));
        client.socket = { sendMessage };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            { statusJidList: ['anon_contact_123@lid', '972501234567:44@s.whatsapp.net'] }
        );

        expect(sendMessage).toHaveBeenCalledWith(
            'status@broadcast',
            { text: 'hello' },
            expect.objectContaining({
                statusJidList: ['anon_contact_123@lid', '972501234567@s.whatsapp.net']
            })
        );
    });

    it('should preserve numeric @lid recipients in explicit statusJidList', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-4' } }));
        client.socket = { sendMessage };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            { statusJidList: ['103140015788103@lid'] }
        );

        expect(sendMessage).toHaveBeenCalledWith(
            'status@broadcast',
            { text: 'hello' },
            expect.objectContaining({
                statusJidList: ['103140015788103@lid']
            })
        );
    });

    it('should fail status send when audience is empty', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-2' } }));
        client.socket = { sendMessage };
        client.contactsCache.clear();
        client.groupMetadataCache.clear();
        client.meJid = null;

        await expect(client.sendStatusBroadcast({ text: 'hello' }))
            .rejects
            .toThrow('No status recipients resolved');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should include ephemeralExpiration for disappearing groups', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'group-msg-1' } }));
        const groupMetadata: any = jest.fn(async () => ({
            id: '120363000000000010@g.us',
            subject: 'Test Group',
            size: 2,
            ephemeralDuration: 86400,
            participants: []
        }));

        client.socket = { sendMessage, groupMetadata };

        await client.sendMessage('120363000000000010@g.us', { text: 'hello group' });

        expect(sendMessage).toHaveBeenCalledWith(
            '120363000000000010@g.us',
            { text: 'hello group' },
            expect.objectContaining({ ephemeralExpiration: 86400 })
        );
    });

    it('should include ephemeralExpiration for disappearing private chats from store state', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'pm-msg-1' } }));

        client.socket = {
            sendMessage,
            store: {
                chats: [
                    { id: '972501234567:18@s.whatsapp.net', ephemeralExpiration: 604800 }
                ]
            }
        };

        await client.sendMessage('972501234567@s.whatsapp.net', { text: 'hello pm' });

        expect(sendMessage).toHaveBeenCalledWith(
            '972501234567@s.whatsapp.net',
            { text: 'hello pm' },
            expect.objectContaining({ ephemeralExpiration: 604800 })
        );
    });

    it('should not add ephemeralExpiration when the chat does not prove disappearing mode', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'plain-msg-1' } }));

        client.socket = {
            sendMessage,
            store: {
                chats: [
                    { id: '972501234567@s.whatsapp.net', ephemeralExpiration: 0 }
                ]
            }
        };

        await client.sendMessage('972501234567@s.whatsapp.net', { text: 'plain chat' });

        expect(sendMessage).toHaveBeenCalledWith(
            '972501234567@s.whatsapp.net',
            { text: 'plain chat' },
            {}
        );
    });

    it('should treat invalid account signature as auth corruption', () => {
        expect(client.isAuthStateCorrupted('Invalid account signature')).toBe(true);
    });

    it('should clear auth state when invalid account signature is detected', async () => {
        const clearState = jest.fn(async () => {});
        const updateStatus = jest.fn(async () => {});
        client.authStore = {
            ...client.authStore,
            clearState,
            updateStatus
        };

        client.scheduleReconnect = jest.fn();
        client.cleanupSocket = jest.fn();
        client.socket = { end: jest.fn() };

        await client.handleCorruptedAuthState(new Error('Invalid account signature'));

        expect(clearState).toHaveBeenCalled();
        expect((updateStatus as any).mock.calls[0]?.[0]).toBe('error');
        expect(client.scheduleReconnect).toHaveBeenCalledWith(5000);
    });

    it('should treat info-level pairing traces as auth corruption', async () => {
        const corrupted = jest.fn(async () => {});
        client.handleCorruptedAuthState = corrupted;

        const baileysLogger = client.createBaileysLogger();
        baileysLogger.info(
            {
                trace: 'Error: Invalid account signature\n    at configureSuccessfulPairing (...)'
            },
            'error in pairing'
        );

        await Promise.resolve();

        expect((corrupted as any).mock.calls.length).toBe(1);
        expect((corrupted as any).mock.calls[0][0].message).toContain('Invalid account signature');
    });

    it('should refuse hard refresh while connected', async () => {
        const clearState = jest.fn(async () => {});
        client.authStore = {
            ...client.authStore,
            clearState
        };
        client.status = 'connected';
        client.lastSeenAt = new Date();
        client.connect = jest.fn();

        await expect(client.hardRefresh()).rejects.toThrow(
            'WhatsApp is already connected. Use reconnect or takeover instead of hard refresh.'
        );

        expect(clearState).not.toHaveBeenCalled();
        expect(client.connect).not.toHaveBeenCalled();
    });

    it('should refuse hard refresh shortly after a successful connection', async () => {
        const clearState = jest.fn(async () => {});
        client.authStore = {
            ...client.authStore,
            clearState
        };
        client.status = 'disconnected';
        client.lastSeenAt = new Date(Date.now() - 30_000);
        client.connect = jest.fn();

        await expect(client.hardRefresh()).rejects.toThrow(
            'WhatsApp connected recently. Wait before forcing a new QR.'
        );

        expect(clearState).not.toHaveBeenCalled();
        expect(client.connect).not.toHaveBeenCalled();
    });

    it('should allow forced hard refresh shortly after a successful connection', async () => {
        const clearState = jest.fn(async () => {});
        client.authStore = {
            ...client.authStore,
            clearState
        };
        client.status = 'disconnected';
        client.lastSeenAt = new Date(Date.now() - 30_000);
        client.connect = jest.fn(async () => {});

        await client.hardRefresh({ force: true });

        expect(clearState).toHaveBeenCalled();
        expect(client.connect).toHaveBeenCalled();
    });
});
