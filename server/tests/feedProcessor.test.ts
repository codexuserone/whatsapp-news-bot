import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type QueueSchedule = {
    id: string;
    target_ids?: string[];
    template_id?: string;
    approval_required?: boolean;
    state?: string;
    active?: boolean;
};

type ExistingLogRow = {
    feed_item_id?: string;
    target_id?: string;
};

const mockGetSupabaseClient: any = jest.fn();

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: () => mockGetSupabaseClient()
}));

const { queueFeedItemsForSchedules } = require('../src/services/feedProcessor');

const createSeededRandom = (seed: number) => {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};

const sampleSubset = (values: string[], nextRandom: () => number) =>
    values.filter(() => nextRandom() >= 0.5);

const createQueueSupabase = (scenario: {
    schedules: QueueSchedule[];
    existingLogsBySchedule: Record<string, ExistingLogRow[]>;
}) => {
    const upsertMock: any = jest.fn(async (rows: Array<Record<string, unknown>>) => ({ data: rows, error: null }));

    return {
        upsertMock,
        from: (table: string) => {
            if (table === 'schedules') {
                return {
                    select: jest.fn(() => ({
                        eq: jest.fn(async () => ({ data: scenario.schedules, error: null }))
                    }))
                };
            }

            if (table === 'message_logs') {
                return {
                    select: jest.fn(() => ({
                        eq: jest.fn((_field: string, scheduleId: string) => ({
                            in: jest.fn((_feedItemField: string, feedItemIds: string[]) => ({
                                in: jest.fn(async (_targetField: string, targetIds: string[]) => ({
                                    data: (scenario.existingLogsBySchedule[scheduleId] || []).filter(
                                        (row) =>
                                            Boolean(row.feed_item_id && feedItemIds.includes(String(row.feed_item_id))) &&
                                            Boolean(row.target_id && targetIds.includes(String(row.target_id)))
                                    ),
                                    error: null
                                }))
                            }))
                        }))
                    })),
                    upsert: upsertMock
                };
            }

            throw new Error(`Unexpected table: ${table}`);
        }
    };
};

describe('queueFeedItemsForSchedules', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('queues only missing dispatches for running schedules and preserves approval state', async () => {
        const supabase = createQueueSupabase({
            schedules: [
                {
                    id: 'schedule-active',
                    target_ids: ['target-a', 'target-b'],
                    template_id: 'template-1',
                    approval_required: true,
                    state: 'active',
                    active: true
                },
                {
                    id: 'schedule-paused',
                    target_ids: ['target-a'],
                    template_id: 'template-2',
                    approval_required: false,
                    state: 'paused',
                    active: false
                }
            ],
            existingLogsBySchedule: {
                'schedule-active': [{ feed_item_id: 'item-1', target_id: 'target-a' }]
            }
        });

        mockGetSupabaseClient.mockReturnValue(supabase);

        const queued = await queueFeedItemsForSchedules('feed-1', [{ id: 'item-1' }, { id: 'item-2' }]);

        expect(queued).toEqual([
            {
                feed_item_id: 'item-1',
                target_id: 'target-b',
                schedule_id: 'schedule-active',
                template_id: 'template-1',
                status: 'awaiting_approval',
                approved_at: null,
                approved_by: null
            },
            {
                feed_item_id: 'item-2',
                target_id: 'target-a',
                schedule_id: 'schedule-active',
                template_id: 'template-1',
                status: 'awaiting_approval',
                approved_at: null,
                approved_by: null
            },
            {
                feed_item_id: 'item-2',
                target_id: 'target-b',
                schedule_id: 'schedule-active',
                template_id: 'template-1',
                status: 'awaiting_approval',
                approved_at: null,
                approved_by: null
            }
        ]);
        expect(supabase.upsertMock).toHaveBeenCalledTimes(1);
        expect(supabase.upsertMock).toHaveBeenCalledWith(
            queued,
            { onConflict: 'schedule_id,feed_item_id,target_id', ignoreDuplicates: true }
        );
    });

    it('does not queue newly discovered feed items whose publish time is outside the auto-queue age limit', async () => {
        const supabase = createQueueSupabase({
            schedules: [
                {
                    id: 'schedule-active',
                    target_ids: ['target-a'],
                    template_id: 'template-1',
                    state: 'active',
                    active: true
                }
            ],
            existingLogsBySchedule: {}
        });

        mockGetSupabaseClient.mockReturnValue(supabase);

        const stalePubDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        const queued = await queueFeedItemsForSchedules('feed-1', [
            { id: 'old-item', pub_date: stalePubDate, created_at: new Date().toISOString() }
        ]);

        expect(queued).toEqual([]);
        expect(supabase.upsertMock).not.toHaveBeenCalled();
    });

    it('matches expected queue coverage across seeded randomized schedule layouts', async () => {
        const nextRandom = createSeededRandom(1337);

        for (let iteration = 0; iteration < 30; iteration += 1) {
            const itemCount = 1 + Math.floor(nextRandom() * 4);
            const targetUniverse = Array.from({ length: 1 + Math.floor(nextRandom() * 4) }, (_, index) => `target-${index + 1}`);
            const items = Array.from({ length: itemCount }, (_, index) => ({ id: `item-${index + 1}` }));
            const scheduleCount = 1 + Math.floor(nextRandom() * 3);
            const schedules: QueueSchedule[] = [];
            const existingLogsBySchedule: Record<string, ExistingLogRow[]> = {};
            const expectedRows: Array<Record<string, unknown>> = [];

            for (let scheduleIndex = 0; scheduleIndex < scheduleCount; scheduleIndex += 1) {
                const scheduleId = `schedule-${iteration + 1}-${scheduleIndex + 1}`;
                const state = nextRandom() >= 0.35 ? 'active' : 'paused';
                const active = state === 'active';
                const targetIds = sampleSubset(targetUniverse, nextRandom);
                const approvalRequired = nextRandom() >= 0.5;

                const schedule: QueueSchedule = {
                    id: scheduleId,
                    target_ids: targetIds,
                    template_id: `template-${scheduleIndex + 1}`,
                    approval_required: approvalRequired,
                    state,
                    active
                };

                schedules.push(schedule);

                const existing: ExistingLogRow[] = [];
                for (const item of items) {
                    for (const targetId of targetIds) {
                        if (nextRandom() >= 0.7) {
                            existing.push({ feed_item_id: String(item.id), target_id: targetId });
                        } else if (active) {
                            expectedRows.push({
                                feed_item_id: item.id,
                                target_id: targetId,
                                schedule_id: scheduleId,
                                template_id: schedule.template_id,
                                status: approvalRequired ? 'awaiting_approval' : 'pending',
                                approved_at: null,
                                approved_by: null
                            });
                        }
                    }
                }
                existingLogsBySchedule[scheduleId] = existing;
            }

            const supabase = createQueueSupabase({ schedules, existingLogsBySchedule });
            mockGetSupabaseClient.mockReturnValue(supabase);

            const queued = await queueFeedItemsForSchedules('feed-random', items);

            const normalize = (rows: Array<Record<string, unknown>>) =>
                rows
                    .map((row) =>
                        [
                            row.schedule_id,
                            row.feed_item_id,
                            row.target_id,
                            row.template_id,
                            row.status
                        ].join('|')
                    )
                    .sort();

            expect(normalize(queued)).toEqual(normalize(expectedRows));
            if (expectedRows.length > 0) {
                expect(supabase.upsertMock).toHaveBeenCalledTimes(1);
            } else {
                expect(supabase.upsertMock).not.toHaveBeenCalled();
            }
        }
    });
});
