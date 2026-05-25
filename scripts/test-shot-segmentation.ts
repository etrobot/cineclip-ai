/**
 * Shot Segmentation 测试脚本
 * 测试 FFmpeg scene detection + VL grid classification 流程
 *
 * 用法：
 *   npx tsx scripts/test-shot-segmentation.ts <video_path>
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ override: true, path: path.resolve(process.cwd(), '.env') });

async function main() {
  const videoPath = process.argv[2];

  if (!videoPath || !fs.existsSync(videoPath)) {
    console.error('Usage: npx tsx scripts/test-shot-segmentation.ts <video_path>');
    console.error('Video file not found:', videoPath);
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║       Shot Segmentation 测试 (FFmpeg + VL Grid)       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n视频: ${videoPath}`);

  const { analyzeShots } = await import('../server/services/shotSegmentation.js');

  const startTime = performance.now();
  try {
    const { shots } = await analyzeShots(videoPath);
    const duration = performance.now() - startTime;

    console.log(`\n✅ 分析完成，耗时: ${(duration / 1000).toFixed(2)}s`);
    console.log(`\n检测到 ${shots.length} 个 shots:`);
    console.log(`${'编号'.padEnd(6)} ${'开始'.padStart(10)} ${'结束'.padStart(10)} ${'时长'.padStart(8)}  标签`);
    console.log('─'.repeat(70));

    shots.forEach((shot, i) => {
      const dur = shot.end - shot.start;
      console.log(
        `#${(i + 1).toString().padEnd(4)} ` +
        `${shot.start.toFixed(3).padStart(10)} ` +
        `${shot.end.toFixed(3).padStart(10)} ` +
        `${dur.toFixed(3).padStart(8)}  ${shot.label}`
      );
    });

    // 验证精度
    const hasDecimal = shots.some(s => s.start !== Math.floor(s.start) || s.end !== Math.floor(s.end));
    if (hasDecimal) {
      console.log('\n✅ 时间精度: 包含毫秒级精度');
    } else {
      console.log('\n⚠️  时间精度: 只有整数秒');
    }

  } catch (err: any) {
    console.error('\n❌ 分析失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});