import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';

const execAsync = promisify(exec);

const TARGET_WIDTH = 256;
const TOP_RATIO = 2 / 3;

/**
 * Extract frames from video at given FPS using ffmpeg.
 * Returns array of { data: Buffer<raw RGBA>, width, height, timestamp }.
 */
interface ExtractedFrame {
  jpegBuf: Buffer;
  width: number;
  height: number;
  timestamp: number;
}

async function extractFrames(
  videoPath: string,
  fps: number = 2.0
): Promise<ExtractedFrame[]> {
  const frames: ExtractedFrame[] = [];
  // Use ffmpeg to extract frames as JPEG to temp dir, then read with sharp
  const tempDir = path.join(process.cwd(), 'storage', 'temp', `grid_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Extract frames as JPEGs
    const pattern = path.join(tempDir, 'frame_%04d.jpg');
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "fps=${fps}" -q:v 4 -y "${pattern}"`,
      { timeout: 60000 }
    );

    // Read extracted frames
    const frameFiles = fs.readdirSync(tempDir)
      .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
      .sort();

    for (const file of frameFiles) {
      const filePath = path.join(tempDir, file);
      const jpegBuf = fs.readFileSync(filePath);
      const meta = await sharp(jpegBuf).metadata();

      // Parse timestamp from frame number
      const frameNum = parseInt(file.replace('frame_', '').replace('.jpg', ''), 10);
      const timestamp = (frameNum - 1) / fps;

      frames.push({
        jpegBuf,
        width: meta.width || 480,
        height: meta.height || 270,
        timestamp,
      });
    }

    return frames;
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`
  );
  return parseFloat(stdout.trim()) || 0;
}

async function getVideoResolution(videoPath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries stream=width,height -of csv=p=0:s=x -select_streams v:0 "${videoPath}"`
  );
  const [w, h] = stdout.trim().split('x').map(Number);
  return { width: w || 1920, height: h || 1080 };
}

/**
 * Process top region of a JPEG frame for diff comparison.
 * Uses sharp to crop top 2/3, resize to TARGET_WIDTH, convert to grayscale.
 */
