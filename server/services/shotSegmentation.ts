import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { extractClip } from './ffmpeg';

const execAsync = promisify(exec);

/**
 * Shot segment result from VL model analysis
 */
export interface ShotSegment {
  start: number;
  end: number;
  label: string;
}

/**
 * Extracted frame with timestamp for VL analysis
 */
interface SamplingFrame {
  jpegBuf: Buffer;
  width: number;
  height: number;
  timestamp: number;
}

/**
 * Subtitle segment within a clip time range
 */
interface ClipSubtitle {
  start: number;
  end: number;
  text: string;
}

/**
 * Get VL model config from environment
 */
function vlEnv() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: process.env.VL_MODEL || 'gemini-2.0-flash-vision',
  };
}

/**
 * Extract sampling frames from a clip at given FPS.
 * Returns array of frames with timestamp.
 */
async function extractSamplingFrames(
  clipPath: string,
  fps: number = 1.0
): Promise<SamplingFrame[]> {
  const frames: SamplingFrame[] = [];
  const tempDir = path.join(process.cwd(), 'storage', 'temp', `shots_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const pattern = path.join(tempDir, 'frame_%04d.jpg');
    await execAsync(
      `ffmpeg -i "${clipPath}" -vf "fps=${fps},scale=640:-2" -q:v 4 -y "${pattern}"`,
      { timeout: 60000 }
    );

    const frameFiles = fs.readdirSync(tempDir)
      .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
      .sort();

    for (const file of frameFiles) {
      const filePath = path.join(tempDir, file);
      const jpegBuf = fs.readFileSync(filePath);
      const meta = await sharp(jpegBuf).metadata();
      const frameNum = parseInt(file.replace('frame_', '').replace('.jpg', ''), 10);
      const timestamp = (frameNum - 1) / fps;

      frames.push({
        jpegBuf,
        width: meta.width || 640,
        height: meta.height || 360,
        timestamp,
      });
    }

    return frames;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Convert a Buffer to base64 data URL for vision API
 */
function bufferToDataUrl(jpegBuf: Buffer): string {
  const base64 = jpegBuf.toString('base64');
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * Call VL model with multi-modal prompt (images + text).
 * Returns raw API response.
 */
async function callVLModel(
  modelMessages: Array<any>
): Promise<any> {
  const cfg = vlEnv();
  if (!cfg.apiKey) {
    throw new Error('OPENAI_API_KEY not configured for VL model');
  }

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: modelMessages,
      temperature: 0.35,
      max_tokens: 4096,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`VL API error: ${response.status} ${response.statusText} - ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch (err: any) {
    throw new Error(`VL API returned invalid JSON: ${responseText.slice(0, 200)}`);
  }
}

/**
 * Extract assistant text from response
 */
function extractAssistantText(response: any): string {
  const msg = response?.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  return '';
}

/**
 * Parse JSON from response, handling code blocks
 */
function parseJsonFromText(content: string): unknown {
  let s = content.trim();
  // Remove markdown code blocks
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '');
  }
  // Try direct parse first
  try {
    return JSON.parse(s);
  } catch {
    // Fallback: extract first JSON object from text
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        // Try to find and parse the shots array specifically
        const shotsStart = s.indexOf('"shots"');
        if (shotsStart >= 0) {
          const arrStart = s.indexOf('[', shotsStart);
          const arrEnd = s.lastIndexOf(']');
          if (arrStart >= 0 && arrEnd > arrStart) {
            try {
              return { shots: JSON.parse(s.slice(arrStart, arrEnd + 1)) };
            } catch {}
          }
        }
      }
    }
    throw new Error(`Failed to parse JSON from VL response: ${s.slice(0, 300)}`);
  }
}

/**
 * Format seconds to M:SS.s
 */
function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/**
 * Build multi-modal prompt for shot segmentation.
 * Returns messages array for VL API.
 */
