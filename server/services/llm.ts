import type { SubtitleSegment } from './youtube';

export interface Clip {
  start: number;
  end: number;
  title: string;
  category: string;
  description?: string;
}

function llmEnv() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

function extractAssistantText(response: any): string {
  const msg = response?.choices?.[0]?.message;
  const content = msg?.content;
  if (typeof content === 'string' && content.trim()) return content;

  const reasoning = msg?.reasoning;
  if (typeof reasoning === 'string' && reasoning.trim()) return reasoning;

  const details = msg?.reasoning_details;
  if (Array.isArray(details)) {
    const joined = details
      .map((d: any) => (typeof d?.text === 'string' ? d.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (joined) return joined;
  }

  return '';
}

function parseJsonObject(content: string): unknown {
  let s = content.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '');
  }
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error('Failed to parse JSON from LLM response');
  }
}

/** Format seconds to M:SS.s (1 decimal place) — preserves subtitle timing precision */
function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

async function callLLM(
  messages: Array<{ role: string; content: string }>,
  opts?: { responseFormat?: boolean }
): Promise<any> {
  const cfg = llmEnv();
  console.log('=== LLM Config ===');
  console.log('Base URL:', cfg.baseUrl);
  console.log('Model:', cfg.model);
  console.log('API Key:', cfg.apiKey.substring(0, 15) + '...');
  
  const useResponseFormat = false; // 禁用 response_format，某些模型不支持
  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      ...(useResponseFormat ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.35,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data;
}

function detectSubtitleLanguage(subtitles: SubtitleSegment[]): 'zh' | 'en' {
  let zhCount = 0;
  let enCount = 0;
  const sampleSize = Math.min(subtitles.length, 50);
  for (let i = 0; i < sampleSize; i++) {
    const text = subtitles[i].text;
    if (/[\u4e00-\u9fa5]/.test(text)) zhCount++;
    if (/[a-zA-Z]{3,}/.test(text)) enCount++;
  }
  return zhCount > enCount ? 'zh' : 'en';
}

function validateTitle(title: string): { valid: boolean; reason?: string } {
  if (!title || title.length < 4) {
    return { valid: false, reason: '标题过短' };
  }

  const emptyPatterns = [
    { pattern: /精彩.{0,3}片段/, desc: '包含"精彩片段"' },
    { pattern: /视频.{0,3}(片段|节选|剪辑|内容)/, desc: '包含"视频片段/节选"' },
    { pattern: /.{0,2}片段$/, desc: '以"片段"结尾' },
    { pattern: /.{0,2}节选$/, desc: '以"节选"结尾' },
    { pattern: /^\d+[:：].*$/, desc: '纯时间戳格式' },
    { pattern: /^(And|But|So|The|Well|Now|OK|So,)\s/i, desc: '英文口语开头，非标题格式' },
    { pattern: /^.{1,25}\s$/, desc: '英文标题被截断（末尾空格）' },
  ];
  for (const { pattern, desc } of emptyPatterns) {
    if (pattern.test(title)) {
      return { valid: false, reason: `标题不合格: ${desc}` };
    }
  }
  return { valid: true };
}

export async function analyzeClips(subtitles: SubtitleSegment[], videoTitle: string): Promise<Clip[]> {
  if (!subtitles || subtitles.length === 0) {
    return [];
  }

  if (!llmEnv().apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const lang = detectSubtitleLanguage(subtitles);

  // Include 1-based index so LLM can reference exact subtitle lines
  const subtitleLines = subtitles.map((s, i) =>
    `#${i + 1} [${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  );
  const maxLines = 300;
  const trimmedLines = subtitleLines.length > maxLines
    ? subtitleLines.slice(0, maxLines)
    : subtitleLines;
  const subtitlesText = trimmedLines.join('\n');



  const systemPrompt = `你是视频剪辑师。根据完整视频字幕，把视频切成若干个有独立主题的片段。

【输入格式】
每行字幕格式：#序号 [M:SS.s-M:SS.s] 字幕文本
时间精确到0.1秒，例如 0:20.8 表示20.8秒

【输出要求】
只输出 JSON，结构如下：
{"clips":[{"title":"...","start_idx":1,"end_idx":15,"category":"分类"},...]}

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
5. 如果视频内容连贯无明显断点，可以只切 1-2 个精华片段
6. 不要切太多碎片，宁缺毋滥`;

  const userPrompt = `整支视频标题：${videoTitle}

完整字幕（共 ${subtitles.length} 条）：
${subtitlesText}

请按规则切成若干片段，输出JSON。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  console.log('=== Calling LLM ===');
  console.log(`Model: ${llmEnv().model}`);
  console.log(`Subtitles: ${subtitles.length} segments`);

  const response = await callLLM(messages);
  console.log('=== LLM Raw Response ===');
  console.log(JSON.stringify(response, null, 2));
  
  const content = extractAssistantText(response);
  console.log('=== Extracted Content ===');
  console.log(content);
  
  if (!content) throw new Error('No text in LLM response');

  console.log('=== LLM Response ===');
  console.log(content);

  const parsed = parseJsonObject(content) as any;
  const clips = normalizeClips(parsed, subtitles);

  if (clips.length === 0) {
    throw new Error('LLM returned no valid clips');
  }

  console.log(`=== Generated ${clips.length} clips ===`);
  return clips;
}

/**
 * Snap a time value to the nearest subtitle boundary.
 * Finds the subtitle segment whose start is closest to `t` within `threshold` seconds.
 * Returns the snapped time, or the original `t` if no subtitle is close enough.
 */
function snapToSubtitle(t: number, subtitles: SubtitleSegment[], threshold: number = 2): number {
  let bestDist = Infinity;
  let bestTime = t;
  for (const s of subtitles) {
    const d = Math.abs(s.start - t);
    if (d < bestDist) {
      bestDist = d;
      bestTime = s.start;
    }
  }
  return bestDist <= threshold ? bestTime : t;
}

function normalizeClips(parsed: any, subtitles: SubtitleSegment[]): Clip[] {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a valid object');
  }

  const clipsArray = parsed.clips || parsed.segments || parsed.fragments;
  if (!Array.isArray(clipsArray)) {
    throw new Error('LLM response missing clips array');
  }

  const results: Clip[] = [];
  const videoStart = subtitles[0]?.start ?? 0;
  const videoEnd = subtitles[subtitles.length - 1]?.end ?? 0;

  for (const item of clipsArray) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid clip item in LLM response');
    }

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const category = typeof item.category === 'string' ? item.category.trim() : 'Highlights';

    // ── Resolve start/end from subtitle index (preferred) or seconds (fallback) ──
    let start: number;
    let end: number;

    if (typeof item.start_idx === 'number' && typeof item.end_idx === 'number') {
      // LLM returned subtitle indices (1-based) → look up exact timestamps
      const startIdx = Math.max(1, Math.min(item.start_idx, subtitles.length)) - 1;
      const endIdx = Math.max(1, Math.min(item.end_idx, subtitles.length)) - 1;
      start = subtitles[startIdx].start;
      // End = next subtitle's start (preserves last subtitle display + natural gap)
      // Falls back to last subtitle's end only when there is no next subtitle
      end = endIdx < subtitles.length - 1
        ? subtitles[endIdx + 1].start
        : subtitles[endIdx].end;
      console.log(`  [idx] start_idx=${item.start_idx} → ${start}s, end_idx=${item.end_idx} → ${end}s`);
    } else {
      // Legacy: LLM returned seconds → snap to nearest subtitle boundary
      let rawStart = typeof item.start_sec === 'number' ? item.start_sec
        : typeof item.start === 'number' ? item.start : 0;
      let rawEnd = typeof item.end_sec === 'number' ? item.end_sec
        : typeof item.end === 'number' ? item.end : 0;

      start = snapToSubtitle(rawStart, subtitles);
      end = snapToSubtitle(rawEnd, subtitles);
      console.log(`  [sec] raw start=${rawStart} → snapped=${start}, raw end=${rawEnd} → snapped=${end}`);
    }

    if (!title) {
      throw new Error('LLM returned clip with empty title');
    }
    if (start >= end || end - start < 5) {
      console.warn(`Skipping invalid clip: start=${start}, end=${end} (too short)`);
      continue;
    }
    if (start < videoStart - 1 || end > videoEnd + 5) {
      console.warn(`Skipping out-of-range clip: ${start}-${end} (video: ${videoStart}-${videoEnd})`);
      continue;
    }

    const validation = validateTitle(title);
    if (!validation.valid) {
      console.warn(`Skipping invalid title: ${validation.reason}: "${title}"`);
      continue;
    }

    // Keep precise timestamps (no floor/ceil) — FFmpeg handles fractional seconds natively
    results.push({
      title,
      category,
      start: Math.round(start * 10) / 10,  // round to 0.1s precision
      end: Math.round(end * 10) / 10,
      description: item.description || '',
    });
  }

  return deduplicateClips(results);
}

function deduplicateClips(clips: Clip[]): Clip[] {
  if (clips.length <= 1) return clips;

  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const result: Clip[] = [];

  for (const clip of sorted) {
    let shouldAdd = true;
    for (const existing of result) {
      const overlapStart = Math.max(clip.start, existing.start);
      const overlapEnd = Math.min(clip.end, existing.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const minDuration = Math.min(clip.end - clip.start, existing.end - existing.start);

      if (overlap > minDuration * 0.8) {
        if ((clip.end - clip.start) > (existing.end - existing.start)) {
          existing.title = clip.title;
          existing.category = clip.category;
          existing.start = clip.start;
          existing.end = clip.end;
        }
        shouldAdd = false;
        break;
      }
    }
    if (shouldAdd) {
      result.push(clip);
    }
  }

  return result;
}
