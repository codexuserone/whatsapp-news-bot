const logger = require('./logger');

const isNewsletterJid = (jid: string) => String(jid || '').trim().toLowerCase().endsWith('@newsletter');

type PreparedNewsletterImage = {
  buffer: Buffer;
  mimetype: string;
  jpegThumbnail?: string;
  width?: number;
  height?: number;
  converted: boolean;
};

const prepareNewsletterImage = async (
  input: Buffer,
  options?: { maxBytes?: number; jpegQuality?: number; thumbWidth?: number }
): Promise<PreparedNewsletterImage> => {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const maxBytes = Math.max(Number(options?.maxBytes ?? 8 * 1024 * 1024), 1);
  const jpegQuality = Math.min(Math.max(Number(options?.jpegQuality ?? 82), 30), 95);
  const thumbWidth = Math.min(Math.max(Number(options?.thumbWidth ?? 32), 16), 96);

  if (!buffer.length) {
    throw new Error('Empty image buffer');
  }
  if (buffer.length > maxBytes) {
    throw new Error(`Image too large (${buffer.length} bytes)`);
  }

  const detectMimeTypeFromBuffer = (value: Buffer): string | null => {
    if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg';
    if (
      value.length >= 8 &&
      value[0] === 0x89 &&
      value[1] === 0x50 &&
      value[2] === 0x4e &&
      value[3] === 0x47 &&
      value[4] === 0x0d &&
      value[5] === 0x0a &&
      value[6] === 0x1a &&
      value[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (
      value.length >= 12 &&
      value.slice(0, 4).toString('ascii') === 'RIFF' &&
      value.slice(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return null;
  };

  const inputMime = detectMimeTypeFromBuffer(buffer) || 'application/octet-stream';
  const shouldConvertToJpeg = inputMime !== 'image/jpeg';

  // Keep sharp optional at runtime (Render builds can occasionally fail to install it).
  let sharp: any;
  try {
    sharp = require('sharp');
  } catch (error) {
    logger.warn({ error }, 'sharp not available; sending image without newsletter-specific normalization');
    return { buffer, mimetype: inputMime, converted: false };
  }

  let converted = false;
  let jpegBuffer = buffer;
  let width: number | undefined;
  let height: number | undefined;
  let jpegThumbnail: string | undefined;

  try {
    // metadata() is useful even if we don't convert; WhatsApp clients render better with dimensions.
    const meta = await sharp(buffer, { failOnError: false }).metadata();
    if (Number.isFinite(meta?.width)) width = Number(meta.width);
    if (Number.isFinite(meta?.height)) height = Number(meta.height);
  } catch {
    // Best-effort only.
  }

  try {
    if (shouldConvertToJpeg) {
      jpegBuffer = await sharp(buffer, { failOnError: false })
        .rotate()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toBuffer();
      if (!jpegBuffer.length) {
        throw new Error('sharp produced an empty JPEG buffer');
      }
      if (jpegBuffer.length > maxBytes) {
        throw new Error(`JPEG too large (${jpegBuffer.length} bytes)`);
      }
      converted = true;
    }

    const thumbBuf = await sharp(jpegBuffer, { failOnError: false })
      .resize({ width: thumbWidth })
      .jpeg({ quality: 50, mozjpeg: true })
      .toBuffer();
    if (thumbBuf.length) {
      jpegThumbnail = thumbBuf.toString('base64');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to generate newsletter image thumbnail/dimensions');
  }

  const result: PreparedNewsletterImage = {
    buffer: jpegBuffer,
    mimetype: converted ? 'image/jpeg' : inputMime,
    converted
  };
  if (jpegThumbnail) {
    result.jpegThumbnail = jpegThumbnail;
  }
  if (typeof width === 'number') {
    result.width = width;
  }
  if (typeof height === 'number') {
    result.height = height;
  }
  return result;
};

module.exports = {
  isNewsletterJid,
  prepareNewsletterImage
};

export {};
