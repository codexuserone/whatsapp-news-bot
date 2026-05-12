import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetSupabaseClient: any = jest.fn();
const mockFetchAndProcessFeed: any = jest.fn();
const mockSendQueuedForSchedule: any = jest.fn();
const mockSendPendingForAllSchedules: any = jest.fn();
const mockReconcileUpdatedFeedItems: any = jest.fn();
const mockWithScheduleLock: any = jest.fn();
const mockCleanupStaleLocks: any = jest.fn(async () => 0);
const mockGetSettings: any = jest.fn();
const mockCronSchedule: any = jest.fn(() => ({ stop: jest.fn() }));
const mockCronValidate: any = jest.fn(() => true);

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: () => mockGetSupabaseClient()
}));

jest.mock('../src/services/feedProcessor', () => ({
    fetchAndProcessFeed: (...args: any[]) => mockFetchAndProcessFeed(...args)
}));

jest.mock('../src/services/queueService', () => ({
    sendQueuedForSchedule: (...args: any[]) => mockSendQueuedForSchedule(...args),
    reconcileUpdatedFeedItems: (...args: any[]) => mockReconcileUpdatedFeedItems(...args),
    sendPendingForAllSchedules: (...args: any[]) => mockSendPendingForAllSchedules(...args)
}));

jest.mock('../src/services/scheduleLockService', () => ({
    withScheduleLock: (...args: any[]) => mockWithScheduleLock(...args),
    cleanupStaleLocks: (...args: any[]) => mockCleanupStaleLocks(...args)
}));

jest.mock('../src/services/settingsService', () => ({
    getSettings: (...args: any[]) => mockGetSettings(...args)
}));

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

jest.mock('node-cron', () => ({
    schedule: (...args: any[]) => mockCronSchedule(...args),
    validate: (...args: any[]) => mockCronValidate(...args)
}));

const schedulerService = require('../src/services/schedulerService');

const createSchedulesSupabase = (schedules: Array<Record<string, unknown>>) => ({
    from: (table: string) => {
        if (table !== 'schedules') {
            throw new Error(`Unexpected table: ${table}`);
        }
        return {
            select: jest.fn(() => ({
                eq: jest.fn(async () => ({ data: schedules, error: null })),
                not: jest.fn(async () => ({ data: schedules, error: null }))
            }))
        };
    }
});

