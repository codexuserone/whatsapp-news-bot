import { describe, expect, it } from '@jest/globals';

const queueRoutes = require('../src/routes/queue');

describe('queue route retry safeguards', () => {
  const testUtils = queueRoutes.__testUtils;

  it('defaults retry windows to the recent history view', () => {
    expect(testUtils.parseWindowHours(undefined)).toBe(24);
    expect(testUtils.parseWindowHours('0')).toBe(24);
    expect(testUtils.parseWindowHours('999')).toBe(168);
  });

  it('retries only recent rows from running schedules', () => {
    const windowStartIso = '2026-03-17T00:00:00.000Z';

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'recent-running',
          schedule_id: 'schedule-1',
          updated_at: '2026-03-17T02:00:00.000Z',
          schedule: { state: 'active', active: true }
        },
        windowStartIso
      )
    ).toBe(true);

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'old-row',
          schedule_id: 'schedule-1',
          updated_at: '2026-03-16T23:59:59.000Z',
          schedule: { state: 'active', active: true }
        },
        windowStartIso
      )
    ).toBe(false);

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'paused-row',
          schedule_id: 'schedule-2',
          updated_at: '2026-03-17T03:00:00.000Z',
          schedule: { state: 'paused', active: false }
        },
        windowStartIso
      )
    ).toBe(false);

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'manual-row',
          schedule_id: null,
          updated_at: '2026-03-17T04:00:00.000Z',
          schedule: null
        },
        windowStartIso
      )
    ).toBe(true);
  });

  it('limits history filters to the recent window and keeps live statuses separate', () => {
    expect(testUtils.shouldLimitQueueStatusToRecentHistory('sent')).toBe(true);
    expect(testUtils.shouldLimitQueueStatusToRecentHistory('failed')).toBe(true);
    expect(testUtils.shouldLimitQueueStatusToRecentHistory('uncertain')).toBe(true);
    expect(testUtils.shouldLimitQueueStatusToRecentHistory('pending')).toBe(false);
    expect(testUtils.shouldLimitQueueStatusToRecentHistory(undefined)).toBe(false);
  });

  it('builds a combined filter that keeps live queue rows plus recent history', () => {
    expect(testUtils.buildCombinedQueueFilter('2026-03-18T00:00:00.000Z')).toBe(
      'status.eq.awaiting_approval,status.eq.pending,status.eq.processing,updated_at.gte.2026-03-18T00:00:00.000Z'
    );
  });

  it('allows in-place edits only for text rows', () => {
    expect(testUtils.hasEditableQueuePayload({
      media_type: null,
      media_url: null
    })).toBe(true);

    expect(testUtils.hasEditableQueuePayload({
      media_type: 'image',
      media_url: 'https://example.com/image.jpg'
    })).toBe(false);

    expect(testUtils.hasEditableQueuePayload({
      media_type: 'audio',
      media_url: 'https://example.com/audio.mp3'
    })).toBe(false);
  });
});
