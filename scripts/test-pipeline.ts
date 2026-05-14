/**
 * 全链路逐阶段计时诊断脚本
 *
 * 用法：
 *   npx tsx scripts/test-pipeline.ts <youtube_url>          # 直接调用 service 层
 *   npx tsx scripts/test-pipeline.ts http <youtube_url>     # 通过 HTTP API + SSE 测试
 *
 * 逐阶段测量：
 *   Stage 1: Getting Subtitles（yt-dlp --dump-json + --write-sub）
 *   Stage 2: Analyzing（LLM API 调用）
 *   Stage 3: Downloading（yt-dlp 下载视频）
 *   Stage 4: Render（FFmpeg extractClip + combineClips）
 *   Stage 5: Thumbnail（FFmpeg generateThumbnail）
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ override: true, path: path.resolve(process.cwd(), '.env') });

// ─── 工具函数 ──────────────────────────────────────────────

function now(): number {
  return performance.now();
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
}

// ─── 直接调用各 service 函数（绕过 HTTP，精确计时） ──────────

async function testDirectPipeline(videoUrl: string) {
  const results: { stage: string; duration: number; detail: string }[] = [];

  const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) {
    console.error('Invalid YouTube URL');
    process.exit(1);
  }
  const videoId = videoIdMatch[1];

  section('ENV 配置检查');
  console.log(`  OPENAI_BASE_URL: ${process.env.OPENAI_BASE_URL || '(未设置)'}`);
  console.log(`  OPENAI_MODEL:    ${process.env.OPENAI_MODEL || '(未设置)'}`);
  console.log(`  OPENAI_API_KEY:  ${(process.env.OPENAI_API_KEY || '').substring(0, 15)}...`);
  console.log(`  HTTPS_PROXY:     ${process.env.HTTPS_PROXY || process.env.https_proxy || '(未设置)'}`);
  console.log(`  Video ID:        ${videoId}`);

  // ═══ Stage 1: Getting Subtitles ═══
  section('Stage 1: Getting Subtitles');
  const { getVideoWithSubtitles } = await import('../server/services/youtube.js');

  const t1s = now();
  const videoData = await getVideoWithSubtitles(videoId);
  const t1e = now();
  const d1 = t1e - t1s;

  if (!videoData) {
    console.error('❌ Stage 1 FAILED: 无法获取字幕');
    results.push({ stage: 'Getting Subtitles', duration: d1, detail: 'FAILED - 无字幕' });
    printSummary(results);
    return;
  }

  console.log(`  ✅ 字幕获取成功`);
  console.log(`     标题: ${videoData.title}`);
  console.log(`     时长: ${videoData.duration}s`);
  console.log(`     字幕段数: ${videoData.subtitles.length}`);
  console.log(`     耗时: ${fmt(d1)}`);
  results.push({ stage: 'Getting Subtitles', duration: d1, detail: `${videoData.subtitles.length} segments` });

  // ═══ Stage 2: Analyzing (LLM) ═══
  section('Stage 2: Analyzing (LLM)');
  const { analyzeClips } = await import('../server/services/llm.js');

  const t2s = now();
  let clips: any[];
  try {
    clips = await analyzeClips(videoData.subtitles, videoData.title);
  } catch (err: any) {
    const t2e = now();
    console.error(`  ❌ Stage 2 FAILED: ${err.message}`);
    results.push({ stage: 'Analyzing', duration: t2e - t2s, detail: `FAILED: ${err.message}` });
    printSummary(results);
    return;
  }
  const t2e = now();
  const d2 = t2e - t2s;

  console.log(`  ✅ LLM 分析完成`);
  console.log(`     生成剪辑数: ${clips.length}`);
  clips.forEach((c: any, i: number) => {
    console.log(`     [${i + 1}] ${c.title} (${c.start}s-${c.end}s) [${c.category}]`);
  });
  console.log(`     耗时: ${fmt(d2)}`);
  results.push({ stage: 'Analyzing', duration: d2, detail: `${clips.length} clips` });

  // ═══ Stage 3: Downloading ═══
  section('Stage 3: Downloading Video');
  const { downloadVideo } = await import('../server/services/youtube.js');

  const videoPath = path.join(process.cwd(), 'videos', `${videoId}.mp4`);
  const alreadyDownloaded = fs.existsSync(videoPath);

  if (alreadyDownloaded) {
    const stat = fs.statSync(videoPath);
    console.log(`  ⏭️  视频已缓存，跳过下载`);
    console.log(`     文件大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    results.push({ stage: 'Downloading', duration: 0, detail: `CACHED (${(stat.size / 1024 / 1024).toFixed(1)} MB)` });
  } else {
    const t3s = now();
    try {
      await downloadVideo(videoId);
    } catch (err: any) {
      const t3e = now();
      console.error(`  ❌ Stage 3 FAILED: ${err.message}`);
      results.push({ stage: 'Downloading', duration: t3e - t3s, detail: `FAILED: ${err.message}` });
      printSummary(results);
      return;
    }
    const t3e = now();
    const d3 = t3e - t3s;
    const stat = fs.statSync(videoPath);
    console.log(`  ✅ 视频下载成功`);
    console.log(`     文件大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`     耗时: ${fmt(d3)}`);
    results.push({ stage: 'Downloading', duration: d3, detail: `${(stat.size / 1024 / 1024).toFixed(1)} MB` });
  }

  // ═══ Stage 4: Render (第一个 clip) ═══
  if (clips.length > 0) {
    section('Stage 4: Render Clip');
    const { renderClip } = await import('../server/services/render.js');
    const firstClip = clips[0];

    const t4s = now();
    try {
      const outputPath = await renderClip(
        videoId,
        firstClip.start,
        firstClip.end,
        undefined,
        firstClip.title,
        firstClip.description
          ? [{ start: firstClip.start, end: firstClip.end, text: firstClip.description }]
          : undefined
      );
      const t4e = now();
      const d4 = t4e - t4s;
      const stat = fs.statSync(outputPath);
      console.log(`  ✅ 剪辑渲染成功`);
      console.log(`     输出: ${outputPath}`);
      console.log(`     文件大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
      console.log(`     耗时: ${fmt(d4)}`);
      results.push({ stage: 'Render', duration: d4, detail: `${(stat.size / 1024 / 1024).toFixed(1)} MB` });
    } catch (err: any) {
      const t4e = now();
      console.error(`  ❌ Stage 4 FAILED: ${err.message}`);
      results.push({ stage: 'Render', duration: t4e - t4s, detail: `FAILED: ${err.message}` });
    }
  }

  // ═══ Stage 5: Thumbnail ═══
  if (clips.length > 0) {
    section('Stage 5: Thumbnail');
    const { generateThumbnail } = await import('../server/services/ffmpeg.js');
    const firstClip = clips[0];
    const thumbsDir = path.join(process.cwd(), 'clips', 'thumbnails');
    if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });
    const thumbPath = path.join(thumbsDir, `test_${videoId}_${firstClip.start}_${firstClip.end}.jpg`);
    const midTime = Math.round((firstClip.start + firstClip.end) / 2);

    const t5s = now();
    try {
      await generateThumbnail(videoPath, thumbPath, midTime);
      const t5e = now();
      const d5 = t5e - t5s;
      const stat = fs.statSync(thumbPath);
      console.log(`  ✅ 缩略图生成成功`);
      console.log(`     输出: ${thumbPath}`);
      console.log(`     文件大小: ${(stat.size / 1024).toFixed(0)} KB`);
      console.log(`     耗时: ${fmt(d5)}`);
      results.push({ stage: 'Thumbnail', duration: d5, detail: `${(stat.size / 1024).toFixed(0)} KB` });

      try { fs.unlinkSync(thumbPath); } catch {}
    } catch (err: any) {
      const t5e = now();
      console.error(`  ❌ Stage 5 FAILED: ${err.message}`);
      results.push({ stage: 'Thumbnail', duration: t5e - t5s, detail: `FAILED: ${err.message}` });
    }
  }

  printSummary(results);
}

// ─── 通过 HTTP API 测试（含 SSE 进度验证） ──────────────────

async function testHttpPipeline(videoUrl: string, serverUrl: string) {
  section('HTTP API 测试 + SSE 进度验证');
  console.log(`  Server: ${serverUrl}`);

  console.log(`\n  ── POST /api/analyze ──`);
  const jobId = `test_${Date.now()}`;

  const events: { stage: string; progress: number; message: string; ts: number }[] = [];
  const eventSource = new EventSource(`${serverUrl}/api/progress/${jobId}`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return;
      events.push({ ...data, ts: Date.now() });
      console.log(`  📡 SSE: [${data.stage}] ${data.progress}% - ${data.message}`);
    } catch {}
  };

  await new Promise(r => setTimeout(r, 500));

  const tStart = now();
  const analyzeResp = await fetch(`${serverUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: videoUrl, jobId }),
  });

  if (!analyzeResp.ok) {
    console.error(`  ❌ Analyze 失败: ${analyzeResp.status}`);
    const errText = await analyzeResp.text();
    console.error(`  ${errText}`);
    eventSource.close();
    return;
  }

  const analyzeData = await analyzeResp.json();
  const tAnalyze = now() - tStart;

  console.log(`\n  ✅ Analyze 完成: ${fmt(tAnalyze)}`);
  console.log(`     SSE 事件数: ${events.length}`);
  console.log(`     阶段时间线:`);

  const stageGroups = new Map<string, { start: number; end: number; count: number }>();
  for (const e of events) {
    const g = stageGroups.get(e.stage) || { start: e.ts, end: e.ts, count: 0 };
    g.start = Math.min(g.start, e.ts);
    g.end = Math.max(g.end, e.ts);
    g.count++;
    stageGroups.set(e.stage, g);
  }
  for (const [stage, g] of stageGroups) {
    console.log(`       ${stage}: ${fmt(g.end - g.start)} (${g.count} events)`);
  }

  eventSource.close();

  if (analyzeData.clips?.length > 0) {
    const firstClip = analyzeData.clips[0];
    const renderJobId = `test_render_${Date.now()}`;

    console.log(`\n  ── POST /api/render ──`);

    const renderEvents: any[] = [];
    const renderES = new EventSource(`${serverUrl}/api/progress/${renderJobId}`);
    renderES.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'connected') return;
        renderEvents.push({ ...data, ts: Date.now() });
        console.log(`  📡 SSE: [${data.stage}] ${data.progress}% - ${data.message}`);
      } catch {}
    };

    await new Promise(r => setTimeout(r, 500));

    const tRenderStart = now();
    const renderResp = await fetch(`${serverUrl}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: analyzeData.videoId,
        start: firstClip.start,
        end: firstClip.end,
        title: firstClip.title,
        subtitles: firstClip.description
          ? [{ start: firstClip.start, end: firstClip.end, text: firstClip.description }]
          : undefined,
        jobId: renderJobId,
      }),
    });

    if (!renderResp.ok) {
      console.error(`  ❌ Render 失败: ${renderResp.status}`);
      renderES.close();
      return;
    }

    const renderData = await renderResp.json();
    const tRender = now() - tRenderStart;

    console.log(`\n  ✅ Render 完成: ${fmt(tRender)}`);
    console.log(`     clipUrl: ${renderData.clipUrl}`);
    console.log(`     thumbnailUrl: ${renderData.thumbnailUrl}`);
    console.log(`     SSE 事件数: ${renderEvents.length}`);

    const renderStageGroups = new Map<string, { start: number; end: number; count: number }>();
    for (const e of renderEvents) {
      const g = renderStageGroups.get(e.stage) || { start: e.ts, end: e.ts, count: 0 };
      g.start = Math.min(g.start, e.ts);
      g.end = Math.max(g.end, e.ts);
      g.count++;
      renderStageGroups.set(e.stage, g);
    }
    console.log(`     阶段时间线:`);
    for (const [stage, g] of renderStageGroups) {
      console.log(`       ${stage}: ${fmt(g.end - g.start)} (${g.count} events)`);
    }

    renderES.close();
  }
}

// ─── 打印汇总 ──────────────────────────────────────────────

function printSummary(results: { stage: string; duration: number; detail: string }[]) {
  section('汇总报告');

  const total = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n  ${'阶段'.padEnd(22)} ${'耗时'.padStart(10)} ${'占比'.padStart(8)} 详情`);
  console.log(`  ${'─'.repeat(60)}`);

  for (const r of results) {
    const pct = total > 0 ? ((r.duration / total) * 100).toFixed(1) : '0';
    console.log(
      `  ${r.stage.padEnd(22)} ${fmt(r.duration).padStart(10)} ${pct.padStart(7)}% ${r.detail}`
    );
  }

  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'总计'.padEnd(22)} ${fmt(total).padStart(10)}`);

  const sorted = [...results].sort((a, b) => b.duration - a.duration);
  if (sorted.length > 0 && sorted[0].duration > 0) {
    console.log(`\n  🔴 瓶颈: ${sorted[0].stage} (${fmt(sorted[0].duration)}, 占 ${total > 0 ? ((sorted[0].duration / total) * 100).toFixed(1) : 0}%)`);
  }
}

// ─── 主入口 ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  console.log('[DEBUG] raw argv:', process.argv);
  console.log('[DEBUG] sliced args:', args);

  // 解析参数：支持 "http <url> [server]" 或 "<url>"
  let mode: string;
  let videoUrl: string;

  if (args[0] === 'http') {
    mode = 'http';
    videoUrl = args[1] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  } else {
    mode = 'direct';
    videoUrl = args[0] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  }

  console.log(`[DEBUG] mode=${mode}, videoUrl=${videoUrl}`);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       CineClip AI - 全链路逐阶段计时诊断              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (mode === 'http') {
    const serverUrl = args[2] || 'http://localhost:3001';
    await testHttpPipeline(videoUrl, serverUrl);
  } else {
    await testDirectPipeline(videoUrl);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
