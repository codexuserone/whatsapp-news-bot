import assert from 'node:assert/strict';
import { buildTemplatePreviewSendPayloads } from '../apps/web/lib/templatePreviewPayload';

const payloads = buildTemplatePreviewSendPayloads({
  jid: 'status@broadcast',
  statusAudience: ['19144477725@s.whatsapp.net'],
  isStatus: true,
  sampleData: {
    title: 'Story title',
    excerpt: 'Story excerpt',
    link: 'https://example.test/story',
    image_url: 'https://example.test/story.jpg',
    media_url: 'https://example.test/story.mp4',
    media_kind: 'video'
  },
  fallback: {
    content: '{{title}}',
    sendMode: 'text_only',
    mediaSource: 'auto',
    statusBackgroundColor: '#0f172a',
    statusFont: 0
  },
  sequenceSteps: [
    {
      label: 'Text',
      content: '{{excerpt}}',
      sendMode: 'text_preview',
      mediaSource: 'auto',
      statusBackgroundColor: '#166534',
      statusFont: 2,
      delaySeconds: 0
    },
    {
      label: 'Image',
      content: '{{title}}',
      sendMode: 'auto_media',
      mediaSource: 'image',
      statusBackgroundColor: '#7c2d12',
      statusFont: 3,
      delaySeconds: 1
    },
    {
      label: 'Video',
      content: '{{title}}',
      sendMode: 'media_only',
      mediaSource: 'video',
      statusBackgroundColor: '#be123c',
      statusFont: 4,
      delaySeconds: 2
    }
  ]
});

assert.equal(payloads.length, 3);

assert.deepEqual(payloads[0], {
  label: 'Text',
  delaySeconds: 0,
  payload: {
    jid: 'status@broadcast',
    message: 'Story excerpt\nhttps://example.test/story',
    disableLinkPreview: false,
    confirm: true,
    backgroundColor: '#166534',
    font: 2,
    statusJidList: ['19144477725@s.whatsapp.net']
  }
});

assert.deepEqual(payloads[1], {
  label: 'Image',
  delaySeconds: 1,
  payload: {
    jid: 'status@broadcast',
    message: 'Story title',
    imageUrl: 'https://example.test/story.jpg',
    includeCaption: true,
    confirm: true,
    statusJidList: ['19144477725@s.whatsapp.net']
  }
});

assert.deepEqual(payloads[2], {
  label: 'Video',
  delaySeconds: 2,
  payload: {
    jid: 'status@broadcast',
    message: 'Story title',
    videoUrl: 'https://example.test/story.mp4',
    includeCaption: false,
    confirm: true,
    statusJidList: ['19144477725@s.whatsapp.net']
  }
});

const fallbackPayloads = buildTemplatePreviewSendPayloads({
  jid: '120363407220244757@g.us',
  statusAudience: [],
  isStatus: false,
  sampleData: {
    title: 'No media story',
    link: 'https://example.test/no-media'
  },
  fallback: {
    content: '{{title}}',
    sendMode: 'auto_media',
    mediaSource: 'auto',
    statusBackgroundColor: '#0f172a',
    statusFont: 0
  },
  sequenceSteps: []
});

assert.deepEqual(fallbackPayloads, [
  {
    label: 'Preview',
    delaySeconds: 0,
    payload: {
      jid: '120363407220244757@g.us',
      message: 'No media story\nhttps://example.test/no-media',
      disableLinkPreview: false,
      confirm: true
    }
  }
]);

assert.throws(
  () =>
    buildTemplatePreviewSendPayloads({
      jid: 'status@broadcast',
      statusAudience: ['19144477725@s.whatsapp.net'],
      isStatus: true,
      sampleData: {
        title: 'Audio story',
        media_url: 'https://example.test/audio.mp3',
        media_kind: 'audio'
      },
      fallback: {
        content: '{{title}}',
        sendMode: 'auto_media',
        mediaSource: 'auto',
        statusBackgroundColor: '#0f172a',
        statusFont: 0
      },
      sequenceSteps: []
    }),
  /Status previews support text, image, and video only/
);
