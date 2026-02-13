const logger = require('./logger');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const isNewsletterJid = (jid: string) => String(jid || '').trim().toLowerCase().endsWith('@newsletter');

type PreparedNewsletterImage = {
  buffer: Buffer;
  mimetype: string;
  jpegThumbnail?: string;
  width?: number;
  height?: number;
  converted: boolean;
};

type PreparedNewsletterVideo = {
  buffer: Buffer;
  mimetype: string;
  jpegThumbnail?: string;
  width?: number;
  height?: number;
  seconds?: number;
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

const parseMp4Metadata = (buffer: Buffer): { width?: number; height?: number; seconds?: number } => {
  const result: { width?: number; height?: number; seconds?: number } = {};
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return result;

  const readBoxHeader = (
    offset: number,
    end: number
  ): { type: string; size: number; headerSize: number; dataStart: number; dataEnd: number } | null => {
    if (offset + 8 > end) return null;
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (offset + 16 > end) return null;
      const big = buffer.readBigUInt64BE(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize) return null;
    const dataStart = offset + headerSize;
    const dataEnd = offset + size;
    if (dataEnd > end) return null;
    return { type, size, headerSize, dataStart, dataEnd };
  };

  const findChildBoxes = (start: number, end: number) => {
    const out: Array<{ type: string; dataStart: number; dataEnd: number }> = [];
    let offset = start;
    let guard = 0;
    while (offset < end && guard < 10_000) {
      guard += 1;
      const header = readBoxHeader(offset, end);
      if (!header) break;
      out.push({ type: header.type, dataStart: header.dataStart, dataEnd: header.dataEnd });
      offset = header.dataEnd;
    }
    return out;
  };

  const moov = (() => {
    const top = findChildBoxes(0, buffer.length);
    return top.find((box) => box.type === 'moov') || null;
  })();

  if (!moov) return result;

  let movieDurationSeconds: number | null = null;

  const parseMvhd = (dataStart: number, dataEnd: number) => {
    if (dataEnd - dataStart < 24) return;
    const version = buffer[dataStart];
    if (version === 1) {
      if (dataEnd - dataStart < 32) return;
      const timescale = buffer.readUInt32BE(dataStart + 20);
      const duration = Number(buffer.readBigUInt64BE(dataStart + 24));
      if (timescale > 0 && Number.isFinite(duration)) {
        movieDurationSeconds = duration / timescale;
      }
      return;
    }

    const timescale = buffer.readUInt32BE(dataStart + 12);
    const duration = buffer.readUInt32BE(dataStart + 16);
    if (timescale > 0 && Number.isFinite(duration)) {
      movieDurationSeconds = duration / timescale;
    }
  };

  const parseHdlr = (dataStart: number, dataEnd: number): string | null => {
    if (dataEnd - dataStart < 12) return null;
    return buffer.toString('ascii', dataStart + 8, dataStart + 12);
  };

  const parseMdhdDurationSeconds = (dataStart: number, dataEnd: number): number | null => {
    if (dataEnd - dataStart < 24) return null;
    const version = buffer[dataStart];
    if (version === 1) {
      if (dataEnd - dataStart < 36) return null;
      const timescale = buffer.readUInt32BE(dataStart + 20);
      const duration = Number(buffer.readBigUInt64BE(dataStart + 24));
      if (timescale > 0 && Number.isFinite(duration)) return duration / timescale;
      return null;
    }
    const timescale = buffer.readUInt32BE(dataStart + 12);
    const duration = buffer.readUInt32BE(dataStart + 16);
    if (timescale > 0 && Number.isFinite(duration)) return duration / timescale;
    return null;
  };

  const parseTkhdDimensions = (dataStart: number, dataEnd: number): { width?: number; height?: number } => {
    if (dataEnd - dataStart < 84) return {};
    const version = buffer[dataStart];
    const widthOffset = version === 1 ? dataStart + 88 : dataStart + 76;
    const heightOffset = version === 1 ? dataStart + 92 : dataStart + 80;
    if (heightOffset + 4 > dataEnd) return {};

    const widthFixed = buffer.readUInt32BE(widthOffset);
    const heightFixed = buffer.readUInt32BE(heightOffset);
    const width = Math.floor(widthFixed / 65536);
    const height = Math.floor(heightFixed / 65536);
    const out: { width?: number; height?: number } = {};
    if (Number.isFinite(width) && width > 0) out.width = width;
    if (Number.isFinite(height) && height > 0) out.height = height;
    return out;
  };

  const moovChildren = findChildBoxes(moov.dataStart, moov.dataEnd);
  for (const box of moovChildren) {
    if (box.type === 'mvhd') {
      parseMvhd(box.dataStart, box.dataEnd);
      break;
    }
  }

  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let videoDurationSeconds: number | null = null;

  const trakBoxes = moovChildren.filter((box) => box.type === 'trak');
  for (const trak of trakBoxes) {
    const trakChildren = findChildBoxes(trak.dataStart, trak.dataEnd);
    const tkhd = trakChildren.find((box) => box.type === 'tkhd') || null;
    const mdia = trakChildren.find((box) => box.type === 'mdia') || null;
    if (!mdia) continue;

    const mdiaChildren = findChildBoxes(mdia.dataStart, mdia.dataEnd);
    const hdlr = mdiaChildren.find((box) => box.type === 'hdlr') || null;
    const handlerType = hdlr ? parseHdlr(hdlr.dataStart, hdlr.dataEnd) : null;
    if (handlerType !== 'vide') continue;

    if (tkhd) {
      const dims = parseTkhdDimensions(tkhd.dataStart, tkhd.dataEnd);
      if (dims.width) videoWidth = dims.width;
      if (dims.height) videoHeight = dims.height;
    }

    const mdhd = mdiaChildren.find((box) => box.type === 'mdhd') || null;
    if (mdhd) {
      const seconds = parseMdhdDurationSeconds(mdhd.dataStart, mdhd.dataEnd);
      if (seconds != null && Number.isFinite(seconds) && seconds > 0) {
        videoDurationSeconds = seconds;
      }
    }

    // Stop after the first video track.
    break;
  }

  if (videoWidth) result.width = videoWidth;
  if (videoHeight) result.height = videoHeight;

  const secondsFloat = videoDurationSeconds != null ? videoDurationSeconds : movieDurationSeconds;
  if (secondsFloat != null && Number.isFinite(secondsFloat) && secondsFloat > 0) {
    // WhatsApp expects integer seconds. Round to the nearest second, but keep >= 1.
    result.seconds = Math.max(1, Math.round(secondsFloat));
  }

  return result;
};

const buildPlaceholderVideoThumbnail = async (width: number): Promise<Buffer> => {
  let sharp: any;
  try {
    sharp = require('sharp');
  } catch {
    return Buffer.alloc(0);
  }

  const size = Math.min(Math.max(Math.floor(width), 16), 96);
  const triangleSvg = `
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#000000"/>
  <polygon points="${Math.round(size * 0.42)},${Math.round(size * 0.3)} ${Math.round(size * 0.72)},${Math.round(
    size * 0.5
  )} ${Math.round(size * 0.42)},${Math.round(size * 0.7)}" fill="#ffffff"/>
</svg>`;

  return await sharp(Buffer.from(triangleSvg))
    .jpeg({ quality: 60, mozjpeg: true })
    .toBuffer();
};

const extractVideoThumbWithFfmpeg = async (videoBuffer: Buffer, width: number): Promise<Buffer> => {
  let ffmpegPath: string | null = null;
  try {
    // Optional dependency; if present we can generate real thumbnails without system ffmpeg.
    ffmpegPath = require('ffmpeg-static');
  } catch {
    ffmpegPath = null;
  }

  // If ffmpeg-static is not installed, fall back to system ffmpeg (if any).
  const command = ffmpegPath || (process.env.FFMPEG_PATH ? String(process.env.FFMPEG_PATH) : null);
  if (!command) {
    throw new Error('ffmpeg not available');
  }

  const size = Math.min(Math.max(Math.floor(width), 16), 256);
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `wa-newsletter-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  const outputPath = path.join(tmpDir, `wa-newsletter-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);

  try {
    await fs.writeFile(inputPath, videoBuffer);
    await execFileAsync(command, [
      '-loglevel',
      'error',
      '-ss',
      '00:00:00',
      '-i',
      inputPath,
      '-y',
      '-vf',
      `scale=${size}:-1`,
      '-vframes',
      '1',
      '-f',
      'image2',
      outputPath
    ]);
    const out = await fs.readFile(outputPath);
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } finally {
    await fs.unlink(inputPath).catch(() => undefined);
    await fs.unlink(outputPath).catch(() => undefined);
  }
};

