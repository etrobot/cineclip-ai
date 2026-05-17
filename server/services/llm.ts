import type { SubtitleSegment } from './youtube';
import { buildClipSystemPrompt, buildClipUserPrompt } from './llmPrompt';

export interface Clip {
  start: number;
  end: number;
  title: string;
  description?: string;
}

function llmEnv() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: (process.env.OPENAI_API_KEY || '').trim(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

export function extractAssistantText(response: any): string {
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

export function parseJsonObject(content: string): unknown {
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

export async function callLLM(
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

export async function analyzeClips(
  subtitles: SubtitleSegment[],
  videoTitle: string,
  videoDescription: string
): Promise<Clip[]> {
  if (!subtitles || subtitles.length === 0) {
    return [];
  }

  if (!llmEnv().apiKey) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const lang = detectSubtitleLanguage(subtitles);

  const systemPrompt = buildClipSystemPrompt();
  const userPrompt = buildClipUserPrompt({ videoTitle, videoDescription, subtitles });

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

/**
 * Detect continuous music subtitle blocks and return them as clips.
 * A "music" subtitle is one whose text is exactly "music" (case-insensitive).
 * Contiguous music segments are merged into a single clip.
 */
/**
 * Check if a subtitle text represents a music/sound marker (e.g. "[music]", ">>[Music]").
 */
function isMusicMarker(text: string): boolean {
  return /\bmusic\b/i.test(text);
}

function detectMusicClips(subtitles: SubtitleSegment[]): Clip[] {
  const musicClips: Clip[] = [];
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  for (const seg of subtitles) {
    const isMusic = isMusicMarker(seg.text ?? '');

    if (isMusic) {
      if (currentStart === null) {
        currentStart = seg.start;
        currentEnd = seg.end;
      } else {
        // Extend current music block
        currentEnd = seg.end;
      }
    } else {
      // End of a music block
      if (currentStart !== null && currentEnd !== null) {
        musicClips.push({
          title: 'Music',
          start: Math.round(currentStart * 10) / 10,
          end: Math.round(currentEnd * 10) / 10,
          description: '',
        });
        currentStart = null;
        currentEnd = null;
      }
    }
  }

  // Handle trailing music block
  if (currentStart !== null && currentEnd !== null) {
    musicClips.push({
      title: 'Music',
      start: Math.round(currentStart * 10) / 10,
      end: Math.round(currentEnd * 10) / 10,
      description: '',
    });
  }

  return musicClips;
}

function normalizeClips(parsed: any, subtitles: SubtitleSegment[]): Clip[] {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a valid object');
  }

  const clipsArray = parsed.clips || parsed.segments || parsed.fragments;
  if (!Array.isArray(clipsArray)) {
    throw new Error('LLM response missing clips array');
  }

  const results: Clip[] = detectMusicClips(subtitles);
  const videoStart = subtitles[0]?.start ?? 0;
  const videoEnd = subtitles[subtitles.length - 1]?.end ?? 0;

  for (const item of clipsArray) {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid clip item in LLM response');
    }

    const title = typeof item.title === 'string' ? item.title.trim() : '';

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

    // Keep precise timestamps (no floor/ceil) — FFmpeg handles fractional seconds natively
    results.push({
      title,
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
