import { describe, expect, it } from '@jest/globals';

const templateRoutes = require('../src/routes/templates');

describe('template route normalization', () => {
  const testUtils = templateRoutes.__testUtils;

  it('stores modern auto media mode using the legacy database enum', () => {
    expect(
      testUtils.normalizeTemplatePayload({
        name: 'Test',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true
      })
    ).toMatchObject({
      send_mode: 'image',
      send_images: true
    });
  });

  it('stores text preview using the legacy database enum', () => {
    expect(
      testUtils.normalizeTemplatePayload({
        name: 'Test',
        content: '{{title}}',
        send_mode: 'text_preview',
        send_images: false
      })
    ).toMatchObject({
      send_mode: 'link_preview',
      send_images: false
    });
  });

  it('maps legacy stored modes back to modern UI labels', () => {
    expect(
      testUtils.normalizeTemplateResponse({
        id: 'template-1',
        send_mode: 'image',
        send_images: true
      })
    ).toMatchObject({
      send_mode: 'auto_media',
      send_images: true
    });

    expect(
      testUtils.normalizeTemplateResponse({
        id: 'template-2',
        send_mode: 'link_preview',
        send_images: false
      })
    ).toMatchObject({
      send_mode: 'text_preview',
      send_images: false
    });
  });
});
