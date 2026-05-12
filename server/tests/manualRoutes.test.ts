import { describe, expect, it } from '@jest/globals';

const manualRoutes = require('../src/routes/manual');

describe('manual route queue payloads', () => {
  const testUtils = manualRoutes.__testUtils;

  it('deduplicates target ids for multi-target manual sends', () => {
    expect(
      testUtils.buildTargetIds({
        target_id: 'target-1',
        target_ids: ['target-1', 'target-2', '', 'target-2']
      })
    ).toEqual(['target-1', 'target-2']);
  });

  it('stores attachment and caption flags as first-class queue fields', () => {
    const rows = testUtils.buildManualLogRows({
      target_ids: ['target-1'],
      message: 'Caption text',
      imageDataUrl: 'data:image/png;base64,AAAA',
      includeCaption: false,
      disableLinkPreview: true
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_id: 'target-1',
      media_url: 'data:image/png;base64,AAAA',
      media_type: 'image',
      disable_link_preview: true,
      include_caption: false,
      media_sent: false,
      status: 'pending'
    });
    expect(rows[0].message_content).toContain('__WNB_MANUAL_META__=');
  });

  it('summarizes legacy unresolved manual send results as failures', () => {
    const response = testUtils.buildManualSendResponse(
      [
        { id: 'sent-row' },
        { id: 'uncertain-row' },
        { id: 'held-row' },
        { id: 'failed-row' }
      ],
      [
        { id: 'sent-row', status: 'sent', whatsapp_message_id: 'msg-1', media_sent: true },
        {
          id: 'uncertain-row',
          status: 'uncertain',
          whatsapp_message_id: 'msg-2',
          media_sent: false,
          error_message: 'Server ack was not observed yet'
        },
        {
          id: 'held-row',
          status: 'awaiting_approval',
          media_sent: false,
          error_message: 'Channel media is held for review'
        },
        {
          id: 'failed-row',
          status: 'failed',
          media_sent: false,
          error_message: 'Unsupported attachment'
        }
      ]
    );

    expect(response).toMatchObject({
      ok: false,
      queued: 4,
      sent: 1,
      held: 1,
      failed: 2
    });
    expect(response.results).toEqual([
      {
        id: 'sent-row',
        status: 'sent',
        ok: true,
        messageId: 'msg-1',
        mediaSent: true,
        error: null
      },
      {
        id: 'uncertain-row',
        status: 'failed',
        ok: false,
        messageId: 'msg-2',
        mediaSent: false,
        error: 'WhatsApp did not confirm this send. It was not counted as sent.'
      },
      {
        id: 'held-row',
        status: 'awaiting_approval',
        ok: false,
        messageId: null,
        mediaSent: false,
        error: 'Channel media is held for review'
      },
      {
        id: 'failed-row',
        status: 'failed',
        ok: false,
        messageId: null,
        mediaSent: false,
        error: 'Unsupported attachment'
      }
    ]);
  });

  it('counts delivered, read, and played manual rows as sent outcomes', () => {
    const response = testUtils.buildManualSendResponse(
      [{ id: 'delivered-row' }, { id: 'read-row' }, { id: 'played-row' }],
      [
        { id: 'delivered-row', status: 'delivered' },
        { id: 'read-row', status: 'read' },
        { id: 'played-row', status: 'played' }
      ]
    );

    expect(response).toMatchObject({
      ok: true,
      queued: 3,
      sent: 3,
      held: 0,
      failed: 0
    });
  });
});
