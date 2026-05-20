import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { extractClip, detectSceneChanges } from './ffmpeg';
import type { SubtitleSegment } from './youtube';
import { buildVideoContextBlock, formatTime } from './llmPrompt';
import type { VideoContext } from './llmPrompt';

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
 * Extract a single frame at a specific timestamp from a video.
 */
async function extractFrameAt(
  clipPath: string,
  timestamp: number
): Promise<{ jpegBuf: Buffer; width: number; height: number } | null> {
  const tempDir = path.join(process.cwd(), 'storage', 'temp', `frame_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const outputPath = path.join(tempDir, 'frame.jpg');

  try {
    const cmd = `ffmpeg -i "${clipPath}" -ss ${timestamp} -vframes 1 -q:v 2 -y "${outputPath}"`;
    await execAsync(cmd, { timeout: 30000 });

    if (fs.existsSync(outputPath)) {
      const jpegBuf = fs.readFileSync(outputPath);
      const meta = await sharp(jpegBuf).metadata();
      return {
        jpegBuf,
        width: meta.width || 640,
        height: meta.height || 360,
      };
    }
    return null;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Add scene number label to a frame buffer.
 */
async function addSceneNumberToBuffer(
  imgBuf: Buffer,
  sceneNum: number,
  timestamp: number,
  width: number,
  height: number
): Promise<Buffer> {
  const totalSecs = Math.floor(timestamp);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
  const text = `#${sceneNum} ${timeStr}`;

  const fontSize = Math.max(14, Math.floor(width / 20));
  const padding = Math.max(4, Math.floor(width / 60));
  const textWidth = text.length * fontSize * 0.6;
  const textHeight = fontSize * 1.4;

  const bgX = padding;
  const bgY = padding;
  const bgW = textWidth + padding * 2;
  const bgH = textHeight + padding * 2;

  const svg = Buffer.from(`<svg width="${width}" height="${height}">
    <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" fill="black" opacity="0.75" rx="3"/>
    <text x="${bgX + padding}" y="${bgY + padding + fontSize}" fill="#FFFF00" font-family="monospace" font-size="${fontSize}" font-weight="bold">${text}</text>
  </svg>`);

  return sharp(imgBuf)
    .composite([{ input: svg, blend: 'over' }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Build a numbered grid image from scene keyframes.
 * Returns the grid as a Buffer.
 */
async function buildSceneGrid(
  frames: Array<{ jpegBuf: Buffer; width: number; height: number; timestamp: number }>,
  videoWidth: number,
  videoHeight: number,
  maxGridSize: number = 2000
): Promise<Buffer> {
  const numImages = frames.length;
  const videoRatio = videoWidth / videoHeight || 1.0;
  const gridRatio = videoHeight / videoWidth || 1.0;

  // Calculate grid layout
  let cols: number, rows: number;
  if (gridRatio >= 1.0) {
    cols = Math.max(1, Math.round(Math.sqrt(numImages * gridRatio)));
    rows = Math.max(1, Math.ceil(numImages / cols));
  } else {
    rows = Math.max(1, Math.round(Math.sqrt(numImages / gridRatio)));
    cols = Math.max(1, Math.ceil(numImages / rows));
  }
  while (cols * rows < numImages) {
    if (gridRatio >= 1.0) cols++;
    else rows++;
  }

  // Calculate cell size
  let cellW = 480, cellH = 240;
  if (videoRatio > 1.0) {
    cellH = Math.round(cellW / videoRatio);
  } else {
    cellW = Math.round(cellH * videoRatio);
  }

  const gridW = cols * cellW + (cols + 1);
  const gridH = rows * cellH + (rows + 1);
  if (Math.max(gridW, gridH) > maxGridSize) {
    const scale = maxGridSize / Math.max(gridW, gridH);
    cellW = Math.floor(cellW * scale);
    cellH = Math.floor(cellH * scale);
  }

  // Build composites
  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < numImages; i++) {
    const frame = frames[i];
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = c * cellW + (c + 1);
    const y = r * cellH + (r + 1);

    // Resize and add scene number
    let resizedBuf = await sharp(frame.jpegBuf)
      .resize(cellW, cellH, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();

    resizedBuf = await addSceneNumberToBuffer(resizedBuf, i + 1, frame.timestamp, cellW, cellH);

    composites.push({ input: resizedBuf, left: x, top: y });
  }

  // Pad with black if needed
  const capacity = cols * rows;
  if (numImages < capacity) {
    const blackTile = await sharp({
      create: { width: cellW, height: cellH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    for (let i = numImages; i < capacity; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const x = c * cellW + (c + 1);
      const y = r * cellH + (r + 1);
      composites.push({ input: blackTile, left: x, top: y });
    }
  }

  // Create canvas and composite
  let gridImage = sharp({
    create: { width: gridW, height: gridH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });

  const batchSize = 50;
  for (let i = 0; i < composites.length; i += batchSize) {
    const batch = composites.slice(i, i + batchSize);
    gridImage = gridImage.composite(batch);
  }

  return gridImage.jpeg({ quality: 90 }).toBuffer();
}

/**
 * Call VL model to classify all scenes from a grid image.
 * Returns array of labels.
 */
async function classifyScenesFromGrid(
  gridBuf: Buffer,
  numScenes: number,
  boundaries: number[],
  subtitles: ClipSubtitle[],
  clipDuration: number,
  videoCtx?: VideoContext
): Promise<string[]> {
  const cfg = vlEnv();
  if (!cfg.apiKey) {
    console.warn('OPENAI_API_KEY not configured, using default labels');
    return Array.from({ length: numScenes }, (_, i) => `Shot ${i + 1}`);
  }

  // Build scene list text
  const sceneList = boundaries.slice(0, -1).map((start, i) => {
    const end = boundaries[i + 1];
    return `场景 ${i + 1}: ${start.toFixed(3)}s - ${end.toFixed(3)}s`;
  }).join('\n');

  // Build subtitle text
  const subtitleLines = subtitles.map((s, i) =>
    `#${i + 1} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  ).join('\n');

  // Build user prompt
  let userText = `以下是一张 grid 图，包含从视频 clip 中提取的所有场景关键帧，每个格子左上角标有编号和时间。\n\n`;
  userText += `clip 时长：${clipDuration.toFixed(1)} 秒\n\n`;
  userText += `场景列表（FFmpeg 检测到的精确边界）：\n${sceneList}\n\n`;
  if (subtitleLines) {
    userText += `clip 内字幕：\n${subtitleLines}\n\n`;
  }
  userText += `请为每个场景生成标签，按编号顺序输出 JSON：{"labels":["标签1","标签2",...]}`;

  // Add video context if available
  if (videoCtx) {
    const contextBlock = buildVideoContextBlock(videoCtx);
    userText = `${contextBlock}\n\n${userText}`;
  }

  const systemContent = `你是专业的视频分镜分析师。根据提供的 grid 图（包含编号场景关键帧）、字幕和视频主题，为每个场景给出简短的描述标签。

【输出格式】
只输出 JSON：{"labels":["标签1","标签2",...]}

【规则】
- 每个标签对应 grid 中的一个编号场景，按编号顺序输出
- 标签应简短描述该场景的核心内容，如：工厂航拍、火箭发射、机器人操作、焊接特写
- 标签应结合视频整体主题，禁止空洞词汇如"视频片段"、"精彩瞬间"`;

  const messages = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        {
          type: 'image_url',
          image_url: { url: bufferToDataUrl(gridBuf) },
        },
      ],
    },
  ];

  console.log(`Calling VL model to classify ${numScenes} scenes from grid...`);
  const response = await callVLModel(messages);
  const content = extractAssistantText(response);

  if (!content) {
    console.warn('No content in VL response, using default labels');
    return Array.from({ length: numScenes }, (_, i) => `Shot ${i + 1}`);
  }

  console.log('VL classification response:', content);

  // Parse labels
  try {
    const parsed = parseJsonFromText(content);
    if (parsed && Array.isArray((parsed as any).labels)) {
      const labels = (parsed as any).labels;
      while (labels.length < numScenes) {
        labels.push(`Shot ${labels.length + 1}`);
      }
      return labels.slice(0, numScenes);
    }
  } catch (err) {
    console.warn('Failed to parse VL labels:', err);
  }

  return Array.from({ length: numScenes }, (_, i) => `Shot ${i + 1}`);
}

/**
 * Extract shot segments from a clip using FFmpeg scene detection + VL grid classification.
 * Returns array of ShotSegment with start/end relative to clip.
 */
export async function analyzeShots(
  clipPath: string,
  subtitles?: ClipSubtitle[],
  videoCtx?: VideoContext
): Promise<ShotSegment[]> {
  console.log(`Analyzing shots for clip: ${clipPath}`);

  // Get clip duration and resolution
  const { stdout: durationOut } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${clipPath}"`
  );
  const clipDuration = parseFloat(durationOut.trim()) || 0;
  if (clipDuration <= 0) {
    throw new Error('Failed to get clip duration');
  }

  const { stdout: resOut } = await execAsync(
    `ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x -select_streams v:0 "${clipPath}"`
  );
  const [videoWidth, videoHeight] = resOut.trim().split('x').map(Number);

  console.log(`Clip: ${clipDuration.toFixed(3)}s, ${videoWidth}x${videoHeight}`);

  // Step 1: Detect scene changes with FFmpeg (precise to frame level)
  console.log('Detecting scene changes with FFmpeg...');
  const boundaries = await detectSceneChanges(clipPath, 0.3);
  console.log(`Scene boundaries: ${boundaries.map(b => b.toFixed(3)).join(', ')}`);

  if (boundaries.length <= 2) {
    return [{ start: 0, end: clipDuration, label: 'Full clip' }];
  }

  // Step 2: Extract keyframes at scene midpoints
  console.log('Extracting keyframes at scene midpoints...');
  const keyFrames: Array<{ jpegBuf: Buffer; width: number; height: number; timestamp: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const mid = (start + end) / 2;

    const frame = await extractFrameAt(clipPath, mid);
    if (frame) {
      keyFrames.push({ ...frame, timestamp: mid });
    }
  }
  console.log(`Extracted ${keyFrames.length} keyframes`);

  if (keyFrames.length === 0) {
    return [{ start: 0, end: clipDuration, label: 'Full clip' }];
  }

  // Step 3: Build numbered grid image
  console.log('Building numbered grid image...');
  const gridBuf = await buildSceneGrid(keyFrames, videoWidth || 1920, videoHeight || 1080);
  console.log(`Grid image: ${gridBuf.length} bytes`);

  // Step 4: Use VL model to classify all scenes from grid (single call)
  const labels = await classifyScenesFromGrid(
    gridBuf,
    keyFrames.length,
    boundaries,
    subtitles || [],
    clipDuration,
    videoCtx
  );

  // Step 5: Build ShotSegment array from boundaries + labels
  const shots: ShotSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const label = labels[i] || `Shot ${i + 1}`;

    // Skip shots that are too short (< 0.5s)
    if (end - start < 0.5) {
      console.warn(`Skipping shot too short: ${start.toFixed(3)} - ${end.toFixed(3)}`);
      continue;
    }

    shots.push({
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      label,
    });
  }

  console.log(`Detected ${shots.length} shots:`, shots.map(s => `${s.start.toFixed(3)}-${s.end.toFixed(3)}s: ${s.label}`).join(', '));

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
  subtitles?: ClipSubtitle[],
  videoCtx?: VideoContext
): Promise<Array<{ start: number; end: number; label: string; clipUrl: string; thumbnailUrl: string; duration: string }>> {
  // Analyze shots
  const shots = await analyzeShots(clipPath, subtitles, videoCtx);

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