const prepareNewsletterVideo = async (
  input: Buffer,
  options?: { maxBytes?: number; thumbWidth?: number }
): Promise<PreparedNewsletterVideo> => {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const maxBytes = Math.max(Number(options?.maxBytes ?? 32 * 1024 * 1024), 1);
  const thumbWidth = Math.min(Math.max(Number(options?.thumbWidth ?? 32), 16), 96);

  if (!buffer.length) {
    throw new Error('Empty video buffer');
  }
  if (buffer.length > maxBytes) {
    throw new Error(`Video too large (${buffer.length} bytes)`);
  }

  // Minimal MP4 guard. WhatsApp/Baileys expect mp4 for video messages.
  const hasMp4Signature = buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
  if (!hasMp4Signature) {
    throw new Error('Unsupported video format (expected mp4)');
  }

  const meta = parseMp4Metadata(buffer);

  let jpegThumbnail: string | undefined;
  try {
    const thumbBuf = await extractVideoThumbWithFfmpeg(buffer, thumbWidth);
    if (thumbBuf.length) {
      jpegThumbnail = thumbBuf.toString('base64');
    }
  } catch (error) {
    logger.debug({ error }, 'ffmpeg thumbnail generation failed; falling back to placeholder');
    try {
      const placeholder = await buildPlaceholderVideoThumbnail(thumbWidth);
      if (placeholder.length) {
        jpegThumbnail = placeholder.toString('base64');
      }
    } catch (innerError) {
      logger.warn({ error: innerError }, 'Failed to generate placeholder video thumbnail');
    }
  }

  const result: PreparedNewsletterVideo = {
    buffer,
    mimetype: 'video/mp4'
  };
  if (jpegThumbnail) result.jpegThumbnail = jpegThumbnail;
  if (typeof meta.width === 'number') result.width = meta.width;
  if (typeof meta.height === 'number') result.height = meta.height;
  if (typeof meta.seconds === 'number') result.seconds = meta.seconds;
  return result;
};

module.exports = {
  isNewsletterJid,
  prepareNewsletterImage,
  prepareNewsletterVideo
};

export {};
