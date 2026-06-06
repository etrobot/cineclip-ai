import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { extractClip } from './ffmpeg';
import type { SubtitleSegment } from './youtube';
import { buildVideoContextBlock, formatTime } from './llmPrompt';
import type { VideoContext } from './llmPrompt';
import { extractFrameAt, getSceneTimestamps, addSceneIndexToBuffer, MAX_GRID_CELLS, MAX_GRID_COLS, MAX_GRID_ROWS } from './grid';

const execAsync = promisify(exec);

/**
 * Shot segment result from VL model analysis
 */
export interface ShotSegment {
  start: number;
  end: number;
  label: string;
  category: string;
}

/**
 * Extracted frame with timestamp for VL analysis
 */
interface SamplingFrame {
  jpegBuf: Buffer;
  width: number;
  height: number;
  timestamp: number;
  sceneIndex: number;
}

interface SceneBoundary {
  index: number;
  start: number;
  end: number;
  startUs: number;
  endUs: number;
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
      max_tokens: 8192,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`VL API error: ${response.status} ${response.statusText} - ${responseText}`);
  }

  const result = (() => { try { return { ok: true as const, value: JSON.parse(responseText) }; } catch { return { ok: false as const }; } })();
  if (!result.ok) {
    throw new Error(`VL API returned invalid JSON: ${responseText.slice(0, 200)}`);
  }
  return result.value;
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
 * Parse JSON from response, handling code blocks and truncated output.
 */
function parseJsonFromText(content: string): unknown {
  let s = content.trim();
  // Remove markdown code blocks
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '');
  }
  // Try direct parse first
  const directError = (() => { try { return { ok: true, value: JSON.parse(s) as unknown }; } catch (e) { return { ok: false, error: e }; } })();
  if (directError.ok) return directError.value;

  // Extract first JSON object from text
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const objError = (() => { try { return { ok: true, value: JSON.parse(s.slice(start, end + 1)) as unknown }; } catch (e) { return { ok: false, error: e }; } })();
    if (objError.ok) return objError.value;
  }

  // Recover complete segments from truncated JSON
  const segmentsStart = s.indexOf('"segments"');
  if (segmentsStart >= 0) {
    const arrStart = s.indexOf('[', segmentsStart);
    if (arrStart >= 0) {
      const arrContent = s.slice(arrStart + 1);
      const recovered: any[] = [];
      let depth = 0;
      let objStart = -1;
      for (let i = 0; i < arrContent.length; i++) {
        if (arrContent[i] === '{') {
          if (depth === 0) objStart = i;
          depth++;
        } else if (arrContent[i] === '}') {
          depth--;
          if (depth === 0 && objStart >= 0) {
            const objStr = arrContent.slice(objStart, i + 1);
            const objResult = (() => { try { return { ok: true, value: JSON.parse(objStr) }; } catch { return { ok: false }; } })();
            if (objResult.ok) recovered.push(objResult.value);
            objStart = -1;
          }
        }
      }
      if (recovered.length > 0) {
        console.warn(`Recovered ${recovered.length} segments from truncated VL response`);
        return { segments: recovered };
      }
    }
  }

  throw new Error(`Failed to parse JSON from VL response: ${s.slice(0, 300)}`);
}

/**
 * Build a scene-indexed grid image from scene keyframes.
 * Returns the grid as a Buffer.
 * Grid is capped at MAX_GRID_COLS × MAX_GRID_ROWS to ensure VL model can process it.
 */
