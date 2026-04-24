import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../src/db/supabase', () => ({
  getSupabaseClient: jest.fn()
}));
jest.mock('../src/services/feedProcessor', () => ({
  fetchAndProcessFeed: jest.fn()
}));
jest.mock('../src/services/settingsService', () => ({
  isAppPaused: jest.fn(),
  getSettings: jest.fn()
}));
jest.mock('../src/services/shabbosService', () => ({
  isCurrentlyShabbos: jest.fn()
}));
jest.mock('cheerio', () => ({
  load: jest.fn()
}));
jest.mock('../src/utils/sleep', () => jest.fn());
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));
jest.mock('../src/utils/withTimeout', () => jest.fn((promise: unknown) => promise));
jest.mock('../src/utils/errorUtils', () => ({
  getErrorMessage: jest.fn((error: unknown) => String((error as Error)?.message || error || ''))
}));
jest.mock('../src/utils/cron', () => ({
  computeNextRunAt: jest.fn()
}));
jest.mock('../src/utils/outboundUrl', () => ({
  assertSafeOutboundUrl: jest.fn(async (url: string) => new URL(url))
}));
jest.mock('../src/utils/safeAxios', () => ({
  safeAxiosRequest: jest.fn()
}));
jest.mock('../src/utils/messageText', () => ({
  normalizeMessageText: jest.fn((value: string) => value),
  escapeWhatsAppFormatting: jest.fn((value: string) => value)
}));
jest.mock('../src/utils/whatsappMedia', () => ({
  isNewsletterJid: jest.fn(() => false),
  prepareNewsletterImage: jest.fn(),
  prepareNewsletterVideo: jest.fn()
}));
jest.mock('../src/utils/manualMeta', () => ({
  parseManualMessageContent: jest.fn(() => ({ text: '', meta: {} }))
}));
jest.mock('../src/services/whatsappConnection', () => ({
  ensureWhatsAppConnected: jest.fn()
}));
jest.mock('../src/services/scheduleState', () => ({
  isScheduleRunning: jest.fn(() => true)
}));
jest.mock('../src/services/scheduleLockService', () => ({
  withScheduleLock: jest.fn()
}));
jest.mock('../src/utils/httpClientIdentity', () => ({
  buildDefaultUserAgent: jest.fn(() => 'test-agent')
}));
jest.mock('../src/utils/targetJid', () => ({
  normalizeTargetJidForSend: jest.fn()
}));
jest.mock('../src/utils/feedMedia', () => ({
  normalizeFeedMedia: jest.fn()
}));
jest.mock('../src/config/features', () => ({
  WHATSAPP_STATUS_ENABLED: true,
  WHATSAPP_STATUS_DISABLED_REASON: null
}));
jest.mock('../src/services/statusAudienceService', () => ({
  ensureFreshStatusRecipients: jest.fn(async () => ({ recipients: [] }))
}));

const queueService = require('../src/services/queueService');

