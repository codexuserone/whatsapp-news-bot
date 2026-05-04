import { describe, expect, it } from '@jest/globals';

const templateRoutes = require('../src/routes/templates');

describe('template route normalization', () => {
  const testUtils = templateRoutes.__testUtils;

  it('stores modern auto media mode directly', () => {
    expect(
      testUtils.normalizeTemplatePayload({
        name: 'Test',
        content: '{{title}}',
        send_mode: 'auto_media',
        send_images: true,
        media_source: 'featured_image'
      })
    ).toMatchObject({
      send_mode: 'auto_media',
      send_images: true,
      media_source: 'image'
    });
  });

  it('stores text preview mode directly', () => {
    expect(
      testUtils.normalizeTemplatePayload({
        name: 'Test',
        content: '{{title}}',
        send_mode: 'text_preview',
        send_images: false
      })
    ).toMatchObject({
      send_mode: 'text_preview',
      send_images: false
    });
  });

  it('preserves disabled template state while normalizing send mode', () => {
    expect(
      testUtils.normalizeTemplatePayload({
        name: 'Disabled',
        content: '{{title}}',
        active: false,
        send_mode: 'text_only'
      })
    ).toMatchObject({
      active: false,
      send_mode: 'text_only',
      send_images: false
    });
  });

  it('maps legacy stored modes back to modern UI labels', () => {
    expect(
      testUtils.normalizeTemplateResponse({
        id: 'template-1',
        send_mode: 'image',
        send_images: true,
        media_source: 'feed_video'
      })
    ).toMatchObject({
      send_mode: 'auto_media',
      send_images: true,
      media_source: 'video'
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

  it('normalizes sequence steps while storing the modern template mode', () => {
    expect(
      testUtils.normalizeTemplatePayload({
        name: 'Status sequence',
        content: '{{title}}',
        status_background_color: '166534',
        status_font: 5,
        send_mode: 'text_preview',
        sequence_steps: [
          { label: 'Text', content: '{{description}}\n{{link}}', send_mode: 'text_preview', status_background_color: '#7e22ce', status_font: 2 },
          { label: 'Image', content: '{{title}}', send_mode: 'media_only', delay_seconds: 10 }
        ]
      })
    ).toMatchObject({
      send_mode: 'text_preview',
      status_background_color: '#166534',
      status_font: 5,
      sequence_steps: [
        {
          label: 'Text',
          content: '{{description}}\n{{link}}',
          send_mode: 'text_preview',
          status_background_color: '#7e22ce',
          status_font: 2,
          delay_seconds: 0,
          active: true
        },
        {
          label: 'Image',
          content: '{{title}}',
          send_mode: 'media_only',
          status_background_color: null,
          status_font: null,
          delay_seconds: 10,
          active: true
        }
      ]
    });
  });

  it('normalizes status style values for template responses', () => {
    expect(
      testUtils.normalizeTemplateResponse({
        id: 'template-3',
        send_mode: 'text_only',
        status_background_color: 'not-a-color',
        status_font: 99,
        sequence_steps: [
          { label: 'Text', content: 'hello', send_mode: 'text_only', status_background_color: 'be123c', status_font: 4 }
        ]
      })
    ).toMatchObject({
      status_background_color: null,
      status_font: 8,
      sequence_steps: [
        {
          status_background_color: '#be123c',
          status_font: 4
        }
      ]
    });
  });
});
