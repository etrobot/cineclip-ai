/**
 * 检查字幕时间戳单位和精度
 */
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
dotenv.config({ override: true, path: path.resolve(process.cwd(), '.env') });

import { getVideoWithSubtitles, parseVTT } from '../server/services/youtube.js';

async function main() {
  const videoId = process.argv[2] || 'eV3lAY77IpU';

  console.log(`获取视频 ${videoId} 的字幕...`);
  const data = await getVideoWithSubtitles(videoId);
  if (!data) {
    console.log('❌ 无法获取字幕');
    process.exit(1);
  }

  console.log(`\n视频标题: ${data.title}`);
  console.log(`视频时长: ${data.duration} (来自 yt-dlp)`);
  console.log(`字幕段数: ${data.subtitles.length}`);

  console.log('\n══════════════════════════════════════════════');
  console.log('  解析后的字幕数据（前 15 条）');
  console.log('══════════════════════════════════════════════');
  console.log('  { start, end, text }');
  console.log('──────────────────────────────────────────────');
  for (let i = 0; i < Math.min(15, data.subtitles.length); i++) {
    const s = data.subtitles[i];
    console.log(`  [${i}] start=${s.start}, end=${s.end}, text="${s.text}"`);
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  最后 5 条字幕');
  console.log('══════════════════════════════════════════════');
  for (let i = Math.max(0, data.subtitles.length - 5); i < data.subtitles.length; i++) {
    const s = data.subtitles[i];
    console.log(`  [${i}] start=${s.start}, end=${s.end}, text="${s.text}"`);
  }

  const lastSub = data.subtitles[data.subtitles.length - 1];
  console.log('\n══════════════════════════════════════════════');
  console.log('  单位判断');
  console.log('══════════════════════════════════════════════');
  console.log(`  视频时长 (yt-dlp): ${data.duration}`);
  console.log(`  最后字幕 end 值:   ${lastSub.end}`);
  console.log(`  比值 (end/duration): ${(lastSub.end / data.duration).toFixed(4)}`);
  
  if (lastSub.end > data.duration * 100) {
    console.log('  ❌ 时间戳是毫秒！');
    console.log('  → LLM prompt 说 "start_sec 和 end_sec 必须是整数（秒）" 会导致偏差');
  } else if (lastSub.end > data.duration * 1.5) {
    console.log('  ⚠️  时间戳单位不明确，end 值明显超过视频时长');
  } else {
    console.log('  ✅ 时间戳是秒（精度为毫秒小数）');
    console.log('  → LLM prompt 要求返回整数秒是合理的');
  }

  // 检查精度：相邻字幕的间隔
  console.log('\n══════════════════════════════════════════════');
  console.log('  相邻字幕间隔分布');
  console.log('══════════════════════════════════════════════');
  const gaps: number[] = [];
  for (let i = 1; i < data.subtitles.length; i++) {
    gaps.push(data.subtitles[i].start - data.subtitles[i - 1].start);
  }
  gaps.sort((a, b) => a - b);
  console.log(`  最小间隔: ${gaps[0].toFixed(3)}s`);
  console.log(`  中位间隔: ${gaps[Math.floor(gaps.length / 2)].toFixed(3)}s`);
  console.log(`  最大间隔: ${gaps[gaps.length - 1].toFixed(3)}s`);
  console.log(`  平均间隔: ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3)}s`);

  // 检查每条字幕自身时长
  const durations = data.subtitles.map(s => s.end - s.start);
  durations.sort((a, b) => a - b);
  console.log('\n══════════════════════════════════════════════');
  console.log('  单条字幕持续时长分布');
  console.log('══════════════════════════════════════════════');
  console.log(`  最短: ${durations[0].toFixed(3)}s`);
  console.log(`  中位: ${durations[Math.floor(durations.length / 2)].toFixed(3)}s`);
  console.log(`  最长: ${durations[durations.length - 1].toFixed(3)}s`);
  console.log(`  平均: ${(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(3)}s`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