describe('queueService __testUtils', () => {
  const testUtils = queueService.__testUtils;

  it('builds a stable dispatch identity key', () => {
    expect(testUtils.buildDispatchIdentityKey('schedule-1', 'target-1', 'feed-1')).toBe('schedule-1:target-1:feed-1');
    expect(testUtils.buildDispatchIdentityKey('schedule-1', null, 'feed-1')).toBeNull();
  });

  it('computes a stale processing threshold with a hard minimum', () => {
    expect(testUtils.computeStaleProcessingThresholdMs(15000)).toBe(120000);
    expect(testUtils.computeStaleProcessingThresholdMs(90000)).toBe(225000);
  });

  it('computes an uncertain retry threshold with a hard minimum', () => {
    expect(testUtils.computeUncertainRetryDelayMs(15000)).toBe(120000);
    expect(testUtils.computeUncertainRetryDelayMs(90000)).toBe(180000);
  });

  it('treats connection-state errors as recoverable without consuming retries', () => {
    expect(testUtils.isConnectionStateError('WhatsApp not connected')).toBe(true);
    expect(testUtils.isConnectionStateError('WhatsApp requires QR scan')).toBe(true);
    expect(testUtils.isConnectionStateError('Timed out sending message')).toBe(false);
  });

  it('builds a connection wait message for queued retries', () => {
    expect(testUtils.buildConnectionWaitErrorMessage('WhatsApp not connected')).toBe(
      'Waiting for WhatsApp connection: WhatsApp not connected'
    );
    expect(testUtils.buildConnectionWaitErrorMessage('')).toBe('Waiting for WhatsApp connection');
  });

  it('requires server ack only for channel media sends', () => {
    const mediaResult = {
      media: { type: 'image', url: 'https://example.com/a.jpg', sent: true, error: null }
    };
    const textResult = {
      media: { type: null, url: null, sent: false, error: null }
    };

    expect(testUtils.shouldRequireServerAckForSend('channel', mediaResult)).toBe(true);
    expect(testUtils.shouldRequireServerAckForSend('channel', textResult)).toBe(false);
    expect(testUtils.shouldRequireServerAckForSend('group', mediaResult)).toBe(false);
  });

  it('detects newsletter media ack 479 as a channel media rejection', () => {
    const mediaResult = {
      media: { type: 'image', url: 'https://example.com/a.jpg', sent: true, error: null }
    };
    const textResult = {
      media: { type: null, url: null, sent: false, error: null }
    };

    expect(testUtils.isChannelMediaAckRejection('channel', mediaResult, 'WhatsApp server rejected message ack 479')).toBe(true);
    expect(testUtils.isChannelMediaAckRejection('channel', textResult, 'WhatsApp server rejected message ack 479')).toBe(false);
    expect(testUtils.isChannelMediaAckRejection('group', mediaResult, 'WhatsApp server rejected message ack 479')).toBe(false);
  });

  it('temporarily suppresses channel media after a newsletter ack rejection', () => {
    const target = { id: 'target-1', phone_number: '120363000@newsletter', type: 'channel' };
    const now = Date.parse('2026-04-24T12:00:00.000Z');

    expect(testUtils.isChannelMediaTemporarilyBlocked(target, now)).toBe(false);
    testUtils.rememberChannelMediaRejection(target, now);
    expect(testUtils.isChannelMediaTemporarilyBlocked(target, now + 1000)).toBe(true);
  });

  it('requeues only stale rows that do not already have a sent sibling', () => {
    const rows = [
      { id: 'log-1', schedule_id: 'schedule-1', target_id: 'target-1', feed_item_id: 'feed-1' },
      { id: 'log-2', schedule_id: 'schedule-1', target_id: 'target-1', feed_item_id: 'feed-2' },
      { id: 'log-3', schedule_id: 'schedule-2', target_id: 'target-2', feed_item_id: 'feed-3' }
    ];
    const successfulDispatchKeys = new Set<string>(['schedule-1:target-1:feed-2']);

    expect(testUtils.partitionStaleProcessingRows(rows, successfulDispatchKeys)).toEqual({
      toPending: ['log-1', 'log-3'],
      toFailed: ['log-2']
    });
  });

  it('infers the outbound media kind from normalized chat envelopes', () => {
    expect(
      testUtils.inferChatMessageMediaKind({
        raw_message: { messageType: 'imageMessage' }
      })
    ).toBe('image');
    expect(
      testUtils.inferChatMessageMediaKind({
        raw_message: { messageType: 'videoMessage' }
      })
    ).toBe('video');
    expect(testUtils.inferChatMessageMediaKind({ raw_message: { messageType: 'conversation' } })).toBeNull();
  });

  it('matches uncertain delivery candidates by normalized text and media type', () => {
    expect(
      testUtils.doesChatMessageMatchExpectedAttempt(
        {
          content: 'Hello   world',
          raw_message: { messageType: 'imageMessage' }
        },
        {
          text: 'Hello world',
          mediaType: 'image'
        }
      )
    ).toBe(true);

    expect(
      testUtils.doesChatMessageMatchExpectedAttempt(
        {
          content: 'Hello world',
          raw_message: { messageType: 'videoMessage' }
        },
        {
          text: 'Hello world',
          mediaType: 'image'
        }
      )
    ).toBe(false);
  });

  it('advances feed pagination using scan order while dispatching by publish order', () => {
    const plan = testUtils.planFeedDispatchPage([
      { id: 'b', created_at: '2026-03-10T10:00:00.000Z', pub_date: '2026-03-10T12:00:00.000Z' },
      { id: 'c', created_at: '2026-03-10T11:00:00.000Z', pub_date: '2026-03-10T09:00:00.000Z' }
    ]);

    expect(plan.dispatchItems.map((item: { id: string }) => item.id)).toEqual(['c', 'b']);
    expect(plan.cursorAt).toBe('2026-03-10T11:00:00.000Z');
    expect(plan.cursorId).toBe('c');
  });

  it('detects text or media changes for correction decisions', () => {
    expect(
      testUtils.hasCorrectionChanges(
        { text: 'hello', mediaUrl: null, mediaType: null },
        { text: 'hello there', mediaUrl: null, mediaType: null }
      )
    ).toBe(true);

    expect(
      testUtils.hasCorrectionChanges(
        { text: 'hello', mediaUrl: 'https://example.com/a.jpg', mediaType: 'image' },
        { text: 'hello', mediaUrl: 'https://example.com/a.jpg', mediaType: 'image' }
      )
    ).toBe(false);

    expect(
      testUtils.hasCorrectionChanges(
        { text: 'hello', mediaUrl: 'https://example.com/a.jpg', mediaType: 'image' },
        { text: 'hello', mediaUrl: 'https://example.com/b.jpg', mediaType: 'image' }
      )
    ).toBe(true);
  });

  it('prefers in-place edit only for text rows inside the edit window', () => {
    expect(
      testUtils.chooseCorrectionStrategy({
        targetType: 'group',
        sentAgeMs: 2 * 60 * 1000,
        editWindowMs: 15 * 60 * 1000,
        correctionWindowMs: 15 * 60 * 1000,
        hasMessageId: true,
        supportsEdit: true,
        supportsDelete: true,
        currentMediaType: null,
        currentMediaUrl: null,
        desiredMediaType: null,
        desiredMediaUrl: null
      })
    ).toBe('edit');

    expect(
      testUtils.chooseCorrectionStrategy({
        targetType: 'group',
        sentAgeMs: 2 * 60 * 1000,
        editWindowMs: 15 * 60 * 1000,
        correctionWindowMs: 15 * 60 * 1000,
        hasMessageId: true,
        supportsEdit: true,
        supportsDelete: true,
        currentMediaType: 'image',
        currentMediaUrl: 'https://example.com/a.jpg',
        desiredMediaType: 'image',
        desiredMediaUrl: 'https://example.com/a.jpg'
      })
    ).toBe('skip');

    expect(
      testUtils.chooseCorrectionStrategy({
        targetType: 'group',
        sentAgeMs: 2 * 60 * 1000,
        editWindowMs: 15 * 60 * 1000,
        correctionWindowMs: 15 * 60 * 1000,
        hasMessageId: true,
        supportsEdit: true,
        supportsDelete: true,
        currentMediaType: 'image',
        currentMediaUrl: 'https://example.com/a.jpg',
        desiredMediaType: 'image',
        desiredMediaUrl: 'https://example.com/b.jpg'
      })
    ).toBe('skip');
  });

  it('skips channel and status corrections by default', () => {
    expect(
      testUtils.chooseCorrectionStrategy({
        targetType: 'channel',
        sentAgeMs: 2 * 60 * 1000,
        editWindowMs: 15 * 60 * 1000,
        correctionWindowMs: 15 * 60 * 1000,
        hasMessageId: true,
        supportsEdit: true,
        supportsDelete: true,
        currentMediaType: null,
        currentMediaUrl: null,
        desiredMediaType: null,
        desiredMediaUrl: null
      })
    ).toBe('skip');

    expect(
      testUtils.chooseCorrectionStrategy({
        targetType: 'status',
        sentAgeMs: 2 * 60 * 1000,
        editWindowMs: 15 * 60 * 1000,
        correctionWindowMs: 15 * 60 * 1000,
        hasMessageId: true,
        supportsEdit: true,
        supportsDelete: true,
        currentMediaType: null,
        currentMediaUrl: null,
        desiredMediaType: null,
        desiredMediaUrl: null
      })
    ).toBe('skip');
  });

  it('does not replace a message after failed edit unless auto replacement is enabled', () => {
    expect(testUtils.shouldAttemptReplacementAfterCorrectionFailure('edit', true)).toBe(false);
    expect(testUtils.shouldAttemptReplacementAfterCorrectionFailure('edit', false)).toBe(false);
    expect(testUtils.shouldAttemptReplacementAfterCorrectionFailure('skip', true)).toBe(false);
  });

  it('still allows direct replacement strategy when delete is supported', () => {
    expect(testUtils.shouldAttemptReplacementAfterCorrectionFailure('replace', true)).toBe(true);
    expect(testUtils.shouldAttemptReplacementAfterCorrectionFailure('replace', false)).toBe(false);
  });

  it('only allows replacement corrections for non-channel targets', () => {
    expect(testUtils.canAttemptReplacementCorrection('channel', true)).toBe(false);
    expect(testUtils.canAttemptReplacementCorrection('status', true)).toBe(false);
  });

  it('blocks stale feed items from auto-queue replay', () => {
    const nowMs = Date.parse('2026-04-16T14:00:00.000Z');

    expect(
      testUtils.isFeedItemFreshEnoughForAutoQueue(
        {
          pub_date: '2026-04-16T13:30:00.000Z',
          created_at: '2026-04-16T13:31:00.000Z'
        },
        72,
        nowMs
      )
    ).toBe(true);

    expect(
      testUtils.isFeedItemFreshEnoughForAutoQueue(
        {
          pub_date: '2026-03-25T10:00:00.000Z',
          created_at: '2026-04-16T13:31:00.000Z'
        },
        72,
        nowMs
      )
    ).toBe(false);
  });

  it('blocks stale queued rows whose source post is older than the automation replay window', () => {
    const nowMs = Date.parse('2026-04-16T14:00:00.000Z');

    expect(
      testUtils.isAutoQueueReplayTooOld(
        { created_at: '2026-04-16T13:30:00.000Z' },
        { pub_date: '2026-04-01T10:00:00.000Z', created_at: '2026-04-01T10:00:01.000Z' },
        72,
        nowMs
      )
    ).toBe(true);

    expect(
      testUtils.isAutoQueueReplayTooOld(
        { created_at: '2026-04-02T10:30:00.000Z' },
        { pub_date: '2026-04-01T10:00:00.000Z', created_at: '2026-04-01T10:00:01.000Z' },
        72,
        nowMs
      )
    ).toBe(false);
  });

  it('accepts only real image candidates for feed automation images', () => {
    expect(testUtils.isUsableFeedImageUrl('https://example.com/photo.jpg')).toBe(true);
    expect(testUtils.isUsableFeedImageUrl('https://example.com/video.mp4')).toBe(false);
    expect(testUtils.isUsableFeedImageUrl('https://example.com/images/default-image.jpg')).toBe(false);
    expect(testUtils.isUsableFeedImageUrl('https://files.anash.org/uploads/2025/09/Anash-Logo.svg')).toBe(false);
    expect(testUtils.isUsableFeedImageUrl('https://example.com/icons/site-icon.png')).toBe(false);
  });
});
