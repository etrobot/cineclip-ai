import type { SubtitleSegment } from './youtube';

export interface VideoContext {
  videoTitle: string;
  videoDescription: string;
  subtitles: SubtitleSegment[];
}

/** Format seconds to M:SS.s (1 decimal place) */
export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/**
 * Check if a subtitle text is a music/sound marker.
 */
function isMusicMarker(text: string): boolean {
  return /\bmusic\b/i.test(text);
}

/**
 * Build the video context text block (title + description + subtitles).
 * This is the common prefix used in all LLM prompts so the model knows
 * the full video context even when analyzing only a clip or segment.
 * Music/sound markers are annotated so LLM knows not to analyze them as content.
 */
export function buildVideoContextBlock(ctx: VideoContext): string {
  const { videoTitle, videoDescription, subtitles } = ctx;

  const subtitleLines = subtitles.map((s, i) => {
    const musicFlag = isMusicMarker(s.text) ? ' (MUSIC段落，无需分析)' : '';
    return `#${i + 1} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}${musicFlag}`;
  });

  const maxLines = 300;
  const trimmedLines = subtitleLines.length > maxLines
    ? subtitleLines.slice(0, maxLines)
    : subtitleLines;
  const subtitlesText = trimmedLines.join('\n');

  const descriptionBlock = (videoDescription ?? '').trim()
    ? `\n视频简介：\n${(videoDescription ?? '').trim()}`
    : '';

  return `整支视频标题：${videoTitle}${descriptionBlock}\n\n完整字幕（共 ${subtitles.length} 条）：\n${subtitlesText}`;
}

/**
 * Build system prompt for clip analysis.
 */
export function buildClipSystemPrompt(): string {
  return `你是视频剪辑师。根据完整视频字幕，提取章节片段。

【输入格式】
每行字幕格式：#序号 [M:SS.s-M:SS.s] 字幕文本
时间精确到0.1秒，例如 0:20.8 表示20.8秒
- 标注了 "(MUSIC段落，无需分析)" 的是音乐/音效段落，这些段落将被系统单独处理，请不要把它们作为内容片段提取

【输出要求】
只输出 JSON，结构如下：
{"clips":[{"title":"...","start_idx":1,"end_idx":15},...]}

【切片规则】
1. 每个片段必须是一个完整、独立的主题/观点，有明确的信息量
2. 标题要求：
   - 禁止空洞词汇："精彩片段"、"视频节选"、"主播谈XX"、"讨论"、"聊聊"
   - 禁止以"片段"、"节选"、"剪辑"结尾
   - 标题应该概括该片段的核心观点或事件，而非照搬字幕开头几个字
3. start_idx 和 end_idx 必须是输入字幕的序号（#后面的数字），不是秒数！
   - start_idx 是片段第一条字幕的序号
   - end_idx 是片段最后一条字幕的序号
   - 例如：片段从 #5 到 #18，则 start_idx=5, end_idx=18
4. 片段之间可以有小重叠（1-3条字幕），但不要大幅重叠
5. **重要**：标记为 "(MUSIC段落，无需分析)" 的字幕不包含有效内容，不要以这些 music 段落作为片段的 start 或 end 边界`;
}

/**
 * Build user prompt for clip analysis.
 */
export function buildClipUserPrompt(ctx: VideoContext): string {
  const contextBlock = buildVideoContextBlock(ctx);
  return `${contextBlock}\n\n请结合视频标题和简介所表达的主题，按规则切成若干片段，输出JSON。`;
}

/**
 * Build system prompt for shot segmentation within a clip.
 */
export function buildShotSystemPrompt(): string {
  return `你是专业的视频分镜分析师。根据视频采样帧和字幕，将视频片段分割成 shots（分镜）。

【重要说明】
你看到的是从完整视频中提取出来的一个 clip（片段），而非完整视频。
下方提供的字幕也只包含该 clip 范围内的内容。
但你同时会收到整支视频的标题和简介，供你理解该 clip 在整体上下文中的意义。

【任务说明】
每个 shot 代表一个独立的镜头或场景

【输出格式】
只输出 JSON：{"shots":[{"start":起始秒,"end":结束秒,"label":"场景描述"},...]}

【规则】
- start/end 是相对于 clip 起始的秒数（0 表示 clip 开头）
- 时间范围必须在 [0, clipDuration] 内
- shot 之间不能重叠
- label 是简短描述该 shot 的内容，比如xx图表动画、工厂xx操作、办公室xxx、地球xxx`;
}

/**
 * Build user prompt for shot segmentation.
 * @param clipDuration   Duration of the clip in seconds (for boundary checking mention)
 * @param clipSubtitles  Subtitles only within the clip time range
 */
export function buildShotUserPrompt(
  ctx: VideoContext,
  clipDuration: number,
  clipSubtitles: SubtitleSegment[]
): string {
  const contextBlock = buildVideoContextBlock(ctx);

  const clipSubtitleLines = clipSubtitles.map((s, i) =>
    `#${i + 1} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  ).join('\n');

  return `${contextBlock}\n\n【当前分析的是以下 clip】\nclip 时长：${clipDuration.toFixed(1)} 秒\nclip 内字幕：\n${clipSubtitleLines || '（无字幕）'}\n\n请结合整支视频的主题，将该 clip 分割成若干 shots，输出JSON。`;
}