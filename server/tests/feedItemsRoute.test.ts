import { describe, expect, it } from '@jest/globals';

const feedItemRoutes = require('../src/routes/feedItems');

describe('feed item delivery summaries', () => {
  const testUtils = feedItemRoutes.__testUtils;

  it('keeps only the newest row per schedule-target pair', () => {
    const rows = [
      {
        id: 'row-1',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-1',
        status: 'sent',
        created_at: '2026-03-18T12:00:00.000Z',
        updated_at: '2026-03-18T12:00:00.000Z'
      },
      {
        id: 'row-2',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-1',
        status: 'pending',
        created_at: '2026-03-18T12:05:00.000Z',
        updated_at: '2026-03-18T12:05:00.000Z'
      },
      {
        id: 'row-3',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-2',
        status: 'failed',
        created_at: '2026-03-18T12:03:00.000Z',
        updated_at: '2026-03-18T12:03:00.000Z'
      },
      {
        id: 'row-4',
        feed_item_id: 'item-1',
        schedule_id: null,
        target_id: 'manual-target',
        status: 'sent',
        created_at: '2026-03-18T12:06:00.000Z',
        updated_at: '2026-03-18T12:06:00.000Z'
      },
      {
        id: 'row-5',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-2',
        target_id: 'target-3',
        status: 'sent',
        created_at: '2026-03-18T12:07:00.000Z',
        updated_at: '2026-03-18T12:07:00.000Z'
      }
    ];

    const selected = testUtils.selectRelevantDeliveryRows(rows, new Set(['schedule-1']));

    expect(selected).toHaveLength(2);
    expect(selected.map((row: { id?: string }) => row.id).sort()).toEqual(['row-2', 'row-3']);
  });

  it('summarizes paused, queued, sent, and failed targets from the filtered rows', () => {
    const summary = testUtils.summarizeDeliveryRows([
      {
        id: 'row-1',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-1',
        status: 'skipped',
        error_message: 'Paused for this post',
        created_at: '2026-03-18T12:00:00.000Z'
      },
      {
        id: 'row-2',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-2',
        status: 'processing',
        corrected_at: '2026-03-18T12:01:30.000Z',
        correction_kind: 'pending_refresh',
        created_at: '2026-03-18T12:01:00.000Z'
      },
      {
        id: 'row-3',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-3',
        status: 'delivered',
        corrected_at: '2026-03-18T12:02:30.000Z',
        correction_kind: 'edit',
        created_at: '2026-03-18T12:02:00.000Z'
      },
      {
        id: 'row-4',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-4',
        status: 'failed',
        created_at: '2026-03-18T12:03:00.000Z'
      },
      {
        id: 'row-5',
        feed_item_id: 'item-1',
        schedule_id: 'schedule-1',
        target_id: 'target-5',
        status: 'failed',
        corrected_at: '2026-03-18T12:04:30.000Z',
        correction_kind: 'replacement',
        correction_error: 'Timed out replacing message',
        created_at: '2026-03-18T12:04:00.000Z'
      }
    ]);

    expect(summary.get('item-1')).toEqual({
      pending: 0,
      processing: 1,
      sent: 1,
      failed: 2,
      uncertain: 0,
      skipped: 1,
      superseded: 0,
      manual_paused: 1,
      corrected: 2,
      corrected_before_send: 1,
      corrected_after_send: 1
    });
  });

  it('restores paused story rows to awaiting approval only when the schedule still requires it', () => {
    expect(testUtils.resolveManualPostResumeStatus({
      approved_at: '2026-03-18T12:00:00.000Z',
      schedule: { approval_required: true }
    })).toBe('pending');

    expect(testUtils.resolveManualPostResumeStatus({
      approved_at: null,
      schedule: { approval_required: true }
    })).toBe('awaiting_approval');

    expect(testUtils.resolveManualPostResumeStatus({
      approved_at: null,
      schedule: { approval_required: false }
    })).toBe('pending');
  });
});