function buildShotPrompt(
  frames: SamplingFrame[],
  subtitles: ClipSubtitle[],
  clipDuration: number
): Array<any> {
  const systemContent = `你是专业的视频分镜分析师。根据视频采样帧和字幕，将视频片段分割成shots（分镜）。

【任务说明】
每个 shot 代表一个独立的镜头或场景

【输出格式】
只输出 JSON：{"shots":[{"start":起始秒,"end":结束秒,"label":"场景描述"},...]}

【规则】
- start/end 是相对于 clip 起始的秒数（0 表示 clip 开头）
- 时间范围必须在 [0, ${clipDuration.toFixed(1)}] 内
- shot 之间不能重叠
- label 是简短描述该 shot 的内容，比如xx图表动画、工厂xx操作、办公室xxx、地球xxx`;

  // Build subtitle text
  const subtitleLines = subtitles.map((s, i) =>
    `#${i + 1} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  ).join('\n');

  // Build user content with images interspersed
  const userContent: Array<any> = [
    { type: 'text', text: `以下是视频片段的采样帧和字幕，请分析并分割 shots。片段总时长 ${clipDuration.toFixed(1)} 秒。\n\n字幕内容：\n${subtitleLines || '（无字幕）'}\n\n采样帧（按时间顺序）：` },
  ];

  // Add up to 8 frames evenly distributed
  const maxFrames = Math.min(frames.length, 8);
  const step = frames.length > maxFrames ? Math.floor(frames.length / maxFrames) : 1;
  for (let i = 0; i < frames.length; i += step) {
    const frame = frames[i];
    userContent.push({
      type: 'image_url',
      image_url: { url: bufferToDataUrl(frame.jpegBuf) },
    });
    userContent.push({
      type: 'text',
      text: `[t=${frame.timestamp.toFixed(1)}s]`,
    });
    if (userContent.filter(c => c.type === 'image_url').length >= maxFrames) break;
  }

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
}

/**
 * Parse and validate shot segments from VL response
 */
function parseShotSegments(
  parsed: any,
  clipDuration: number
): ShotSegment[] {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('VL response is not a valid object');
  }

  const shotsArray = parsed.shots || parsed.segments;
  if (!Array.isArray(shotsArray)) {
    throw new Error('VL response missing shots array');
  }

  const results: ShotSegment[] = [];

  for (const item of shotsArray) {
    if (!item || typeof item !== 'object') continue;

    const start = typeof item.start === 'number' ? item.start : parseFloat(item.start);
    const end = typeof item.end === 'number' ? item.end : parseFloat(item.end);
    const label = typeof item.label === 'string' ? item.label.trim() : `Shot ${results.length + 1}`;

    if (isNaN(start) || isNaN(end)) {
      console.warn('Skipping shot with invalid timestamps:', item);
      continue;
    }

    // Clamp to clip boundaries
    const clampedStart = Math.max(0, Math.min(start, clipDuration));
    const clampedEnd = Math.max(clampedStart + 3, Math.min(end, clipDuration));

    if (clampedEnd - clampedStart < 3) {
      console.warn('Skipping shot too short:', clampedStart, clampedEnd);
      continue;
    }

    results.push({ start: clampedStart, end: clampedEnd, label });
  }

  // Sort and validate no overlap
  results.sort((a, b) => a.start - b.start);

  // Merge/adjust overlapping shots
  const merged: ShotSegment[] = [];
  for (const shot of results) {
    if (merged.length === 0) {
      merged.push(shot);
      continue;
    }
    const last = merged[merged.length - 1];
    if (shot.start < last.end) {
      // Overlap - adjust previous end
      last.end = shot.start;
    }
    merged.push(shot);
  }

  // Ensure last shot reaches end of clip
  if (merged.length > 0) {
    merged[merged.length - 1].end = clipDuration;
  }

  // If only 1 shot and it covers almost entire clip, keep it as 1
  if (merged.length === 1) {
    merged[0].start = 0;
    merged[0].end = clipDuration;
  }

  return merged;
}

/**
 * Extract shot segments from a clip using VL model.
 * Returns array of ShotSegment with start/end relative to clip.
 */
export async function analyzeShots(
  clipPath: string,
  subtitles?: ClipSubtitle[]
): Promise<ShotSegment[]> {
  console.log(`Analyzing shots for clip: ${clipPath}`);

  // Get clip duration
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${clipPath}"`
  );
  const clipDuration = parseFloat(stdout.trim()) || 0;
  if (clipDuration <= 0) {
    throw new Error('Failed to get clip duration');
  }
  console.log(`Clip duration: ${clipDuration}s`);

  // Extract sampling frames at 1 FPS (max ~30 frames for typical clip)
  console.log('Extracting sampling frames...');
  const frames = await extractSamplingFrames(clipPath, 1.0);
  console.log(`Extracted ${frames.length} frames`);

  if (frames.length === 0) {
    // No frames extracted, return single shot
    return [{ start: 0, end: clipDuration, label: 'Full clip' }];
  }

  // Build prompt and call VL model
  console.log('Calling VL model for shot segmentation...');
  const messages = buildShotPrompt(frames, subtitles || [], clipDuration);
  const response = await callVLModel(messages);
  const content = extractAssistantText(response);

  if (!content) {
    throw new Error('No content in VL response');
  }

  console.log('VL response:', content);

  // Parse result
  const parsed = parseJsonFromText(content);
  const shots = parseShotSegments(parsed, clipDuration);

  console.log(`Detected ${shots.length} shots:`, shots.map(s => `${s.start}-${s.end}s: ${s.label}`).join(', '));

  return shots;
}

