type MediaKind = 'image' | 'video' | 'audio' | 'document';

type ParsedMediaDataUrl = {
  buffer: Buffer;
  mimetype: string;
  kind: MediaKind;
  filename: string | null;
};

const MAX_MEDIA_BYTES: Record<MediaKind, number> = {
  image: 8 * 1024 * 1024,
  video: 32 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  document: 25 * 1024 * 1024
};

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+/-]+);base64,([a-zA-Z0-9+/=\s]+)$/;

const isMediaDataUrl = (value: unknown) => DATA_URL_PATTERN.test(String(value || '').trim());

const detectImageMimeTypeFromBuffer = (buffer: Buffer): string | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
};

const detectKindFromMime = (mimetype: string): MediaKind => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

const normalizeFilename = (value?: string | null) => {
  const filename = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 180);
  return filename || null;
};

const assertMediaKindMatches = (expectedKind: MediaKind | null | undefined, actualKind: MediaKind) => {
  if (expectedKind && expectedKind !== actualKind) {
    throw new Error(`Attachment type mismatch: expected ${expectedKind}, got ${actualKind}`);
  }
};

const parseMediaDataUrl = (
  value: string,
  options?: {
    expectedKind?: MediaKind | null;
    filename?: string | null;
    maxBytes?: number;
  }
): ParsedMediaDataUrl => {
  const raw = String(value || '').trim();
  const match = raw.match(DATA_URL_PATTERN);
  if (!match || !match[1] || !match[2]) {
    throw new Error('Attachment must be a valid base64 data URL');
  }

  const declaredMime = String(match[1]).trim().toLowerCase();
  const buffer = Buffer.from(String(match[2]).replace(/\s+/g, ''), 'base64');
  if (!buffer.length) {
    throw new Error('Attachment is empty');
  }

  const declaredKind = detectKindFromMime(declaredMime);
  assertMediaKindMatches(options?.expectedKind || null, declaredKind);
  const maxBytes = Math.max(1, Math.floor(Number(options?.maxBytes || MAX_MEDIA_BYTES[declaredKind])));
  if (buffer.length > maxBytes) {
    throw new Error(`Attachment too large (${buffer.length} bytes)`);
  }

  if (declaredKind === 'image') {
    const detectedMime = detectImageMimeTypeFromBuffer(buffer);
    if (!detectedMime || !['image/jpeg', 'image/png', 'image/webp'].includes(detectedMime)) {
      throw new Error('Image attachment must be a valid jpeg, png, or webp image');
    }
    return {
      buffer,
      mimetype: detectedMime,
      kind: 'image',
      filename: normalizeFilename(options?.filename)
    };
  }

  if (declaredKind === 'video') {
    const hasMp4Signature = buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
    if (!hasMp4Signature) {
      throw new Error('Video attachment must be an mp4 video');
    }
    return {
      buffer,
      mimetype: 'video/mp4',
      kind: 'video',
      filename: normalizeFilename(options?.filename)
    };
  }

  if (declaredKind === 'audio') {
    if (!declaredMime.startsWith('audio/')) {
      throw new Error('Audio attachment must use an audio MIME type');
    }
    return {
      buffer,
      mimetype: declaredMime,
      kind: 'audio',
      filename: normalizeFilename(options?.filename)
    };
  }

  return {
    buffer,
    mimetype: declaredMime || 'application/octet-stream',
    kind: 'document',
    filename: normalizeFilename(options?.filename) || 'attachment'
  };
};

module.exports = {
  isMediaDataUrl,
  parseMediaDataUrl
};

export {};
