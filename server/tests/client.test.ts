import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const newsletterTempFiles = new Set<string>();

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
        Browsers: { windows: jest.fn() },
        DEFAULT_ORIGIN: 'https://web.whatsapp.com',
        proto: {
            Message: {
                decode: jest.fn((value: Uint8Array) => ({
                    toJSON: () => JSON.parse(Buffer.from(value).toString('utf8'))
                }))
            }
        },
        generateMessageIDV2: jest.fn(() => 'newsletter-msg-id'),
        encodeNewsletterMessage: jest.fn((message: unknown) => Buffer.from(JSON.stringify(message))),
        prepareWAMessageMedia: jest.fn(async (message: Record<string, unknown>, options: Record<string, unknown>) => {
            let uploadResult: any = null;
            if (typeof options?.upload === 'function') {
                const tmpFile = path.join(os.tmpdir(), `newsletter-test-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
                fs.writeFileSync(tmpFile, Buffer.from('newsletter-media'));
                newsletterTempFiles.add(tmpFile);
                uploadResult = await options.upload(tmpFile, {
                    fileEncSha256B64: 'ZmFrZWhhc2g=',
                    mediaType: Object.prototype.hasOwnProperty.call(message, 'video') ? 'video' : 'image'
                });
            }

            if (Object.prototype.hasOwnProperty.call(message, 'video')) {
                return {
                    videoMessage: {
                        url: uploadResult?.mediaUrl || 'https://mmg.whatsapp.net/newsletter-video',
                        directPath: uploadResult?.directPath || '/o1/v/t24/newsletter-video',
                        caption: String((message as { caption?: unknown }).caption || ''),
                        fileSha256: Buffer.from('video-sha')
                    }
                };
            }

            return {
                imageMessage: {
                    url: uploadResult?.mediaUrl || 'https://mmg.whatsapp.net/newsletter-image',
                    directPath: uploadResult?.directPath || '/o1/v/t24/newsletter-image',
                    caption: String((message as { caption?: unknown }).caption || ''),
                    fileSha256: Buffer.from('image-sha')
                }
            };
        })
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
const useSupabaseAuthState = require('../src/whatsapp/authStore');
const { loadBaileys } = require('../src/whatsapp/baileys');
const DEFAULT_LEASE_TTL_MS = 60_000;

describe('WhatsAppClient', () => {
    let client: any;

    beforeEach(() => {
        jest.clearAllMocks();
        client = WhatsAppClient();
    });

    afterEach(() => {
        client?.stopLeaseRenewal?.();
        client?.clearPresenceOfflineHeartbeat?.();
        if (client?.reconnectTimer) {
            clearTimeout(client.reconnectTimer);
            client.reconnectTimer = null;
        }
        if (client?.pendingReceiptFlushTimer) {
            clearTimeout(client.pendingReceiptFlushTimer);
            client.pendingReceiptFlushTimer = null;
        }
    });

    afterAll(() => {
        for (const tmpFile of newsletterTempFiles) {
            try {
                if (fs.existsSync(tmpFile)) {
                    fs.unlinkSync(tmpFile);
                }
            } catch {
                // ignore temp cleanup failures in tests
            }
        }
        newsletterTempFiles.clear();
    });

    it('should instantiate with default values', () => {
        expect(client).toBeDefined();
        expect(client.status).toBe('disconnected');
        expect(client.instanceId).toBeDefined();
    });

    it('confirms a channel message by fetching newsletter messages', async () => {
        client.socket = {
            newsletterFetchMessages: jest.fn(async () => ({
                tag: 'iq',
                attrs: {},
                content: [
                    {
                        tag: 'message_updates',
                        attrs: {},
                        content: [
                            {
                                tag: 'message',
                                attrs: { message_id: 'newsletter-msg-123', server_id: 'newsletter-msg-123', t: '1770000000' },
                                content: [
                                    {
                                        tag: 'plaintext',
                                        attrs: {},
                                        content: Buffer.from(JSON.stringify({ imageMessage: { caption: 'Published image' } }))
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }))
        };

        const result = await client.confirmNewsletterMessage(
            '120363406955649221@newsletter',
            'newsletter-msg-123',
            { timeoutMs: 1000, pollMs: 100 }
        );

        expect(result).toEqual({ ok: true, via: 'fetch', status: 2, statusLabel: 'published' });
        await expect(client.fetchNewsletterMessages('120363406955649221@newsletter', { count: 1 })).resolves.toMatchObject({
            ok: true,
            messages: [
                {
                    id: 'newsletter-msg-123',
                    serverId: 'newsletter-msg-123',
                    hasImage: true,
                    hasVideo: false,
                    hasText: true,
                    caption: 'Published image'
                }
            ]
        });
        expect(client.socket.newsletterFetchMessages).toHaveBeenCalledWith(
            '120363406955649221@newsletter',
            10,
            undefined,
            undefined
        );
    });

    it('reports unsupported channel fetch verification when Baileys lacks the API', async () => {
        client.socket = {};

        await expect(
            client.confirmNewsletterMessage('120363406955649221@newsletter', 'newsletter-msg-123', {
                timeoutMs: 1000,
                pollMs: 100
            })
        ).resolves.toMatchObject({
            ok: false,
            via: 'none',
            unsupported: true,
            error: 'Baileys newsletterFetchMessages is not available'
        });
    });

    it('times out channel fetch verification instead of hanging the route', async () => {
        client.socket = {
            newsletterFetchMessages: jest.fn(() => new Promise(() => {}))
        };

        await expect(
            client.fetchNewsletterMessages('120363406955649221@newsletter', {
                count: 1,
                timeoutMs: 50
            })
        ).resolves.toMatchObject({
            ok: false,
            messages: [],
            error: 'Timed out fetching channel messages'
        });
    });

    it('should lazily initialize the auth store during connect', async () => {
        await client.connect();

        expect(useSupabaseAuthState).toHaveBeenCalled();
        expect(client.authStore).toBeTruthy();
    });

    it('should force-acquire a still-valid lease when auto-takeover is enabled', async () => {
        const originalAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
        process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = 'true';

        const acquireLease = jest.fn(async () => ({
            ok: false,
            supported: true,
            ownerId: 'old-render-instance',
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        }));
        const forceAcquireLease = jest.fn(async () => ({
            ok: true,
            supported: true,
            ownerId: 'new-render-instance',
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        const updateStatus = jest.fn(async () => {});
        const renewLease = jest.fn(async () => ({ ok: true, supported: true, ownerId: 'new-render-instance' }));

        (useSupabaseAuthState as any).mockResolvedValueOnce({
            state: {},
            saveCreds: jest.fn(),
            clearState: jest.fn(),
            updateStatus,
            acquireLease,
            forceAcquireLease,
            renewLease
        });

        try {
            await client.connect();

            expect(acquireLease as any).toHaveBeenCalledWith(client.instanceId, DEFAULT_LEASE_TTL_MS);
            expect(forceAcquireLease as any).toHaveBeenCalledWith(client.instanceId, DEFAULT_LEASE_TTL_MS);
            expect(client.leaseHeld).toBe(true);
            expect(client.leaseOwnerId).toBe('new-render-instance');
            expect(client.status).not.toBe('conflict');
            expect(updateStatus as any).not.toHaveBeenCalledWith('conflict');
        } finally {
            client.stopLeaseRenewal();
            if (originalAutoTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = originalAutoTakeover;
            }
        }
    });

    it('should allow a fresh deploy handoff takeover before the instance has connected', async () => {
        const originalAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
        const originalDeployTakeover = process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER;
        process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = 'false';
        process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER = 'true';
        client.hasConnectedOnce = false;

        const acquireLease = jest.fn(async () => ({
            ok: false,
            supported: true,
            ownerId: 'previous-render-instance',
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        const forceAcquireLease = jest.fn(async () => ({
            ok: true,
            supported: true,
            ownerId: 'new-render-instance',
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        const updateStatus = jest.fn(async () => {});
        const renewLease = jest.fn(async () => ({ ok: true, supported: true, ownerId: 'new-render-instance' }));

        (useSupabaseAuthState as any).mockResolvedValueOnce({
            state: {},
            saveCreds: jest.fn(),
            clearState: jest.fn(),
            updateStatus,
            acquireLease,
            forceAcquireLease,
            renewLease
        });

        try {
            await client.connect();

            expect(acquireLease as any).toHaveBeenCalledWith(client.instanceId, DEFAULT_LEASE_TTL_MS);
            expect(forceAcquireLease as any).toHaveBeenCalledWith(client.instanceId, DEFAULT_LEASE_TTL_MS);
            expect(client.leaseHeld).toBe(true);
            expect(client.leaseOwnerId).toBe('new-render-instance');
            expect(client.status).not.toBe('conflict');
        } finally {
            client.stopLeaseRenewal();
            if (originalAutoTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = originalAutoTakeover;
            }
            if (originalDeployTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER = originalDeployTakeover;
            }
        }
    });

    it('should not use deploy handoff takeover after the instance has already connected', async () => {
        const originalAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
        const originalDeployTakeover = process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER;
        process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = 'false';
        process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER = 'true';
        client.hasConnectedOnce = true;

        const acquireLease = jest.fn(async () => ({
            ok: false,
            supported: true,
            ownerId: 'new-render-instance',
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        const forceAcquireLease = jest.fn(async () => ({
            ok: true,
            supported: true,
            ownerId: 'old-render-instance',
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        const updateStatus = jest.fn(async () => {});

        (useSupabaseAuthState as any).mockResolvedValueOnce({
            state: {},
            saveCreds: jest.fn(),
            clearState: jest.fn(),
            updateStatus,
            acquireLease,
            forceAcquireLease,
            renewLease: jest.fn()
        });

        try {
            await client.connect();

            expect(acquireLease as any).toHaveBeenCalledWith(client.instanceId, DEFAULT_LEASE_TTL_MS);
            expect(forceAcquireLease as any).not.toHaveBeenCalled();
            expect(client.leaseHeld).toBe(false);
            expect(client.leaseOwnerId).toBe('new-render-instance');
            expect(client.status).toBe('conflict');
        } finally {
            client.stopLeaseRenewal();
            if (client.reconnectTimer) {
                clearTimeout(client.reconnectTimer);
                client.reconnectTimer = null;
            }
            if (originalAutoTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = originalAutoTakeover;
            }
            if (originalDeployTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_DEPLOY_TAKEOVER = originalDeployTakeover;
            }
        }
    });

    it('should not auto-take back a lease after this instance already lost it', async () => {
        const originalAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
        process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = 'true';
        client.leaseLostToAnotherOwner = true;

        const acquireLease = jest.fn(async () => ({
            ok: false,
            supported: true,
            ownerId: 'new-render-instance',
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        }));
        const forceAcquireLease = jest.fn(async () => ({
            ok: true,
            supported: true,
            ownerId: 'old-render-instance',
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        const updateStatus = jest.fn(async () => {});

        (useSupabaseAuthState as any).mockResolvedValueOnce({
            state: {},
            saveCreds: jest.fn(),
            clearState: jest.fn(),
            updateStatus,
            acquireLease,
            forceAcquireLease,
            renewLease: jest.fn()
        });

        try {
            await client.connect();

            expect(acquireLease as any).toHaveBeenCalledWith(client.instanceId, DEFAULT_LEASE_TTL_MS);
            expect(forceAcquireLease as any).not.toHaveBeenCalled();
            expect(client.leaseHeld).toBe(false);
            expect(client.leaseOwnerId).toBe('new-render-instance');
            expect(client.status).toBe('conflict');
            expect(updateStatus as any).not.toHaveBeenCalledWith('conflict');
        } finally {
            client.stopLeaseRenewal();
            if (client.reconnectTimer) {
                clearTimeout(client.reconnectTimer);
                client.reconnectTimer = null;
            }
            if (originalAutoTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = originalAutoTakeover;
            }
        }
    });

    it('should reject background takeover after this instance already lost its lease', async () => {
        const originalAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
        process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = 'true';
        client.leaseLostToAnotherOwner = true;
        client.isPaused = false;
        const forceAcquireLease = jest.fn(async () => ({
            ok: true,
            supported: true,
            ownerId: client.instanceId,
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        client.authStore = {
            forceAcquireLease
        };

        try {
            const lease = await client.takeoverLease();

            expect(forceAcquireLease as any).not.toHaveBeenCalled();
            expect(lease.ok).toBe(false);
            expect(lease.reason).toBe('lost_lease_to_another_owner');
        } finally {
            if (originalAutoTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = originalAutoTakeover;
            }
        }
    });

    it('should not force-acquire in background when auto-takeover is disabled', async () => {
        const originalAutoTakeover = process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
        process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = 'false';

        const forceAcquireLease = jest.fn(async () => ({
            ok: true,
            supported: true,
            ownerId: client.instanceId,
            expiresAt: new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString()
        }));
        client.authStore = {
            forceAcquireLease
        };
        client.leaseOwnerId = 'existing-render-instance';
        client.leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString();

        try {
            const lease = await client.takeoverLease();

            expect(forceAcquireLease as any).not.toHaveBeenCalled();
            expect(lease.ok).toBe(false);
            expect(lease.reason).toBe('auto_takeover_disabled');
            expect(lease.ownerId).toBe('existing-render-instance');
        } finally {
            if (originalAutoTakeover === undefined) {
                delete process.env.WHATSAPP_LEASE_AUTO_TAKEOVER;
            } else {
                process.env.WHATSAPP_LEASE_AUTO_TAKEOVER = originalAutoTakeover;
            }
        }
    });

    it('should not overwrite global status when an old instance loses its lease', async () => {
        const updateStatus = jest.fn(async () => {});
        const renewLease = jest.fn(async () => ({
            ok: false,
            supported: true,
            ownerId: 'new-render-instance',
            expiresAt: new Date(Date.now() + 90_000).toISOString()
        }));
        const socketEnd = jest.fn();
        client.authStore = {
            updateStatus,
            renewLease
        };
        client.leaseSupported = true;
        client.leaseHeld = true;
        client.leaseOwnerId = client.instanceId;
        client.status = 'qr_ready';
        client.socket = { end: socketEnd };
        client.cleanupSocket = jest.fn();
        client.scheduleReconnect = jest.fn();

        client.startLeaseRenewal(90_000);
        await new Promise((resolve) => setImmediate(resolve));

        expect(renewLease as any).toHaveBeenCalledWith(client.instanceId, 90_000);
        expect(client.status).toBe('conflict');
        expect(client.leaseLostToAnotherOwner).toBe(true);
        expect(updateStatus as any).not.toHaveBeenCalledWith('conflict');
        expect(socketEnd).toHaveBeenCalled();
        expect(client.scheduleReconnect).toHaveBeenCalledWith(15000);
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

    it('should leave newsletter media direct paths unchanged unless explicitly enabled', () => {
        const originalFlag = process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH;
        const originalAliasFlag = process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH;
        delete process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH;
        delete process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH;

        const message: any = {
            imageMessage: {
                directPath: '/o1/v/t24/example-image',
                thumbnailDirectPath: '/o1/v/t24/example-thumb',
                url: 'https://mmg.whatsapp.net/o1/v/t24/example-image'
            }
        };

        const patched = WhatsAppClient.patchNewsletterMediaDirectPaths(message);

        expect(patched.imageMessage.directPath).toBe('/o1/v/t24/example-image');
        expect(patched.imageMessage.thumbnailDirectPath).toBe('/o1/v/t24/example-thumb');
        expect(patched.imageMessage.url).toBe('https://mmg.whatsapp.net/o1/v/t24/example-image');

        if (originalFlag === undefined) {
            delete process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH;
        } else {
            process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH = originalFlag;
        }
        if (originalAliasFlag === undefined) {
            delete process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH;
        } else {
            process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH = originalAliasFlag;
        }
    });

    it('can patch newsletter media direct paths from /o1/ to /m1/ when forced', () => {
        const message: any = {
            imageMessage: {
                directPath: '/o1/v/t24/example-image',
                thumbnailDirectPath: '/o1/v/t24/example-thumb',
                url: 'https://mmg.whatsapp.net/o1/v/t24/example-image'
            }
        };

        const patched = WhatsAppClient.patchNewsletterMediaDirectPaths(message, { force: true });

        expect(patched.imageMessage.directPath).toBe('/m1/v/t24/example-image');
        expect(patched.imageMessage.thumbnailDirectPath).toBe('/m1/v/t24/example-thumb');
        expect(patched.imageMessage.url).toBe('https://mmg.whatsapp.net/m1/v/t24/example-image');
    });

    it('can enable newsletter media direct path patch with the Baileys alias flag', () => {
        const originalFlag = process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH;
        const originalAliasFlag = process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH;
        delete process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH;
        process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH = '1';

        const message: any = {
            imageMessage: {
                directPath: '/o1/v/t24/example-image'
            }
        };

        const patched = WhatsAppClient.patchNewsletterMediaDirectPaths(message);
        expect(patched.imageMessage.directPath).toBe('/m1/v/t24/example-image');

        if (originalFlag === undefined) {
            delete process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH;
        } else {
            process.env.WHATSAPP_NEWSLETTER_MEDIA_DIRECT_PATH_PATCH = originalFlag;
        }
        if (originalAliasFlag === undefined) {
            delete process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH;
        } else {
            process.env.BAILEYS_NEWSLETTER_MEDIA_PATCH = originalAliasFlag;
        }
    });

    it('warms group metadata only for the explicit unsafe group-backed status audience override', async () => {
        const originalInclude = process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
        const originalAllow = process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
        process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = 'true';
        process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = 'unsafe';

        const groupFetchAllParticipating: any = jest.fn(async () => ({
            '120363407220244757@g.us': {
                id: '120363407220244757@g.us',
                subject: 'Test',
                size: 3,
                participants: [
                    { id: '16465527019@s.whatsapp.net' },
                    { id: '19144477725@s.whatsapp.net' },
                    { id: '15551234567@s.whatsapp.net' }
                ]
            }
        }));

        client.socket = {
            user: { id: '16465527019:55@s.whatsapp.net' },
            groupFetchAllParticipating
        };
        client.meJid = '16465527019:55@s.whatsapp.net';

        try {
            const audience = await client.getStatusAudience({ sampleSize: 10 });

            expect(groupFetchAllParticipating).toHaveBeenCalled();
            expect(audience.participantCount).toBe(2);
            expect(audience.sample).toEqual(['15551234567@s.whatsapp.net', '19144477725@s.whatsapp.net']);
            expect(audience.sources.groupMetadata).toBe(2);
            expect(audience.warnings).not.toContain(
                'Group participants are not used as Status recipients because WhatsApp Status needs explicit/private recipients.'
            );
        } finally {
            if (originalInclude === undefined) {
                delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
            } else {
                process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = originalInclude;
            }
            if (originalAllow === undefined) {
                delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
            } else {
                process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = originalAllow;
            }
        }
    });

    it('does not use group metadata for status audience when the unsafe override is absent', async () => {
        const originalInclude = process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
        const originalAllow = process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
        process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = 'true';
        delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;

        const groupFetchAllParticipating: any = jest.fn(async () => ({
            '120363407220244757@g.us': {
                id: '120363407220244757@g.us',
                subject: 'Test',
                size: 2,
                participants: [
                    { id: '16465527019@s.whatsapp.net' },
                    { id: '19144477725@s.whatsapp.net' }
                ]
            }
        }));

        client.socket = {
            user: { id: '16465527019:55@s.whatsapp.net' },
            groupFetchAllParticipating
        };
        client.meJid = '16465527019:55@s.whatsapp.net';

        try {
            const audience = await client.getStatusAudience({ sampleSize: 10 });

            expect(groupFetchAllParticipating).not.toHaveBeenCalled();
            expect(audience.participantCount).toBe(0);
            expect(audience.sources.groupMetadata).toBe(0);
        } finally {
            if (originalInclude === undefined) {
                delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
            } else {
                process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = originalInclude;
            }
            if (originalAllow === undefined) {
                delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
            } else {
                process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = originalAllow;
            }
        }
    });

    it('uses group metadata for status audience when the caller explicitly enables it', async () => {
        const originalInclude = process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
        const originalAllow = process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
        delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
        delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;

        const groupFetchAllParticipating: any = jest.fn(async () => ({
            '120363407220244757@g.us': {
                id: '120363407220244757@g.us',
                subject: 'Test',
                size: 2,
                participants: [
                    { id: '16465527019@s.whatsapp.net' },
                    { id: '19144477725@s.whatsapp.net' }
                ]
            }
        }));

        client.socket = {
            user: { id: '16465527019:55@s.whatsapp.net' },
            groupFetchAllParticipating
        };
        client.meJid = '16465527019:55@s.whatsapp.net';

        try {
            const audience = await client.getStatusAudience({ sampleSize: 10, includeGroupParticipants: true } as any);

            expect(groupFetchAllParticipating).toHaveBeenCalled();
            expect(audience.sample).toEqual(['19144477725@s.whatsapp.net']);
            expect(audience.sources.groupMetadata).toBe(1);
        } finally {
            if (originalInclude === undefined) {
                delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
            } else {
                process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = originalInclude;
            }
            if (originalAllow === undefined) {
                delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
            } else {
                process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = originalAllow;
            }
        }
    });

    it('should send newsletter image media with media_id and plaintext mediatype attrs', async () => {
        const originalFetch = global.fetch;
        const sendNode: any = jest.fn(async () => undefined);
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'fallback-newsletter-msg-id' } }));
        const refreshMediaConn: any = jest.fn(async () => ({
            hosts: [{ hostname: 'upload.whatsapp.test' }],
            auth: 'auth-token'
        }));

        global.fetch = jest.fn(async (_input: any, init?: any) => {
            const requestUrl = String(_input);
            expect(requestUrl).toContain('/newsletter/newsletter-image/');
            expect(requestUrl).toContain('server_thumb_gen=1');
            expect(requestUrl).not.toContain('server_transcode=1');
            const body = init?.body;
            if (body && typeof body.on === 'function') {
                await new Promise<void>((resolve, reject) => {
                    body.on('error', reject);
                    body.on('data', () => undefined);
                    body.on('end', resolve);
                });
            }

            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    url: 'https://mmg.whatsapp.net/newsletter-image',
                    direct_path: '/o1/v/t24/newsletter-image',
                    handle: 'newsletter-media-handle-123',
                    thumbnail_info: {
                        thumbnail_direct_path: '/o1/v/t24/newsletter-thumb',
                        thumbnail_sha256: Buffer.from('thumbnail-sha').toString('base64')
                    }
                })
            };
        }) as any;

        client.socket = {
            sendNode,
            sendMessage,
            refreshMediaConn,
            user: { id: '16465527019:54@s.whatsapp.net' }
        };

        const result = await client.sendMessage('120363401649232180@newsletter', {
            image: Buffer.from('fake-image'),
            caption: 'newsletter caption',
            mimetype: 'image/jpeg'
        });

        expect(refreshMediaConn).toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(sendNode).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: 'message',
                attrs: expect.objectContaining({
                    to: '120363401649232180@newsletter',
                    id: 'newsletter-msg-id',
                    type: 'media',
                    media_id: 'newsletter-media-handle-123'
                }),
                content: [
                    expect.objectContaining({
                        tag: 'plaintext',
                        attrs: { mediatype: 'image' },
                        content: expect.any(Buffer)
                    })
                ]
            })
        );
        const sentPayload = JSON.parse(String(sendNode.mock.calls[0][0].content[0].content));
        expect(sentPayload.imageMessage.directPath).toBe('/m1/v/t24/newsletter-image');
        expect(sentPayload.imageMessage.thumbnailDirectPath).toBe('/m1/v/t24/newsletter-thumb');
        expect(sentPayload.imageMessage.thumbnailSha256).toBeDefined();
        expect(sentPayload.imageMessage.fileEncSha256).toBeDefined();
        expect(sentPayload.imageMessage.url).toBeUndefined();
        expect(result?.key?.id).toBe('newsletter-msg-id');

        global.fetch = originalFetch;
    });

    it('should request newsletter video uploads with transcode enabled', async () => {
        const originalFetch = global.fetch;
        const sendNode: any = jest.fn(async () => undefined);

        global.fetch = jest.fn(async (_input: any, init?: any) => {
            const requestUrl = String(_input);
            expect(requestUrl).toContain('/newsletter/newsletter-video/');
            expect(requestUrl).toContain('server_thumb_gen=1');
            expect(requestUrl).toContain('server_transcode=1');
            const body = init?.body;
            if (body && typeof body.on === 'function') {
                await new Promise<void>((resolve, reject) => {
                    body.on('error', reject);
                    body.on('data', () => undefined);
                    body.on('end', resolve);
                });
            }
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    url: 'https://mmg.whatsapp.net/newsletter-video',
                    direct_path: '/o1/v/t24/newsletter-video',
                    handle: 'newsletter-video-handle-123'
                })
            };
        }) as any;

        client.socket = {
            sendNode,
            sendMessage: jest.fn(async () => ({ key: { id: 'fallback-newsletter-msg-id' } })),
            refreshMediaConn: jest.fn(async () => ({
                hosts: [{ hostname: 'upload.whatsapp.test' }],
                auth: 'auth-token'
            })),
            user: { id: '16465527019:54@s.whatsapp.net' }
        };

        await client.sendMessage('120363401649232180@newsletter', {
            video: Buffer.from('fake-video'),
            caption: 'newsletter video caption',
            mimetype: 'video/mp4'
        });

        global.fetch = originalFetch;
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

    it('should resolve status audience from trusted cache/store contacts without counting own jid as a viewer', async () => {
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
        expect(audience.participantCount).toBeGreaterThanOrEqual(3);
        expect(audience.sample).toContain('972501234567@s.whatsapp.net');
        expect(audience.sample).not.toContain('972506666666@s.whatsapp.net');
        expect(audience.selfJid).toBe('972506666666@s.whatsapp.net');
        expect(audience.sample).not.toContain('972509999999@s.whatsapp.net');
        expect(audience.warnings.some((warning: string) => warning.includes('Group participants are not used'))).toBe(true);
    });

    it('should ignore group participants for status audience unless explicitly enabled', async () => {
        client.groupMetadataCache.set('120363000000000000@g.us', {
            participants: [
                { id: '103140015788103@lid', pn: '972501234567@s.whatsapp.net' },
                { id: '103140015788104@lid', phoneNumber: '+1 (646) 555-0100' }
            ]
        });
        client.socket = {
            user: { id: '972506666666@s.whatsapp.net' }
        };

        const audience = await client.getStatusAudience({ sampleSize: 20 });

        expect(audience.sample).toEqual([]);
        expect(audience.sources.groupMetadata).toBe(0);
        expect(audience.warnings.some((warning: string) => warning.includes('Group participants are not used'))).toBe(true);
    });

    it('should not use implicit group LIDs for status audience by default', async () => {
        const getPNForLID: any = jest.fn(async (lid: string) => (
            lid === '103140015788103@lid' ? '972501234567@s.whatsapp.net' : null
        ));
        client.groupMetadataCache.set('120363000000000000@g.us', {
            participants: [
                { id: '103140015788103@lid' },
                { id: '103140015788104@lid' }
            ]
        });
        client.socket = {
            user: { id: '972506666666@s.whatsapp.net' },
            signalRepository: {
                lidMapping: { getPNForLID }
            }
        };

        const audience = await client.getStatusAudience({ sampleSize: 20 });

        expect(getPNForLID).not.toHaveBeenCalled();
        expect(audience.sample).toEqual([]);
        expect(audience.sources.lidMappings).toBe(0);
        expect(audience.warnings.some((warning: string) => warning.includes('Group participants are not used'))).toBe(true);
    });

    it('should reject implicit group-only LID status audience without phone mappings', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-lid-only' } }));
        client.groupMetadataCache.set('120363000000000000@g.us', {
            participants: [
                { id: '103140015788103@lid' },
                { id: '103140015788104@lid' }
            ]
        });
        client.socket = {
            sendMessage,
            user: { id: '972506666666@s.whatsapp.net' }
        };

        await expect(client.sendStatusBroadcast({ text: 'hello' }))
            .rejects
            .toThrow('No Status viewers could be resolved');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('marks Baileys crypto/session mismatch errors as outbound-blocking without clearing auth immediately', () => {
        expect(client.isAuthStateCorrupted('Bad MAC')).toBe(false);
        expect(client.isRecoverableSessionCryptoError('Bad MAC')).toBe(true);
        expect(client.isRecoverableSessionCryptoError('No matching sessions found for message')).toBe(true);

        client.scheduleReconnect = jest.fn();
        client.markSessionUnhealthy(new Error('Bad MAC'));

        expect(client.isAuthCorrupted).toBe(true);
        expect(client.status).toBe('error');
        expect(client.lastError).toContain('WhatsApp session key mismatch');
        expect(client.scheduleReconnect).toHaveBeenCalledWith(5000);
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

    it('should include the sender account in status delivery by default', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-self' } }));
        client.socket = {
            sendMessage,
            user: { id: '16465527019:58@s.whatsapp.net' }
        };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            { statusJidList: ['19144477725@s.whatsapp.net'] }
        );

        const sentOptions = sendMessage.mock.calls[0]?.[2];
        expect(sentOptions.statusJidList).toEqual([
            '19144477725@s.whatsapp.net',
            '16465527019@s.whatsapp.net'
        ]);
        expect(sentOptions).not.toHaveProperty('includeSender');
        expect(sentOptions).not.toHaveProperty('includeSelf');
    });

    it('should include all known sender identities in status delivery by default', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-self-lid' } }));
        client.socket = {
            sendMessage,
            user: {
                id: '16465527019:58@s.whatsapp.net',
                lid: '123456789012345@lid'
            }
        };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            { statusJidList: ['19144477725@s.whatsapp.net'] }
        );

        const sentOptions = sendMessage.mock.calls[0]?.[2];
        expect(sentOptions.statusJidList).toEqual([
            '19144477725@s.whatsapp.net',
            '16465527019@s.whatsapp.net',
            '123456789012345@lid'
        ]);
    });

    it('should allow sender account status delivery to be disabled explicitly', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-no-self' } }));
        client.socket = {
            sendMessage,
            user: { id: '16465527019:58@s.whatsapp.net', lid: '123456789012345@lid' }
        };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            {
                statusJidList: ['19144477725@s.whatsapp.net'],
                includeSender: false
            }
        );

        const sentOptions = sendMessage.mock.calls[0]?.[2];
        expect(sentOptions.statusJidList).toEqual(['19144477725@s.whatsapp.net']);
        expect(sentOptions).not.toHaveProperty('includeSender');
    });

    it('should prefer phone-number recipients over @lid recipients in mixed explicit statusJidList values', async () => {
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
                statusJidList: ['972501234567@s.whatsapp.net']
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

    it('should strip text-only status styling options from media status sends', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-5' } }));
        client.socket = { sendMessage };

        await client.sendStatusBroadcast(
            { image: Buffer.from('fake-image'), caption: 'hello', mimetype: 'image/jpeg' } as any,
            {
                statusJidList: ['972501234567@s.whatsapp.net'],
                backgroundColor: '#112233',
                font: 3
            }
        );

        const sentOptions = sendMessage.mock.calls[0]?.[2];
        expect(sendMessage).toHaveBeenCalledWith(
            'status@broadcast',
            expect.objectContaining({
                image: expect.any(Buffer),
                caption: 'hello',
                mimetype: 'image/jpeg'
            }),
            expect.objectContaining({
                broadcast: true,
                statusJidList: ['972501234567@s.whatsapp.net']
            })
        );
        expect(sentOptions).not.toHaveProperty('backgroundColor');
        expect(sentOptions).not.toHaveProperty('font');
    });

    it('should preserve text-only status styling options for text status sends', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'msg-6' } }));
        client.socket = { sendMessage };

        await client.sendStatusBroadcast(
            { text: 'hello' },
            {
                statusJidList: ['972501234567@s.whatsapp.net'],
                backgroundColor: '#112233',
                font: 3
            }
        );

        expect(sendMessage).toHaveBeenCalledWith(
            'status@broadcast',
            { text: 'hello' },
            expect.objectContaining({
                broadcast: true,
                statusJidList: ['972501234567@s.whatsapp.net'],
                backgroundColor: '#112233',
                font: 3
            })
        );
    });

    it('should edit media messages with structured content payloads', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'edit-msg-1' } }));
        client.socket = { sendMessage };

        await client.editMessage('120363000000000010@g.us', 'msg-123', {
            image: Buffer.from('fake-image'),
            caption: 'updated caption',
            mimetype: 'image/jpeg'
        });

        expect(sendMessage).toHaveBeenCalledWith(
            '120363000000000010@g.us',
            expect.objectContaining({
                image: expect.any(Buffer),
                caption: 'updated caption',
                mimetype: 'image/jpeg',
                edit: expect.objectContaining({
                    remoteJid: '120363000000000010@g.us',
                    id: 'msg-123',
                    fromMe: true
                })
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
            .toThrow('No Status viewers could be resolved');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should add ephemeralExpiration for disappearing groups by default', async () => {
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
            { ephemeralExpiration: 86400, useUserDevicesCache: false }
        );
        expect(groupMetadata).toHaveBeenCalled();
    });

    it('should not add ephemeralExpiration for groups without disappearing mode', async () => {
        const sendMessage: any = jest.fn(async (..._args: any[]) => ({ key: { id: 'group-msg-2' } }));
        const groupMetadata: any = jest.fn(async () => ({
            id: '120363000000000011@g.us',
            subject: 'Plain Group',
            size: 2,
            ephemeralDuration: 0,
            participants: []
        }));

        client.socket = { sendMessage, groupMetadata };

        await client.sendMessage('120363000000000011@g.us', { text: 'plain group' });

        expect(sendMessage).toHaveBeenCalledWith(
            '120363000000000011@g.us',
            { text: 'plain group' },
            { useUserDevicesCache: false }
        );
    });

    it('should add ephemeralExpiration for private chats when the store proves disappearing mode', async () => {
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
            { ephemeralExpiration: 604800 }
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

    it('should treat local upsert as a recorded send when ack is absent', async () => {
        client.waitForMessage = jest.fn(async () => ({ key: { id: 'msg-local-only' } }));
        client.waitForMessageStatus = jest.fn(async () => null);

        const result = await client.confirmSend('msg-local-only', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10
        });

        expect(result).toEqual({ ok: true, via: 'upsert', status: 1, statusLabel: 'pending' });
        expect(client.waitForMessageStatus).not.toHaveBeenCalled();
    });

    it('should use a failure grace window before accepting local channel text upserts', async () => {
        client.waitForMessage = jest.fn(async () => ({ key: { id: 'msg-local-failed' } }));
        client.waitForMessageStatus = jest.fn(async () => null);
        client.waitForMessageFailure = jest.fn(async () => ({
            messageId: 'msg-local-failed',
            errorCode: '479',
            errorMessage: 'WhatsApp server rejected message ack 479',
            remoteJid: '120363401649232180@newsletter',
            updatedAtMs: Date.now()
        }));

        const result = await client.confirmSend('msg-local-failed', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10,
            failureGraceMs: 10
        });

        expect(result).toEqual({
            ok: false,
            via: 'none',
            error: 'WhatsApp server rejected message ack 479'
        });
        expect(client.waitForMessageStatus).toHaveBeenCalledWith('msg-local-failed', 2, 10);
    });

    it('should let a later server ack override an early ack error during the grace window', async () => {
        client.waitForMessage = jest.fn(async () => null);
        client.waitForMessageStatus = jest.fn(async () => ({
            status: 3,
            statusLabel: 'delivered',
            remoteJid: 'status@broadcast',
            updatedAtMs: Date.now()
        }));
        client.waitForMessageFailure = jest.fn(async () => ({
            messageId: 'msg-status-eventual-ack',
            errorCode: '479',
            errorMessage: 'WhatsApp server rejected message ack 479',
            remoteJid: '103140015788103:59@lid',
            updatedAtMs: Date.now()
        }));

        const result = await client.confirmSend('msg-status-eventual-ack', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10,
            failureGraceMs: 10
        });

        expect(result).toEqual({
            ok: true,
            via: 'ack',
            status: 3,
            statusLabel: 'delivered'
        });
    });

    it('should not treat pending status as a confirmed send', async () => {
        client.waitForMessage = jest.fn(async () => null);
        client.waitForMessageStatus = jest.fn(async () => null);
        client.recentMessageStatuses.set('msg-pending', {
            status: 1,
            statusLabel: 'pending',
            remoteJid: '120363401649232180@newsletter',
            updatedAtMs: Date.now()
        });

        const result = await client.confirmSend('msg-pending', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10
        });

        expect(result).toEqual({ ok: false, via: 'none', error: null });
        expect(client.waitForMessageStatus).toHaveBeenCalledWith('msg-pending', 2, 10);
    });

    it('should not accept local upsert when server ack is required', async () => {
        client.waitForMessage = jest.fn(async () => ({ key: { id: 'msg-local-only' } }));
        client.waitForMessageStatus = jest.fn(async () => null);

        const result = await client.confirmSend('msg-local-only', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10,
            requireServerAck: true
        });

        expect(result).toEqual({
            ok: false,
            via: 'upsert',
            status: 1,
            statusLabel: 'pending',
            error: 'Server ack not observed'
        });
        expect(client.waitForMessageStatus).toHaveBeenCalledWith('msg-local-only', 2, 10);
    });

    it('should fail confirmation when Baileys reports an ack error', async () => {
        const baileysLogger = client.createBaileysLogger();
        client.waitForMessage = jest.fn(async () => ({ key: { id: 'msg-ack-error' } }));
        client.waitForMessageStatus = jest.fn(async () => null);

        baileysLogger.warn(
            { node: { attrs: { class: 'message', from: '120363401649232180@newsletter', id: 'msg-ack-error', error: '479' } } },
            'received error in ack'
        );

        const result = await client.confirmSend('msg-ack-error', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10,
            requireServerAck: true
        });

        expect(result).toEqual({
            ok: false,
            via: 'none',
            error: 'WhatsApp server rejected message ack 479'
        });
    });

    it('should let a later server ack override a cached ack error during the grace window', async () => {
        const baileysLogger = client.createBaileysLogger();
        client.waitForMessage = jest.fn(async () => ({ key: { id: 'msg-cached-ack-error' } }));
        client.waitForMessageStatus = jest.fn(async () => ({
            status: 3,
            statusLabel: 'delivered',
            remoteJid: 'status@broadcast',
            updatedAtMs: Date.now()
        }));

        baileysLogger.warn(
            { node: { attrs: { class: 'message', from: 'status@broadcast', id: 'msg-cached-ack-error', error: '479' } } },
            'received error in ack'
        );

        const result = await client.confirmSend('msg-cached-ack-error', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10,
            requireServerAck: true,
            failureGraceMs: 10
        });

        expect(result).toEqual({
            ok: true,
            via: 'ack',
            status: 3,
            statusLabel: 'delivered'
        });
        expect(client.waitForMessageStatus).toHaveBeenCalledWith('msg-cached-ack-error', 2, 10);
    });

    it('should not close the session for a Baileys log-only incoming decrypt miss', () => {
        const baileysLogger = client.createBaileysLogger();
        client.markSessionUnhealthy = jest.fn();

        baileysLogger.error(
            {
                key: {
                    remoteJid: '42198154350791@lid',
                    remoteJidAlt: '13474227704@s.whatsapp.net',
                    fromMe: false,
                    id: 'incoming-1',
                    addressingMode: 'lid'
                },
                err: new Error('No matching sessions found for message'),
                messageType: 'msg',
                sender: '42198154350791@lid',
                author: '42198154350791@lid',
                isSessionRecordError: false
            },
            'failed to decrypt message'
        );

        expect(client.markSessionUnhealthy).not.toHaveBeenCalled();
        expect(client.status).toBe('disconnected');
        expect(client.isAuthCorrupted).toBe(false);
    });

    it('should require server ack or better before confirming a send', async () => {
        client.waitForMessage = jest.fn(async () => null);
        client.waitForMessageStatus = jest.fn(async () => ({
            status: 2,
            statusLabel: 'server',
            remoteJid: '120363401649232180@newsletter',
            updatedAtMs: Date.now()
        }));

        const result = await client.confirmSend('msg-server-ack', {
            upsertTimeoutMs: 10,
            ackTimeoutMs: 10
        });

        expect(result).toEqual({
            ok: true,
            via: 'ack',
            status: 2,
            statusLabel: 'server'
        });
    });

    it('should mark auth corruption unhealthy without clearing auth state automatically', async () => {
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

        expect(clearState).not.toHaveBeenCalled();
        expect((updateStatus as any).mock.calls[0]?.[0]).toBe('error');
        expect(client.scheduleReconnect).toHaveBeenCalledWith(5000);
        expect(client.isAuthCorrupted).toBe(true);
        expect(client.lastError).toContain('WhatsApp session key mismatch');
    });

    it('should discard a rejected unregistered QR pairing attempt and generate a fresh QR', async () => {
        const clearState = jest.fn(async () => {});
        const updateStatus = jest.fn(async () => {});
        const socketEnd = jest.fn();
        client.authStore = {
            ...client.authStore,
            clearState,
            updateStatus
        };

        client.status = 'qr';
        client.qrCode = 'data:image/png;base64,active';
        client.qrGeneratedAtMs = Date.now();
        client.qrExpiresAtMs = Date.now() + 30_000;
        client.hasConnectedOnce = false;
        client.lastSeenAt = null;
        client.meJid = null;
        client.socket = { end: socketEnd };
        client.scheduleReconnect = jest.fn();
        client.cleanupSocket = jest.fn();

        await client.handleCorruptedAuthState(new Error('Invalid account signature'));

        expect(clearState).toHaveBeenCalled();
        expect(updateStatus as any).toHaveBeenCalledWith('disconnected', null);
        expect(client.cleanupSocket).toHaveBeenCalled();
        expect(socketEnd).toHaveBeenCalled();
        expect(client.socket).toBeNull();
        expect(client.isAuthCorrupted).toBe(false);
        expect(client.lastError).toContain('QR was rejected');
        expect(client.scheduleReconnect).toHaveBeenCalledWith(1000);
    });

    it('should preserve linked credentials on a post-login 405 connection close', async () => {
        const clearState = jest.fn(async () => {});
        const updateStatus = jest.fn(async () => {});
        const saveCreds = jest.fn(async () => {});
        let connectionHandler: ((update: unknown) => Promise<void>) | null = null;
        const socket = {
            ev: {
                on: jest.fn((event: string, handler: (update: unknown) => Promise<void>) => {
                    if (event === 'connection.update') connectionHandler = handler;
                }),
                removeAllListeners: jest.fn()
            },
            end: jest.fn(),
            user: null
        };

        (useSupabaseAuthState as any).mockResolvedValueOnce({
            state: {
                creds: {
                    registered: true,
                    me: { id: '16465527019:39@s.whatsapp.net' }
                }
            },
            saveCreds,
            clearState,
            updateStatus,
            acquireLease: jest.fn(async () => ({ ok: true, supported: true, ownerId: client.instanceId, expiresAt: 'future' })),
            renewLease: jest.fn(async () => ({ ok: true, supported: true, ownerId: client.instanceId }))
        });
        (loadBaileys as any).mockResolvedValueOnce({
            makeWASocket: jest.fn(() => socket),
            DisconnectReason: { loggedOut: 401, restartRequired: 415 },
            fetchLatestWaWebVersion: jest.fn(async () => ({ version: [2, 24, 1] })),
            fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 24, 1] })),
            Browsers: { ubuntu: jest.fn((name: string) => ['Ubuntu', name, '22.04.4']) },
            DEFAULT_ORIGIN: 'https://web.whatsapp.com'
        });

        await client.connect();
        client.stopLeaseRenewal();
        client.scheduleReconnect = jest.fn();
        client.hasConnectedOnce = false;
        client.lastSeenAt = null;
        client.meJid = null;

        const handler = connectionHandler as ((update: unknown) => Promise<void>) | null;
        expect(handler).toBeTruthy();
        await handler!({
            connection: 'close',
            lastDisconnect: {
                error: {
                    output: {
                        statusCode: 405,
                        payload: { message: 'Method Not Allowed' }
                    }
                }
            }
        });

        expect(clearState).not.toHaveBeenCalled();
        expect(updateStatus as any).toHaveBeenCalledWith('disconnected', null);
        expect(client.scheduleReconnect).toHaveBeenCalled();
        expect(client.lastError).toContain('linked session was kept');
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

    it('should clear old authenticated identity markers before generating a fresh QR', async () => {
        const clearState = jest.fn(async () => {});
        client.authStore = {
            ...client.authStore,
            clearState
        };
        client.status = 'error';
        client.isAuthCorrupted = true;
        client.hasConnectedOnce = true;
        client.lastSeenAt = new Date();
        client.lastSenderKeyResetAt = Date.now();
        client.lastKeyCacheResetAt = Date.now();
        client.connect = jest.fn(async () => {});

        await client.hardRefresh({ force: true });

        expect(clearState).toHaveBeenCalled();
        expect(client.isAuthCorrupted).toBe(false);
        expect(client.hasConnectedOnce).toBe(false);
        expect(client.lastSeenAt).toBeNull();
        expect(client.lastSenderKeyResetAt).toBeNull();
        expect(client.lastKeyCacheResetAt).toBeNull();
        expect(client.connect).toHaveBeenCalled();
    });

    it('should keep self in the final status delivery audience by default', async () => {
        const sendMessage = jest.fn(async () => ({
            key: { id: 'status-msg-id', remoteJid: 'status@broadcast', fromMe: true },
            message: { imageMessage: { mimetype: 'image/jpeg', caption: 'caption' } }
        }));

        client.socket = {
            sendMessage,
            user: { id: '16465527019:54@s.whatsapp.net' }
        };
        client.meJid = '16465527019:54@s.whatsapp.net';
        client.resolveStatusAudienceWithLidMappings = jest.fn(async () => ({
            participants: ['15551234567@s.whatsapp.net'],
            selfJid: '16465527019@s.whatsapp.net',
            sources: {
                contactsCache: 1,
                storeContacts: 0,
                storeChats: 0,
                groupMetadata: 0,
                env: 0,
                me: 1,
                lidMappings: 0
            },
            warnings: []
        }));

        await client.sendStatusBroadcast(
            { image: Buffer.from('status-image'), mimetype: 'image/jpeg', caption: 'caption' },
            { statusJidList: ['15551234567@s.whatsapp.net'] }
        );

        expect(sendMessage as any).toHaveBeenCalledWith(
            'status@broadcast',
            expect.any(Object),
            expect.objectContaining({
                broadcast: true,
                statusJidList: ['15551234567@s.whatsapp.net', '16465527019@s.whatsapp.net']
            })
        );
    });
});
