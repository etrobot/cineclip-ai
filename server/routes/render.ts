import { Router } from 'express';
import { renderClip } from '../services/render';
import { generateThumbnailFromGrid } from '../services/grid';
import { downloadVideo } from '../services/youtube';
import { progressEmitter } from '../services/progressEmitter';
import { refreshClipsJson } from './gallery';
import * as path from 'path';
import * as fs from 'fs';

export const renderRoute = Router();

/**
 * POST /api/render
 * Body: {
 *   videoId: string,
 *   start: number,
 *   end: number,
 *   outputName?: string,
 *   title?: string,
 *   subtitles?: Array<{start:number,end:number,text:string}>,
 *   jobId?: string
 * }
 * Returns: { outputPath: string, clipUrl: string, thumbnailUrl: string, jobId: string }
 */
renderRoute.post('/', async (req, res) => {
  const { videoId, start, end, outputName, title, subtitles, jobId } = req.body;
  const jid = jobId || `render_${Date.now()}`;

  try {
    if (!videoId || start === undefined || end === undefined) {
      return res.status(400).json({ error: 'videoId, start, and end are required' });
    }

    const videosDir = path.join(process.cwd(), 'videos');
    const clipsDir = path.join(process.cwd(), 'clips');
    const thumbsDir = path.join(process.cwd(), 'clips', 'thumbnails');

    // Ensure directories exist
    if (!fs.existsSync(clipsDir)) {
      fs.mkdirSync(clipsDir, { recursive: true });
    }
    if (!fs.existsSync(thumbsDir)) {
      fs.mkdirSync(thumbsDir, { recursive: true });
    }

    // Step 0: Download video if not already cached
    const videoPath = path.join(videosDir, `${videoId}.mp4`);
    if (!fs.existsSync(videoPath)) {
      progressEmitter.emitProgress(jid, 'downloading', 5, 'Downloading video...');
      await downloadVideo(videoId);
      progressEmitter.emitProgress(jid, 'downloading', 25, 'Video downloaded');
    } else {
      progressEmitter.emitProgress(jid, 'downloading', 25, 'Video already cached');
    }

    // Step 1: Render the clip first (needed for grid-based thumbnail)
    progressEmitter.emitProgress(jid, 'rendering', 30, 'Extracting clip...');
    const outputPath = await renderClip(videoId, start, end, outputName, title, subtitles);

    progressEmitter.emitProgress(jid, 'rendering', 70, 'Clip rendered');

    // Step 2: Generate thumbnail from grid (1:1 first cell)
    progressEmitter.emitProgress(jid, 'thumbnail', 75, 'Generating thumbnail from grid...');
    const safeStart = String(start).replace(/\./g, 'p');
    const safeEnd = String(end).replace(/\./g, 'p');
    const thumbFileName = outputName
      ? `${path.parse(outputName).name}.jpg`
      : `${videoId}_${safeStart}_${safeEnd}.jpg`;
    const thumbPath = path.join(thumbsDir, thumbFileName);

    try {
      await generateThumbnailFromGrid(outputPath, thumbPath);
    } catch (thumbErr) {
      console.warn('Thumbnail generation from grid failed, continuing without it:', thumbErr);
    }

    progressEmitter.emitProgress(jid, 'thumbnail', 90, 'Thumbnail generated');

    // Complete
    progressEmitter.emitProgress(jid, 'complete', 100, 'Render complete');

    // Update clips.json in background
    setImmediate(() => refreshClipsJson());

    const thumbnailUrl = `/api/clips/thumbnails/${thumbFileName}`;
    const clipFileName = path.basename(outputPath);
    const clipUrl = `/api/clips/${clipFileName}`;

    res.json({ outputPath, clipUrl, thumbnailUrl, jobId: jid });
  } catch (error: any) {
    console.error('Render error:', error);
    progressEmitter.emitProgress(jid, 'error', 0, error.message || 'Failed to render clip');
    res.status(500).json({ error: error.message || 'Failed to render clip' });
  }
});
