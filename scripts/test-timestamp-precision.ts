/**
 * 测试修复后的时间戳精度
 * 验证 LLM 返回 start_idx/end_idx 后，normalizeClips 能正确映射到字幕原始时间戳
 */
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ override: true, path: path.resolve(process.cwd(), '.env') });

import { getVideoWithSubtitles } from '../server/services/youtube.js';
import { analyzeClips } from '../server/services/llm.js';

async function main() {
  const videoId = process.argv[2] || 'eV3lAY77IpU';

  console.log(`获取视频 ${videoId} 的字幕...`);
  const data = await getVideoWithSubtitles(videoId);
  if (!data) {
    console.log('❌ 无法获取字幕');
    process.exit(1);
  }

  console.log(`字幕段数: ${data.subtitles.length}`);
  console.log(`视频时长: ${data.duration}s`);

  console.log('\n══════════════════════════════════════════════');
  console.log('  调用 LLM 分析...');
  console.log('══════════════════════════════════════════════');

  const t0 = performance.now();
  const clips = await analyzeClips(data.subtitles, data.title);
  const dt = performance.now() - t0;

  console.log(`\n✅ LLM 分析完成，耗时 ${(dt / 1000).toFixed(2)}s`);
  console.log(`生成 ${clips.length} 个片段：`);

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const duration = c.end - c.start;
    console.log(`\n  [${i + 1}] ${c.title}`);
    console.log(`      时间: ${c.start}s → ${c.end}s (时长 ${duration.toFixed(1)}s)`);

    // 找到该时间段内的字幕
    const relatedSubs = data.subtitles.filter(s =>
      s.start >= c.start - 0.5 && s.end <= c.end + 0.5
    );
    console.log(`      覆盖字幕: ${relatedSubs.length} 条`);
    if (relatedSubs.length > 0) {
      const firstSub = relatedSubs[0];
      const lastSub = relatedSubs[relatedSubs.length - 1];
      console.log(`      首条字幕: ${firstSub.start}s "${firstSub.text}"`);
      console.log(`      末条字幕: ${lastSub.end}s "${lastSub.text}"`);
      
      // 检查精度：clip.start 是否精确匹配字幕 start
      const startDiff = Math.abs(c.start - firstSub.start);
      const endDiff = Math.abs(c.end - lastSub.end);
      console.log(`      起始偏差: ${startDiff.toFixed(2)}s ${startDiff < 0.1 ? '✅' : '⚠️'}`);
      console.log(`      结束偏差: ${endDiff.toFixed(2)}s ${endDiff < 0.1 ? '✅' : '⚠️'}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
