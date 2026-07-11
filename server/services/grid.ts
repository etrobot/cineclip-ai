import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { detectSceneChanges, getVideoDuration } from './ffmpeg';

const execAsync = promisify(exec);

let extractFrameCounter = 0;

/**
 * Composite tiles onto a grid canvas.
 * Sharp pipelines must be materialized between batches — chained .composite() drops earlier layers.
 */
export async function renderCompositeGrid(
  gridW: number,
  gridH: number,
  composites: sharp.OverlayOptions[],
  batchSize: number = 50
): Promise<Buffer> {
  if (composites.length === 0) {
    return sharp({
      create: { width: gridW, height: gridH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  let imageBuffer = await sharp({
    create: { width: gridW, height: gridH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite(composites.slice(0, batchSize))
    .jpeg({ quality: 90 })
    .toBuffer();

  for (let i = batchSize; i < composites.length; i += batchSize) {
    const batch = composites.slice(i, i + batchSize);
    imageBuffer = await sharp(imageBuffer)
      .composite(batch)
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  if (composites.length > 10 && imageBuffer.length < 50_000) {
    throw new Error(
      `Grid composite output too small (${imageBuffer.length} bytes for ${composites.length} tiles) — likely a render failure`
    );
  }

  return imageBuffer;
}

function pickThumbnailFrame(
  frames: Array<{ jpegBuf: Buffer; timestamp: number }>
): { jpegBuf: Buffer; timestamp: number } {
  // Skip t=0 — many clips fade in from black at the first frame
  const candidate = frames.find((f) => f.timestamp >= 0.5);
  return candidate ?? frames[Math.min(1, frames.length - 1)] ?? frames[0];
}

interface VisualFrame {
  jpegBuf: Buffer;
  timestamp: number;
}

async function buildFrameSignature(jpegBuf: Buffer): Promise<Buffer> {
  return sharp(jpegBuf)
    .resize(64, 36, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
}

/**
 * Remove adjacent near-identical samples while retaining periodic coverage of
 * long static scenes. Small text changes are preserved via changed-pixel ratio.
 */
export async function removeNearDuplicateFrames<T extends VisualFrame>(
  frames: T[],
  maxStaticGapSec: number = 3
): Promise<T[]> {
  if (frames.length <= 1) return frames;

  const kept: T[] = [frames[0]];
  let previousSignature = await buildFrameSignature(frames[0].jpegBuf);

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    const signature = await buildFrameSignature(frame.jpegBuf);
    let totalDelta = 0;
    let changedPixels = 0;

    for (let offset = 0; offset < signature.length; offset += 3) {
      const r = Math.abs(signature[offset] - previousSignature[offset]);
      const g = Math.abs(signature[offset + 1] - previousSignature[offset + 1]);
      const b = Math.abs(signature[offset + 2] - previousSignature[offset + 2]);
      totalDelta += r + g + b;
      if (Math.max(r, g, b) >= 20) changedPixels++;
    }

    const pixelCount = signature.length / 3;
    const meanDelta = totalDelta / (signature.length * 255);
    const changedRatio = changedPixels / pixelCount;
    const staticGap = frame.timestamp - kept[kept.length - 1].timestamp;
    const isNearDuplicate = meanDelta < 0.012 && changedRatio < 0.008;

    if (!isNearDuplicate || staticGap >= maxStaticGapSec) {
      kept.push(frame);
      previousSignature = signature;
    }
  }

  return kept;
}

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
  const tempDir = path.join(
    process.cwd(),
    'storage',
    'temp',
    `grid_frame_${Date.now()}_${extractFrameCounter++}_${Math.random().toString(36).slice(2, 8)}`
  );
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
 * Minimum scene count based on clip duration.
 * Short clips need finer granularity for shot segmentation.
 */
export function computeMinScenes(durationSec: number, maxScenes: number): number {
  if (durationSec <= 15) {
    return Math.min(maxScenes, Math.max(24, Math.ceil(durationSec * 4)));
  }
  if (durationSec <= 60) {
    return Math.min(maxScenes, Math.max(30, Math.ceil(durationSec * 2)));
  }
  if (durationSec <= 180) {
    return Math.min(maxScenes, Math.max(60, Math.ceil(durationSec)));
  }
  if (durationSec <= 600) {
    return Math.min(maxScenes, Math.max(90, Math.ceil(durationSec * 0.4)));
  }
  return Math.min(maxScenes, 120);
}

/**
 * Fill gaps with uniform sampling when scene detection alone cannot reach target count.
 */
function supplementUniformSamples(
  existing: number[],
  duration: number,
  targetCount: number,
  maxScenes: number
): number[] {
  const target = Math.min(maxScenes, targetCount);
  if (existing.length >= target) return existing;

  const samples = Array.from(new Set([0, ...existing]))
    .filter(t => t >= 0 && t < duration)
    .sort((a, b) => a - b);

  // Repeatedly split the largest uncovered time span. This preserves every real
  // cut and gives the VL grid even coverage without exceeding its target size.
  while (samples.length < target) {
    let largestGap = -1;
    let insertAfter = 0;
    for (let i = 0; i < samples.length; i++) {
      const end = i + 1 < samples.length ? samples[i + 1] : duration;
      const gap = end - samples[i];
      if (gap > largestGap) {
        largestGap = gap;
        insertAfter = i;
      }
    }

    if (largestGap <= 0.02) break;
    const end = insertAfter + 1 < samples.length ? samples[insertAfter + 1] : duration;
    samples.splice(insertAfter + 1, 0, (samples[insertAfter] + end) / 2);
  }

  return samples;
}

/**
 * Use adaptive scene boundaries, then fill uncovered spans to the duration-based
 * grid density. Short clips deliberately receive more samples per second.
 * Returns array of timestamps for keyframes (scene starts).
 */
export async function getSceneTimestamps(
  videoPath: string,
  maxScenes: number = MAX_GRID_CELLS,
): Promise<number[]> {
  const duration = await getVideoDuration(videoPath);
  const minScenes = computeMinScenes(duration, maxScenes);

  const threshold = duration <= 180 ? 0.22 : 0.3;
  const boundaries = await detectSceneChanges(videoPath, threshold);
  let timestamps = boundaries.slice(0, -1);

  console.log(
    `Scene detection: single adaptive scan produced ${timestamps.length} scenes ` +
    `(min=${minScenes}, max=${maxScenes})`
  );

  if (timestamps.length > maxScenes) {
    const source = timestamps;
    timestamps = Array.from({ length: maxScenes }, (_, i) => {
      const index = Math.min(source.length - 1, Math.floor(i * source.length / maxScenes));
      return source[index];
    });
    console.log(`Scene detection: reduced ${source.length} → ${timestamps.length} samples for grid capacity`);
  }

  if (timestamps.length < minScenes) {
    const supplemented = supplementUniformSamples(timestamps, duration, minScenes, maxScenes);
    console.log(`Scene detection: supplemented ${timestamps.length} → ${supplemented.length} scenes`);
    return supplemented;
  }

  return timestamps;
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
 * Add scene index text to a frame buffer.
 */
export async function addSceneIndexToBuffer(
  imgBuf: Buffer,
  sceneIndex: number,
  width: number,
  height: number
): Promise<Buffer> {
  const text = `#${sceneIndex}`;
  const fontSize = Math.max(14, Math.floor(width / 18));
  const padding = Math.max(4, Math.floor(width / 70));
  const textWidth = text.length * fontSize * 0.7;
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

  const uniqueFrames = await removeNearDuplicateFrames(frames);
  console.log(`Grid: visual dedupe ${frames.length} → ${uniqueFrames.length} frames`);
  const numImages = uniqueFrames.length;
  const { cols, rows, cellSize } = calculateGridLayout(videoWidth, videoHeight, numImages, maxGridSize);
  const [cellW, cellH] = cellSize;
  console.log(`Grid: layout ${cols}x${rows}, cell ${cellW}x${cellH}`);

  // Build grid image using sharp
  const gridW = cols * cellW + (cols + 1); // 1px grid lines
  const gridH = rows * cellH + (rows + 1);

  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < numImages; i++) {
    const frame = uniqueFrames[i];
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
  const thumbsDir = path.join(path.dirname(videoPath), 'thumbnails');
  if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  const baseName = path.parse(videoPath).name;
  const outputPath = path.join(thumbsDir, `${baseName}_grid.jpg`);

  const gridBuffer = await renderCompositeGrid(gridW, gridH, composites);
  await sharp(gridBuffer).toFile(outputPath);
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

  const uniqueFrames = await removeNearDuplicateFrames(frames);
  console.log(`Grid: visual dedupe ${frames.length} → ${uniqueFrames.length} frames`);
  const numImages = uniqueFrames.length;
  const { cols, rows, cellSize } = calculateGridLayout(videoWidth, videoHeight, numImages, maxGridSize);
  const [cellW, cellH] = cellSize;

  // --- Save a representative keyframe as 1:1 thumbnail ---
  const thumbFrame = pickThumbnailFrame(uniqueFrames);
  const thumbSize = Math.min(cellW, cellH); // 1:1 square
  const outputDir = path.dirname(thumbnailOutputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await sharp(thumbFrame.jpegBuf)
    .resize(thumbSize, thumbSize, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toFile(thumbnailOutputPath);
  console.log(`Thumbnail (1:1 from grid): saved to ${thumbnailOutputPath} @ ${thumbFrame.timestamp.toFixed(2)}s`);

  // --- Generate the full grid image ---
  const gridW = cols * cellW + (cols + 1);
  const gridH = rows * cellH + (rows + 1);

  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < numImages; i++) {
    const frame = uniqueFrames[i];
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

  const thumbsDir = path.join(path.dirname(videoPath), 'thumbnails');
  if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  const baseName = path.parse(videoPath).name;
  const gridOutputPath = path.join(thumbsDir, `${baseName}_grid.jpg`);

  const gridBuffer = await renderCompositeGrid(gridW, gridH, composites);
  await sharp(gridBuffer).toFile(gridOutputPath);
  console.log(`Grid: saved to ${gridOutputPath} (${composites.length} tiles, ${gridBuffer.length} bytes)`);

  return { gridPath: gridOutputPath, thumbnailPath: thumbnailOutputPath };
}
