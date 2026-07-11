import * as fs from 'fs';
import * as path from 'path';
import { runYtDlp } from '../utils/ytDlp.js';

export interface VideoMetadata {
  videoId: string;
  title: string;
  description: string;
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
  // Preserve music/sound markers (e.g. "[music]") — do NOT merge or drop them
  const result: SubtitleSegment[] = [];
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    let currentText = item.text;

    if (result.length > 0) {
      const prevText = result[result.length - 1].text;

      // music 标记段落完全保留，不做任何去重/跳过处理
      if (isMusicMarker(currentText)) {
        result.push({ start: item.start, end: item.end, text: currentText });
        continue;
      }

      // Never skip text contained in previous text (avoid duplication)
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
 * Check if text represents a music/sound marker (e.g. "[music]", ">>[Music]").
 */
function isMusicMarker(text: string): boolean {
  return /\bmusic\b/i.test(text);
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
      console.warn(`  No subtitles available for ${videoId}, will use fallback clip strategy`);
    }

    return {
      videoId,
      title: info.title,
      description: info.description || '',
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

function isValidVideoFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 1024 * 1024) return false; // Less than 1MB is suspicious

    // Check for MP4 signature in first 64KB: ftyp box or moov/mdat atoms
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);

    const header = buf.slice(0, bytesRead);
    // MP4 files start with 'ftyp' box, or contain 'moov'/'mdat' atoms
    return header.includes(Buffer.from('ftyp')) ||
           header.includes(Buffer.from('mdat')) ||
           header.includes(Buffer.from('moov'));
  } catch {
    return false;
  }
}

/**
 * In-memory lock to prevent concurrent downloads of the same video.
 * Maps videoId to a promise that resolves when download completes.
 */
const downloadLocks = new Map<string, Promise<string>>();

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

  // Check if already downloaded and valid
  if (fs.existsSync(outputPath) && isValidVideoFile(outputPath)) {
    console.log(`Video ${videoId} already downloaded`);
    return outputPath;
  }

  // If another request is already downloading this video, wait for it
  const existingLock = downloadLocks.get(videoId);
  if (existingLock) {
    console.log(`Video ${videoId} download already in progress, waiting...`);
    return existingLock;
  }

  // Create a new download promise and store it in the lock map
  const downloadPromise = (async (): Promise<string> => {
    try {
      // Double-check after acquiring the lock
      if (fs.existsSync(outputPath) && isValidVideoFile(outputPath)) {
        console.log(`Video ${videoId} already downloaded (after lock)`);
        return outputPath;
      }

      // Remove corrupted file if exists
      if (fs.existsSync(outputPath)) {
        console.warn(`Video ${videoId} file is corrupted, re-downloading...`);
        fs.unlinkSync(outputPath);
      }

      console.log(`Downloading video ${videoId}...`);

      // Use yt-dlp's default template to avoid merge issues, then rename
      const tempOutputTemplate = path.join(videosDir, `%(id)s.%(ext)s`);

      await runYtDlp([
        ...commonArgs,
        '-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', tempOutputTemplate,
        videoUrl,
      ]);

      // Find the downloaded file (yt-dlp may add suffixes or .part extension)
      const allFiles = fs.readdirSync(videosDir)
        .filter(f => f.startsWith(videoId) && (f.endsWith('.mp4') || f.endsWith('.mp4.part')));

      // Exclude yt-dlp temporary fragment files (e.g. .f137.mp4, .f140.mp4)
      const tempFragmentRegex = /\.f\d+\.mp4$/;
      const downloadedFiles = allFiles
        .filter(f => !tempFragmentRegex.test(f))
        .map(f => path.join(videosDir, f));

      console.log(`[download] found MP4 files for ${videoId}: [${allFiles.join(', ')}], filtered: [${downloadedFiles.map(f => path.basename(f)).join(', ')}]`);

      if (downloadedFiles.length === 0) {
        throw new Error(`Download completed but no file found for ${videoId}`);
      }

      // Prefer exact match (non-.part), then largest file
      const exactMatch = downloadedFiles.find(f => path.basename(f) === `${videoId}.mp4`);
      const downloadedFile = exactMatch || downloadedFiles.sort((a, b) => {
        const aIsPart = a.endsWith('.part');
        const bIsPart = b.endsWith('.part');
        if (aIsPart !== bIsPart) return aIsPart ? 1 : -1;
        return fs.statSync(b).size - fs.statSync(a).size;
      })[0];

      console.log(`[download] selected file for validation: ${downloadedFile}`);

      // Validate the downloaded file
      if (!isValidVideoFile(downloadedFile)) {
        fs.unlinkSync(downloadedFile);
        throw new Error(`Downloaded file for ${videoId} is corrupted or invalid`);
      }

      // Rename to expected path if needed (strip .part suffix)
      if (downloadedFile !== outputPath) {
        fs.renameSync(downloadedFile, outputPath);
      }

      console.log(`Video downloaded to ${outputPath}`);
      return outputPath;
    } finally {
      // Always release the lock when done (success or error)
      downloadLocks.delete(videoId);
    }
  })();

  downloadLocks.set(videoId, downloadPromise);
  return downloadPromise;
}
