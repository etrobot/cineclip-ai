import * as fs from 'fs';
import * as path from 'path';
import { runYtDlp } from '../utils/ytDlp';

export interface VideoMetadata {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
  publishedAt: string;
  subtitles: SubtitleSegment[];
}

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Get proxy URL from environment
 */
function getProxy(): string {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
}

/**
 * Clean a VTT text line: strip HTML tags, inline timestamp cues, and alignment attrs
 */
function cleanVTTLine(line: string): string {
  let s = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '');
  s = s.replace(/<\/?[^>]+>/g, '');
  return s.trim();
}

/**
 * Parse VTT subtitle file
 */
export function parseVTT(content: string): SubtitleSegment[] {
  const timeRe = /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;
  const blocks = content.split(/\n\n+/);

  const unique: SubtitleSegment[] = [];
  const seenKeys = new Set<string>();

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let start = 0;
    let end = 0;
    let foundTime = false;
    for (const line of lines) {
      const m = line.match(timeRe);
      if (m) {
        start = parseVTTTime(m[1]);
        end = parseVTTTime(m[2]);
        foundTime = true;
        break;
      }
    }
    if (!foundTime) continue;

    const textParts: string[] = [];
    for (const line of lines) {
      if (timeRe.test(line)) continue;
      if (line.startsWith('align:') || line.startsWith('position:')) continue;
      const cleaned = cleanVTTLine(line);
      if (cleaned) textParts.push(cleaned);
    }
    const subtitleText = textParts.join(' ').trim();
    if (!subtitleText) continue;

    const key = `${start.toFixed(3)}_${end.toFixed(3)}_${subtitleText}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    unique.push({ start, end, text: subtitleText });
  }

  // Pass 2: Remove overlapping prefix between adjacent subtitles
  const result: SubtitleSegment[] = [];
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    let currentText = item.text;

    if (result.length > 0) {
      const prevText = result[result.length - 1].text;

      if (currentText && prevText.includes(currentText)) continue;

      if (currentText.startsWith(prevText)) {
        currentText = currentText.slice(prevText.length).trim();
      } else {
        currentText = removeOverlappingWords(prevText, currentText);
      }
    }

    if (currentText) {
      result.push({ start: item.start, end: item.end, text: currentText });
    }
  }

  return result;
}

/**
 * Remove overlapping words between the end of prevText and start of currentText
 */
function removeOverlappingWords(prevText: string, currentText: string): string {
  const prevWords = prevText.split(/\s+/);
  const currWords = currentText.split(/\s+/);
  if (prevWords.length === 0 || currWords.length === 0) return currentText;

  const maxCheck = Math.min(3, prevWords.length, currWords.length);
  let overlapCount = 0;

  for (let i = 1; i <= maxCheck; i++) {
    const prevEnd = prevWords.slice(-i).join(' ').toLowerCase();
    const currStart = currWords.slice(0, i).join(' ').toLowerCase();
    if (prevEnd === currStart) {
      overlapCount = i;
    }
  }

  if (overlapCount > 0) {
    return currWords.slice(overlapCount).join(' ');
  }
  return currentText;
}

/**
 * Parse VTT time format to seconds
 */
function parseVTTTime(timeStr: string): number {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0]);
  const minutes = parseInt(parts[1]);
  const seconds = parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Get video info including subtitles
 */
export async function getVideoWithSubtitles(videoId: string): Promise<VideoMetadata | null> {
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const proxy = getProxy();
    const commonArgs: string[] = ['--no-warnings'];
    if (proxy) {
      commonArgs.push('--proxy', proxy);
    }

    console.log(`Fetching video info for ${videoId}...`);

    // Get video info
    const infoResult = await runYtDlp([...commonArgs, '--dump-json', videoUrl]);
    const info = JSON.parse(infoResult.stdout.trim()) as any;

    console.log(`  Title: ${info.title}`);
    console.log(`  Duration: ${info.duration} seconds`);

    // Download subtitles
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const subtitlePath = path.join(tempDir, `${videoId}`);
    let subtitles: SubtitleSegment[] = [];

    try {
      await runYtDlp([
        ...commonArgs,
        '--skip-download',
        '--write-sub',
        '--write-auto-sub',
        '--sub-lang',
        'en',
        '--sub-format',
        'vtt',
        '--output',
        subtitlePath,
        videoUrl,
      ]);

      const subtitleFiles = fs.readdirSync(tempDir)
        .filter((f: string) => f.includes(videoId) && f.endsWith('.vtt'));

      if (subtitleFiles.length > 0) {
        const actualSubtitlePath = path.join(tempDir, subtitleFiles[0]);
        const content = fs.readFileSync(actualSubtitlePath, 'utf-8');
        subtitles = parseVTT(content);
        console.log(`  Extracted ${subtitles.length} subtitle segments`);

        fs.unlinkSync(actualSubtitlePath);
      }
    } catch (subtitleError) {
      console.warn(`  Failed to extract subtitles: ${subtitleError}`);
    }

    if (subtitles.length === 0) {
      console.log(`  Skipping ${videoId}: No subtitles available`);
      return null;
    }

    return {
      videoId,
      title: info.title,
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      publishedAt: info.upload_date || new Date().toISOString(),
      subtitles
    };
  } catch (error) {
    console.error(`Failed to get video info for ${videoId}:`, error);
    return null;
  }
}

/**
 * Download video file
 */
export async function downloadVideo(videoId: string): Promise<string> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const proxy = getProxy();
  const commonArgs: string[] = ['--no-warnings'];
  if (proxy) {
    commonArgs.push('--proxy', proxy);
  }

  const videosDir = path.join(process.cwd(), 'videos');
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const outputPath = path.join(videosDir, `${videoId}.mp4`);

  // Check if already downloaded
  if (fs.existsSync(outputPath)) {
    console.log(`Video ${videoId} already downloaded`);
    return outputPath;
  }

  console.log(`Downloading video ${videoId}...`);

  await runYtDlp([
    ...commonArgs,
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputPath,
    videoUrl,
  ]);

  console.log(`Video downloaded to ${outputPath}`);
  return outputPath;
}
