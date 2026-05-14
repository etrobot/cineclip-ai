import * as fs from 'fs';
import * as path from 'path';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { SubtitleSegment } from './youtube';

const TEMP_DIR = path.resolve(process.cwd(), 'temp');

// ─── Layout constants (1080×1920 竖屏) ─────────────────────────────
const CANVAS_W = 1080;
const CANVAS_H = 1920;

// 视频素材是 16:9，宽度 1080 时高度 = 607.5
const VIDEO_H = Math.round((CANVAS_W * 9) / 16); // 607
const VIDEO_Y = Math.round((CANVAS_H - VIDEO_H) / 2); // 656
const VIDEO_BOTTOM = VIDEO_Y + VIDEO_H; // 1263

// 标题区域：视频上方 0 ~ 656，标题垂直居中
const TITLE_Y = Math.round(VIDEO_Y / 2); // 328（标题中心）
const TITLE_H = 120;

// 字幕区域：视频下方 1263 ~ 1920，字幕垂直居中
const SUBTITLE_Y = VIDEO_BOTTOM + Math.round((CANVAS_H - VIDEO_BOTTOM) / 2) - 60; // 1590（字幕中心）
const SUBTITLE_H = 140;

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  return _browser;
}

/**
 * 用 Puppeteer 截图 HTML，输出透明背景 PNG
 */
async function htmlToPng(html: string, outputPath: string, width: number, height: number): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: outputPath, type: 'png', omitBackground: true });
    return outputPath;
  } finally {
    await page.close();
  }
}

// ─── 智能换行：超过阈值时平均分成两行 ────────────────────────────────

function smartBreak(text: string, threshold: number): string {
  if (text.length <= threshold) return text;

  const mid = Math.ceil(text.length / 2);
  // 找中点附近的空格或标点，优先在空格处断开
  let breakPoint = -1;

  // 从中点向两边找最佳断点（空格）
  for (let offset = 0; offset < mid && offset < text.length - mid; offset++) {
    if (text[mid + offset] === ' ') {
      breakPoint = mid + offset;
      break;
    }
    if (text[mid - offset] === ' ') {
      breakPoint = mid - offset;
      break;
    }
  }

  // 如果没找到空格，在中点直接断开（中文）
  if (breakPoint === -1) breakPoint = mid;

  const first = text.slice(0, breakPoint).trim();
  const second = text.slice(breakPoint).trim();
  return first + '\n' + second;
}

// ─── HTML 模板：标题覆盖层 ───────────────────────────────────────────

function buildTitleHtml(title: string): string {
  const broken = smartBreak(title, 14); // 标题超过14字换行
  const escaped = broken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, 120);
  const lines = escaped.split('\n');
  const lineHtml = lines.map(l => `<div class="line">${l}</div>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${CANVAS_W}px;
    height: ${TITLE_H}px;
    font-family: 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    padding: 0 40px;
  }
  .title {
    color: #ffffff;
    font-size: 52px;
    font-weight: 700;
    text-align: center;
    line-height: 1.2;
    letter-spacing: 0.5px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.8), 0 0 30px rgba(0,0,0,0.5);
    word-break: break-word;
  }
  .line { display: block; }
</style>
</head>
<body>
  <div class="title">${lineHtml}</div>
</body>
</html>`;
}

// ─── HTML 模板：字幕覆盖层（单条字幕） ──────────────────────────────

function buildSubtitleHtml(text: string): string {
  const broken = smartBreak(text, 20); // 字幕超过20字换行
  const escaped = broken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const lines = escaped.split('\n');
  const lineHtml = lines.map(l => `<div class="line">${l}</div>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${CANVAS_W}px;
    height: ${SUBTITLE_H}px;
    font-family: 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    padding: 0 40px;
  }
  .subtitle {
    color: #ffffff;
    font-size: 30px;
    font-weight: 500;
    text-align: center;
    line-height: 1.35;
    letter-spacing: 0.3px;
    text-shadow: 0 2px 6px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.6);
    background: rgba(0, 0, 0, 0.5);
    border-radius: 8px;
    padding: 8px 16px;
    max-width: 1000px;
    word-break: break-word;
  }
  .line { display: block; }
</style>
</head>
<body>
  <div class="subtitle">${lineHtml}</div>
</body>
</html>`;
}

// ─── 字幕处理：转换为相对时间 ────────────────────────────────────────

export function prepareSubtitles(
  subtitles: SubtitleSegment[],
  clipStartSec: number,
  clipEndSec: number
): Array<{ text: string; tStart: number; tEnd: number }> {
  return subtitles
    .map(s => ({
      tStart: Math.max(0, s.start - clipStartSec),
      tEnd: Math.min(clipEndSec - clipStartSec, s.end - clipStartSec),
      text: s.text.replace(/\n/g, ' ').trim(),
    }))
    .filter(s => s.tEnd > s.tStart && s.text.length > 0)
    .sort((a, b) => a.tStart - b.tStart);
}

// ─── 渲染覆盖层图片 ─────────────────────────────────────────────────

export async function renderTitleOverlay(title: string): Promise<string> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pngPath = path.join(TEMP_DIR, `overlay-title-${id}.png`);
  const html = buildTitleHtml(title);
  return htmlToPng(html, pngPath, CANVAS_W, TITLE_H);
}

export async function renderSubtitleOverlay(text: string): Promise<string> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pngPath = path.join(TEMP_DIR, `overlay-sub-${id}.png`);
  const html = buildSubtitleHtml(text);
  return htmlToPng(html, pngPath, CANVAS_W, SUBTITLE_H);
}

/**
 * 批量渲染字幕覆盖层
 */
export async function renderSubtitleOverlays(
  subtitles: Array<{ text: string; tStart: number; tEnd: number }>
): Promise<Array<{ pngPath: string; tStart: number; tEnd: number }>> {
  if (subtitles.length === 0) return [];

  const results: Array<{ pngPath: string; tStart: number; tEnd: number }> = [];

  for (const { text, tStart, tEnd } of subtitles) {
    const pngPath = await renderSubtitleOverlay(text);
    results.push({ pngPath, tStart, tEnd });
  }

  return results;
}

// ─── 布局常量导出 ───────────────────────────────────────────────────

export { CANVAS_W, CANVAS_H, VIDEO_H, VIDEO_Y, VIDEO_BOTTOM, TITLE_Y, TITLE_H, SUBTITLE_Y, SUBTITLE_H };
