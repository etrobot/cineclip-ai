import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

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

/**
 * Detect scene changes in a video using FFmpeg's select filter.
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

  // Use FFmpeg's select filter to detect scene changes
  // The metadata shows pts_time when scene change is detected
  const command = `ffmpeg -i "${videoPath}" -vf "select=gt(scene\\,${threshold}),showinfo" -f null - 2>&1 | grep "pts_time:" | sed 's/.*pts_time:\\([0-9.]*\\).*/\\1/'`;

  try {
    const { stdout } = await execAsync(command, { timeout: 120000 });

    // Parse timestamps from output
    const timestamps = stdout
      .trim()
      .split('\n')
      .map(line => parseFloat(line.trim()))
      .filter(t => !isNaN(t) && t > 0);

    // Always include start (0) and end (duration)
    const duration = await getVideoDuration(videoPath);
    const allPoints = [0, ...timestamps, duration];

    // Remove duplicates and sort
    const unique = Array.from(new Set(allPoints.map(t => Math.round(t * 1000) / 1000))).sort((a, b) => a - b);

    // Merge boundaries that are too close (< minGap seconds)
    const minGap = 1.0; // Minimum gap between scenes (1 second)
    const merged: number[] = [];
    for (const t of unique) {
      if (merged.length === 0 || t - merged[merged.length - 1] >= minGap) {
        merged.push(t);
      }
    }
    // Always ensure end boundary is included
    if (merged[merged.length - 1] !== duration) {
      merged[merged.length - 1] = duration;
    }

    console.log(`Scene detection: found ${timestamps.length} raw changes, merged to ${merged.length - 1} scenes`);
    return merged;
  } catch (error) {
    console.error('Scene detection failed:', error);
    // Fallback: return just start and end
    const duration = await getVideoDuration(videoPath);
    return [0, duration];
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
