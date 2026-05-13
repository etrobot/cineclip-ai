import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db/init';
import { runYtDlp } from './ytDlp';

async function runYtDlpRaw(url: string, args: string[]): Promise<string> {
  const result = await runYtDlp([...args, url]);
  return result.stdout;
}

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

export interface ChannelVideos {
  videos: VideoMetadata[];
}

/**
 * Get proxy URL from environment
 */
function getProxy(): string {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
}

/**
 * Extract channel handle from URL
 * Supports formats:
 * - youtube.com/@channel
 * - youtube.com/channel/UC...
 * - youtube.com/c/channel
 */
export function extractChannelHandle(channelUrl: string): string {
  const url = channelUrl.trim();

  // Handle @channel format
  if (url.includes('@')) {
    const match = url.match(/@([^\/\?]+)/);
    if (match) return match[1];
  }

  // Handle channel/UC... format
  if (url.includes('/channel/')) {
    const match = url.match(/\/channel\/([^\/\?]+)/);
    if (match) return match[1];
  }

  // Handle /c/channel format
  if (url.includes('/c/')) {
    const match = url.match(/\/c\/([^\/\?]+)/);
    if (match) return match[1];
  }

  // If no format matches, return the URL as-is
  return url;
}

/**
 * Clean a VTT text line: strip HTML tags, inline timestamp cues, and alignment attrs
 * e.g. "<00:00:33.699><c>exclusive</c>" → "exclusive"
 */
function cleanVTTLine(line: string): string {
  // Remove inline timestamp cues like <00:00:33.699>
  let s = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '');
  // Remove HTML tags like <c>, </c>, <b>, </b>, <i>, </i>
  s = s.replace(/<\/?[^>]+>/g, '');
  return s.trim();
}

/**
 * Parse VTT subtitle file
 *
 * Two-pass approach (matching the reference Python implementation):
 *  Pass 1 – parse each block, strip HTML/cue tags, deduplicate exact duplicates
 *  Pass 2 – remove overlapping prefix between adjacent subtitles
 */
