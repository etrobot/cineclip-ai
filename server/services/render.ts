import * as path from 'path';
import * as fs from 'fs';
import { extractClip } from './ffmpeg';
import type { SubtitleSegment } from './youtube';

/**
 * Render a single clip from video with vertical format conversion
 */
export async function renderClip(
  videoId: string,
  start: number,
  end: number,
  outputName?: string,
  title?: string,
  subtitles?: SubtitleSegment[]
): Promise<string> {
  const videosDir = path.join(process.cwd(), 'videos');
  const clipsDir = path.join(process.cwd(), 'clips');

  const inputPath = path.join(videosDir, `${videoId}.mp4`);
  // Sanitize fractional seconds in filename (replace dots to avoid path issues)
  const safeStart = String(start).replace(/\./g, 'p');
  const safeEnd = String(end).replace(/\./g, 'p');
  const outputFileName = outputName || `${videoId}_${safeStart}_${safeEnd}.mp4`;
  const outputPath = path.join(clipsDir, outputFileName);

  console.log(`Rendering clip: ${start}s - ${end}s`);

  // Shot analysis needs frame-accurate clips. Stream copy can drop everything
  // before the next keyframe (some downloads have 6s GOPs).
  console.log(`Cutting clip: ${start}s - ${end}s`);
  await extractClip({
    videoPath: inputPath,
    startSec: start,
    endSec: end,
    outputPath,
    codec: 'reencode',
  });
  console.log(`Clip saved to ${outputPath}`);
  return outputPath;
}

/**
 * Render multiple clips and combine them
 */
export async function renderMultipleClips(
  videoId: string,
  clips: Array<{ start: number; end: number; outputName?: string }>,
): Promise<string[]> {
  const videosDir = path.join(process.cwd(), 'videos');
  const clipsDir = path.join(process.cwd(), 'clips');
  const tempDir = path.join(process.cwd(), 'temp');

  const inputPath = path.join(videosDir, `${videoId}.mp4`);

  // Cut each segment directly and return the list of file paths
  const outputPaths: string[] = [];
  for (const clip of clips) {
    const safeName = clip.outputName || `${videoId}_${String(clip.start).replace(/\./g, 'p')}_${String(clip.end).replace(/\./g, 'p')}.mp4`;
    const clipOutput = path.join(clipsDir, safeName);
    console.log(`Cutting clip: ${clip.start}s - ${clip.end}s`);
    await extractClip({
      videoPath: inputPath,
      startSec: clip.start,
      endSec: clip.end,
      outputPath: clipOutput,
      codec: 'reencode',
    });
    outputPaths.push(clipOutput);
  }
  return outputPaths;
}