/**
 * Cut shots from a clip using FFmpeg.
 * Returns array of { shotPath, thumbnailPath, segment }.
 */
export async function cutShots(
  clipPath: string,
  shots: ShotSegment[],
  clipId: string
): Promise<Array<{ path: string; thumbnailPath: string; segment: ShotSegment; clipUrl: string; thumbnailUrl: string }>> {
  const shotsDir = path.join(process.cwd(), 'clips', 'shots');
  const thumbsDir = path.join(shotsDir, 'thumbnails');

  if (!fs.existsSync(shotsDir)) {
    fs.mkdirSync(shotsDir, { recursive: true });
  }
  if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  const results: Array<{ path: string; thumbnailPath: string; segment: ShotSegment; clipUrl: string; thumbnailUrl: string }> = [];

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const fileName = `${clipId}_shot_${i}.mp4`;
    const thumbName = `${clipId}_shot_${i}.jpg`;
    const outputPath = path.join(shotsDir, fileName);
    const thumbPath = path.join(thumbsDir, thumbName);

    console.log(`Cutting shot ${i}: ${shot.start}s - ${shot.end}s`);
    await extractClip({
      videoPath: clipPath,
      startSec: shot.start,
      endSec: shot.end,
      outputPath,
      codec: 'copy',
    });

    // Generate thumbnail at midpoint
    const midTime = (shot.start + shot.end) / 2;
    const thumbCmd = `ffmpeg -i "${clipPath}" -ss ${midTime} -vframes 1 -q:v 2 -y "${thumbPath}"`;
    try {
      await execAsync(thumbCmd);
    } catch (err) {
      console.warn(`Failed to generate thumbnail for shot ${i}:`, err);
    }

    results.push({
      path: outputPath,
      thumbnailPath: thumbPath,
      segment: shot,
      clipUrl: `/api/clips/shots/${fileName}`,
      thumbnailUrl: `/api/clips/shots/thumbnails/${thumbName}`,
    });

    console.log(`Shot ${i} saved: ${outputPath}`);
  }

  return results;
}

/**
 * Full pipeline: analyze shots + cut them from clip.
 * Returns array of shot info with URLs.
 */
export async function segmentShots(
  clipPath: string,
  clipId: string,
  subtitles?: ClipSubtitle[]
): Promise<Array<{ start: number; end: number; label: string; clipUrl: string; thumbnailUrl: string; duration: string }>> {
  // Analyze shots
  const shots = await analyzeShots(clipPath, subtitles);

  // Cut shots
  const cutResults = await cutShots(clipPath, shots, clipId);

  // Format result
  return cutResults.map(r => {
    const durSec = r.segment.end - r.segment.start;
    const mins = Math.floor(durSec / 60);
    const secs = Math.floor(durSec % 60);
    return {
      start: r.segment.start,
      end: r.segment.end,
      label: r.segment.label,
      clipUrl: r.clipUrl,
      thumbnailUrl: r.thumbnailUrl,
      duration: `${mins}:${secs.toString().padStart(2, '0')}`,
    };
  });
}