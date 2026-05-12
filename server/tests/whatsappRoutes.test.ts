import { describe, expect, it } from '@jest/globals';

const whatsappRoutes = require('../src/routes/whatsapp');

describe('whatsapp route test-send logging resolution', () => {
  const testUtils = whatsappRoutes.__testUtils;

  const buildTargetsSupabaseMock = (seed: Array<Record<string, any>>) => {
    const rows = seed.map((row) => ({ ...row }));

    class SelectBuilder {
      private filters: Array<(row: Record<string, any>) => boolean> = [];

      in(field: string, values: any[]) {
        this.filters.push((row) => values.includes(row[field]));
        return this;
      }

      eq(field: string, value: any) {
        this.filters.push((row) => row[field] === value);
        return this;
      }

      then(resolve: (value: any) => any) {
        return resolve({
          data: rows.filter((row) => this.filters.every((filter) => filter(row))).map((row) => ({ ...row })),
          error: null
        });
      }
    }

    class UpdateBuilder {
      private filters: Array<(row: Record<string, any>) => boolean> = [];

      constructor(private readonly patch: Record<string, any>) {}

      in(field: string, values: any[]) {
        this.filters.push((row) => values.includes(row[field]));
        return this;
      }

      eq(field: string, value: any) {
        this.filters.push((row) => row[field] === value);
        return this;
      }

      then(resolve: (value: any) => any) {
        for (const row of rows) {
          if (this.filters.every((filter) => filter(row))) {
            Object.assign(row, this.patch);
          }
        }
        return resolve({ data: null, error: null });
      }
    }

    return {
      rows,
      supabase: {
        from: () => ({
          select: () => new SelectBuilder(),
          insert: async (row: Record<string, any>) => {
            rows.push({ id: `inserted-${rows.length + 1}`, ...row });
            return { data: row, error: null };
          },
          update: (patch: Record<string, any>) => new UpdateBuilder(patch)
        })
      }
    };
  };

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

  it('marks unconfirmed sends as failed even when WhatsApp returned a message id', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: false, via: 'upsert', status: 1, statusLabel: 'pending' }
      })
    ).toMatchObject({
      status: 'failed',
      errorMessage: 'Message send not confirmed'
    });
  });

  it('marks explicit WhatsApp ack rejections as failed', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: 'abc123',
        confirmation: { ok: false, via: 'none', error: 'WhatsApp server rejected message ack 479' }
      })
    ).toEqual({
      status: 'failed',
      errorMessage: 'WhatsApp server rejected message ack 479',
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

  it('marks missing message ids as failed', () => {
    expect(
      testUtils.resolveTestSendLogResolution({
        messageId: null,
        confirmation: null
      })
    ).toMatchObject({
      status: 'failed',
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

  it('allows all-LID status audiences when production group audience is enabled', () => {
    expect(() =>
      testUtils.assertUsableStatusAudience({
        recipients: ['103140015788103@lid', '103140015788104@lid'],
        groupAudienceAllowed: true,
        sources: { groupMetadata: 2, env: 0, activeIndividualTargets: 0, recentSuccessfulDirectRecipients: 0, lidMappings: 0 }
      })
    ).not.toThrow();
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

  it('returns only a bounded status audience sample when recipients are requested', () => {
    expect(
      testUtils.buildStatusAudienceResponse(
        {
          participantCount: 3,
          recipients: [
            '12015550101@s.whatsapp.net',
            '12015550102@s.whatsapp.net',
            '12015550103@s.whatsapp.net'
          ],
          sources: { groupMetadata: 3 },
          warnings: []
        },
        { includeRecipients: true, sampleSize: 2, stale: false }
      )
    ).toMatchObject({
      participantCount: 3,
      recipientCount: 3,
      recipients: ['12015550101@s.whatsapp.net', '12015550102@s.whatsapp.net'],
      recipientsTruncated: true,
      sample: ['12015550101@s.whatsapp.net', '12015550102@s.whatsapp.net']
    });
  });

  it('marks status audience samples truncated when total count exceeds returned recipients', () => {
    expect(
      testUtils.buildStatusAudienceResponse(
        {
          participantCount: 1154,
          recipients: [
            '12015550101@s.whatsapp.net',
            '12015550102@s.whatsapp.net',
            '12015550103@s.whatsapp.net',
            '12015550104@s.whatsapp.net',
            '12015550105@s.whatsapp.net'
          ],
          sources: { contactsCache: 1154 },
          warnings: []
        },
        { includeRecipients: true, sampleSize: 5, stale: false }
      )
    ).toMatchObject({
      participantCount: 1154,
      recipientCount: 1154,
      recipientsTruncated: true
    });
  });

  it('does not deactivate saved channels when discovery returns a partial channel list', async () => {
    const { rows, supabase } = buildTargetsSupabaseMock([
      {
        id: 'channel-main',
        type: 'channel',
        active: true,
        name: 'Main Channel',
        phone_number: '120363400000000000@newsletter'
      },
      {
        id: 'channel-test',
        type: 'channel',
        active: true,
        name: 'Test Channel',
        phone_number: '120363406955649221@newsletter'
      }
    ]);

    await testUtils.upsertDiscoveredTargets(
      supabase,
      [
        {
          name: 'Test Channel',
          phone_number: '120363406955649221@newsletter',
          type: 'channel',
          active: true
        }
      ],
      { deactivateMissingTypes: ['channel'] }
    );

    expect(rows.find((row) => row.id === 'channel-main')?.active).toBe(true);
    expect(rows.find((row) => row.id === 'channel-test')?.active).toBe(true);
  });
});
