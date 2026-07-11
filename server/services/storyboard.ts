import { db } from '../db';
import { author, originalPost, clips as clipsTable, shots as shotsTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import { callLLM, extractAssistantText, parseJsonObject } from './llm';

interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface StoryboardEntry {
  shotNumber: number;
  clipTitle: string;
  shotLabel: string;
  timeRange: string;
  absoluteStart: number;
  absoluteEnd: number;
  shotType: string;
  cameraMovement: string;
  visualContent: string;
  dialogue: string;
  narrativeRole: string;
  notes: string;
}

export interface StoryboardResult {
  videoId: string;
  videoTitle: string;
  summary: string;
  storyboard: StoryboardEntry[];
  totalShots: number;
  totalClips: number;
}

/** Format seconds to M:SS.s */
function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/**
 * Call LLM with retry on 429 / 5xx errors (exponential backoff).
 */
async function callLLMWithRetry(
  messages: Array<{ role: string; content: string }>,
  maxRetries = 3
): Promise<any> {
  const BASE_DELAY_MS = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callLLM(messages);
    } catch (err: any) {
      const msg = err?.message || '';
      const isRetryable = msg.includes('429') || msg.includes('500') || msg.includes('502') || msg.includes('503');
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`Storyboard LLM call failed, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Storyboard LLM: max retries exceeded');
}

function buildStoryboardSystemPrompt(): string {
  return `你是专业的视频分镜分析师。根据完整视频字幕和已抽取的镜头描述，生成一份完整的分镜表。

【输入】
1. 视频标题和简介
2. 完整字幕（带时间码）
3. 已抽取的所有 clips 及其 shots 的描述信息（含时间码和标签）

【输出要求】
只输出 JSON，结构如下：
{
  "summary": "整支视频的内容概述（1-2句话）",
  "storyboard": [
    {
      "shotNumber": 1,
      "clipTitle": "所属片段标题",
      "shotLabel": "原始镜头描述（直接引用输入的label）",
      "timeRange": "0:00.0 - 0:05.3",
      "shotType": "近景/中景/远景/特写/全景",
      "cameraMovement": "固定/推拉/摇移/跟拍/快切",
      "visualContent": "画面具体内容描述（结合label和字幕，15-40字）",
      "dialogue": "该时间段对应的字幕内容摘要",
      "narrativeRole": "开场/发展/高潮/结尾/转场/铺垫",
      "notes": "制作备注（可选，如无则留空）"
    }
  ]
}

【规则】
1. shotNumber 从 1 开始连续编号
2. 按时间顺序排列所有 shots
3. shotType 根据label推断：特写=人物面部/物体细节，近景=人物上半身，中景=人物全身，远景=环境为主
4. cameraMovement 根据label推断：如有"飞入/缩放"=推拉，"快切"=快切，"摇移"=摇移，其余默认"固定"
5. dialogue 从完整字幕中提取对应时间段的内容，如无字幕则留空
6. narrativeRole 根据片段在整体叙事中的作用判断
7. visualContent 要结合镜头标签和字幕内容，写出具体画面描述`;
}

function buildStoryboardUserPrompt(
  videoTitle: string,
  videoDescription: string,
  subtitles: SubtitleSegment[],
  clipsData: Array<{
    title: string;
    fileName: string;
    clipStart: number;
    clipEnd: number;
    shots: Array<{
      idx: number;
      label: string;
      category: string | null;
      start: number;
      end: number;
    }>;
  }>
): string {
  // Format subtitles
  const subtitleLines = subtitles.slice(0, 300).map((s, i) => {
    return `#${i + 1} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`;
  });
  const subtitlesText = subtitleLines.join('\n');

  // Format clips and shots
  const clipsText = clipsData.map((clip, ci) => {
    const clipHeader = `Clip ${ci + 1}: "${clip.title}" [${formatTime(clip.clipStart)} - ${formatTime(clip.clipEnd)}]`;
    const shotsText = clip.shots.map(shot => {
      const absStart = clip.clipStart + shot.start;
      const absEnd = clip.clipStart + shot.end;
      const cat = shot.category ? `[${shot.category}]` : '';
      return `  Shot ${shot.idx + 1}: [${formatTime(absStart)}-${formatTime(absEnd)}] (clip内 ${shot.start.toFixed(1)}s-${shot.end.toFixed(1)}s) ${cat} ${shot.label}`;
    }).join('\n');
    return `${clipHeader}\n${shotsText}`;
  }).join('\n\n');

  let prompt = `整支视频标题：${videoTitle}`;
  if (videoDescription?.trim()) {
    prompt += `\n视频简介：${videoDescription.trim()}`;
  }
  prompt += `\n\n完整字幕（共 ${subtitles.length} 条）：\n${subtitlesText}`;
  prompt += `\n\n已抽取的镜头列表（共 ${clipsData.length} 个 clips）：\n${clipsText}`;
  prompt += `\n\n请根据以上完整字幕和已抽取的镜头描述，生成一份完整的分镜表，输出JSON。`;

  return prompt;
}

