import * as path from 'path';
import { extractClip, combineClips } from './ffmpeg';

/**
 * Render a single clip from video with vertical format conversion
 */
export async function renderClip(
  videoId: string,
  start: number,
  end: number,
  outputName?: string
): Promise<string> {
  const videosDir = path.join(process.cwd(), 'videos');
  const clipsDir = path.join(process.cwd(), 'clips');

  const inputPath = path.join(videosDir, `${videoId}.mp4`);
  const outputFileName = outputName || `${videoId}_${start}_${end}.mp4`;
  const outputPath = path.join(clipsDir, outputFileName);

  console.log(`Rendering clip: ${start}s - ${end}s`);

  // Extract and convert to portrait format
  await combineClips({
    clipPaths: [inputPath],
    outputPath,
    codec: 'reencode',
    quality: 23,
    portrait: true,
  });

  console.log(`Clip rendered to ${outputPath}`);
  return outputPath;
}

/**
 * Render multiple clips and combine them
 */
export async function renderMultipleClips(
  videoId: string,
  clips: Array<{ start: number; end: number; title?: string }>,
  outputName?: string
): Promise<string> {
  const videosDir = path.join(process.cwd(), 'videos');
  const clipsDir = path.join(process.cwd(), 'clips');
  const tempDir = path.join(process.cwd(), 'temp');

  const inputPath = path.join(videosDir, `${videoId}.mp4`);

  // Extract individual clips
  const clipPaths: string[] = [];
  const textOverlays: string[] = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const clipPath = path.join(tempDir, `${videoId}_clip_${i}_${Date.now()}.mp4`);

    await extractClip({
      videoPath: inputPath,
      startSec: clip.start,
      endSec: clip.end,
      outputPath: clipPath,
      codec: 'copy',
    });

    clipPaths.push(clipPath);
    if (clip.title) {
      textOverlays.push(clip.title);
    }
  }

  // Combine clips into portrait format
  const outputFileName = outputName || `${videoId}_combined_${Date.now()}.mp4`;
  const outputPath = path.join(clipsDir, outputFileName);

  await combineClips({
    clipPaths,
    outputPath,
    codec: 'reencode',
    quality: 23,
    portrait: true,
    textOverlays: textOverlays.length > 0 ? textOverlays : undefined,
  });

  console.log(`Combined clips rendered to ${outputPath}`);
  return outputPath;
}
