type FeedMediaKind = 'image' | 'video';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg'];
const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm', '.m4v'];

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

const inferMediaKindFromUrl = (value: unknown): FeedMediaKind | null => {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
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
  if (normalized === 'image' || normalized === 'video') return normalized;
  return null;
};

const normalizeFeedMedia = (input: {
  mediaUrl?: unknown;
  mediaKind?: unknown;
  imageUrl?: unknown;
  rawData?: Record<string, unknown> | null;
}) => {
  const rawData = input.rawData && typeof input.rawData === 'object' ? input.rawData : null;

  const directMediaUrl = normalizeUrl(input.mediaUrl);
  const directMediaKind = readMediaKind(input.mediaKind);
  if (directMediaUrl) {
    const inferred = directMediaKind || inferMediaKindFromUrl(directMediaUrl);
    if (inferred) {
      return {
        mediaUrl: directMediaUrl,
        mediaKind: inferred,
        imageUrl: inferred === 'image' ? directMediaUrl : ''
      };
    }
  }

  const rawMediaUrl = normalizeUrl(rawData?.media_url);
  const rawMediaKind = readMediaKind(rawData?.media_kind);
  if (rawMediaUrl) {
    const inferred = rawMediaKind || inferMediaKindFromUrl(rawMediaUrl);
    if (inferred) {
      return {
        mediaUrl: rawMediaUrl,
        mediaKind: inferred,
        imageUrl: inferred === 'image' ? rawMediaUrl : ''
      };
    }
  }

  const imageUrl = normalizeUrl(input.imageUrl || rawData?.image_url);
  if (imageUrl) {
    const inferred = inferMediaKindFromUrl(imageUrl) || 'image';
    return {
      mediaUrl: imageUrl,
      mediaKind: inferred,
      imageUrl: inferred === 'image' ? imageUrl : ''
    };
  }

  return { mediaUrl: '', mediaKind: null, imageUrl: '' };
};

module.exports = {
  inferMediaKindFromUrl,
  normalizeFeedMedia
};

export { };