async function buildSceneGrid(
  frames: SamplingFrame[],
  videoWidth: number,
  videoHeight: number,
  maxGridSize: number = 2000
): Promise<Buffer> {
  const numImages = Math.min(frames.length, MAX_GRID_CELLS);
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

  // Enforce max grid dimensions
  cols = Math.min(cols, MAX_GRID_COLS);
  rows = Math.min(rows, MAX_GRID_ROWS);
  while (cols * rows < numImages && cols < MAX_GRID_COLS && rows < MAX_GRID_ROWS) {
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

    // Resize and add scene index
    let resizedBuf = await sharp(frame.jpegBuf)
      .resize(cellW, cellH, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();

    resizedBuf = await addSceneIndexToBuffer(resizedBuf, frame.sceneIndex, cellW, cellH);

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

// extractFrameAt and getSceneTimestamps are imported from ./grid

/**
 * Call VL model to analyze grid and suggest shot groupings.
 * Returns array of scene-index ranges describing which grid cells belong together.
 */
async function analyzeGridSegments(
  gridBuf: Buffer,
  scenes: SceneBoundary[],
  subtitles: ClipSubtitle[],
  clipDuration: number,
  videoCtx?: VideoContext
): Promise<Array<{ startScene: number; endScene: number; label: string; category: string }>> {
  const cfg = vlEnv();
  if (!cfg.apiKey) {
    throw new Error('OPENAI_API_KEY not configured for VL model');
  }

  const numScenes = scenes.length;
  const sceneIndexList = scenes.map(scene => `#${scene.index}`).join(', ');
  const sceneList = scenes.map(scene =>
    `#${scene.index} [${scene.start.toFixed(6)}-${scene.end.toFixed(6)}]`
  ).join('\n');

  // Build subtitle text
  const subtitleLines = subtitles.map((s, i) =>
    `[${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  ).join('\n');

  let userText = `时长：${clipDuration.toFixed(6)}s\n\n`;
  userText += `可选 scene 序号：${sceneIndexList}\n\n`;
  userText += `scene 列表：\n${sceneList}\n\n`;
  if (subtitleLines) {
    userText += `字幕：\n${subtitleLines}\n\n`;
  }
  if (videoCtx) {
    const contextBlock = buildVideoContextBlock(videoCtx);
    userText += `${contextBlock}\n\n`;
  }

  const systemContent = `根据帧合集提取分镜。每张图左下角黄色标记是 scene 序号，不是时间。画面相似的连续 scene 合并为一段，画面明显不同才分段。只输出JSON。

输出格式：{"segments":[{"startScene":1,"endScene":3,"label":"火箭组装","category":"纪录"},{"startScene":4,"endScene":6,"label":"电子产线","category":"纪录"},{"startScene":7,"endScene":10,"label":"发射场景","category":"纪录"}]}

category 分类（每段必须选一个）：讲座、标题、图表、纪录、卡通、访谈、新闻、演示、动画、片头、片尾、过渡、广告、音乐、其他

规则：
- startScene 和 endScene 只能从提供的 scene 序号中选取，必须是整数
- startScene / endScene 表示闭区间，前后段必须连续覆盖全部 scene
- 首段 startScene=1，末段 endScene=${numScenes}
- 前一段 endScene + 1 = 下一段 startScene
- 不允许跳号、不允许重叠、不允许遗漏任何 scene
- label 用具体内容命名，禁止用"描述""片段"等空洞词`;

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

  console.log(`Calling VL model to analyze grid segments (${numScenes} scenes)...`);
  const response = await callVLModel(messages);
  const content = extractAssistantText(response);

  if (!content) {
    throw new Error('VL model returned empty response');
  }

  console.log('VL segment analysis response:', content);

  const parsed = parseJsonFromText(content);
  if (parsed && Array.isArray((parsed as any).segments)) {
    const raw: Array<{ startScene: number; endScene: number; label: string; category: string }> = (parsed as any).segments
      .map((s: any) => ({
        startScene: typeof s.startScene === 'number' ? s.startScene : parseInt(String(s.startScene), 10),
        endScene: typeof s.endScene === 'number' ? s.endScene : parseInt(String(s.endScene), 10),
        label: s.label || `Segment`,
        category: s.category || '其他',
      }))
      .filter((s: { startScene: number; endScene: number; label: string; category: string }) =>
        Number.isInteger(s.startScene) &&
        Number.isInteger(s.endScene) &&
        s.startScene >= 1 &&
        s.endScene >= s.startScene &&
        s.endScene <= numScenes
      );

    if (raw.length === 0) {
      throw new Error('VL response did not contain any valid scene-index segments');
    }

    raw.sort((a, b) => a.startScene - b.startScene);

    let expectedStart = 1;
    for (const seg of raw) {
      if (seg.startScene !== expectedStart) {
        throw new Error(`VL scene coverage is invalid: expected startScene=${expectedStart}, got ${seg.startScene}`);
      }
      expectedStart = seg.endScene + 1;
    }
    if (expectedStart !== numScenes + 1) {
      throw new Error(`VL scene coverage is incomplete: expected final endScene=${numScenes}`);
    }

    // Merge adjacent segments with the same (or very similar) label
    const merged: Array<{ startScene: number; endScene: number; label: string; category: string }> = [];
    for (const seg of raw) {
      if (merged.length === 0) {
        merged.push({ ...seg });
        continue;
      }
      const last = merged[merged.length - 1];
      const lastLabel = last.label.trim().toLowerCase();
      const curLabel = seg.label.trim().toLowerCase();
      const lastCategory = last.category.trim().toLowerCase();
      const curCategory = seg.category.trim().toLowerCase();
      if ((lastLabel === curLabel || lastLabel.includes(curLabel) || curLabel.includes(lastLabel)) && lastCategory === curCategory) {
        last.endScene = seg.endScene;
      } else {
        merged.push({ ...seg });
      }
    }

    return merged;
  }

  throw new Error('VL response did not contain valid segments');
}

/**
 * Extract shot segments from a clip using FFmpeg scene detection + VL grid segmentation.
 * Returns array of ShotSegment with start/end relative to clip.
 */
export interface AnalyzeShotsResult {
  shots: ShotSegment[];
  gridBuf: Buffer;
}

export async function analyzeShots(
  clipPath: string,
  subtitles?: ClipSubtitle[],
  videoCtx?: VideoContext
): Promise<AnalyzeShotsResult> {
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

  // Step 1: Use FFmpeg scene detection to get keyframe timestamps
  console.log('Detecting scene changes with FFmpeg...');
  const timestamps = await getSceneTimestamps(clipPath, MAX_GRID_CELLS);
  console.log(`Detected ${timestamps.length} scene keyframes`);

  if (timestamps.length === 0) {
    throw new Error('No scene keyframes detected from video');
  }

  // Step 2: Extract frames at detected timestamps
  const keyFrames: SamplingFrame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const frame = await extractFrameAt(clipPath, ts);
    if (frame) {
      keyFrames.push({ ...frame, timestamp: ts, sceneIndex: i + 1 });
    }
  }

  if (keyFrames.length !== timestamps.length) {
    throw new Error(`Failed to extract all scene frames: expected ${timestamps.length}, got ${keyFrames.length}`);
  }

  const boundaries: number[] = [...timestamps, clipDuration];
  const scenes: SceneBoundary[] = keyFrames.map((frame, i) => {
    const start = frame.timestamp;
    const end = boundaries[i + 1];
    return {
      index: frame.sceneIndex,
      start,
      end,
      startUs: Math.round(start * 1_000_000),
      endUs: Math.round(end * 1_000_000),
    };
  });

  // Step 3: Build scene-indexed grid image
  console.log('Building scene-indexed grid image...');
  const gridBuf = await buildSceneGrid(keyFrames, videoWidth || 1920, videoHeight || 1080);
  console.log(`Grid image: ${gridBuf.length} bytes`);

  // Step 4: Use VL model to suggest segment groupings from grid
  const segments = await analyzeGridSegments(
    gridBuf,
    scenes,
    subtitles || [],
    clipDuration,
    videoCtx
  );

  // Step 5: Build ShotSegment array from VL suggestions via scene-index → precise boundary mapping
  const shots: ShotSegment[] = [];
  for (const seg of segments) {
    const startScene = scenes[seg.startScene - 1];
    const endScene = scenes[seg.endScene - 1];
    if (!startScene || !endScene) {
      throw new Error(`Invalid scene range returned by VL: ${seg.startScene}-${seg.endScene}`);
    }

    const start = startScene.startUs / 1_000_000;
    const end = endScene.endUs / 1_000_000;

    // Skip shots that are too short (< 1.0s)
    if (end - start < 1.0) {
      console.warn(`Skipping shot too short: ${start.toFixed(3)} - ${end.toFixed(3)}s`);
      continue;
    }

    shots.push({
      start,
      end,
      label: seg.label,
      category: seg.category,
    });
  }

  console.log(`Detected ${shots.length} shots:`, shots.map(s => `${s.start.toFixed(3)}-${s.end.toFixed(3)}s: ${s.label}`).join(', '));

  return { shots, gridBuf };
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
      codec: 'reencode',
    });

    // Generate thumbnail at midpoint
    const midTime = (shot.start + shot.end) / 2;
    const thumbCmd = `ffmpeg -i "${clipPath}" -ss ${midTime} -vframes 1 -q:v 2 -y "${thumbPath}"`;
    await execAsync(thumbCmd);

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
 * Returns array of shot info with URLs, plus the grid image URL.
 */
export async function segmentShots(
  clipPath: string,
  clipId: string,
  subtitles?: ClipSubtitle[],
  videoCtx?: VideoContext
): Promise<{ shots: Array<{ start: number; end: number; label: string; category: string; clipUrl: string; thumbnailUrl: string; duration: string }>; gridUrl: string }> {
  // Analyze shots
  const { shots, gridBuf } = await analyzeShots(clipPath, subtitles, videoCtx);

  // Save grid image to file
  let gridUrl = '';
  if (gridBuf.length > 0) {
    const shotsDir = path.join(process.cwd(), 'clips', 'shots');
    if (!fs.existsSync(shotsDir)) {
      fs.mkdirSync(shotsDir, { recursive: true });
    }
    const gridFileName = `${clipId}_grid.jpg`;
    const gridPath = path.join(shotsDir, gridFileName);
    fs.writeFileSync(gridPath, gridBuf);
    gridUrl = `/api/clips/shots/${gridFileName}`;
    console.log(`Grid image saved: ${gridPath}`);
  }

  // Cut shots
  const cutResults = await cutShots(clipPath, shots, clipId);

  // Format result
  return {
    shots: cutResults.map(r => {
      const durSec = r.segment.end - r.segment.start;
      const mins = Math.floor(durSec / 60);
      const secs = Math.floor(durSec % 60);
      return {
        start: r.segment.start,
        end: r.segment.end,
        label: r.segment.label,
        category: r.segment.category,
        clipUrl: r.clipUrl,
        thumbnailUrl: r.thumbnailUrl,
        duration: `${mins}:${secs.toString().padStart(2, '0')}`,
      };
    }),
    gridUrl,
  };
}
