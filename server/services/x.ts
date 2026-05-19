import * as fs from 'fs';
import * as path from 'path';
import { runYtDlp } from '../utils/ytDlp.js';
import { parseVTT } from './youtube';
import type { SubtitleSegment } from './youtube';

function getProxy(): string {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
}

const VIDEOS_DIR = path.join(process.cwd(), 'videos');
const TEMP_DIR = path.join(process.cwd(), 'temp', 'x');
const THRESHOLD_SECONDS = 120; // 2 minutes

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isValidVideoFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 1024 * 1024) return false;

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);

    const header = buf.slice(0, bytesRead);
    return header.includes(Buffer.from('ftyp')) ||
           header.includes(Buffer.from('mdat')) ||
           header.includes(Buffer.from('moov'));
  } catch {
    return false;
  }
}

export interface XVideoInfo {
  videoId: string;
  postId: string;
  index: number;
  url: string;
  title: string;
  description: string;
  duration: number;
  thumbnail: string;
  publishedAt: string;
}

export interface XPostResult {
  postId: string;
  authorName: string;
  content: string;
  videos: XVideoInfo[];
}

export interface XVideoClipPlan {
  video: XVideoInfo;
  clips: Array<{ start: number; end: number; title: string }>;
  subtitles: SubtitleSegment[];
  needsAnalysis: boolean; // true if duration > 2min
}

/**
 * Extract all videos from an X post URL using yt-dlp.
 *
 * An X post may contain multiple videos. yt-dlp behavior:
 * - Single video post: info object has duration, url, etc. directly
 * - Multi-video post: info.entries contains each video as an entry
 *
 * X post URLs supported:
 * - https://x.com/username/status/1234567890
 * - https://x.com/i/web/status/1234567890
 * - https://twitter.com/username/status/1234567890
 */
export async function extractXPostVideos(postUrl: string, postId: string): Promise<XPostResult> {
  ensureDir(TEMP_DIR);
  const proxy = getProxy();
  const args: string[] = ['--no-warnings'];
  if (proxy) {
    args.push('--proxy', proxy);
  }

  console.log(`[X] Fetching post info: ${postUrl}`);
  const infoResult = await runYtDlp([...args, '--dump-json', postUrl]);
  const info = JSON.parse(infoResult.stdout.trim()) as any;

  // Determine entries: multi-video posts have info.entries
  const entries: any[] = info.entries && Array.isArray(info.entries) && info.entries.length > 0
    ? info.entries
    : [info];

  const videos: XVideoInfo[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Only include entries that seem like videos (have duration or video-related fields)
    if (typeof entry.duration !== 'number' && !entry.url) {
      continue;
    }

    // X video ID: prefer entry.id, fallback to composite ID with index
    // yt-dlp for X often produces IDs like "1234567890" or "1234567890_0" for first video
    let videoId = entry.id;
    if (!videoId || videoId === postId) {
      videoId = entries.length > 1 ? `${postId}_v${i}` : postId;
    }

    videos.push({
      videoId,
      postId,
      index: i,
      url: entry.webpage_url || entry.url || postUrl,
      title: entry.title || info.title || info.description?.substring(0, 50) || `X Video ${i + 1}`,
      description: entry.description || info.description || '',
      duration: entry.duration || 0,
      thumbnail: entry.thumbnail || info.thumbnail || '',
      publishedAt: entry.upload_date || info.upload_date || new Date().toISOString(),
    });
  }

  return {
    postId,
    authorName: info.uploader || info.channel || info.uploader_id || 'Unknown',
    content: info.description || info.title || '',
    videos,
  };
}

/**
 * Download an X video to local storage.
 * Returns the local file path (in videos/ directory).
 */
