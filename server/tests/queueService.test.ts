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
});
