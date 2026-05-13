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

export interface CombineClipsOptions {
  clipPaths: string[];
  outputPath: string;
  codec?: 'copy' | 'reencode';
  quality?: number;
  portrait?: boolean;
  textOverlays?: string[];
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
  const { clipPaths, outputPath, codec = 'copy', quality = 23, portrait = false, textOverlays } = options;

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

        let filterComplex: string;
        if (text) {
          const escaped = text
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/:/g, '\\:')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/%/g, '\\%');
          filterComplex = `[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[scaled];[scaled]split[orig][fg];[orig]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=20:luma_power=3[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[bgfg];[bgfg]drawtext=text='${escaped}':fontcolor=white:fontsize=48:fontfile=/System/Library/Fonts/Helvetica.ttc:x=(w-text_w)/2:y=80:box=1:boxcolor=black@0.6:boxborderw=16:line_spacing=8[outv]`;
        } else {
          filterComplex = `[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[scaled];[scaled]split[orig][fg];[orig]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=20:luma_power=3[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[outv]`;
        }

        const cmd = `ffmpeg -y -i "${clipPath}" -filter_complex "${filterComplex}" -map "[outv]" -map "0:a?" -c:v libx264 -crf ${quality} -c:a aac -shortest -r 30 "${processedPath}"`;
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