const createRecentCorrectionSupabase = (options: {
    logRows: Array<Record<string, unknown>>;
    feedItems: Array<Record<string, unknown>>;
    feeds: Array<Record<string, unknown>>;
    schedules: Array<Record<string, unknown>>;
}) => ({
    from: (table: string) => {
        if (table === 'message_logs') {
            return {
                select: jest.fn(() => ({
                    in: jest.fn(() => ({
                        gte: jest.fn(() => ({
                            not: jest.fn(() => ({
                                limit: jest.fn(async () => ({ data: options.logRows, error: null }))
                            }))
                        }))
                    }))
                }))
            };
        }

        if (table === 'feed_items') {
            return {
                select: jest.fn(() => ({
                    in: jest.fn(async () => ({ data: options.feedItems, error: null }))
                }))
            };
        }

        if (table === 'feeds') {
            return {
                select: jest.fn(() => ({
                    in: jest.fn(() => ({
                        eq: jest.fn(async () => ({ data: options.feeds, error: null }))
                    }))
                }))
            };
        }

        if (table === 'schedules') {
            return {
                select: jest.fn(() => ({
                    eq: jest.fn(async () => ({ data: options.schedules, error: null }))
                }))
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    }
});

describe('schedulerService dispatch entry points', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        schedulerService.clearAll();
        mockGetSettings.mockResolvedValue({ app_paused: false });
        mockWithScheduleLock.mockImplementation(async (_supabase: unknown, _scheduleId: string, callback: () => Promise<unknown>) => ({
            skipped: false,
            result: await callback()
        }));
        mockSendQueuedForSchedule.mockResolvedValue({ sent: 1 });
    });

    it('triggers only active immediate schedules without cron expressions when connected', async () => {
        const whatsappClient = {
            getStatus: () => ({ status: 'connected' })
        };
        const schedules = [
            { id: 'immediate-active', state: 'active', active: true, delivery_mode: 'immediate', cron_expression: null },
            { id: 'batched-active', state: 'active', active: true, delivery_mode: 'batch', cron_expression: null },
            { id: 'cron-active', state: 'active', active: true, delivery_mode: 'immediate', cron_expression: '*/5 * * * *' },
            { id: 'paused-immediate', state: 'paused', active: false, delivery_mode: 'immediate', cron_expression: null }
        ];
        mockGetSupabaseClient.mockReturnValue(createSchedulesSupabase(schedules));

        await schedulerService.triggerImmediateSchedules('feed-1', whatsappClient);

        expect(mockSendQueuedForSchedule).toHaveBeenCalledTimes(1);
        expect(mockSendQueuedForSchedule).toHaveBeenCalledWith(
            'immediate-active',
            whatsappClient,
            {
                skipFeedRefresh: true,
                allowOverdueBatchDispatch: true,
                maxQueueLookbackHours: undefined
            }
        );
    });

    it('queues immediate schedules without a live WhatsApp client when disconnected', async () => {
        const whatsappClient = {
            getStatus: () => ({ status: 'disconnected' })
        };
        mockGetSupabaseClient.mockReturnValue(
            createSchedulesSupabase([
                { id: 'immediate-active', state: 'active', active: true, delivery_mode: 'immediate', cron_expression: null }
            ])
        );

        await schedulerService.triggerImmediateSchedules('feed-2', whatsappClient);

        expect(mockSendQueuedForSchedule).toHaveBeenCalledTimes(1);
        expect(mockSendQueuedForSchedule).toHaveBeenCalledWith(
            'immediate-active',
            undefined,
            {
                skipFeedRefresh: true,
                allowOverdueBatchDispatch: true,
                maxQueueLookbackHours: undefined
            }
        );
    });

    it('does not start background schedulers before WhatsApp is connected', async () => {
        const whatsappClient = {
            getStatus: () => ({ status: 'disconnected', lease: { supported: false, held: false } })
        };
        mockGetSupabaseClient.mockReturnValue(createSchedulesSupabase([]));

        await schedulerService.initSchedulers(whatsappClient);

        expect(mockCleanupStaleLocks).not.toHaveBeenCalled();
        expect(mockFetchAndProcessFeed).not.toHaveBeenCalled();
        expect(mockCronSchedule).not.toHaveBeenCalled();
    });

    it('does not run a schedule after the WhatsApp lease has moved to another instance', async () => {
        const whatsappClient = {
            getStatus: () => ({
                status: 'connected',
                instanceId: 'stale-instance',
                lease: { supported: true, held: false, ownerId: 'new-instance', expiresAt: new Date(Date.now() + 60000).toISOString() }
            })
        };
        mockGetSupabaseClient.mockReturnValue(createSchedulesSupabase([]));

        await schedulerService.__testUtils.runScheduleOnce('schedule-after-lease-loss', whatsappClient);

        expect(mockWithScheduleLock).not.toHaveBeenCalled();
        expect(mockSendQueuedForSchedule).not.toHaveBeenCalled();
    });

    it('queues only active batched schedules after a feed refresh', async () => {
        const whatsappClient = {
            getStatus: () => ({ status: 'connected' })
        };
        const schedules = [
            { id: 'batch-active', state: 'active', active: true, delivery_mode: 'batch', cron_expression: null },
            { id: 'batch-paused', state: 'paused', active: false, delivery_mode: 'batch', cron_expression: null },
            { id: 'immediate-active', state: 'active', active: true, delivery_mode: 'immediate', cron_expression: null }
        ];
        mockGetSupabaseClient.mockReturnValue(createSchedulesSupabase(schedules));

        await schedulerService.queueBatchSchedulesForFeed('feed-3', whatsappClient);

        expect(mockSendQueuedForSchedule).toHaveBeenCalledTimes(1);
        expect(mockSendQueuedForSchedule).toHaveBeenCalledWith(
            'batch-active',
            whatsappClient,
            {
                skipFeedRefresh: true,
                allowOverdueBatchDispatch: true
            }
        );
    });

    it('caps the correction window parser at the supported 15-minute limit', () => {
        expect(schedulerService.__testUtils.parseCorrectionWindowMinutes(5)).toBe(5);
        expect(schedulerService.__testUtils.parseCorrectionWindowMinutes(90)).toBe(15);
        expect(schedulerService.__testUtils.parseCorrectionWindowMinutes(undefined)).toBe(15);
    });

    it('queues immediate schedules when the correction watcher discovers new feed items', async () => {
        const whatsappClient = {
            getStatus: () => ({ status: 'connected' })
        };
        const immediateSchedule = {
            id: 'immediate-active',
            feed_id: 'feed-1',
            state: 'active',
            active: true,
            delivery_mode: 'immediate',
            cron_expression: null
        };

        mockFetchAndProcessFeed.mockResolvedValue({
            items: [{ id: 'new-item' }],
            updatedItems: []
        });
        mockGetSupabaseClient.mockReturnValue(
            createRecentCorrectionSupabase({
                logRows: [{ feed_item_id: 'old-item' }],
                feedItems: [{ id: 'old-item', feed_id: 'feed-1' }],
                feeds: [{ id: 'feed-1', active: true }],
                schedules: [immediateSchedule]
            })
        );

        await schedulerService.__testUtils.runRecentFeedCorrectionPass(whatsappClient);

        expect(mockFetchAndProcessFeed).toHaveBeenCalledWith({ id: 'feed-1', active: true });
        expect(mockSendQueuedForSchedule).toHaveBeenCalledWith(
            'immediate-active',
            whatsappClient,
            {
                skipFeedRefresh: true,
                allowOverdueBatchDispatch: true,
                maxQueueLookbackHours: undefined
            }
        );
    });

    it('runs bounded catch-up for immediate feed schedules even when no pending rows exist', async () => {
        const whatsappClient = {
            getStatus: () => ({ status: 'connected' })
        };
        mockGetSupabaseClient.mockReturnValue(
            createSchedulesSupabase([
                { id: 'immediate-active', feed_id: 'feed-1', state: 'active', active: true, delivery_mode: 'immediate', cron_expression: null },
                { id: 'cron-active', feed_id: 'feed-1', state: 'active', active: true, delivery_mode: 'immediate', cron_expression: '*/5 * * * *' },
                { id: 'batch-active', feed_id: 'feed-1', state: 'active', active: true, delivery_mode: 'batched', cron_expression: null }
            ])
        );

        await schedulerService.__testUtils.runImmediateScheduleCatchupPass(whatsappClient);

        expect(mockSendQueuedForSchedule).toHaveBeenCalledTimes(1);
        expect(mockSendQueuedForSchedule).toHaveBeenCalledWith(
            'immediate-active',
            whatsappClient,
            {
                skipFeedRefresh: true,
                allowOverdueBatchDispatch: true,
                maxQueueLookbackHours: 1
            }
        );
    });
});
