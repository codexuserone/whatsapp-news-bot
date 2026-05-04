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
});
