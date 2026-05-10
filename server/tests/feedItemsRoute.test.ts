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
      awaiting_approval: 0,
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

  it('does not report approval-held feed items as failed', () => {
    const status = testUtils.resolveDeliveryStatus(
      {
        awaiting_approval: 4,
        pending: 0,
        processing: 0,
        sent: 0,
        failed: 0,
        uncertain: 0,
        skipped: 0,
        superseded: 0,
        manual_paused: 0,
        corrected: 0,
        corrected_before_send: 0,
        corrected_after_send: 0
      },
      {
        hasManualPause: false,
        dispatchableAutomationCount: 2,
        activeAutomationCount: 2,
        outsideCursorWindow: false
      }
    );

    expect(status).toBe('awaiting_approval');
  });

  it('keeps the default feed item list query slim for polling views', () => {
    const slimSelect = testUtils.buildFeedItemListSelect(false);

    expect(slimSelect).toContain('title');
    expect(slimSelect).toContain('media_url');
    expect(slimSelect).not.toContain('raw_data');
    expect(slimSelect).not.toContain('description');
    expect(slimSelect).not.toContain('content');

    const wideSelect = testUtils.buildFeedItemListSelect(true);
    expect(wideSelect).toContain('raw_data');
    expect(wideSelect).toContain('description');
    expect(wideSelect).toContain('content');
  });
});
