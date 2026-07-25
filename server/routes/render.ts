import { Router } from 'express';
import { renderClip } from '../services/render';
import { generateThumbnailFromGrid } from '../services/grid';
import { downloadVideo } from '../services/youtube';
import { downloadXVideo } from '../services/x';
import { progressEmitter } from '../services/progressEmitter';
import { db } from '../db';
import { originalPost, clips as clipsTable } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import * as path from 'path';
import * as fs from 'fs';

export const renderRoute = Router();

function isValidVideoFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 1024 * 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const nullCount = buf.slice(0, bytesRead).filter(b => b === 0).length;
    const nullRatio = nullCount / bytesRead;
    if (nullRatio > 0.1) return false;
    const header = buf.slice(0, bytesRead);
    return header.includes(Buffer.from('mdat')) || header.includes(Buffer.from('moov'));
  } catch {
    return false;
  }
}

/**
 * POST /api/render
 * Body: {
 *   videoId: string,
 *   start: number,
 *   end: number,
 *   outputName?: string,
 *   title?: string,
 *   subtitles?: Array<{start:number,end:number,text:string}>,
 *   jobId?: string,
 *   sourceUrl?: string,   // For non-YouTube videos (e.g. X posts)
 * }
 * Returns: { outputPath: string, clipUrl: string, thumbnailUrl: string, jobId: string }
 */
renderRoute.post('/', async (req, res) => {
  const { videoId, start, end, outputName, title, subtitles, jobId, sourceUrl } = req.body;
  const jid = jobId || `render_${Date.now()}`;

  try {
    if (!videoId || start === undefined || end === undefined) {
      return res.status(400).json({ error: 'videoId, start, and end are required' });
    }

    const videosDir = path.join(process.cwd(), 'videos');
    const clipsDir = path.join(process.cwd(), 'clips');
    const thumbsDir = path.join(process.cwd(), 'clips', 'thumbnails', videoId);

    // Ensure directories exist
    if (!fs.existsSync(clipsDir)) {
      fs.mkdirSync(clipsDir, { recursive: true });
    }
    if (!fs.existsSync(thumbsDir)) {
      fs.mkdirSync(thumbsDir, { recursive: true });
    }

    // Step 0: Ensure video is downloaded
    const videoPath = path.join(videosDir, `${videoId}.mp4`);
    let needDownload = true;
    if (fs.existsSync(videoPath) && isValidVideoFile(videoPath)) {
      needDownload = false;
    }

    if (needDownload) {
      progressEmitter.emitProgress(jid, 'downloading', 5, 'Downloading video...');

      if (sourceUrl) {
        // Non-YouTube source (e.g. X post video)
        await downloadXVideo(videoId, sourceUrl);
      } else {
        // YouTube source
        await downloadVideo(videoId);
      }
      progressEmitter.emitProgress(jid, 'downloading', 25, 'Video downloaded');
    } else {
      progressEmitter.emitProgress(jid, 'downloading', 25, 'Video already cached');
    }

    // Step 1: Render the clip
    progressEmitter.emitProgress(jid, 'rendering', 30, 'Extracting clip...');
    const outputPath = await renderClip(videoId, start, end, outputName, title, subtitles);

    progressEmitter.emitProgress(jid, 'rendering', 70, 'Clip rendered');

    // Step 2: Generate thumbnail from grid
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

    const thumbnailUrl = `/api/clips/thumbnails/${videoId}/${thumbFileName}`;
    const clipFileName = path.basename(outputPath);
    const clipUrl = `/api/clips/${clipFileName}`;

    // Save clip metadata to database
    // Find post by videoId (YouTube format: https://www.youtube.com/watch?v={videoId})
    // or by post URL if sourceUrl is an X post
    let post = await db.query.originalPost.findFirst({
      where: (p, { eq, or }) => or(
        eq(p.postUrl, `https://www.youtube.com/watch?v=${videoId}`),
        sourceUrl ? eq(p.postUrl, sourceUrl) : undefined
      ),
    });

    // Also try matching by postUrl that contains the videoId (for X posts with composite IDs)
    if (!post) {
      const allPosts = await db.query.originalPost.findMany({
        where: (p, { eq }) => eq(p.platform, 'x'),
      });
      // Find a post whose URL contains the postId part of videoId (e.g. postId_v0 → postId)
      const postIdPrefix = videoId.split('_')[0];
      const matchedPost = allPosts.find(p => p.postUrl.includes(postIdPrefix));
      if (matchedPost) {
        post = matchedPost;
      }
    }

    if (post) {
      const durationSec = end - start;
      const mins = Math.floor(durationSec / 60);
      const secs = Math.floor(durationSec % 60);
      const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;

      // Check if the exact same clip already exists to avoid duplicates
      const existingClip = await db.query.clips.findFirst({
        where: (c, { eq, and }) => and(
          eq(c.originalPostId, post.id),
          eq(c.startTime, start),
          eq(c.endTime, end)
        ),
      });

      if (!existingClip) {
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
    }

    res.json({ outputPath, clipUrl, thumbnailUrl, jobId: jid });
  } catch (error: any) {
    console.error('Render error:', error);
    progressEmitter.emitProgress(jid, 'error', 0, error.message || 'Failed to render clip');
    res.status(500).json({ error: error.message || 'Failed to render clip' });
  }
});