export type TemplatePreviewSendMode = 'auto_media' | 'media_only' | 'text_preview' | 'text_only';
export type TemplatePreviewMediaSource = 'auto' | 'image' | 'video';
export type TemplatePreviewMediaKind = 'image' | 'video' | 'audio' | 'document' | '';

export type TemplatePreviewPayload = {
  jid: string;
  message: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
  documentUrl?: string;
  statusJidList?: string[];
  backgroundColor?: string;
  font?: number;
  includeCaption?: boolean;
  disableLinkPreview?: boolean;
  confirm?: boolean;
};

export type TemplatePreviewStepPayload = {
  label: string;
  delaySeconds: number;
  payload: TemplatePreviewPayload;
};

type TemplatePreviewStepInput = {
  label?: string;
  content: string;
  sendMode: TemplatePreviewSendMode;
  mediaSource: TemplatePreviewMediaSource;
  statusBackgroundColor?: string | null;
  statusFont?: number | null;
  delaySeconds?: number | null;
  active?: boolean | null;
};

type TemplatePreviewInput = {
  jid: string;
  statusAudience: string[];
  isStatus: boolean;
  sampleData: Record<string, unknown>;
  fallback: Omit<TemplatePreviewStepInput, 'label' | 'delaySeconds' | 'active'>;
  sequenceSteps: TemplatePreviewStepInput[];
};

const WORD_JOINER = '\u2060';
const DEFAULT_STATUS_BACKGROUND = '#0f172a';

