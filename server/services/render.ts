import * as path from 'path';
import * as fs from 'fs';
import { extractClip, combineClips } from './ffmpeg';
import {
  renderTitleOverlay,
  renderSubtitleOverlays,
  prepareSubtitles,
} from './overlayRenderer';
import type { SubtitleOverlay } from './ffmpeg';
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

  // Extract the clip first, then convert to portrait format
  const tempDir = path.join(process.cwd(), 'temp');
  const tempClipPath = path.join(tempDir, `${videoId}_temp_${Date.now()}.mp4`);

  await extractClip({
    videoPath: inputPath,
    startSec: start,
    endSec: end,
    outputPath: tempClipPath,
    codec: 'copy',
  });

  // Render title overlay as PNG if title provided
  let titlePng: string | undefined;
  if (title) {
    console.log(`Rendering title overlay: "${title}"`);
    titlePng = await renderTitleOverlay(title);
  }

  // Render subtitle overlays if subtitles provided
  let subtitleOverlays: SubtitleOverlay[] = [];
  if (subtitles && subtitles.length > 0) {
    const preparedSubs = prepareSubtitles(subtitles, start, end);
    console.log(`Rendering ${preparedSubs.length} subtitle overlays...`);
    subtitleOverlays = await renderSubtitleOverlays(preparedSubs);
  }

  await combineClips({
    clipPaths: [tempClipPath],
    outputPath,
    codec: 'reencode',
    quality: 23,
    portrait: true,
    pngOverlays: titlePng ? [titlePng] : undefined,
    subtitleOverlays: subtitleOverlays.length > 0 ? [subtitleOverlays] : undefined,
  });

  // Clean up temp files
  try {
    fs.unlinkSync(tempClipPath);
  } catch {}
  if (titlePng) {
    try { fs.unlinkSync(titlePng); } catch {}
  }
  for (const sub of subtitleOverlays) {
    try { fs.unlinkSync(sub.pngPath); } catch {}
  }

  console.log(`Clip rendered to ${outputPath}`);
  return outputPath;
}

/**
 * Render multiple clips and combine them
 */
export async function renderMultipleClips(
  videoId: string,
  clips: Array<{ start: number; end: number; title?: string; subtitles?: SubtitleSegment[] }>,
  outputName?: string
): Promise<string> {
  const videosDir = path.join(process.cwd(), 'videos');
  const clipsDir = path.join(process.cwd(), 'clips');
  const tempDir = path.join(process.cwd(), 'temp');

  const inputPath = path.join(videosDir, `${videoId}.mp4`);

  // Extract individual clips
  const clipPaths: string[] = [];
  const pngOverlays: (string | undefined)[] = [];
  const allSubtitleOverlays: SubtitleOverlay[][] = [];

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

    // Render title overlay as PNG if title provided
    if (clip.title) {
      console.log(`Rendering title overlay ${i}: "${clip.title}"`);
      const titlePng = await renderTitleOverlay(clip.title);
      pngOverlays.push(titlePng);
    } else {
      pngOverlays.push(undefined);
    }

    // Render subtitle overlays if subtitles provided
    if (clip.subtitles && clip.subtitles.length > 0) {
      const preparedSubs = prepareSubtitles(clip.subtitles, clip.start, clip.end);
      console.log(`Rendering ${preparedSubs.length} subtitle overlays for clip ${i}...`);
      const subOverlays = await renderSubtitleOverlays(preparedSubs);
      allSubtitleOverlays.push(subOverlays);
    } else {
      allSubtitleOverlays.push([]);
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
    pngOverlays: pngOverlays.filter(Boolean) as string[],
    subtitleOverlays: allSubtitleOverlays.some(s => s.length > 0) ? allSubtitleOverlays : undefined,
  });

  // Clean up temp files
  for (const clipPath of clipPaths) {
    try { fs.unlinkSync(clipPath); } catch {}
  }
  for (const png of pngOverlays) {
    if (png) {
      try { fs.unlinkSync(png); } catch {}
    }
  }
  for (const subs of allSubtitleOverlays) {
    for (const sub of subs) {
      try { fs.unlinkSync(sub.pngPath); } catch {}
    }
  }

  console.log(`Combined clips rendered to ${outputPath}`);
  return outputPath;
}
