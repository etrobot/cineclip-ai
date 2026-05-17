import { Router } from 'express';
import { renderClip } from '../services/render';
import { generateThumbnailFromGrid } from '../services/grid';
import { downloadVideo } from '../services/youtube';
import { progressEmitter } from '../services/progressEmitter';
import { db } from '../db';
import { originalPost, clips as clipsTable } from '../db/schema';
import { eq } from 'drizzle-orm';
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
    let needDownload = true;
    if (fs.existsSync(videoPath)) {
      // Validate file is a proper video (not corrupt/incomplete)
      const stats = fs.statSync(videoPath);
      if (stats.size > 1024 * 1024) {
        try {
          const fd = fs.openSync(videoPath, 'r');
          const buf = Buffer.alloc(65536);
          const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
          fs.closeSync(fd);
          const nullCount = buf.slice(0, bytesRead).filter(b => b === 0).length;
          if (nullCount / bytesRead < 0.1 && (buf.includes('mdat') || buf.includes('moov'))) {
            needDownload = false;
          }
        } catch {
          // Validation failed, re-download
        }
      }
    }
    
    if (needDownload) {
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

    const thumbnailUrl = `/api/clips/thumbnails/${thumbFileName}`;
    const clipFileName = path.basename(outputPath);
    const clipUrl = `/api/clips/${clipFileName}`;

    // Save clip metadata to database
    const postUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const post = await db.query.originalPost.findFirst({
      where: (p, { eq }) => eq(p.postUrl, postUrl),
    });

    if (post) {
      const durationSec = end - start;
      const mins = Math.floor(durationSec / 60);
      const secs = Math.floor(durationSec % 60);
      const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;

      await db.insert(clipsTable).values({
        originalPostId: post.id,
        fileName: clipFileName,
        clipUrl,
        thumbnailUrl,
        startTime: start,
        endTime: end,
        duration: durationStr,
        title: title || clipFileName,
        size: fs.statSync(outputPath).size,
      });
    }

    res.json({ outputPath, clipUrl, thumbnailUrl, jobId: jid });
  } catch (error: any) {
    console.error('Render error:', error);
    progressEmitter.emitProgress(jid, 'error', 0, error.message || 'Failed to render clip');
    res.status(500).json({ error: error.message || 'Failed to render clip' });
  }
});