/**
 * Generate a storyboard (分镜表) for a video by sending its complete subtitles
 * and all extracted shot descriptions to the LLM.
 *
 * @param videoId - The platformId (e.g. YouTube video ID)
 * @returns StoryboardResult with summary and storyboard entries
 * @throws Error if video not found, or if any clip has no shots
 */
export async function generateStoryboard(videoId: string): Promise<StoryboardResult> {
  // 1. Query DB for video data with clips and shots
  const authorRecord = await db.query.author.findFirst({
    where: eq(author.platformId, videoId),
    with: {
      originalPosts: {
        with: {
          clips: {
            with: {
              shots: true,
            },
          },
        },
      },
    },
  });

  if (!authorRecord || authorRecord.originalPosts.length === 0) {
    throw new Error(`No video found for videoId: ${videoId}`);
  }

  const post = authorRecord.originalPosts[0];
  const videoTitle = post.title || videoId;
  const videoDescription = post.description || '';

  // Parse subtitles
  let subtitles: SubtitleSegment[] = [];
  if (post.subtitlesJson) {
    try {
      subtitles = JSON.parse(post.subtitlesJson);
    } catch {
      console.warn('Failed to parse subtitlesJson for storyboard');
    }
  }

  // 2. Sort clips chronologically
  const sortedClips = [...post.clips].sort((a, b) => {
    const aStart = a.startTime ?? 0;
    const bStart = b.startTime ?? 0;
    return aStart - bStart;
  });

  // 3. Check if all clips have shots
  const clipsWithoutShots = sortedClips.filter(
    clip => !clip.shots || clip.shots.length === 0
  );

  if (clipsWithoutShots.length > 0) {
    const missingTitles = clipsWithoutShots
      .map(c => c.title || c.fileName)
      .join(', ');
    throw new Error(
      `请先为每个片段检测镜头(Detect shots)。${clipsWithoutShots.length} 个片段缺少镜头数据: ${missingTitles}`
    );
  }

  // 4. Build clips data for prompt
  const clipsData = sortedClips.map(clip => {
    const clipStart = clip.startTime ?? 0;
    const clipEnd = clip.endTime ?? 0;
    const sortedShots = [...(clip.shots ?? [])].sort(
      (a, b) => (a.idx ?? 0) - (b.idx ?? 0)
    );
    return {
      title: clip.title || clip.fileName,
      fileName: clip.fileName,
      clipStart,
      clipEnd,
      shots: sortedShots.map(shot => ({
        idx: shot.idx,
        label: shot.label || `Shot ${shot.idx + 1}`,
        category: shot.category,
        start: shot.start ?? 0,
        end: shot.end ?? 0,
      })),
    };
  });

  // Count total shots
  const totalShots = clipsData.reduce((sum, c) => sum + c.shots.length, 0);

  if (totalShots === 0) {
    throw new Error('未找到任何镜头数据。请先为每个片段检测镜头(Detect shots)。');
  }

  // 5. Build LLM prompt
  const systemPrompt = buildStoryboardSystemPrompt();
  const userPrompt = buildStoryboardUserPrompt(
    videoTitle,
    videoDescription,
    subtitles,
    clipsData
  );

  console.log(`[Storyboard] Generating for videoId=${videoId}, clips=${sortedClips.length}, shots=${totalShots}`);

  // 6. Call LLM with retry
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const response = await callLLMWithRetry(messages);
  const content = extractAssistantText(response);

  if (!content) {
    throw new Error('LLM returned empty response for storyboard');
  }

  // 7. Parse response
  const parsed = parseJsonObject(content) as any;

  if (!parsed || !parsed.storyboard || !Array.isArray(parsed.storyboard)) {
    throw new Error('LLM response missing storyboard array');
  }

  // 8. Build result
  const storyboard: StoryboardEntry[] = parsed.storyboard.map((entry: any, idx: number) => {
    // Find the corresponding clip/shot to get absolute times
    let absoluteStart = 0;
    let absoluteEnd = 0;
    const clipTitle = entry.clipTitle || '';
    
    // Try to find matching clip by title
    const matchingClip = clipsData.find(c => c.title === clipTitle);
    if (matchingClip && typeof entry.shotNumber === 'number') {
      const matchingShot = matchingClip.shots.find(s => s.idx === entry.shotNumber - 1);
      if (matchingShot) {
        absoluteStart = matchingClip.clipStart + matchingShot.start;
        absoluteEnd = matchingClip.clipStart + matchingShot.end;
      }
    }

    return {
      shotNumber: entry.shotNumber || idx + 1,
      clipTitle: entry.clipTitle || '',
      shotLabel: entry.shotLabel || '',
      timeRange: entry.timeRange || `${formatTime(absoluteStart)} - ${formatTime(absoluteEnd)}`,
      absoluteStart,
      absoluteEnd,
      shotType: entry.shotType || '',
      cameraMovement: entry.cameraMovement || '',
      visualContent: entry.visualContent || '',
      dialogue: entry.dialogue || '',
      narrativeRole: entry.narrativeRole || '',
      notes: entry.notes || '',
    };
  });

  return {
    videoId,
    videoTitle,
    summary: parsed.summary || '',
    storyboard,
    totalShots: storyboard.length,
    totalClips: sortedClips.length,
  };
}
