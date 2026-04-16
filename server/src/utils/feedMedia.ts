type FeedMediaKind = 'image' | 'video' | 'audio' | 'document';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma'];
const DOCUMENT_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.rtf',
  '.zip'
];

const normalizeUrl = (value: unknown) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
};

const hasExtension = (value: string, extension: string) => {
  const lower = String(value || '').toLowerCase();
  return new RegExp(`${extension.replace('.', '\\.')}([?#]|$)`).test(lower);
};

const normalizeMimeType = (value: unknown) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || '';
};

const readMediaFilename = (value: unknown) => {
  const normalized = String(value || '').trim();
  return normalized || '';
};

const inferMediaKindFromMimeType = (value: unknown): FeedMediaKind | null => {
  const normalized = normalizeMimeType(value);
  if (!normalized) return null;
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  if (
    normalized.startsWith('application/') ||
    normalized === 'text/plain' ||
    normalized === 'text/csv' ||
    normalized === 'text/rtf'
  ) {
    return 'document';
  }
  return null;
};

const inferMediaKindFromUrl = (value: unknown): FeedMediaKind | null => {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  if (AUDIO_EXTENSIONS.some((extension) => hasExtension(normalized, extension))) {
    return 'audio';
  }
  if (DOCUMENT_EXTENSIONS.some((extension) => hasExtension(normalized, extension))) {
    return 'document';
  }
  if (VIDEO_EXTENSIONS.some((extension) => hasExtension(normalized, extension))) {
    return 'video';
  }
  if (IMAGE_EXTENSIONS.some((extension) => hasExtension(normalized, extension))) {
    return 'image';
  }
  return null;
};

const readMediaKind = (value: unknown): FeedMediaKind | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio' || normalized === 'document') {
    return normalized;
  }
  return null;
};

const normalizeImageUrlCandidate = (value: unknown) => {
  const normalized = normalizeUrl(value);
  if (!normalized) return '';
  const inferred = inferMediaKindFromUrl(normalized);
  if (inferred && inferred !== 'image') return '';
  return normalized;
};

const normalizeFeedMedia = (input: {
  mediaUrl?: unknown;
  mediaKind?: unknown;
  mediaMime?: unknown;
  mediaFilename?: unknown;
  imageUrl?: unknown;
  rawData?: Record<string, unknown> | null;
}) => {
  const rawData = input.rawData && typeof input.rawData === 'object' ? input.rawData : null;
  const normalizedImageUrl = normalizeImageUrlCandidate(input.imageUrl || rawData?.image_url);
  const selectKind = (...candidates: Array<FeedMediaKind | null>) => {
    for (const candidate of candidates) {
      if (candidate) return candidate;
    }
    return null;
  };

  const directMediaUrl = normalizeUrl(input.mediaUrl);
  const directMediaKind = readMediaKind(input.mediaKind);
  const directMediaMime = normalizeMimeType(input.mediaMime);
  const directMediaFilename = readMediaFilename(input.mediaFilename);
  if (directMediaUrl) {
    const inferred = selectKind(
      directMediaKind,
      inferMediaKindFromMimeType(directMediaMime),
      inferMediaKindFromUrl(directMediaUrl),
      inferMediaKindFromUrl(directMediaFilename)
    );
    if (inferred) {
      return {
        mediaUrl: directMediaUrl,
        mediaKind: inferred,
        mediaMime: directMediaMime,
        mediaFilename: directMediaFilename,
        imageUrl: inferred === 'image' ? directMediaUrl : normalizedImageUrl
      };
    }
  }

  const rawMediaUrl = normalizeUrl(rawData?.media_url);
  const rawMediaKind = readMediaKind(rawData?.media_kind);
  const rawMediaMime = normalizeMimeType(rawData?.media_mime);
  const rawMediaFilename = readMediaFilename(rawData?.media_filename);
  if (rawMediaUrl) {
    const inferred = selectKind(
      rawMediaKind,
      inferMediaKindFromMimeType(rawMediaMime),
      inferMediaKindFromUrl(rawMediaUrl),
      inferMediaKindFromUrl(rawMediaFilename)
    );
    if (inferred) {
      return {
        mediaUrl: rawMediaUrl,
        mediaKind: inferred,
        mediaMime: rawMediaMime,
        mediaFilename: rawMediaFilename,
        imageUrl: inferred === 'image' ? rawMediaUrl : normalizedImageUrl
      };
    }
  }

  if (normalizedImageUrl) {
    const inferred = inferMediaKindFromUrl(normalizedImageUrl) || 'image';
    return {
      mediaUrl: normalizedImageUrl,
      mediaKind: inferred,
      mediaMime: inferred === 'image' ? 'image/*' : '',
      mediaFilename: '',
      imageUrl: inferred === 'image' ? normalizedImageUrl : ''
    };
  }

  return { mediaUrl: '', mediaKind: null, mediaMime: '', mediaFilename: '', imageUrl: '' };
};

module.exports = {
  inferMediaKindFromUrl,
  inferMediaKindFromMimeType,
  normalizeFeedMedia
};

export { };
