import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const execAsync = promisify(exec);

export interface ExtractClipOptions {
  videoPath: string;
  startSec: number;
  endSec: number;
  outputPath: string;
  codec?: 'copy' | 'reencode';
  quality?: number;
}

export interface SubtitleOverlay {
  pngPath: string;
  tStart: number;
  tEnd: number;
}

export interface CombineClipsOptions {
  clipPaths: string[];
  outputPath: string;
  codec?: 'copy' | 'reencode';
  quality?: number;
  portrait?: boolean;
  textOverlays?: string[];
  /** PNG overlay paths to composite on top of each clip (same length as clipPaths) */
  pngOverlays?: string[];
  /** Subtitle overlays with timing info for each clip */
  subtitleOverlays?: SubtitleOverlay[][];
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
}

function getTempDir(): string {
  const storagePath = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
  const storageDir = path.isAbsolute(storagePath) ? storagePath : path.resolve(process.cwd(), storagePath);
  const tempDir = path.join(storageDir, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  return tempDir;
}

function getOutputDir(): string {
  const storagePath = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
  const storageDir = path.isAbsolute(storagePath) ? storagePath : path.resolve(process.cwd(), storagePath);
  const outputDir = path.join(storageDir, 'output');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  return outputDir;
}

export async function checkFFmpeg(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch (error) {
    console.error('FFmpeg is not installed or not in PATH');
    return false;
  }
}

export async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -show_entries stream=width,height,r_frame_rate,codec_name -of json "${videoPath}"`
    );

    const data = JSON.parse(stdout);
    const videoStream = data.streams.find((s: any) => s.codec_type === 'video');

    let fps = 30;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      fps = den > 0 ? num / den : 30;
    }

    return {
      duration: parseFloat(data.format.duration) || 0,
      width: videoStream?.width || 1920,
      height: videoStream?.height || 1080,
      fps,
      codec: videoStream?.codec_name || 'h264'
    };
  } catch (error) {
    console.error('Failed to get video info:', error);
    throw new Error(`Failed to get video info: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function extractClip(options: ExtractClipOptions): Promise<string> {
  const { videoPath, startSec, endSec, outputPath, codec = 'copy', quality = 23 } = options;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  if (startSec < 0) {
    throw new Error(`Start time must be >= 0: ${startSec}`);
  }

  if (endSec <= startSec) {
    throw new Error(`End time must be > start time: ${startSec} -> ${endSec}`);
  }

  const duration = endSec - startSec;

  console.log(`Extracting clip: ${videoPath} (${startSec}s - ${endSec}s, ${duration}s total)`);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    let command: string;

    if (codec === 'copy') {
      command = `ffmpeg -i "${videoPath}" -ss ${startSec} -to ${endSec} -c copy -y "${outputPath}"`;
    } else {
      command = `ffmpeg -i "${videoPath}" -ss ${startSec} -to ${endSec} -c:v libx264 -crf ${quality} -c:a aac -y "${outputPath}"`;
    }

    await execAsync(command);

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg failed to create output file');
    }

    console.log(`Successfully extracted clip to: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('Failed to extract clip:', error);
    throw new Error(`Failed to extract clip: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function combineClips(options: CombineClipsOptions): Promise<string> {
  const { clipPaths, outputPath, codec = 'copy', quality = 23, portrait = false, textOverlays, pngOverlays, subtitleOverlays } = options;

  if (!clipPaths || clipPaths.length === 0) {
    throw new Error('No clips provided');
  }

  for (const clipPath of clipPaths) {
    if (!fs.existsSync(clipPath)) {
      throw new Error(`Clip file not found: ${clipPath}`);
    }
  }

  console.log(`Combining ${clipPaths.length} clips into: ${outputPath} (portrait=${portrait})`);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    if (portrait) {
      const tempDir = getTempDir();
      const processedPaths: string[] = [];

      for (let i = 0; i < clipPaths.length; i++) {
        const clipPath = clipPaths[i];
        const processedPath = path.join(tempDir, `portrait_clip_${i}_${Date.now()}.mp4`);
        const text = textOverlays?.[i]?.trim();
        const pngOverlay = pngOverlays?.[i];
        const subs = subtitleOverlays?.[i] || [];

        // Build inputs and filter_complex
        const inputs: string[] = ['-y', '-i', clipPath];
        const inputLabels: string[] = ['0:v'];
        let inputIdx = 1;

        // Title PNG input
        if (pngOverlay && fs.existsSync(pngOverlay)) {
          inputs.push('-i', pngOverlay);
          inputLabels.push(`${inputIdx}:v`);
          inputIdx++;
        }

        // Subtitle PNG inputs
        for (const sub of subs) {
          if (fs.existsSync(sub.pngPath)) {
            inputs.push('-i', sub.pngPath);
            inputLabels.push(`${inputIdx}:v`);
            inputIdx++;
          }
        }

        // Build filter_complex
        const filterParts: string[] = [];

        // Base portrait conversion
        filterParts.push('[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[scaled]');
        filterParts.push('[scaled]split[orig][fg]');
        filterParts.push('[orig]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=20:luma_power=3[bg]');
        filterParts.push('[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[video]');

        let currentLabel = 'video';
        let overlayIdx = 1;

        // Layout constants (1080x1920 portrait)
        const VIDEO_H = Math.round((1080 * 9) / 16); // 607
        const VIDEO_Y = Math.round((1920 - VIDEO_H) / 2); // 656
        const VIDEO_BOTTOM = VIDEO_Y + VIDEO_H; // 1263
        const TITLE_Y = Math.round(VIDEO_Y / 2); // 328 (title center)
        const TITLE_H = 120;
        const SUBTITLE_Y = VIDEO_BOTTOM + Math.round((1920 - VIDEO_BOTTOM) / 2) - 60; // 1590 (subtitle center)
        const SUBTITLE_H = 140;

        // Overlay title PNG (full duration, vertically centered in top area)
        if (pngOverlay && fs.existsSync(pngOverlay)) {
          const nextLabel = subs.length > 0 ? 'with_title' : 'outv';
          const titleTopY = Math.round(TITLE_Y - TITLE_H / 2); // 328 - 60 = 268
          filterParts.push(`[${currentLabel}][${overlayIdx}:v]overlay=0:${titleTopY}:format=auto[${nextLabel}]`);
          currentLabel = nextLabel;
          overlayIdx++;
        }

        // Overlay subtitle PNGs (timed, vertically centered in bottom area)
        for (let j = 0; j < subs.length; j++) {
          const sub = subs[j];
          if (!fs.existsSync(sub.pngPath)) continue;
          const subTopY = Math.round(SUBTITLE_Y - SUBTITLE_H / 2); // 1590 - 70 = 1520
          const nextLabel = j === subs.length - 1 ? 'outv' : `sub_${j}`;
          filterParts.push(
            `[${currentLabel}][${overlayIdx}:v]overlay=0:${subTopY}:enable='between(t\\,${sub.tStart.toFixed(2)}\\,${sub.tEnd.toFixed(2)})':format=auto[${nextLabel}]`
          );
          currentLabel = nextLabel;
          overlayIdx++;
        }

        // If no overlays at all, label the output
        if (filterParts.length === 4 && currentLabel === 'video') {
          filterParts.push('[video]copy[outv]');
        }

        const filterComplex = filterParts.join(';');
        const cmd = `ffmpeg ${inputs.join(' ')} -filter_complex "${filterComplex}" -map "[outv]" -map "0:a?" -c:v libx264 -crf ${quality} -c:a aac -shortest -r 30 "${processedPath}"`;
        await execAsync(cmd);

        if (!fs.existsSync(processedPath)) {
          throw new Error(`Failed to process portrait clip ${i}`);
        }
        processedPaths.push(processedPath);
      }

      const concatListPath = path.join(tempDir, `concat_portrait_${Date.now()}.txt`);
      const concatList = processedPaths.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(concatListPath, concatList);

      const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`;
      await execAsync(concatCmd);

      fs.unlinkSync(concatListPath);
      for (const p of processedPaths) {
        try { fs.unlinkSync(p); } catch {}
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error('FFmpeg failed to create output file');
      }

      console.log(`Successfully combined portrait clips to: ${outputPath}`);
      return outputPath;
    }

    const tempDir = getTempDir();
    const concatListPath = path.join(tempDir, `concat_${Date.now()}.txt`);

    const concatList = clipPaths.map(clipPath => `file '${clipPath}'`).join('\n');
    fs.writeFileSync(concatListPath, concatList);

    let command: string;

    if (codec === 'copy') {
      command = `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy -y "${outputPath}"`;
    } else {
      command = `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c:v libx264 -crf ${quality} -c:a aac -y "${outputPath}"`;
    }

    await execAsync(command);
    fs.unlinkSync(concatListPath);

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg failed to create output file');
    }

    console.log(`Successfully combined clips to: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('Failed to combine clips:', error);
    throw new Error(`Failed to combine clips: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function generateThumbnail(
  videoPath: string,
  outputPath: string,
  timestamp: number = 0
): Promise<string> {
  console.log(`Generating thumbnail at ${timestamp}s from: ${videoPath}`);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const command = `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 2 -y "${outputPath}"`;
    await execAsync(command);

    if (!fs.existsSync(outputPath)) {
      throw new Error('FFmpeg failed to create thumbnail');
    }

    console.log(`Successfully generated thumbnail: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error('Failed to generate thumbnail:', error);
    throw new Error(`Failed to generate thumbnail: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getVideoDuration(videoPath: string): Promise<number> {
  const info = await getVideoInfo(videoPath);
  return info.duration;
}

const SCENE_SCAN_WIDTH = 160;
const SCENE_SCAN_HEIGHT = 90;
const SCENE_SCAN_FPS = 6;
const SCENE_FRAME_BYTES = SCENE_SCAN_WIDTH * SCENE_SCAN_HEIGHT * 3;

interface SceneFrameDiff {
  score: number;
  histogram: number;
  pixels: number;
  edges: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function compareSceneFrames(a: Buffer, b: Buffer): SceneFrameDiff {
  const histA = new Uint32Array(96);
  const histB = new Uint32Array(96);
  let pixelDelta = 0;
  let edgeDelta = 0;
  let edgeSamples = 0;

  for (let i = 0; i < SCENE_FRAME_BYTES; i++) {
    const av = a[i];
    const bv = b[i];
    const channelOffset = (i % 3) * 32;
    histA[channelOffset + (av >> 3)]++;
    histB[channelOffset + (bv >> 3)]++;
    pixelDelta += Math.abs(av - bv);

    if (i >= 3 && Math.floor(i / 3) % SCENE_SCAN_WIDTH !== 0) {
      edgeDelta += Math.abs(Math.abs(av - a[i - 3]) - Math.abs(bv - b[i - 3]));
      edgeSamples++;
    }
  }

  let intersection = 0;
  for (let i = 0; i < histA.length; i++) {
    intersection += Math.min(histA[i], histB[i]);
  }

  const histogram = 1 - intersection / SCENE_FRAME_BYTES;
  const pixels = pixelDelta / (SCENE_FRAME_BYTES * 255);
  const edges = edgeSamples > 0 ? edgeDelta / (edgeSamples * 255) : 0;

  return {
    histogram,
    pixels,
    edges,
    score: histogram * 0.55 + pixels * 0.3 + edges * 0.15,
  };
}

async function scanSceneFrames(videoPath: string, hardwareDecode: boolean, sensitivity: number): Promise<number[]> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    ...(hardwareDecode ? ['-hwaccel', 'videotoolbox'] : []),
    '-i', videoPath,
    '-an',
    '-vf', `fps=${SCENE_SCAN_FPS},scale=${SCENE_SCAN_WIDTH}:${SCENE_SCAN_HEIGHT}:flags=fast_bilinear,format=rgb24`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffered = Buffer.alloc(0);
    let stderr = '';
    let frameIndex = 0;
    let previous: Buffer | null = null;
    let previousPrevious: Buffer | null = null;
    let pendingDiff: SceneFrameDiff | null = null;
    const recentScores: number[] = [];
    const timestamps: number[] = [];
    let lastBoundary = -Infinity;
    let suppressTransitionsUntil = -Infinity;

    const configuredSensitivity = Number(process.env.SCENE_DETECT_SENSITIVITY);
    const effectiveSensitivity = Number.isFinite(configuredSensitivity)
      ? configuredSensitivity
      : sensitivity;
    const clampedSensitivity = Math.min(0.95, Math.max(0.03, effectiveSensitivity));
    const absoluteThreshold = 0.055 + clampedSensitivity * 0.18;
    const minGap = Math.max(0.25, Number(process.env.SCENE_DETECT_MIN_GAP || 0.6));

    const evaluatePending = (nextFrame: Buffer, boundaryFrameIndex: number) => {
      if (!pendingDiff || !previousPrevious) return;

      const baseline = median(recentScores);
      const deviations = recentScores.map(score => Math.abs(score - baseline));
      const adaptiveThreshold = baseline + Math.max(0.025, median(deviations) * 4.5);
      const threshold = Math.max(absoluteThreshold, adaptiveThreshold);
      const timestamp = boundaryFrameIndex / SCENE_SCAN_FPS;

      // A one-frame flash has two large transitions while the frames around it remain similar.
      const aroundFlash = compareSceneFrames(previousPrevious, nextFrame).score;
      const isFlash = pendingDiff.score >= absoluteThreshold &&
        aroundFlash < Math.max(0.035, pendingDiff.score * 0.38);
      if (isFlash) suppressTransitionsUntil = timestamp + 2 / SCENE_SCAN_FPS;

      if (
        pendingDiff.score >= threshold &&
        !isFlash &&
        timestamp > suppressTransitionsUntil &&
        timestamp - lastBoundary >= minGap
      ) {
        timestamps.push(timestamp);
        lastBoundary = timestamp;
      }

      recentScores.push(pendingDiff.score);
      if (recentScores.length > SCENE_SCAN_FPS * 5) recentScores.shift();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      while (buffered.length >= SCENE_FRAME_BYTES) {
        const frame = Buffer.from(buffered.subarray(0, SCENE_FRAME_BYTES));
        buffered = buffered.subarray(SCENE_FRAME_BYTES);

        if (previous) {
          if (previousPrevious) evaluatePending(frame, frameIndex - 1);
          pendingDiff = compareSceneFrames(previous, frame);
        }
        previousPrevious = previous;
        previous = frame;
        frameIndex++;
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('scene scan timed out after 120s'));
    }, 120000);

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(timestamps);
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Detect scene changes with a single low-resolution adaptive scan.
 * Returns array of timestamps (in seconds) where scene changes occur.
 * Threshold: 0.0-1.0, higher = less sensitive (default 0.3)
 */
export async function detectSceneChanges(
  videoPath: string,
  threshold: number = 0.3
): Promise<number[]> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  try {
    let timestamps: number[];
    try {
      timestamps = await scanSceneFrames(videoPath, process.platform === 'darwin', threshold);
    } catch (hardwareError) {
      if (process.platform !== 'darwin') throw hardwareError;
      console.warn(`VideoToolbox scene scan failed, retrying with software decode: ${hardwareError instanceof Error ? hardwareError.message : hardwareError}`);
      timestamps = await scanSceneFrames(videoPath, false, threshold);
    }

    // Always include start (0) and end (duration)
    const duration = await getVideoDuration(videoPath);
    const allPoints = [0, ...timestamps, duration];

    // Remove duplicates and sort (keep full microsecond precision from FFmpeg)
    const seen = new Set<number>();
    const unique = allPoints
      .sort((a, b) => a - b)
      .filter(t => {
        // Dedupe: treat timestamps within 10ms as the same
        const key = Math.round(t * 100);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    console.log(`Scene detection: adaptive scan found ${timestamps.length} changes, ${unique.length} boundaries`);
    return unique;
  } catch (error) {
    throw new Error(`Scene detection failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Extract a single frame at a specific timestamp from a video.
 */
export async function extractFrameAt(
  videoPath: string,
  timestamp: number
): Promise<{ jpegBuf: Buffer; width: number; height: number } | null> {
  const tempDir = path.join(process.cwd(), 'storage', 'temp', `frame_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const outputPath = path.join(tempDir, 'frame.jpg');

  try {
    const cmd = `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 2 -y "${outputPath}"`;
    await execAsync(cmd, { timeout: 30000 });

    if (fs.existsSync(outputPath)) {
      const jpegBuf = fs.readFileSync(outputPath);
      const meta = await sharp(jpegBuf).metadata();
      return {
        jpegBuf,
        width: meta.width || 640,
        height: meta.height || 360,
      };
    }
    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

interface SmartCropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SmartCropResult {
  thumbnail: Buffer;
  getMetadata: () => Promise<{
    originalWidth: number;
    originalHeight: number;
    cropRegion: SmartCropRegion;
    scaledWidth: number;
    scaledHeight: number;
  }>;
  saveToFile: (outputPath: string) => Promise<void>;
}

/**
 * 基于画面的重要性进行 center-crop，提取视频的"最佳画面"缩略图。
 *
 * - 纵向 9:16 (1080 x 1920)
 * - 先 scale 到 1080 宽，保持比例
 * - 然后计算 center-crop 区域，crop 高度为 1920
 * - 如果 crop 后画面超出原画面，则在上下 black padding
 * - 使用 ffmpeg 的 cropdetect 来检测有效画面，避免 black bars
 * - 如果原视频是横向的，crop 区域会集中在画面中心
 */
export async function extractSmartFrame(
  videoPath: string,
  timestamp: number = 0
): Promise<SmartCropResult> {
  const TARGET_W = 1080;
  const TARGET_H = 1920;

  // 1. 先提取视频信息
  const info = await getVideoInfo(videoPath);
  const origW = info.width;
  const origH = info.height;

  // 2. 计算缩放后的尺寸，保持宽高比
  const scale = TARGET_W / origW;
  const scaledW = Math.round(origW * scale);
  const scaledH = Math.round(origH * scale);

  // 3. 计算 crop 区域
  let cropX = 0;
  let cropY = 0;
  let cropW = scaledW;
  let cropH = Math.min(scaledH, TARGET_H);

  if (scaledH > TARGET_H) {
    // 画面高于目标，需要裁剪上下
    cropY = Math.round((scaledH - TARGET_H) / 2);
    cropH = TARGET_H;
  }

  const cropRegion: SmartCropRegion = {
    x: Math.round(cropX / scale),
    y: Math.round(cropY / scale),
    width: Math.round(cropW / scale),
    height: Math.round(cropH / scale),
  };

  // 4. 临时目录
  const tempDir = path.join(process.cwd(), 'storage', 'temp', `smartframe_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, 'smartframe_temp.webp');

  try {
    // 5. 使用 ffmpeg 提取并 scaling
    const ffmpegCmd = `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -vf "scale=${TARGET_W}:-2:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:black" -q:v 2 -y "${tempPath}"`;
    await execAsync(ffmpegCmd, { timeout: 30000 });

    if (!fs.existsSync(tempPath)) {
      throw new Error('Failed to extract smart frame with ffmpeg');
    }

    const thumbnail = fs.readFileSync(tempPath);

    return {
      thumbnail,
      getMetadata: async () => ({
        originalWidth: origW,
        originalHeight: origH,
        cropRegion,
        scaledWidth: scaledW,
        scaledHeight: scaledH,
      }),
      saveToFile: async (outputPath: string): Promise<void> => {
        const parentDir = path.dirname(outputPath);
        fs.mkdirSync(parentDir, { recursive: true });

        await sharp(thumbnail)
          .webp({ quality: 95 })
          .toFile(outputPath);
      },
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

export function cleanupTempFiles(): number {
  const tempDir = getTempDir();
  let deletedCount = 0;

  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);

      for (const file of files) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile()) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    }

    console.log(`Cleaned up ${deletedCount} temp files`);
  } catch (error) {
    console.error('Error cleaning up temp files:', error);
  }

  return deletedCount;
}
