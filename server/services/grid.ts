import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { detectSceneChanges } from './ffmpeg';

const execAsync = promisify(exec);

async function getVideoResolution(videoPath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x -select_streams v:0 "${videoPath}"`
  );
  const [w, h] = stdout.trim().split('x').map(Number);
  return { width: w || 1920, height: h || 1080 };
}

/**
 * Extract a single frame at a specific timestamp from a video.
 */
export async function extractFrameAt(
  videoPath: string,
  timestamp: number
): Promise<{ jpegBuf: Buffer; width: number; height: number } | null> {
  const tempDir = path.join(process.cwd(), 'storage', 'temp', `grid_frame_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const outputPath = path.join(tempDir, 'frame.jpg');

  try {
    const cmd = `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 2 -y "${outputPath}"`;
    await execAsync(cmd, { timeout: 30000 });

    if (fs.existsSync(outputPath)) {
      const jpegBuf = fs.readFileSync(outputPath);
      const meta = await sharp(jpegBuf).metadata();
      return {
        jpegBuf,
        width: meta.width || 480,
        height: meta.height || 270,
      };
    }
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export const MAX_GRID_COLS = 16;
export const MAX_GRID_ROWS = 16;
export const MAX_GRID_CELLS = MAX_GRID_COLS * MAX_GRID_ROWS; // 256

/**
 * Use FFmpeg scene detection to get scene boundary timestamps.
 * If > maxScenes, increase threshold and retry.
 * Returns array of timestamps for keyframes (scene starts).
 */
export async function getSceneTimestamps(
  videoPath: string,
  maxScenes: number = MAX_GRID_CELLS,
): Promise<number[]> {
  let threshold = 0.3;
  const MAX_THRESHOLD = 0.5;

  while (true) {
    const boundaries = await detectSceneChanges(videoPath, threshold);
    const numScenes = boundaries.length - 1; // boundaries includes 0 and duration

    console.log(`Scene detection: threshold=${threshold.toFixed(2)} → ${numScenes} scenes (boundaries=${boundaries.length})`);

    if (numScenes <= maxScenes) {
      // Return scene start timestamps (excluding the final duration boundary)
      return boundaries.slice(0, -1);
    }

    if (threshold >= MAX_THRESHOLD) {
      console.warn(`Scene detection: ${numScenes} scenes > ${maxScenes} even at threshold=${threshold}, truncating`);
      // Uniformly sample maxScenes boundaries
      const step = boundaries.length / maxScenes;
      const sampled: number[] = [];
      for (let i = 0; i < maxScenes; i++) {
        sampled.push(boundaries[Math.floor(i * step)]);
      }
      return sampled;
    }

    threshold = Math.min(MAX_THRESHOLD, threshold + 0.05);
    console.log(`Scene detection: too many scenes (${numScenes} > ${maxScenes}), retrying with threshold=${threshold.toFixed(2)}`);
  }
}

/**
 * Calculate grid columns, rows, and cell size.
 * Grid ratio is inverted from video aspect ratio.
 * Grid is capped at MAX_GRID_COLS × MAX_GRID_ROWS to ensure VL model can process it.
 */
function calculateGridLayout(
  videoWidth: number,
  videoHeight: number,
  numImages: number,
  maxSize: number = 2000
): { cols: number; rows: number; cellSize: [number, number] } {
  const videoRatio = videoWidth / videoHeight || 1.0;
  const gridRatio = videoHeight / videoWidth || 1.0; // inverted

  // Clamp numImages to max grid capacity
  const effectiveNumImages = Math.min(numImages, MAX_GRID_CELLS);

  let cols: number, rows: number;
  if (gridRatio >= 1.0) {
    cols = Math.max(1, Math.round(Math.sqrt(effectiveNumImages * gridRatio)));
    rows = Math.max(1, Math.ceil(effectiveNumImages / cols));
  } else {
    rows = Math.max(1, Math.round(Math.sqrt(effectiveNumImages / gridRatio)));
    cols = Math.max(1, Math.ceil(effectiveNumImages / rows));
  }

  while (cols * rows < effectiveNumImages) {
    if (gridRatio >= 1.0) cols++;
    else rows++;
  }

  // Ensure grid never exceeds the max dimensions
  cols = Math.min(cols, MAX_GRID_COLS);
  rows = Math.min(rows, MAX_GRID_ROWS);
  // Re-check capacity after clamping
  while (cols * rows < effectiveNumImages && cols < MAX_GRID_COLS && rows < MAX_GRID_ROWS) {
    if (gridRatio >= 1.0) cols++;
    else rows++;
  }

  let cellW = 480, cellH = 240;
  if (videoRatio > 1.0) {
    cellH = Math.round(cellW / videoRatio);
  } else {
    cellW = Math.round(cellH * videoRatio);
  }

  const gridW = cols * cellW;
  const gridH = rows * cellH;
  if (Math.max(gridW, gridH) > maxSize) {
    const scale = maxSize / Math.max(gridW, gridH);
    cellW = Math.floor(cellW * scale);
    cellH = Math.floor(cellH * scale);
  }

  return { cols, rows, cellSize: [cellW, cellH] };
}

/**
 * Add timestamp text to a sharp pipeline image.
 * We draw the timestamp using a simple overlay approach.
 */
export async function addTimestampToBuffer(
  imgBuf: Buffer,
  timestamp: number,
  width: number,
  height: number
): Promise<Buffer> {
  const totalSecs = Math.floor(timestamp);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const frac = timestamp - Math.floor(timestamp);
  const fracStr = frac.toFixed(6).slice(1); // ".512875"
  const text = `${mins}:${secs.toString().padStart(2, '0')}${fracStr}`;

  // Create a small SVG overlay with the timestamp
  const fontSize = Math.max(12, Math.floor(width / 25));
  const padding = Math.max(3, Math.floor(width / 80));
  const textWidth = text.length * fontSize * 0.55;
  const textHeight = fontSize * 1.3;

  const bgX = padding;
  const bgY = height - textHeight - padding * 2;
  const bgW = textWidth + padding * 2;
  const bgH = textHeight + padding * 2;

  const svg = Buffer.from(`<svg width="${width}" height="${height}">
    <rect x="${bgX}" y="${bgY}" width="${bgW}" height="${bgH}" fill="black" opacity="0.7" rx="2"/>
    <text x="${bgX + padding}" y="${bgY + padding + fontSize}" fill="#FFFF00" font-family="monospace" font-size="${fontSize}" font-weight="bold">${text}</text>
  </svg>`);

  return sharp(imgBuf)
    .composite([{ input: svg, blend: 'over' }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Generate a multi-frame grid screenshot from a video clip.
 * Uses FFmpeg scene detection to pick keyframes.
 * Returns the output file path.
 */
export async function generateVideoGrid(
  videoPath: string,
  options: {
    maxGridSize?: number;
  } = {}
): Promise<string> {
  const { maxGridSize = 2000 } = options;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  // Get video info
  const { width: videoWidth, height: videoHeight } = await getVideoResolution(videoPath);
  console.log(`Grid: video ${videoWidth}x${videoHeight}`);

  // Use FFmpeg scene detection to get keyframe timestamps
  const timestamps = await getSceneTimestamps(videoPath);
  console.log(`Grid: detected ${timestamps.length} scene keyframes`);

  if (timestamps.length === 0) {
    throw new Error('No scene keyframes detected from video');
  }

  // Extract frames at detected timestamps
  const frames: Array<{ jpegBuf: Buffer; width: number; height: number; timestamp: number }> = [];
  for (const ts of timestamps) {
    const frame = await extractFrameAt(videoPath, ts);
    if (frame) {
      frames.push({ ...frame, timestamp: ts });
    }
  }

  if (frames.length === 0) {
    throw new Error('Failed to extract any frames for grid');
  }

  const numImages = frames.length;
  const { cols, rows, cellSize } = calculateGridLayout(videoWidth, videoHeight, numImages, maxGridSize);
  const [cellW, cellH] = cellSize;
  console.log(`Grid: layout ${cols}x${rows}, cell ${cellW}x${cellH}`);

  // Build grid image using sharp
  const gridW = cols * cellW + (cols + 1); // 1px grid lines
  const gridH = rows * cellH + (rows + 1);

  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < numImages; i++) {
    const frame = frames[i];
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = c * cellW + (c + 1);
    const y = r * cellH + (r + 1);

    // Resize frame and add timestamp
    let resizedBuf = await sharp(frame.jpegBuf)
      .resize(cellW, cellH, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();

    resizedBuf = await addTimestampToBuffer(resizedBuf, frame.timestamp, cellW, cellH);

    composites.push({
      input: resizedBuf,
      left: x,
      top: y,
    });
  }

  // Pad with black if needed
  const capacity = cols * rows;
  if (numImages < capacity) {
    const blackTile = await sharp({
      create: { width: cellW, height: cellH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    for (let i = numImages; i < capacity; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const x = c * cellW + (c + 1);
      const y = r * cellH + (r + 1);
      composites.push({ input: blackTile, left: x, top: y });
    }
  }

  // Create canvas and composite all tiles
  let gridImage = sharp({
    create: { width: gridW, height: gridH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });

  // Apply composites in batches (sharp has limits)
  const batchSize = 50;
  for (let i = 0; i < composites.length; i += batchSize) {
    const batch = composites.slice(i, i + batchSize);
    gridImage = gridImage.composite(batch);
  }

  const finalImage = gridImage.jpeg({ quality: 90 });

  // Save output
  const thumbsDir = path.join(path.dirname(videoPath), 'thumbnails');
  if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  const baseName = path.parse(videoPath).name;
  const outputPath = path.join(thumbsDir, `${baseName}_grid.jpg`);

  await finalImage.toFile(outputPath);
  console.log(`Grid: saved to ${outputPath}`);

  return outputPath;
}

/**
 * Generate a grid image and crop the first 1:1 cell as a thumbnail.
 * Returns { gridPath, thumbnailPath }.
 */
export async function generateThumbnailFromGrid(
  videoPath: string,
  thumbnailOutputPath: string,
  options: {
    maxGridSize?: number;
  } = {}
): Promise<{ gridPath: string; thumbnailPath: string }> {
  const { maxGridSize = 2000 } = options;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  // Get video info
  const { width: videoWidth, height: videoHeight } = await getVideoResolution(videoPath);

  // Use FFmpeg scene detection to get keyframe timestamps
  const timestamps = await getSceneTimestamps(videoPath);

  // Extract frames at detected timestamps
  const frames: Array<{ jpegBuf: Buffer; width: number; height: number; timestamp: number }> = [];
  for (const ts of timestamps) {
    const frame = await extractFrameAt(videoPath, ts);
    if (frame) {
      frames.push({ ...frame, timestamp: ts });
    }
  }

  if (frames.length === 0) {
    throw new Error('No frames extracted from video');
  }

  const numImages = frames.length;
  const { cols, rows, cellSize } = calculateGridLayout(videoWidth, videoHeight, numImages, maxGridSize);
  const [cellW, cellH] = cellSize;

  // --- Save the first keyframe as 1:1 thumbnail ---
  const firstFrame = frames[0];
  const thumbSize = Math.min(cellW, cellH); // 1:1 square
  const outputDir = path.dirname(thumbnailOutputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await sharp(firstFrame.jpegBuf)
    .resize(thumbSize, thumbSize, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toFile(thumbnailOutputPath);
  console.log(`Thumbnail (1:1 from grid): saved to ${thumbnailOutputPath}`);

  // --- Generate the full grid image ---
  const gridW = cols * cellW + (cols + 1);
  const gridH = rows * cellH + (rows + 1);

  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < numImages; i++) {
    const frame = frames[i];
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = c * cellW + (c + 1);
    const y = r * cellH + (r + 1);

    let resizedBuf = await sharp(frame.jpegBuf)
      .resize(cellW, cellH, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();

    resizedBuf = await addTimestampToBuffer(resizedBuf, frame.timestamp, cellW, cellH);

    composites.push({ input: resizedBuf, left: x, top: y });
  }

  const capacity = cols * rows;
  if (numImages < capacity) {
    const blackTile = await sharp({
      create: { width: cellW, height: cellH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    for (let i = numImages; i < capacity; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const x = c * cellW + (c + 1);
      const y = r * cellH + (r + 1);
      composites.push({ input: blackTile, left: x, top: y });
    }
  }

  let gridImage = sharp({
    create: { width: gridW, height: gridH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });

  const batchSize = 50;
  for (let i = 0; i < composites.length; i += batchSize) {
    const batch = composites.slice(i, i + batchSize);
    gridImage = gridImage.composite(batch);
  }

  const thumbsDir = path.join(path.dirname(videoPath), 'thumbnails');
  if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  const baseName = path.parse(videoPath).name;
  const gridOutputPath = path.join(thumbsDir, `${baseName}_grid.jpg`);

  await gridImage.jpeg({ quality: 90 }).toFile(gridOutputPath);
  console.log(`Grid: saved to ${gridOutputPath}`);

  return { gridPath: gridOutputPath, thumbnailPath: thumbnailOutputPath };
}