const escapeWhatsAppFormatting = (value: unknown) => {
  const text = String(value ?? '');
  if (!text) return '';
  return text.replace(/([*_~`])(?!\u2060)/g, `$1${WORD_JOINER}`);
};

const applyTemplate = (content: string, data: Record<string, unknown>) => {
  if (!content || !data) return content;
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) return `{{${key}}}`;
    return escapeWhatsAppFormatting(value);
  });
};

const normalizeDelaySeconds = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(3600, Math.floor(parsed))) : 0;
};

const resolveStatusBackgroundColor = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_STATUS_BACKGROUND;
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-f]{6}$/i.test(withHash) ? withHash.toLowerCase() : DEFAULT_STATUS_BACKGROUND;
};

const resolveStatusFont = (value: unknown) => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : 0;
};

const messageWithPreviewLink = (message: string, data: Record<string, unknown>) => {
  const link = String(data.link || data.url || '').trim();
  if (!link || /https?:\/\//i.test(message)) return message.trim();
  return `${message}\n${link}`.trim();
};

const inferMediaKind = (mediaUrl: string, rawKind: string): TemplatePreviewMediaKind => {
  if (rawKind === 'video' || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(mediaUrl)) return 'video';
  if (rawKind === 'audio' || /\.(mp3|wav|ogg|m4a|flac|aac|opus)(?:[?#]|$)/i.test(mediaUrl)) return 'audio';
  if (rawKind === 'document' || /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|txt|rtf|zip)(?:[?#]|$)/i.test(mediaUrl)) {
    return 'document';
  }
  return mediaUrl ? 'image' : '';
};

const selectMediaForSource = (
  data: Record<string, unknown>,
  source: TemplatePreviewMediaSource
) => {
  const imageUrl = String(data.image_url || data.imageUrl || '').trim();
  const mediaUrl = String(data.media_url || data.mediaUrl || '').trim();
  const rawKind = String(data.media_kind || data.mediaKind || '').trim().toLowerCase();
  const inferredKind = inferMediaKind(mediaUrl, rawKind);

  if (source === 'image') {
    return imageUrl
      ? { mediaUrl: imageUrl, mediaKind: 'image' as TemplatePreviewMediaKind }
      : inferredKind === 'image'
        ? { mediaUrl, mediaKind: 'image' as TemplatePreviewMediaKind }
        : { mediaUrl: '', mediaKind: '' as TemplatePreviewMediaKind };
  }

  if (source === 'video') {
    return inferredKind === 'video'
      ? { mediaUrl, mediaKind: 'video' as TemplatePreviewMediaKind }
      : { mediaUrl: '', mediaKind: '' as TemplatePreviewMediaKind };
  }

  return { mediaUrl: mediaUrl || imageUrl, mediaKind: inferredKind || (imageUrl ? 'image' : '' as TemplatePreviewMediaKind) };
};

const mediaPatchFor = (mediaUrl: string, mediaKind: TemplatePreviewMediaKind) => {
  if (mediaKind === 'video') return { videoUrl: mediaUrl };
  if (mediaKind === 'audio') return { audioUrl: mediaUrl };
  if (mediaKind === 'document') return { documentUrl: mediaUrl };
  return { imageUrl: mediaUrl };
};

export const buildTemplatePreviewSendPayloads = ({
  jid,
  statusAudience,
  isStatus,
  sampleData,
  fallback,
  sequenceSteps
}: TemplatePreviewInput): TemplatePreviewStepPayload[] => {
  const statusAudiencePatch = isStatus ? { statusJidList: statusAudience } : {};
  const activeSequenceSteps = sequenceSteps
    .filter((step) => step.active !== false && String(step.content || '').trim())
    .map((step, index) => ({
      ...step,
      label: String(step.label || `Step ${index + 1}`).trim() || `Step ${index + 1}`,
      delaySeconds: normalizeDelaySeconds(step.delaySeconds)
    }));
  const steps = activeSequenceSteps.length
    ? activeSequenceSteps
    : [{ ...fallback, label: 'Preview', delaySeconds: 0 }];

  return steps.map((step) => {
    const baseMessage = applyTemplate(step.content || '', sampleData).trim();
    const media = selectMediaForSource(sampleData, step.mediaSource);
    const statusTextStylePatch = isStatus
      ? {
        backgroundColor: resolveStatusBackgroundColor(step.statusBackgroundColor),
        font: resolveStatusFont(step.statusFont)
      }
      : {};

    if (isStatus && media.mediaUrl && (media.mediaKind === 'audio' || media.mediaKind === 'document')) {
      throw new Error('Status previews support text, image, and video only.');
    }

    if (step.sendMode === 'media_only') {
      if (!media.mediaUrl) {
        throw new Error(`${step.label} needs sample media.`);
      }
      return {
        label: step.label,
        delaySeconds: normalizeDelaySeconds(step.delaySeconds),
        payload: {
          jid,
          message: baseMessage || ' ',
          ...mediaPatchFor(media.mediaUrl, media.mediaKind),
          includeCaption: false,
          confirm: true,
          ...statusAudiencePatch
        }
      };
    }

    if (step.sendMode === 'auto_media' && media.mediaUrl) {
      return {
        label: step.label,
        delaySeconds: normalizeDelaySeconds(step.delaySeconds),
        payload: {
          jid,
          message: baseMessage,
          ...mediaPatchFor(media.mediaUrl, media.mediaKind),
          includeCaption: true,
          confirm: true,
          ...statusAudiencePatch
        }
      };
    }

    if (step.sendMode === 'auto_media' || step.sendMode === 'text_preview') {
      return {
        label: step.label,
        delaySeconds: normalizeDelaySeconds(step.delaySeconds),
        payload: {
          jid,
          message: messageWithPreviewLink(baseMessage, sampleData),
          disableLinkPreview: false,
          confirm: true,
          ...statusTextStylePatch,
          ...statusAudiencePatch
        }
      };
    }

    return {
      label: step.label,
      delaySeconds: normalizeDelaySeconds(step.delaySeconds),
      payload: {
        jid,
        message: baseMessage,
        disableLinkPreview: true,
        confirm: true,
        ...statusTextStylePatch,
        ...statusAudiencePatch
      }
    };
  });
};
