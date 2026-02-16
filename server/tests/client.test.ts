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

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: jest.fn(() => null)
}));

const { getSupabaseClient } = require('../src/db/supabase');
const WhatsAppClient = require('../src/whatsapp/client');

describe('WhatsAppClient', () => {
    let client: any;

    beforeEach(() => {
        jest.clearAllMocks();
        (getSupabaseClient as jest.Mock).mockReturnValue(null);
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

    it('should fall back to database recipients when runtime audience is empty', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-5' } }));
        client.socket = { sendMessage };
        client.contactsCache.clear();
        client.groupMetadataCache.clear();
        client.meJid = null;

        const mockSupabase = {
            from: jest.fn((table: string) => {
                if (table === 'targets') {
                    return {
                        select: jest.fn(() => ({
                            eq: jest.fn(() => ({
                                eq: jest.fn(() => ({
                                    limit: jest.fn(async () => ({
                                        data: [{ phone_number: '972501234567' }],
                                        error: null
                                    }))
                                }))
                            }))
                        }))
                    };
                }

                if (table === 'chat_messages') {
                    return {
                        select: jest.fn(() => ({
                            order: jest.fn(() => ({
                                limit: jest.fn(async () => ({
                                    data: [
                                        { remote_jid: '103140015788103@lid' },
                                        { remote_jid: '120363407220244757@g.us' }
                                    ],
                                    error: null
                                }))
                            }))
                        }))
                    };
                }

                throw new Error(`Unexpected table ${table}`);
            })
        };
        (getSupabaseClient as jest.Mock).mockReturnValue(mockSupabase);

        await client.sendStatusBroadcast({ text: 'hello' });

        const options = sendMessage.mock.calls[0]?.[2] || {};
        expect(options.statusJidList).toEqual(expect.arrayContaining(['103140015788103@lid', '972501234567@s.whatsapp.net']));
        expect(options.statusJidList).not.toContain('120363407220244757@g.us');
    });

    it('should fail status send when audience is empty and empty audience is not allowed', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-2' } }));
        client.socket = { sendMessage };
        client.contactsCache.clear();
        client.groupMetadataCache.clear();
        client.meJid = null;

        const previous = process.env.WHATSAPP_ALLOW_EMPTY_STATUS_AUDIENCE;
        delete process.env.WHATSAPP_ALLOW_EMPTY_STATUS_AUDIENCE;

        await expect(client.sendStatusBroadcast({ text: 'hello' }))
            .rejects
            .toThrow('No status recipients resolved');
        expect(sendMessage).not.toHaveBeenCalled();

        if (previous === undefined) {
            delete process.env.WHATSAPP_ALLOW_EMPTY_STATUS_AUDIENCE;
        } else {
            process.env.WHATSAPP_ALLOW_EMPTY_STATUS_AUDIENCE = previous;
        }
    });
});
