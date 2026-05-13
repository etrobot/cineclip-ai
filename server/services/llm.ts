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

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
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

  const subtitleLines = subtitles.map(s =>
    `[${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  );
  const maxLines = 300;
  const trimmedLines = subtitleLines.length > maxLines
    ? subtitleLines.slice(0, maxLines)
    : subtitleLines;
  const subtitlesText = trimmedLines.join('\n');

  const titleLangRule = lang === 'en'
    ? `   - 必须用简体中文写标题，8-25个字
   - 把英文字幕的核心内容翻译概括成中文标题，不要夹杂英文
   - 例如：字幕说 "We're winning Michigan by a lot"，标题写 "特朗普宣布在密歇根大幅领先"`
    : `   - 用简体中文写标题，8-25个字
   - 必须具体、有信息量，让读者一眼知道核心内容
   - 优先使用字幕中的核心名词、动词、观点`;

  const systemPrompt = `你是视频剪辑师。根据完整视频字幕，把视频切成若干个有独立主题的片段。

【输入格式】
每行字幕格式：[MM:SS-MM:SS] 字幕文本

【输出要求】
只输出 JSON，结构如下：
{"clips":[{"title":"...","start_sec":0,"end_sec":120,"category":"分类"},...]}

【切片规则】
1. 每个片段必须是一个完整、独立的主题/观点，有明确的信息量
2. 片段时长建议在 30-120 秒之间
3. 标题要求：
${titleLangRule}
   - 禁止空洞词汇："精彩片段"、"视频节选"、"主播谈XX"、"讨论"、"聊聊"
   - 禁止以"片段"、"节选"、"剪辑"结尾
   - 标题应该概括该片段的核心观点或事件，而非照搬字幕开头几个字
   - 如果标题超过25个字，精简到25字以内，不要截断
4. category 分类：High Intensity Moments（高能时刻）、Viral Hooks（病毒式传播点）、Key Insights（核心观点）、Funny Moments（搞笑时刻）、Controversial Takes（争议话题）
5. start_sec 和 end_sec 必须是整数（秒），必须对应输入字幕中的实际时间点
6. 片段之间可以有小重叠（1-3秒），但不要大幅重叠
7. 如果视频内容连贯无明显断点，可以只切 1-2 个精华片段
8. 不要切太多碎片，宁缺毋滥`;

  const userPrompt = `整支视频标题：${videoTitle}

完整字幕（共 ${subtitles.length} 条）：
${subtitlesText}

请按规则切成若干片段，输出JSON。标题必须用简体中文，概括核心内容。`;

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
    let start = typeof item.start_sec === 'number' ? item.start_sec : 0;
    let end = typeof item.end_sec === 'number' ? item.end_sec : 0;

    if (!start && typeof item.start === 'number') start = item.start;
    if (!end && typeof item.end === 'number') end = item.end;

    if (!title) {
      throw new Error('LLM returned clip with empty title');
    }
    if (start >= end || end - start < 10) {
      console.warn(`Skipping invalid clip: start=${start}, end=${end}`);
      continue;
    }
    if (start < videoStart || end > videoEnd + 5) {
      console.warn(`Skipping out-of-range clip: ${start}-${end}`);
      continue;
    }

    const validation = validateTitle(title);
    if (!validation.valid) {
      console.warn(`Skipping invalid title: ${validation.reason}: "${title}"`);
      continue;
    }

    results.push({
      title,
      category,
      start: Math.floor(start),
      end: Math.ceil(end),
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