export async function downloadXVideo(videoId: string, sourceUrl: string): Promise<string> {
  ensureDir(VIDEOS_DIR);
  const proxy = getProxy();
  const args: string[] = ['--no-warnings'];
  if (proxy) {
    args.push('--proxy', proxy);
  }

  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Check if already downloaded and valid
  if (fs.existsSync(outputPath) && isValidVideoFile(outputPath)) {
    console.log(`[X] Video ${videoId} already downloaded`);
    return outputPath;
  }

  // Remove corrupted file if exists
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  console.log(`[X] Downloading video ${videoId} from ${sourceUrl}`);

  // Use a temporary download path to avoid yt-dlp id vs postId mismatch
  const tempBaseName = `x_download_${videoId}`;
  const tempOutputTemplate = path.join(VIDEOS_DIR, `${tempBaseName}.%(ext)s`);
  await runYtDlp([
    ...args,
    '-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', tempOutputTemplate,
    sourceUrl,
  ]);

  // Find the downloaded file by tempBaseName prefix (include .part files)
  const allFiles = fs.readdirSync(VIDEOS_DIR)
    .filter(f => f.startsWith(tempBaseName) && (f.endsWith('.mp4') || f.endsWith('.mp4.part')))
    .map(f => path.join(VIDEOS_DIR, f));

  // Exclude yt-dlp temporary fragment files
  const tempFragmentRegex = /\.f\d+\.mp4$/;
  const downloadedFiles = allFiles.filter(f => !tempFragmentRegex.test(f));

  if (downloadedFiles.length === 0) {
    throw new Error(`[X] Download completed but no file found for ${videoId}`);
  }

  // Use the downloaded file (prefer .mp4 over .mp4.part)
  const downloadedFile = downloadedFiles.sort((a, b) => {
    // Prefer non-.part files
    const aIsPart = a.endsWith('.part');
    const bIsPart = b.endsWith('.part');
    if (aIsPart !== bIsPart) return aIsPart ? 1 : -1;
    // Otherwise prefer larger file
    return fs.statSync(b).size - fs.statSync(a).size;
  })[0];

  // Rename to expected path (strip .part suffix if present)
  if (downloadedFile !== outputPath) {
    fs.renameSync(downloadedFile, outputPath);
  }

  console.log(`[X] Video downloaded to ${outputPath}`);
  return outputPath;
}

/**
 * Extract subtitles for an X video via yt-dlp.
 * Note: X videos typically don't have manual subtitles,
 * but auto-subtitles may be available.
 */
export async function extractXSubtitles(videoId: string, sourceUrl: string): Promise<SubtitleSegment[]> {
  const proxy = getProxy();
  const args: string[] = ['--no-warnings'];
  if (proxy) {
    args.push('--proxy', proxy);
  }

  const tempDir = path.join(TEMP_DIR, 'subtitles');
  ensureDir(tempDir);
  const baseName = path.join(tempDir, `subtitle_${videoId}_${Date.now()}`);

  try {
    await runYtDlp([
      ...args,
      '--skip-download',
      '--write-sub',
      '--write-auto-sub',
      '--sub-lang', 'en,zh,zh-CN,zh-TW',
      '--sub-format', 'vtt',
      '--output', baseName,
      sourceUrl,
    ]);

    const candidates = fs.readdirSync(tempDir)
      .filter((file) => file.startsWith(path.basename(baseName)) && file.endsWith('.vtt'));

    if (candidates.length === 0) {
      return [];
    }

    const subtitlePath = path.join(tempDir, candidates[0]);
    const content = fs.readFileSync(subtitlePath, 'utf-8');
    return parseVTT(content);
  } catch (error) {
    console.warn('[X] Failed to fetch subtitles for', videoId, error);
    return [];
  } finally {
    try {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        if (file.startsWith(path.basename(baseName))) {
          fs.rmSync(path.join(tempDir, file));
        }
      }
    } catch {}
  }
}

/**
 * Determine clip strategy for an X video based on duration threshold.
 *
 * Rule:
 * - Duration > 2min (120s): Needs subtitle extraction + LLM analysis
 * - Duration <= 2min: Treat as a single clip (no analysis needed)
 *
 * Returns a plan object; for long videos, clips array is empty
 * and needsAnalysis=true, signaling the caller to run LLM analysis.
 */
export function planXVideoClips(video: XVideoInfo): XVideoClipPlan {
  if (video.duration <= THRESHOLD_SECONDS) {
    // Short video: one clip from start to end
    return {
      video,
      clips: [{
        start: 0,
        end: video.duration,
        title: video.title || `X Video ${video.index + 1}`,
      }],
      subtitles: [],
      needsAnalysis: false,
    };
  }

  // Long video: needs subtitle extraction + LLM analysis
  return {
    video,
    clips: [], // To be filled by LLM analysis
    subtitles: [], // To be filled by extractXSubtitles
    needsAnalysis: true,
  };
}

/**
 * Build clip suggestions from X subtitles using the same LLM analysis pipeline.
 * This reuses the analyzeClips function from llm.ts.
 */
export async function analyzeXVideoClips(
  subtitles: SubtitleSegment[],
  videoTitle: string,
  videoDescription: string,
  videoDuration: number
): Promise<Array<{ start: number; end: number; title: string }>> {
  // Import dynamically to avoid circular dependency
  const { analyzeClips } = await import('./llm');
  const clips = await analyzeClips(subtitles, videoTitle, videoDescription);

  // Filter out clips that exceed video duration
  return clips
    .filter(c => c.start >= 0 && c.end <= videoDuration + 5 && c.end > c.start)
    .map(c => ({
      start: Math.max(0, c.start),
      end: Math.min(videoDuration, c.end),
      title: c.title,
    }));
}
