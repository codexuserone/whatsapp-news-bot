import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
const { ensureFreshStatusRecipients } = require('../src/services/statusAudienceService');
const { normalizeTargetJidForSend } = require('../src/utils/targetJid');
const { normalizeFeedMedia } = require('../src/utils/feedMedia');
const { safeAxiosRequest } = require('../src/utils/safeAxios');
const { prepareNewsletterImage } = require('../src/utils/whatsappMedia');

describe('queueService __testUtils', () => {
  const testUtils = queueService.__testUtils;
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
  const mp4Buffer = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds a stable dispatch identity key', () => {
    expect(testUtils.buildDispatchIdentityKey('schedule-1', 'target-1', 'feed-1')).toBe('schedule-1:target-1:feed-1:0');
    expect(testUtils.buildDispatchIdentityKey('schedule-1', 'target-1', 'feed-1', 2)).toBe('schedule-1:target-1:feed-1:2');
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

  it('keeps uncertain rows with a WhatsApp id out of automatic retry', () => {
    expect(
      testUtils.isUnconfirmedSendWithMessageId({
        whatsapp_message_id: 'ABC123',
        error_message: 'Send result is uncertain. Verifying delivery before retrying. Message send not confirmed (Server ack not observed)'
      })
    ).toBe(true);
    expect(
      testUtils.isUnconfirmedSendWithMessageId({
        whatsapp_message_id: '',
        error_message: 'Message send not confirmed (Server ack not observed)'
      })
    ).toBe(false);
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

  it('requires server ACKs for non-channel sends before treating them as sent', () => {
    const mediaResult = {
      media: { type: 'image', url: 'https://example.com/a.jpg', sent: true, error: null }
    };
    const textResult = {
      media: { type: null, url: null, sent: false, error: null }
    };

    expect(testUtils.shouldRequireServerAckForSend('channel', mediaResult)).toBe(false);
    expect(testUtils.shouldRequireServerAckForSend('channel', textResult)).toBe(false);
    expect(testUtils.shouldRequireServerAckForSend('group', mediaResult)).toBe(true);
    expect(testUtils.shouldRequireServerAckForSend('individual', textResult)).toBe(true);
    expect(testUtils.shouldRequireServerAckForSend('status', mediaResult)).toBe(true);
  });

  it('confirms channel sends with newsletter fetch when available', async () => {
    const confirmNewsletterMessage: any = jest.fn(async () => ({
      ok: true,
      via: 'fetch',
      status: 2,
      statusLabel: 'published'
    }));
    const confirmSend: any = jest.fn();

    await expect(
      testUtils.confirmSendResult(
        { confirmNewsletterMessage, confirmSend },
        'channel',
        {
          response: { key: { id: 'newsletter-msg-123', remoteJid: '120363406955649221@newsletter' } },
          media: { type: null, url: null, sent: false, error: null }
        }
      )
    ).resolves.toEqual({
      ok: true,
      via: 'fetch',
      status: 2,
      statusLabel: 'published'
    });

    expect(confirmNewsletterMessage).toHaveBeenCalledWith('120363406955649221@newsletter', 'newsletter-msg-123', {
      timeoutMs: 15000,
      count: 10
    });
    expect(confirmSend).not.toHaveBeenCalled();
  });

  it('marks channel sends uncertain when newsletter fetch is supported but does not find the post', async () => {
    const confirmNewsletterMessage: any = jest.fn(async () => ({
      ok: false,
      via: 'none',
      error: 'Channel fetch did not include message newsletter-msg-123',
      unsupported: false
    }));
    const confirmSend: any = jest.fn();

    await expect(
      testUtils.confirmSendResult(
        { confirmNewsletterMessage, confirmSend },
        'channel',
        {
          response: { key: { id: 'newsletter-msg-123', remoteJid: '120363406955649221@newsletter' } },
          media: { type: 'image', url: 'https://example.com/a.jpg', sent: true, error: null }
        }
      )
    ).resolves.toEqual({
      ok: false,
      via: 'none',
      error: 'Message send not confirmed (Channel fetch did not include message newsletter-msg-123)'
    });

    expect(confirmNewsletterMessage).toHaveBeenCalledWith('120363406955649221@newsletter', 'newsletter-msg-123', {
      timeoutMs: 30000,
      count: 10
    });
    expect(confirmSend).not.toHaveBeenCalled();
  });

  it('blocks text fallback after media failure for status and channel targets', () => {
    expect(testUtils.shouldBlockTextFallbackAfterMediaFailure('status')).toBe(true);
    expect(testUtils.shouldBlockTextFallbackAfterMediaFailure('channel')).toBe(true);
    expect(testUtils.shouldBlockTextFallbackAfterMediaFailure('group')).toBe(false);
    expect(testUtils.shouldBlockTextFallbackAfterMediaFailure('individual')).toBe(false);
  });

  it('blocks manual text fallback after any requested media failure', () => {
    expect(testUtils.shouldBlockManualTextFallbackAfterMediaFailure('status')).toBe(true);
    expect(testUtils.shouldBlockManualTextFallbackAfterMediaFailure('channel')).toBe(true);
    expect(testUtils.shouldBlockManualTextFallbackAfterMediaFailure('group')).toBe(true);
    expect(testUtils.shouldBlockManualTextFallbackAfterMediaFailure('individual')).toBe(true);
  });

  it('builds status text styling options only from valid template values', () => {
    expect(
      testUtils.buildTemplateStatusTextOptions({
        status_background_color: '#166534',
        status_font: 5
      })
    ).toEqual({ backgroundColor: '#166534', font: 5 });

    expect(
      testUtils.buildTemplateStatusTextOptions({
        status_background_color: 'bad',
        status_font: 99
      })
    ).toEqual({});
  });

  it('sends template status text styling as WhatsApp status options', async () => {
    ensureFreshStatusRecipients.mockResolvedValueOnce({
      recipients: ['15551234567@s.whatsapp.net'],
      sources: { env: 1 }
    });
    normalizeTargetJidForSend.mockReturnValueOnce('status@broadcast');
    const sendStatusBroadcast: any = jest.fn(async (..._args: unknown[]) => ({ key: { id: 'status-1' } }));

    await testUtils.sendMessageWithTemplate(
      {
        getStatus: () => ({ status: 'connected' }),
        sendStatusBroadcast
      },
      {
        id: 'target-status',
        phone_number: 'status@broadcast',
        type: 'status'
      },
      {
        id: 'template-status',
        content: '{{title}}',
        send_mode: 'text_only',
        status_background_color: '#166534',
        status_font: 5
      },
      {
        id: 'feed-item-1',
        title: 'Status title'
      }
    );

    expect(sendStatusBroadcast).toHaveBeenCalledWith(
      { text: 'Status title', linkPreview: null },
      {
        statusJidList: ['15551234567@s.whatsapp.net'],
        includeSender: true,
        backgroundColor: '#166534',
        font: 5
      }
    );
  });

  it('uses feed video media in automatic media mode when the story has a video and featured image', async () => {
    normalizeTargetJidForSend.mockReturnValueOnce('120363000@g.us');
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: 'https://example.com/story.mp4',
      mediaKind: 'video',
      mediaMime: 'video/mp4',
      mediaFilename: '',
      imageUrl: 'https://example.com/featured.jpg'
    });
    safeAxiosRequest.mockResolvedValueOnce({
      data: mp4Buffer,
      headers: { 'content-type': 'video/mp4' }
    });
    const sendMessage: any = jest.fn(async (..._args: unknown[]) => ({ key: { id: 'video-1' } }));

    const result = await testUtils.sendMessageWithTemplate(
      {
        getStatus: () => ({ status: 'connected' }),
        sendMessage
      },
      {
        id: 'target-group',
        phone_number: '120363000@g.us',
        type: 'group'
      },
      {
        id: 'template-video',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true
      },
      {
        id: 'feed-item-video',
        title: 'Story title',
        link: 'https://example.com/story',
        image_url: 'https://example.com/featured.jpg',
        media_url: 'https://example.com/story.mp4',
        media_kind: 'video',
        media_mime: 'video/mp4'
      }
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '120363000@g.us',
      expect.objectContaining({
        video: expect.any(Buffer),
        caption: 'Story title',
        mimetype: 'video/mp4'
      })
    );
    expect(result.media).toEqual({
      type: 'video',
      url: 'https://example.com/story.mp4',
      sent: true,
      error: null
    });
  });

  it('can force a sequence step to use the featured image even when a story video exists', async () => {
    normalizeTargetJidForSend.mockReturnValueOnce('120363000@g.us');
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: 'https://example.com/story.mp4',
      mediaKind: 'video',
      mediaMime: 'video/mp4',
      mediaFilename: '',
      imageUrl: 'https://example.com/featured.jpg'
    });
    safeAxiosRequest.mockResolvedValueOnce({
      data: jpegBuffer,
      headers: { 'content-type': 'image/jpeg' }
    });
    const sendMessage: any = jest.fn(async (..._args: unknown[]) => ({ key: { id: 'image-1' } }));

    const result = await testUtils.sendMessageWithTemplate(
      {
        getStatus: () => ({ status: 'connected' }),
        sendMessage
      },
      {
        id: 'target-group',
        phone_number: '120363000@g.us',
        type: 'group'
      },
      {
        id: 'template-image',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true,
        media_source: 'image'
      },
      {
        id: 'feed-item-video',
        title: 'Story title',
        link: 'https://example.com/story',
        image_url: 'https://example.com/featured.jpg',
        media_url: 'https://example.com/story.mp4',
        media_kind: 'video',
        media_mime: 'video/mp4'
      }
    );

    expect(sendMessage).toHaveBeenCalledWith(
      '120363000@g.us',
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: 'Story title',
        mimetype: 'image/jpeg'
      })
    );
    expect(result.media).toEqual({
      type: 'image',
      url: 'https://example.com/featured.jpg',
      sent: true,
      error: null
    });
  });

  it('normalizes CDN WebP image responses to JPEG before WhatsApp upload', async () => {
    const webpBuffer = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ');
    normalizeTargetJidForSend.mockReturnValueOnce('120363000@g.us');
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: 'https://cdn.example.com/featured.jpg',
      mediaKind: 'image',
      mediaMime: 'image/*',
      mediaFilename: '',
      imageUrl: 'https://cdn.example.com/featured.jpg'
    });
    safeAxiosRequest.mockResolvedValueOnce({
      data: webpBuffer,
      headers: { 'content-type': 'image/webp' }
    });
    prepareNewsletterImage.mockResolvedValueOnce({
      buffer: jpegBuffer,
      mimetype: 'image/jpeg',
      converted: true
    });
    const sendMessage: any = jest.fn(async (..._args: unknown[]) => ({ key: { id: 'image-1' } }));

    await testUtils.sendMessageWithTemplate(
      {
        getStatus: () => ({ status: 'connected' }),
        sendMessage
      },
      {
        id: 'target-group',
        phone_number: '120363000@g.us',
        type: 'group'
      },
      {
        id: 'template-image',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true,
        media_source: 'image'
      },
      {
        id: 'feed-item-image',
        title: 'Story title',
        link: 'https://example.com/story',
        image_url: 'https://cdn.example.com/featured.jpg'
      }
    );

    expect(prepareNewsletterImage).toHaveBeenCalledWith(webpBuffer, expect.objectContaining({ jpegQuality: 92 }));
    expect(sendMessage).toHaveBeenCalledWith(
      '120363000@g.us',
      expect.objectContaining({
        image: jpegBuffer,
        caption: 'Story title',
        mimetype: 'image/jpeg'
      })
    );
  });

  it('does not silently replace a requested story video with a featured image', async () => {
    normalizeTargetJidForSend.mockReturnValueOnce('120363000@g.us');
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: '',
      mediaKind: '',
      mediaMime: '',
      mediaFilename: '',
      imageUrl: 'https://example.com/featured.jpg'
    });
    const sendMessage: any = jest.fn(async (..._args: unknown[]) => ({ key: { id: 'text-1' } }));

    const result = await testUtils.sendMessageWithTemplate(
      {
        getStatus: () => ({ status: 'connected' }),
        sendMessage
      },
      {
        id: 'target-group',
        phone_number: '120363000@g.us',
        type: 'group'
      },
      {
        id: 'template-video',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true,
        media_source: 'video'
      },
      {
        id: 'feed-item-image-only',
        title: 'Story title',
        link: 'https://example.com/story',
        image_url: 'https://example.com/featured.jpg'
      }
    );

    expect(safeAxiosRequest).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      '120363000@g.us',
      expect.objectContaining({
        text: expect.stringContaining('Story title')
      })
    );
    const sentPayload = sendMessage.mock.calls[0][1];
    expect(sentPayload).not.toHaveProperty('image');
    expect(sentPayload).not.toHaveProperty('video');
    expect(result.media).toEqual({
      type: null,
      url: null,
      sent: false,
      error: null
    });
  });

  it('previews queued automation text and intended media before sending', () => {
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: 'https://example.com/story.mp4',
      mediaKind: 'video',
      mediaMime: 'video/mp4',
      mediaFilename: '',
      imageUrl: 'https://example.com/featured.jpg'
    });

    const preview = testUtils.buildQueuedAutomationPreview(
      { sequence_step_index: 0 },
      {
        id: 'template-video',
        content: '*{{title}}*\n{{link}}',
        send_mode: 'auto_media',
        send_images: true
      },
      {
        id: 'feed-item-video',
        title: 'Story title',
        link: 'https://example.com/story',
        image_url: 'https://example.com/featured.jpg',
        media_url: 'https://example.com/story.mp4',
        media_kind: 'video',
        media_mime: 'video/mp4'
      }
    );

    expect(preview).toEqual({
      text: '*Story title*\nhttps://example.com/story',
      mediaUrl: 'https://example.com/story.mp4',
      mediaType: 'video',
      mediaMime: 'video/mp4',
      mediaFilename: null,
      includeCaption: true,
      disableLinkPreview: false
    });
  });

  it('previews a normal template forced to the featured image', () => {
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: 'https://example.com/story.mp4',
      mediaKind: 'video',
      mediaMime: 'video/mp4',
      mediaFilename: '',
      imageUrl: 'https://example.com/featured.jpg'
    });

    const preview = testUtils.buildQueuedAutomationPreview(
      { sequence_step_index: 0 },
      {
        id: 'template-image',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true,
        media_source: 'image'
      },
      {
        id: 'feed-item-video',
        title: 'Story title',
        link: 'https://example.com/story',
        image_url: 'https://example.com/featured.jpg',
        media_url: 'https://example.com/story.mp4',
        media_kind: 'video',
        media_mime: 'video/mp4'
      }
    );

    expect(preview.mediaUrl).toBe('https://example.com/featured.jpg');
    expect(preview.mediaType).toBe('image');
    expect(preview.text).toBe('Story title');
  });

  it('previews a sequence step forced to the featured image', () => {
    normalizeFeedMedia.mockReturnValueOnce({
      mediaUrl: 'https://example.com/story.mp4',
      mediaKind: 'video',
      mediaMime: 'video/mp4',
      mediaFilename: '',
      imageUrl: 'https://example.com/featured.jpg'
    });

    const preview = testUtils.buildQueuedAutomationPreview(
      { sequence_step_index: 1 },
      {
        id: 'template-sequence',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true,
        sequence_steps: [
          { label: 'Video', content: '{{title}}', send_mode: 'auto_media', media_source: 'video' },
          { label: 'Featured image', content: '{{description}}', send_mode: 'auto_media', media_source: 'image' }
        ]
      },
      {
        id: 'feed-item-video',
        title: 'Story title',
        description: 'Story excerpt',
        link: 'https://example.com/story',
        image_url: 'https://example.com/featured.jpg',
        media_url: 'https://example.com/story.mp4',
        media_kind: 'video',
        media_mime: 'video/mp4'
      }
    );

    expect(preview.mediaUrl).toBe('https://example.com/featured.jpg');
    expect(preview.mediaType).toBe('image');
    expect(preview.text).toBe('Story excerpt');
  });

  it('does not build queue steps for disabled templates', () => {
    expect(
      testUtils.getTemplateQueueSteps({
        active: false,
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true
      })
    ).toEqual([]);
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

  it('temporarily holds channel media after a newsletter ack rejection', () => {
    const target = { id: 'target-1', phone_number: '120363000@newsletter', type: 'channel' };
    const now = Date.parse('2026-04-24T12:00:00.000Z');

    expect(testUtils.isChannelMediaTemporarilyBlocked(target, now)).toBe(false);
    testUtils.rememberChannelMediaRejection(target, now);
    expect(testUtils.isChannelMediaTemporarilyBlocked(target, now + 1000)).toBe(true);
    expect(testUtils.buildChannelMediaHoldError('image', 'WhatsApp server rejected message ack 479')).toContain(
      'not posted'
    );
    expect(testUtils.buildChannelMediaHoldError('image', 'WhatsApp server rejected message ack 479')).not.toContain(
      'sent text/link preview'
    );
  });

  it('rejects status snapshots made only of implicit LID recipients', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['103140015788103@lid', '103140015788104@lid'],
        sources: {
          groupMetadata: 2,
          env: 0,
          activeIndividualTargets: 0,
          recentSuccessfulDirectRecipients: 0,
          lidMappings: 0
        }
      })
    ).toThrow('explicit/private recipients');
  });

  it('rejects all-LID status snapshots even when a stale mapping counter exists', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['103140015788103@lid', '103140015788104@lid'],
        sources: {
          groupMetadata: 2,
          env: 0,
          activeIndividualTargets: 0,
          recentSuccessfulDirectRecipients: 0,
          lidMappings: 1
        }
      })
    ).toThrow('explicit/private recipients');
  });

  it('rejects group participant status snapshots even after LID phone mapping', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['972501234567@s.whatsapp.net'],
        sources: {
          groupMetadata: 2,
          env: 0,
          activeIndividualTargets: 0,
          recentSuccessfulDirectRecipients: 0,
          lidMappings: 1
        }
      })
    ).toThrow('explicit/private recipients');
  });

  it('allows group participant status snapshots when production group audience is enabled', () => {
    const originalInclude = process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
    const originalAllow = process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
    process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = 'true';
    process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = 'unsafe';

    try {
      expect(() =>
        testUtils.assertUsableStatusAudience({
          recipients: ['972501234567@s.whatsapp.net'],
          sources: {
            groupMetadata: 2,
            env: 0,
            activeIndividualTargets: 0,
            recentSuccessfulDirectRecipients: 0,
            lidMappings: 1
          }
        })
      ).not.toThrow();
    } finally {
      if (originalInclude === undefined) delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
      else process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = originalInclude;
      if (originalAllow === undefined) delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
      else process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = originalAllow;
    }
  });

  it('allows group participant status snapshots when the snapshot says group audience was enabled', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['972501234567@s.whatsapp.net'],
        groupAudienceAllowed: true,
        sources: {
          groupMetadata: 2,
          env: 0,
          activeIndividualTargets: 0,
          recentSuccessfulDirectRecipients: 0,
          lidMappings: 1
        }
      })
    ).not.toThrow();
  });

  it('allows status snapshots resolved from private contacts', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['972501234567@s.whatsapp.net'],
        sources: {
          contactsCache: 1,
          storeContacts: 0,
          storeChats: 0,
          groupMetadata: 0,
          env: 0,
          activeIndividualTargets: 0,
          recentSuccessfulDirectRecipients: 0,
          lidMappings: 0
        }
      })
    ).not.toThrow();
  });

  it('requeues only stale rows that do not already have a sent sibling', () => {
    const rows = [
      { id: 'log-1', schedule_id: 'schedule-1', target_id: 'target-1', feed_item_id: 'feed-1' },
      { id: 'log-2', schedule_id: 'schedule-1', target_id: 'target-1', feed_item_id: 'feed-2' },
      { id: 'log-3', schedule_id: 'schedule-2', target_id: 'target-2', feed_item_id: 'feed-3' }
    ];
    const successfulDispatchKeys = new Set<string>(['schedule-1:target-1:feed-2:0']);

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

  it('preserves millisecond precision when queue cursors come back as Date objects', () => {
    const plan = testUtils.planFeedDispatchPage([
      { id: 'cursor-row', created_at: new Date('2026-05-04T04:38:38.286Z'), pub_date: '2026-05-04T04:38:06.000Z' }
    ]);

    expect(plan.cursorAt).toBe('2026-05-04T04:38:38.286Z');
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

  it('clamps queue cursors to a bounded lookback so old backlog is not replayed', () => {
    const nowMs = Date.parse('2026-04-24T17:30:00.000Z');

    expect(testUtils.normalizeQueueLookbackHours(undefined)).toBe(24);
    expect(testUtils.normalizeQueueLookbackHours(999)).toBe(24);
    expect(testUtils.normalizeQueueLookbackHours(0)).toBe(1);
    expect(testUtils.normalizeQueueCursorIso(new Date('2026-04-24T17:00:00.000Z'))).toBe(
      '2026-04-24T17:00:00.000Z'
    );
    expect(testUtils.normalizeQueueCursorIso('Mon Apr 27 2026 09:06:00 GMT-0400')).toBe(
      '2026-04-27T13:06:00.000Z'
    );
    expect(testUtils.clampQueueCursorToLookback('2026-04-20T12:00:00.000Z', 1, nowMs)).toBe(
      '2026-04-24T16:30:00.000Z'
    );
    expect(testUtils.clampQueueCursorToLookback('2026-04-24T17:00:00.000Z', 1, nowMs)).toBe(
      '2026-04-24T17:00:00.000Z'
    );
  });

  it('detects stuck queue pagination cursors after timestamp precision is rounded', () => {
    const cursorAt = '2026-04-29T00:31:42.498Z';

    expect(testUtils.hasQueueCursorAdvanced(cursorAt, 'b', cursorAt, 'b')).toBe(false);
    expect(testUtils.hasQueueCursorAdvanced(cursorAt, 'b', cursorAt, 'c')).toBe(true);
    expect(
      testUtils.hasQueueCursorAdvanced(
        cursorAt,
        'b',
        new Date('2026-04-29T00:31:42.498Z'),
        'b'
      )
    ).toBe(false);
    expect(testUtils.hasQueueCursorAdvanced(cursorAt, 'b', '2026-04-29T00:31:42.499Z', 'a')).toBe(true);
  });

  it('filters repeated feed cursor rows before planning the next queue page', () => {
    const cursorAt = '2026-04-29T00:31:42.498Z';
    const page = [
      { id: 'b', created_at: cursorAt, pub_date: '2026-04-29T00:31:42.498Z' },
      { id: 'c', created_at: cursorAt, pub_date: '2026-04-29T00:31:42.498Z' },
      { id: 'a', created_at: '2026-04-29T00:31:42.497Z', pub_date: '2026-04-29T00:31:42.497Z' },
      { id: 'd', created_at: '2026-04-29T00:31:42.499Z', pub_date: '2026-04-29T00:31:42.499Z' }
    ];

    expect(testUtils.filterFeedPageAfterCursor(page, cursorAt, 'b').map((item: { id: string }) => item.id)).toEqual(['c', 'd']);
    expect(testUtils.filterFeedPageAfterCursor(page, cursorAt, null).map((item: { id: string }) => item.id)).toEqual([
      'b',
      'c',
      'a',
      'd'
    ]);
  });

  it('accepts only real image candidates for feed automation images', () => {
    expect(testUtils.isUsableFeedImageUrl('https://example.com/photo.jpg')).toBe(true);
    expect(testUtils.isUsableFeedImageUrl('https://example.com/video.mp4')).toBe(false);
    expect(testUtils.isUsableFeedImageUrl('https://example.com/images/default-image.jpg')).toBe(false);
    expect(testUtils.isUsableFeedImageUrl('https://files.anash.org/uploads/2025/09/Anash-Logo.svg')).toBe(false);
    expect(testUtils.isUsableFeedImageUrl('https://example.com/icons/site-icon.png')).toBe(false);
  });

  it('treats repeated Baileys crypto/session errors as auth-state failures for queue handling', () => {
    expect(testUtils.isAuthStateError('Bad MAC')).toBe(true);
    expect(testUtils.isAuthStateError('No matching sessions found for message')).toBe(true);
    expect(testUtils.isAuthStateError('no session record')).toBe(true);
  });
});
