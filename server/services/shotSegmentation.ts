import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { extractClip } from './ffmpeg';
import type { SubtitleSegment } from './youtube';
import { buildShotVLUserPrompt } from './llmPrompt';
import { extractFrameAt, getSceneTimestamps, removeNearDuplicateFrames, addSceneIndexToBuffer, renderCompositeGrid, MAX_GRID_CELLS, MAX_GRID_COLS, MAX_GRID_ROWS } from './grid';

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

export interface ShotAnalysisContext {
  fullSubtitles: SubtitleSegment[];
  clipStartTime: number;
  clipEndTime: number;
  videoTitle?: string;
  videoDescription?: string;
}

/**
 * Parse clip start/end times from clipId or filename (e.g. videoId_0p6_130p1).
 */
export function parseClipTimeRange(name: string): { start: number; end: number } | null {
  const baseName = path.parse(name).name;
  const underscoreIdx = baseName.indexOf('_');
  if (underscoreIdx < 0) return null;

  const videoId = baseName.slice(0, underscoreIdx);
  const timePart = baseName.slice(videoId.length + 1);
  const timeParts = timePart.split('_');
  if (timeParts.length < 2) return null;

  const start = parseFloat(timeParts[0].replace(/p/g, '.'));
  const end = parseFloat(timeParts[1].replace(/p/g, '.'));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
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
 *
 * Retries on 429 (rate limited) and 5xx (server error) with exponential backoff.
 */
async function callVLModel(
  modelMessages: Array<any>
): Promise<any> {
  const cfg = vlEnv();
  if (!cfg.apiKey) {
    throw new Error('OPENAI_API_KEY not configured for VL model');
  }

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 2000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

    // Retry on 429 (rate limited) or 5xx (server error)
    if (!response.ok && (response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get('Retry-After');
      let delay: number;
      if (retryAfter) {
        // Respect Retry-After header (seconds)
        delay = parseInt(retryAfter, 10) * 1000;
      } else {
        // Exponential backoff: 2s, 4s, 8s + jitter
        delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      }
      console.warn(`VL API ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    if (!response.ok) {
      throw new Error(`VL API error: ${response.status} ${response.statusText} - ${responseText}`);
    }

    const result = (() => { try { return { ok: true as const, value: JSON.parse(responseText) }; } catch { return { ok: false as const }; } })();
    if (!result.ok) {
      throw new Error(`VL API returned invalid JSON: ${responseText.slice(0, 200)}`);
    }
    return result.value;
  }

  throw new Error('VL API: max retries exceeded');
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

  return renderCompositeGrid(gridW, gridH, composites);
}

// extractFrameAt and getSceneTimestamps are imported from ./grid

/**
 * Call VL model to analyze grid and suggest shot groupings.
 * Returns array of scene-index ranges describing which grid cells belong together.
 */
async function analyzeGridSegments(
  gridBuf: Buffer,
  scenes: SceneBoundary[],
  clipDuration: number,
  analysisCtx?: ShotAnalysisContext
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

  const userText = buildShotVLUserPrompt({
    clipStartTime: analysisCtx?.clipStartTime ?? 0,
    clipEndTime: analysisCtx?.clipEndTime ?? clipDuration,
    clipDuration,
    fullSubtitles: analysisCtx?.fullSubtitles ?? [],
    sceneIndexList,
    sceneList,
    videoTitle: analysisCtx?.videoTitle,
    videoDescription: analysisCtx?.videoDescription,
  });

  console.log(`Shot VL prompt: clip [${analysisCtx?.clipStartTime ?? 0}s - ${analysisCtx?.clipEndTime ?? clipDuration}s], subtitles=${analysisCtx?.fullSubtitles?.length ?? 0}条`);

  const systemContent = `根据帧合集提取分镜。每张图左下角黄色标记是 scene 序号，不是时间。画面相似的连续 scene 合并为一段，画面明显不同才分段。只输出JSON。

输出格式：{"segments":[{"startScene":1,"endScene":3,"label":"用卡通角色飞入动效介绍产品三大核心功能","category":"演示"},{"startScene":4,"endScene":6,"label":"用柱状图动画讲解2024年各季度销量增长趋势","category":"图表"},{"startScene":7,"endScene":10,"label":"用快切特写展示工厂机械臂组装芯片全过程","category":"纪录"}]}

category 分类（每段必须选一个）：讲座、标题、图表、纪录、卡通、访谈、新闻、演示、动画、片头、片尾、过渡、广告、音乐、其他

规则：
- startScene 和 endScene 只能从提供的 scene 序号中选取，必须是整数
- startScene / endScene 表示闭区间，前后段必须连续覆盖全部 scene
- 首段 startScene=1，末段 endScene=${numScenes}
- 前一段 endScene + 1 = 下一段 startScene
- 不允许跳号、不允许重叠、不允许遗漏任何 scene
- label 必须同时包含三个要素：①呈现手法（镜头/动效/转场，如飞入、缩放、快切、特写、分屏、淡入）②主体对象（人物/产品/图表/场景）③讲解或展示的具体内容（这段在讲什么、展示什么）
- label 写法参考：「用[动效/镜头]讲解/展示/介绍[具体内容]」「[主体]在[场景]中[具体动作]说明[知识点]」
- 必须结合完整字幕 JSON 中该段对应时间范围内的内容（clip绝对时间 = clip起始时间 + scene相对时间），说明这段视频在传达什么信息
- label 长度 15-40 字，信息密度要高，让人一看就知道这段在干什么
- 禁止笼统 label：开场动画、卡通动画、图表展示、过渡画面、片头片尾、描述、片段、场景 等无具体信息的词
- category 只表示画面类型，具体语义写在 label 里，不要把 category 当 label 用`;

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
  analysisCtx?: ShotAnalysisContext
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

  const normalizedCtx = analysisCtx
    ? {
        ...analysisCtx,
        clipEndTime: analysisCtx.clipEndTime > analysisCtx.clipStartTime
          ? analysisCtx.clipEndTime
          : analysisCtx.clipStartTime + clipDuration,
      }
    : undefined;

  if (normalizedCtx) {
    console.log(`Clip in full video: [${normalizedCtx.clipStartTime.toFixed(1)}s - ${normalizedCtx.clipEndTime.toFixed(1)}s], subtitles=${normalizedCtx.fullSubtitles.length}条`);
  }

  // Step 1: Use FFmpeg scene detection to get keyframe timestamps
  console.log('Detecting scene changes with FFmpeg...');
  const timestamps = await getSceneTimestamps(clipPath, MAX_GRID_CELLS);
  console.log(`Detected ${timestamps.length} scene keyframes`);

  if (timestamps.length === 0) {
    throw new Error('No scene keyframes detected from video');
  }

  // Step 2: Extract frames at detected timestamps
  const extractedFrames: SamplingFrame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const frame = await extractFrameAt(clipPath, ts);
    if (frame) {
      extractedFrames.push({ ...frame, timestamp: ts, sceneIndex: i + 1 });
    }
  }

  if (extractedFrames.length !== timestamps.length) {
    throw new Error(`Failed to extract all scene frames: expected ${timestamps.length}, got ${extractedFrames.length}`);
  }

  const keyFrames = (await removeNearDuplicateFrames(extractedFrames))
    .map((frame, i) => ({ ...frame, sceneIndex: i + 1 }));
  console.log(`Shot grid: visual dedupe ${extractedFrames.length} → ${keyFrames.length} frames`);

  const scenes: SceneBoundary[] = keyFrames.map((frame, i) => {
    const start = frame.timestamp;
    const end = keyFrames[i + 1]?.timestamp ?? clipDuration;
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
    clipDuration,
    normalizedCtx
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
  analysisCtx?: ShotAnalysisContext
): Promise<{ shots: Array<{ start: number; end: number; label: string; category: string; clipUrl: string; thumbnailUrl: string; duration: string }>; gridUrl: string }> {
  // Analyze shots
  const { shots, gridBuf } = await analyzeShots(clipPath, analysisCtx);

  // Save grid image to file under clips/thumbnails/{videoId}/
  let gridUrl = '';
  if (gridBuf.length > 0) {
    const videoId = clipId.replace(/_[-\dp]+$/, '');
    const thumbsDir = path.join(process.cwd(), 'clips', 'thumbnails', videoId);
    if (!fs.existsSync(thumbsDir)) {
      fs.mkdirSync(thumbsDir, { recursive: true });
    }
    const gridFileName = `${clipId}_grid.jpg`;
    const gridPath = path.join(thumbsDir, gridFileName);
    fs.writeFileSync(gridPath, gridBuf);
    gridUrl = `/api/clips/thumbnails/${videoId}/${gridFileName}`;
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
