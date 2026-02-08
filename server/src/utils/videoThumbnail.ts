const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { promises: fs } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

let ffmpegBinaryPath: string | null = null;
try {
  const value = require('ffmpeg-static');
  ffmpegBinaryPath = typeof value === 'string' && value ? value : null;
} catch {
  ffmpegBinaryPath = null;
}

const runFfmpeg = (args: string[], timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    if (!ffmpegBinaryPath) {
      reject(new Error('ffmpeg binary is not available'));
      return;
    }

    const child = spawn(ffmpegBinaryPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('exit', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${String(code)}`));
    });
  });

const safeUnlink = async (filePath: string) => {
  try {
    await fs.unlink(filePath);
  } catch {
    // best effort
  }
};

const generateVideoThumbnailFromBuffer = async (
  videoBuffer: Buffer,
  options?: { seekSeconds?: number; width?: number; timeoutMs?: number }
): Promise<Buffer | null> => {
  if (!ffmpegBinaryPath) return null;
  if (!Buffer.isBuffer(videoBuffer) || !videoBuffer.length) return null;

  const seekSeconds = Number.isFinite(Number(options?.seekSeconds)) ? Math.max(Number(options?.seekSeconds), 0) : 0.2;
  const width = Number.isFinite(Number(options?.width)) ? Math.max(Number(options?.width), 64) : 480;
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs)) ? Math.max(Number(options?.timeoutMs), 3000) : 20000;
  const suffix = randomUUID().replace(/-/g, '');
  const inputPath = join(tmpdir(), `wabot-video-${suffix}.mp4`);
  const outputPath = join(tmpdir(), `wabot-video-${suffix}.jpg`);

  try {
    await fs.writeFile(inputPath, videoBuffer);
    await runFfmpeg(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(seekSeconds),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-1`,
        outputPath
      ],
      timeoutMs
    );

    const thumbnail = await fs.readFile(outputPath);
    if (!thumbnail.length) return null;
    return thumbnail;
  } catch {
    return null;
  } finally {
    await Promise.all([safeUnlink(inputPath), safeUnlink(outputPath)]);
  }
};

module.exports = {
  generateVideoThumbnailFromBuffer,
  hasVideoThumbnailGenerationSupport: Boolean(ffmpegBinaryPath)
};
