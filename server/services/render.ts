import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Render a clip from video with vertical format conversion
 */
export async function renderClip(
  videoId: string,
  start: number,
  end: number,
  outputName?: string
): Promise<string> {
  const videosDir = path.join(process.cwd(), 'videos');
  const clipsDir = path.join(process.cwd(), 'clips');
  
  if (!fs.existsSync(clipsDir)) {
    fs.mkdirSync(clipsDir, { recursive: true });
  }

  const inputPath = path.join(videosDir, `${videoId}.mp4`);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Video file not found: ${inputPath}`);
  }

  const outputFileName = outputName || `${videoId}_${start}_${end}.mp4`;
  const outputPath = path.join(clipsDir, outputFileName);

  console.log(`Rendering clip: ${start}s - ${end}s`);

  // FFmpeg command to:
  // 1. Extract clip from start to end
  // 2. Convert to vertical format (9:16 aspect ratio)
  // 3. Apply smart crop to focus on the center/action
  const duration = end - start;

  await runFFmpeg([
    '-ss', start.toString(),
    '-i', inputPath,
    '-t', duration.toString(),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-y',
    outputPath
  ]);

  console.log(`Clip rendered to ${outputPath}`);
  return outputPath;
}

/**
 * Run FFmpeg command
 */
async function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('error', (error: Error) => {
      reject(new Error(`FFmpeg error: ${error.message}`));
    });

    ffmpeg.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}\n${stderr}`));
      }
    });
  });
}
