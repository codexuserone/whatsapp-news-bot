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
          target_id: 'target-1',
          updated_at: '2026-03-17T02:00:00.000Z',
          schedule: { state: 'active', active: true },
          target: { active: true }
        },
        windowStartIso
      )
    ).toBe(true);

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'old-row',
          schedule_id: 'schedule-1',
          target_id: 'target-1',
          updated_at: '2026-03-16T23:59:59.000Z',
          schedule: { state: 'active', active: true },
          target: { active: true }
        },
        windowStartIso
      )
    ).toBe(false);

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'paused-row',
          schedule_id: 'schedule-2',
          target_id: 'target-1',
          updated_at: '2026-03-17T03:00:00.000Z',
          schedule: { state: 'paused', active: false },
          target: { active: true }
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

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'terminal-channel-media',
          schedule_id: 'schedule-1',
          target_id: 'target-1',
          updated_at: '2026-03-17T05:00:00.000Z',
          media_error: 'Channel image was rejected by WhatsApp (WhatsApp server rejected message ack 479)',
          schedule: { state: 'active', active: true },
          target: { active: true }
        },
        windowStartIso
      )
    ).toBe(false);

    expect(
      testUtils.isRetryableQueueRow(
        {
          id: 'inactive-target',
          schedule_id: 'schedule-1',
          target_id: 'target-inactive',
          updated_at: '2026-03-17T05:00:00.000Z',
          schedule: { state: 'active', active: true },
          target: { active: false }
        },
        windowStartIso
      )
    ).toBe(false);
  });

  it('limits history filters to the recent window and keeps live statuses separate', () => {
    expect(testUtils.shouldLimitQueueStatusToRecentHistory('sent')).toBe(true);
    expect(testUtils.shouldLimitQueueStatusToRecentHistory('failed')).toBe(true);
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

  it('does not expose inline attachment payloads in queue list responses', () => {
    expect(testUtils.isInlineMediaDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(testUtils.isStoredMediaReference('data:image/png;base64,AAAA')).toBe(true);
    expect(testUtils.isStoredMediaReference('uploaded:image')).toBe(true);
    expect(testUtils.sanitizeMediaUrlForApi('data:image/png;base64,AAAA')).toBeNull();
    expect(testUtils.sanitizeMediaUrlForApi('https://example.com/image.jpg')).toBe('https://example.com/image.jpg');
  });

  it('returns legacy unresolved send-now rows as failed outcomes', () => {
    expect(
      testUtils.buildQueueSendNowResponse(
        { ok: false, error: 'Server ack was not observed yet' },
        {
          id: 'queue-row',
          status: 'uncertain',
          whatsapp_message_id: 'msg-1',
          media_sent: false,
          error_message: 'Server ack was not observed yet'
        }
      )
    ).toEqual({
      httpStatus: 400,
      body: {
        ok: false,
        status: 'failed',
        messageId: 'msg-1',
        mediaSent: false,
        error: 'WhatsApp did not confirm this send. It was not counted as sent.'
      }
    });
  });

  it('keeps failed send-now outcomes as request failures with the stored reason', () => {
    expect(
      testUtils.buildQueueSendNowResponse(
        { ok: false, error: 'Unsupported attachment' },
        {
          id: 'queue-row',
          status: 'failed',
          whatsapp_message_id: null,
          media_sent: false,
          error_message: 'Unsupported attachment'
        }
      )
    ).toEqual({
      httpStatus: 400,
      body: {
        ok: false,
        status: 'failed',
        messageId: null,
        mediaSent: false,
        error: 'Unsupported attachment'
      }
    });
  });
});
