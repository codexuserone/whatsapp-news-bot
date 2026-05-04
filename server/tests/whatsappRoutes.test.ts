import { describe, expect, it } from '@jest/globals';

const whatsappRoutes = require('../src/routes/whatsapp');

describe('whatsapp route test-send logging resolution', () => {
  const testUtils = whatsappRoutes.__testUtils;

  it('marks confirmed sends as sent', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: true, via: 'ack', status: 2, statusLabel: 'server' },
        confirmedAt: '2026-03-18T21:00:00.000Z'
      })
    ).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T21:00:00.000Z'
    });
  });

  it('marks unconfirmed sends as uncertain instead of sent', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: false, via: 'upsert', status: 1, statusLabel: 'pending' }
      })
    ).toMatchObject({
      status: 'uncertain',
      sentAt: null
    });
  });

  it('keeps channel local-upsert confirmations send-only', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: true, via: 'upsert', status: 1, statusLabel: 'pending' },
        confirmedAt: '2026-03-18T21:00:00.000Z'
      })
    ).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T21:00:00.000Z'
    });
  });

  it('does not turn test-send read ACKs into read history', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: true, via: 'ack', status: 4, statusLabel: 'read' },
        confirmedAt: '2026-03-18T21:00:00.000Z'
      })
    ).toEqual({
      status: 'sent',
      errorMessage: null,
      sentAt: '2026-03-18T21:00:00.000Z'
    });
  });

  it('marks missing message ids as uncertain', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: null,
        confirmation: null
      })
    ).toMatchObject({
      status: 'uncertain',
      sentAt: null
    });
  });

  it('blocks implicit LID-only status audiences', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['103140015788103@lid', '103140015788104@lid'],
        sources: { groupMetadata: 2, env: 0, activeIndividualTargets: 0, recentSuccessfulDirectRecipients: 0, lidMappings: 0 }
      })
    ).toThrow('explicit/private recipients');
  });

  it('blocks all-LID status audiences even when a stale mapping counter exists', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['103140015788103@lid', '103140015788104@lid'],
        sources: { groupMetadata: 2, env: 0, activeIndividualTargets: 0, recentSuccessfulDirectRecipients: 0, lidMappings: 1 }
      })
    ).toThrow('explicit/private recipients');
  });

  it('blocks group-derived status audiences even after LID phone mappings', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['972501234567@s.whatsapp.net'],
        sources: { groupMetadata: 1, env: 0, activeIndividualTargets: 0, recentSuccessfulDirectRecipients: 0, lidMappings: 1 }
      })
    ).toThrow('explicit/private recipients');
  });

  it('allows group-derived status audiences when production group audience is enabled', () => {
    const originalInclude = process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
    const originalAllow = process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
    process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = 'true';
    process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = 'unsafe';

    try {
      expect(() =>
        testUtils.assertUsableStatusAudience({
          recipients: ['972501234567@s.whatsapp.net'],
          sources: { groupMetadata: 1, env: 0, activeIndividualTargets: 0, recentSuccessfulDirectRecipients: 0, lidMappings: 1 }
        })
      ).not.toThrow();
    } finally {
      if (originalInclude === undefined) delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
      else process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = originalInclude;
      if (originalAllow === undefined) delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
      else process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = originalAllow;
    }
  });

  it('allows group-derived status audiences when the snapshot says group audience was enabled', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['972501234567@s.whatsapp.net'],
        groupAudienceAllowed: true,
        sources: { groupMetadata: 1, env: 0, activeIndividualTargets: 0, recentSuccessfulDirectRecipients: 0, lidMappings: 1 }
      })
    ).not.toThrow();
  });
});
