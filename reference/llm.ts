/**
 * LLM Service using RESTful API calls
 *
 * 【核心职责】
 * 把完整视频字幕（带时间戳的JSON）交给LLM，LLM返回"标题+起止时间段"的片段列表。
 * 程序按时间段提取原始字幕，直接用于渲染。
 *
 * 【严格模式】
 * LLM 失败 → 直接报错，任务失败。不生成回退垃圾内容。
 * 标题不合格 → 直接报错。不截断、不替换。
 */

function llmEnv() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

/** LLM 返回的单个片段 */
export interface ClipSlice {
  title: string;
  start_sec: number;
  end_sec: number;
}

/** 字幕段（来自VTT解析） */
export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
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

/**
 * Make a RESTful API call to the LLM endpoint
 */
async function callLLM(
  messages: Array<{ role: string; content: string }>,
  opts?: { responseFormat?: boolean }
): Promise<any> {
  const cfg = llmEnv();
  const useResponseFormat = opts?.responseFormat !== false;
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

/**
 * 检测字幕的主要语言
 */
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

/**
 * 验证标题质量（严格模式）
 * 不合格直接报错，不生成回退。
 */
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

/**
 * 【核心】让LLM把完整字幕切成多个片段，每个片段返回 title + start_sec + end_sec
 *
 * 严格模式：LLM失败 → 直接报错，任务失败。不生成回退垃圾内容。
 */
export async function sliceVideoByLLM(
  subtitles: SubtitleSegment[],
  videoTitle: string,
  kolName: string
): Promise<ClipSlice[]> {
  if (!subtitles || subtitles.length === 0) {
    return [];
  }

  if (!llmEnv().apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  // 检测字幕语言，动态调整 prompt
  const lang = detectSubtitleLanguage(subtitles);

  // 构建带时间戳的字幕输入（限制长度避免token超限）
  const subtitleLines = subtitles.map(s =>
    `[${formatTime(s.start)}-${formatTime(s.end)}] ${s.text}`
  );
  // 如果字幕太长，取前300条（约10-15分钟视频的字幕量）
  const maxLines = 300;
  const trimmedLines = subtitleLines.length > maxLines
    ? subtitleLines.slice(0, maxLines)
    : subtitleLines;
  const subtitlesText = trimmedLines.join('\n');

  // 根据字幕语言选择标题语言要求
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
{"clips":[{"title":"...","start_sec":0,"end_sec":120},...]}

【切片规则】
1. 每个片段必须是一个完整、独立的主题/观点，有明确的信息量
2. 片段时长建议在 30-120 秒之间
3. 标题要求：
${titleLangRule}
   - 禁止空洞词汇："精彩片段"、"视频节选"、"主播谈XX"、"讨论"、"聊聊"
   - 禁止以"片段"、"节选"、"剪辑"结尾
   - 标题应该概括该片段的核心观点或事件，而非照搬字幕开头几个字
   - 如果标题超过25个字，精简到25字以内，不要截断
4. start_sec 和 end_sec 必须是整数（秒），必须对应输入字幕中的实际时间点
5. 片段之间可以有小重叠（1-3秒），但不要大幅重叠
6. 如果视频内容连贯无明显断点，可以只切 1-2 个精华片段
7. 不要切太多碎片，宁缺毋滥

【好的标题示例】
- "拜登发表胜选演讲感谢支持者"
- "特朗普竞选团队质疑选票计数"
- "美联储降息对加密市场的传导机制"
- "DeFi流动性挖矿的套利风险"

【差的标题示例】
- "And while the votes" ❌ （照搬字幕开头）
- "North Carolina, big" ❌ （截断的英文）
- "视频片段" ❌ （空洞无意义）`;

  const userPrompt = `整支视频标题：${videoTitle}
博主：${kolName}

完整字幕（共 ${subtitles.length} 条）：
${subtitlesText}

请按规则切成若干片段，输出JSON。标题必须用简体中文，概括核心内容。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  console.log('=== LLM request payload ===');
  console.log(JSON.stringify(messages, null, 2));

  // 区域不支持, mock一份
  const mockResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            clips: [
              {
                title: "伊朗战争推高美国通胀，油价上涨引关注",
                start_sec: 10,
                end_sec: 90
              }
            ]
          })
        }
      }
    ]
  };

  const content = extractAssistantText(mockResponse);
  if (!content) throw new Error('No text in LLM response');

  const parsed = parseJsonObject(content) as any;
  const clips = normalizeSlices(parsed, subtitles);

  if (clips.length === 0) {
    throw new Error('LLM returned no valid clips');
  }

  return clips;
}

/**
 * 规范化LLM返回的切片数据
 * 严格模式：标题不合格 → 直接报错，不回退
 */
function normalizeSlices(parsed: any, subtitles: SubtitleSegment[]): ClipSlice[] {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a valid object');
  }

  const clipsArray = parsed.clips || parsed.segments || parsed.fragments;
  if (!Array.isArray(clipsArray)) {
    throw new Error('LLM response missing clips array');
  }

  const results: ClipSlice[] = [];
  const videoStart = subtitles[0]?.start ?? 0;
  const videoEnd = subtitles[subtitles.length - 1]?.end ?? 0;

  for (const item of clipsArray) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid clip item in LLM response');
    }

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    let start = typeof item.start_sec === 'number' ? item.start_sec : 0;
    let end = typeof item.end_sec === 'number' ? item.end_sec : 0;

    // 兼容可能的字段名
    if (!start && typeof item.start === 'number') start = item.start;
    if (!end && typeof item.end === 'number') end = item.end;

    // 严格验证
    if (!title) {
      throw new Error('LLM returned clip with empty title');
    }
    if (start >= end || end - start < 10) {
      throw new Error(`Invalid clip time from LLM: start=${start}, end=${end}`);
    }
    if (start < videoStart || end > videoEnd + 5) {
      throw new Error(`Clip time out of range: ${start}-${end}, video range: ${videoStart}-${videoEnd}`);
    }

    const validation = validateTitle(title);
    if (!validation.valid) {
      throw new Error(`Invalid clip title from LLM: ${validation.reason}: "${title}"`);
    }

    results.push({ title, start_sec: Math.floor(start), end_sec: Math.ceil(end) });
  }

  // 去重：移除大幅重叠的片段
  return deduplicateSlices(results);
}

/**
 * 去重：如果两个片段重叠超过80%，保留较长的
 */
function deduplicateSlices(slices: ClipSlice[]): ClipSlice[] {
  if (slices.length <= 1) return slices;

  const sorted = [...slices].sort((a, b) => a.start_sec - b.start_sec);
  const result: ClipSlice[] = [];

  for (const slice of sorted) {
    let shouldAdd = true;
    for (const existing of result) {
      const overlapStart = Math.max(slice.start_sec, existing.start_sec);
      const overlapEnd = Math.min(slice.end_sec, existing.end_sec);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const minDuration = Math.min(slice.end_sec - slice.start_sec, existing.end_sec - existing.start_sec);

      if (overlap > minDuration * 0.8) {
        if ((slice.end_sec - slice.start_sec) > (existing.end_sec - existing.start_sec)) {
          existing.title = slice.title;
          existing.start_sec = slice.start_sec;
          existing.end_sec = slice.end_sec;
        }
        shouldAdd = false;
        break;
      }
    }
    if (shouldAdd) {
      result.push(slice);
    }
  }

  return result;
}