export function parseVTT(content: string): SubtitleSegment[] {
  // ------------------------------------------------------------------
  // Pass 1: Parse blocks, clean text, remove exact duplicates
  // ------------------------------------------------------------------
  const timeRe = /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/;
  const blocks = content.split(/\n\n+/);

  const unique: SubtitleSegment[] = [];
  const seenKeys = new Set<string>();

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // Find the timestamp line
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

    // Collect subtitle text (skip timestamp lines & alignment info)
    const textParts: string[] = [];
    for (const line of lines) {
      if (timeRe.test(line)) continue;
      if (line.startsWith('align:') || line.startsWith('position:')) continue;
      const cleaned = cleanVTTLine(line);
      if (cleaned) textParts.push(cleaned);
    }
    const subtitleText = textParts.join(' ').trim();
    if (!subtitleText) continue;

    // Deduplicate: same timestamp + same text → skip
    const key = `${m0(start)}_${m0(end)}_${subtitleText}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    unique.push({ start, end, text: subtitleText });
  }

  // ------------------------------------------------------------------
  // Pass 2: Remove overlapping prefix between adjacent subtitles
  // (mirrors Python reference: if current ⊂ prev → skip; if prev is
  //  prefix of current → strip; else word-level overlap removal)
  // ------------------------------------------------------------------
  const result: SubtitleSegment[] = [];
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    // Work on the ORIGINAL (un-deduplicated) text – this is key!
    // unique[i] already has full text from VTT; Pass 2 trims overlap
    // against the *already-processed* previous output.
    let currentText = item.text;

    if (result.length > 0) {
      const prevText = result[result.length - 1].text;

      // If current text is fully contained in previous → skip entirely
      if (currentText && prevText.includes(currentText)) continue;

      // If previous text is a prefix of current → strip the overlap
      if (currentText.startsWith(prevText)) {
        currentText = currentText.slice(prevText.length).trim();
      } else {
        // Word-level overlap removal (e.g. last 1-3 words of prev == first 1-3 words of current)
        currentText = removeOverlappingWords(prevText, currentText);
      }
    }

    if (currentText) {
      result.push({ start: item.start, end: item.end, text: currentText });
    }
  }

  return result;
}

/** Helper: minimal string key for dedup (avoids floating-point noise) */
function m0(n: number): string { return n.toFixed(3); }

/**
 * Remove overlapping words between the end of prevText and start of currentText.
 * Checks up to 3 words of overlap (mirrors the Python reference).
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
async function getVideoWithSubtitles(videoId: string): Promise<VideoMetadata | null> {
  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const proxy = getProxy();
    const commonArgs: string[] = ['--no-warnings', '--no-call-home'];
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
    const subtitlePath = path.join(process.cwd(), `temp-${videoId}.vtt`);
    let subtitles: SubtitleSegment[] = [];

    try {
      // Use --skip-download to avoid downloading the full video when we only need subtitles
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

      // Find the actual subtitle file (youtube-dl adds language suffix and type)
      // It could be .en.vtt or .en-orig.vtt or .en.auto.vtt
      const subtitleFiles = fs.readdirSync(process.cwd())
        .filter(f => f.includes(`temp-${videoId}`) && f.endsWith('.vtt'));

      if (subtitleFiles.length > 0) {
        const actualSubtitlePath = path.join(process.cwd(), subtitleFiles[0]);
        const content = fs.readFileSync(actualSubtitlePath, 'utf-8');
        subtitles = parseVTT(content);
        console.log(`  Extracted ${subtitles.length} subtitle segments`);

        // Clean up
        fs.unlinkSync(actualSubtitlePath);
      }
    } catch (subtitleError) {
      console.warn(`  Failed to extract subtitles: ${subtitleError}`);
    }

    // Skip videos without subtitles
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
 * Fetch channel videos
 * Fetch channel videos via yt-dlp flat playlist output
 */
export async function fetchChannelVideos(
  channelUrl: string,
  maxVideos: number = 20
): Promise<ChannelVideos> {
  try {
    const proxy = getProxy();
    const commonArgs: string[] = ['--no-warnings', '--no-call-home'];
    if (proxy) {
      commonArgs.push('--proxy', proxy);
    }

    console.log(`Fetching channel videos: ${channelUrl}`);

    const stdout = await runYtDlpRaw(channelUrl, [
      ...commonArgs,
      '--dump-json',
      '--flat-playlist',
      '--playlist-end',
      String(maxVideos),
    ]);

    const videoList = stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));

    console.log(`  Found ${videoList.length} videos`);

    const results: VideoMetadata[] = [];
    for (const video of videoList) {
      if (!video.id) continue;
      
      const info = await getVideoWithSubtitles(video.id);
      if (info) {
        results.push(info);
      }
    }

    return { videos: results };
  } catch (error: any) {
    console.error('Failed to fetch channel videos:', error);
    if (error.stderr) console.error('Error stderr:', error.stderr);
    if (error.stdout) console.error('Error stdout:', error.stdout);
    
    throw new Error(`Failed to fetch channel videos: ${error.message || 'Check logs for details'}`);
  }
}

/**
 * Get video info by video ID
 */
export async function getVideoInfo(videoId: string): Promise<VideoMetadata | null> {
  try {
    return await getVideoWithSubtitles(videoId);
  } catch (error) {
    console.error(`Failed to get video info for ${videoId}:`, error);
    return null;
  }
}

/**
 * Check if video already exists in database
 */
export function videoExists(videoId: string): boolean {
  const result = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
  return !!result;
}

/**
 * Save video to database
 */
export function saveVideo(video: VideoMetadata, kolId: number): void {
  db.prepare(`
    INSERT INTO videos (id, kol_id, title, duration, thumbnail, published_at, subtitles)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    video.videoId,
    kolId,
    video.title,
    video.duration,
    video.thumbnail,
    video.publishedAt,
    JSON.stringify(video.subtitles)
  );
}

/**
 * Get KOL by ID
 */
export function getKOL(kolId: number): any {
  return db.prepare('SELECT * FROM kols WHERE id = ?').get(kolId);
}