async function processFrameTopRegion(frame: ExtractedFrame): Promise<Float32Array | null> {
  try {
    const topH = Math.max(1, Math.floor(frame.height * TOP_RATIO));
    // Use sharp to crop top region and resize to TARGET_WIDTH wide
    const { data, info } = await sharp(frame.jpegBuf)
      .extract({ left: 0, top: 0, width: frame.width, height: topH })
      .resize(TARGET_WIDTH, null, { withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const result = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      result[i] = data[i] / 255.0;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Compute mean absolute difference between two top-region arrays.
 */
function calcDiff(a: Float32Array | null, b: Float32Array | null): number {
  if (!a || !b) return 1.0;
  const len = Math.min(a.length, b.length);
  if (len <= 0) return 1.0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / len;
}

/**
 * Select keyframe indices where visual diff crosses threshold.
 * Uses top-region processing for scene change detection.
 */
async function pickSceneKeyframes(
  frames: ExtractedFrame[],
  diffThreshold: number = 0.15
): Promise<number[]> {
  const selected: number[] = [];
  let lastArr: Float32Array | null = null;

  for (let i = 0; i < frames.length; i++) {
    const arr = await processFrameTopRegion(frames[i]);
    if (!arr) continue;

    if (lastArr === null) {
      selected.push(i);
      lastArr = arr;
    } else {
      const diff = calcDiff(lastArr, arr);
      if (diff >= diffThreshold) {
        selected.push(i);
        lastArr = arr;
      }
    }
  }

  return selected;
}

/**
 * Calculate grid columns, rows, and cell size.
 * Grid ratio is inverted from video aspect ratio.
 */
function calculateGridLayout(
  videoWidth: number,
  videoHeight: number,
  numImages: number,
  maxSize: number = 2000
): { cols: number; rows: number; cellSize: [number, number] } {
  const videoRatio = videoWidth / videoHeight || 1.0;
  const gridRatio = videoHeight / videoWidth || 1.0; // inverted

  let cols: number, rows: number;
  if (gridRatio >= 1.0) {
    cols = Math.max(1, Math.round(Math.sqrt(numImages * gridRatio)));
    rows = Math.max(1, Math.ceil(numImages / cols));
  } else {
    rows = Math.max(1, Math.round(Math.sqrt(numImages / gridRatio)));
    cols = Math.max(1, Math.ceil(numImages / rows));
  }

  while (cols * rows < numImages) {
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
async function addTimestampToBuffer(
  imgBuf: Buffer,
  timestamp: number,
  width: number,
  height: number
): Promise<Buffer> {
  const totalSecs = Math.floor(timestamp);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const ms = Math.floor(((timestamp % 1) * 10 + 0.5) % 10);
  const text = `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;

  // Create a small SVG overlay with the timestamp
  const fontSize = Math.max(12, Math.floor(width / 25));
  const padding = Math.max(3, Math.floor(width / 80));
  const textWidth = text.length * fontSize * 0.6;
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
 * Returns the output file path.
 */
export async function generateVideoGrid(
  videoPath: string,
  options: {
    fps?: number;
    diffThreshold?: number;
    maxGridSize?: number;
  } = {}
): Promise<string> {
  const {
    fps = 2.0,
    diffThreshold = 0.15,
    maxGridSize = 2000,
  } = options;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  // Get video info
  const { width: videoWidth, height: videoHeight } = await getVideoResolution(videoPath);
  console.log(`Grid: video ${videoWidth}x${videoHeight}, fps=${fps}, threshold=${diffThreshold}`);

  // Extract frames
  const frames = await extractFrames(videoPath, fps);
  if (frames.length === 0) {
    throw new Error('No frames extracted from video');
  }
  console.log(`Grid: extracted ${frames.length} frames`);

  // Select keyframes
  let selIndices = await pickSceneKeyframes(frames, diffThreshold);
  console.log(`Grid: selected ${selIndices.length} keyframes`);

  if (selIndices.length === 0) {
    selIndices = [0];
  }

  const numImages = selIndices.length;
  const { cols, rows, cellSize } = calculateGridLayout(videoWidth, videoHeight, numImages, maxGridSize);
  const [cellW, cellH] = cellSize;
  console.log(`Grid: layout ${cols}x${rows}, cell ${cellW}x${cellH}`);

  // Build grid image using sharp
  const gridW = cols * cellW + (cols + 1); // 1px grid lines
  const gridH = rows * cellH + (rows + 1);

  // Start with black canvas
  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < numImages; i++) {
    const frame = frames[selIndices[i]];
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = c * cellW + (c + 1);
    const y = r * cellH + (r + 1);

    // Resize frame and add timestamp
    let resizedBuf = await sharp(frame.jpegBuf)
      .resize(cellW, cellH, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Add timestamp
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

  // Resize if exceeds maxGridSize
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
    fps?: number;
    diffThreshold?: number;
    maxGridSize?: number;
  } = {}
): Promise<{ gridPath: string; thumbnailPath: string }> {
  const { fps = 2.0, diffThreshold = 0.15, maxGridSize = 2000 } = options;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  // Get video info
  const { width: videoWidth, height: videoHeight } = await getVideoResolution(videoPath);

  // Extract frames
  const frames = await extractFrames(videoPath, fps);
  if (frames.length === 0) {
    throw new Error('No frames extracted from video');
  }

  // Select keyframes
  let selIndices = await pickSceneKeyframes(frames, diffThreshold);
  if (selIndices.length === 0) {
    selIndices = [0];
  }

  const numImages = selIndices.length;
  const { cols, rows, cellSize } = calculateGridLayout(videoWidth, videoHeight, numImages, maxGridSize);
  const [cellW, cellH] = cellSize;

  // --- Save the first keyframe as 1:1 thumbnail ---
  const firstFrame = frames[selIndices[0]];
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
    const frame = frames[selIndices[i]];
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