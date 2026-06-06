import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { clips, shots, author, originalPost } from '../db/schema';

export const deleteRoute = Router();

/**
 * POST /api/delete/video/:videoId
 * Deletes ALL clips and shots for a given video (identified by platformId / videoId).
 * Removes: shot files, clip files, thumbnails, and all DB records.
 */
deleteRoute.post('/video/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  const clipsDir = path.join(process.cwd(), 'clips');
  const thumbsDir = path.join(clipsDir, 'thumbnails');
  const shotsDir = path.join(clipsDir, 'shots');
  const shotThumbsDir = path.join(shotsDir, 'thumbnails');
  const deletedFiles: string[] = [];

  // 1. Find the author by platformId
  const authorRecord = await db.query.author.findFirst({
    where: (a, { eq }) => eq(a.platformId, videoId),
    with: {
      originalPosts: {
        with: {
          clips: {
            with: { shots: true },
          },
        },
      },
    },
  });

  if (!authorRecord) {
    return res.json({ success: true, deletedFiles: [], message: 'No records found for this video' });
  }

  // 2. Collect all clipIds (DB numeric IDs) and sourceClipIds for file cleanup
  const clipDbIds: number[] = [];
  const sourceClipIds: string[] = [];

  for (const post of authorRecord.originalPosts) {
    for (const clip of post.clips) {
      clipDbIds.push(clip.id);
      sourceClipIds.push(clip.clipUrl.replace('/api/clips/', '').replace('.mp4', ''));

      // Delete clip video file
      const clipFileName = path.basename(clip.clipUrl);
      const clipFilePath = path.join(clipsDir, clipFileName);
      if (fs.existsSync(clipFilePath)) {
        fs.unlinkSync(clipFilePath);
        deletedFiles.push(clipFilePath);
      }

      // Delete clip thumbnail
      if (clip.thumbnailUrl) {
        const thumbFileName = path.basename(clip.thumbnailUrl);
        const thumbFilePath = path.join(thumbsDir, thumbFileName);
        if (fs.existsSync(thumbFilePath)) {
          fs.unlinkSync(thumbFilePath);
          deletedFiles.push(thumbFilePath);
        }
      }

      // Delete shot files and their thumbnails
      for (const shot of clip.shots) {
        if (shot.clipUrl) {
          const shotFileName = path.basename(shot.clipUrl);
          const shotFilePath = path.join(shotsDir, shotFileName);
          if (fs.existsSync(shotFilePath)) {
            fs.unlinkSync(shotFilePath);
            deletedFiles.push(shotFilePath);
          }
        }
        if (shot.thumbnailUrl) {
          const shotThumbFileName = path.basename(shot.thumbnailUrl);
          const shotThumbFilePath = path.join(shotThumbsDir, shotThumbFileName);
          if (fs.existsSync(shotThumbFilePath)) {
            fs.unlinkSync(shotThumbFilePath);
            deletedFiles.push(shotThumbFilePath);
          }
        }
      }
    }
  }

  // Also scan filesystem for shot files that might not have DB records
  for (const sourceClipId of sourceClipIds) {
    if (fs.existsSync(shotsDir)) {
      const shotFiles = fs.readdirSync(shotsDir).filter(
        (f) => f.startsWith(`${sourceClipId}_shot_`) && f.endsWith('.mp4')
      );
      for (const f of shotFiles) {
        const filePath = path.join(shotsDir, f);
        if (fs.existsSync(filePath) && !deletedFiles.includes(filePath)) {
          fs.unlinkSync(filePath);
          deletedFiles.push(filePath);
        }
        const thumbName = f.replace('.mp4', '.jpg');
        const thumbPath = path.join(shotThumbsDir, thumbName);
        if (fs.existsSync(thumbPath) && !deletedFiles.includes(thumbPath)) {
          fs.unlinkSync(thumbPath);
          deletedFiles.push(thumbPath);
        }
      }
    }

    // Delete grid image
    const gridPath = path.join(shotsDir, `${sourceClipId}_grid.jpg`);
    if (fs.existsSync(gridPath)) {
      fs.unlinkSync(gridPath);
      deletedFiles.push(gridPath);
    }
  }

  // 3. Delete DB records (order: shots → clips → posts → author)
  if (clipDbIds.length > 0) {
    await db.delete(shots).where(inArray(shots.clipId, clipDbIds));
    await db.delete(clips).where(inArray(clips.id, clipDbIds));
  }

  // Delete original posts for this author
  const postIds = authorRecord.originalPosts.map((p) => p.id);
  if (postIds.length > 0) {
    await db.delete(originalPost).where(inArray(originalPost.id, postIds));
  }
  await db.delete(author).where(eq(author.id, authorRecord.id));

  console.log(`[DeleteVideo] videoId=${videoId}: deleted ${deletedFiles.length} files, ${clipDbIds.length} clips from DB`);

  res.json({
    success: true,
    deletedFiles,
    deletedClipCount: clipDbIds.length,
  });
});

/**
 * POST /api/delete
 * Body: { clipUrl: string, thumbnailUrl?: string }
 * Deletes the clip video file, thumbnail, and DB record
 */
deleteRoute.post('/', async (req, res) => {
  const { clipUrl, thumbnailUrl } = req.body;

  try {
    if (!clipUrl) {
      return res.status(400).json({ error: 'clipUrl is required' });
    }

    const clipsDir = path.join(process.cwd(), 'clips');
    const thumbsDir = path.join(clipsDir, 'thumbnails');
    const deleted: string[] = [];

    // Resolve clip file path from clipUrl (e.g. /api/clips/filename.mp4)
    const clipFileName = path.basename(clipUrl);
    const clipFilePath = path.join(clipsDir, clipFileName);

    if (fs.existsSync(clipFilePath)) {
      fs.unlinkSync(clipFilePath);
      deleted.push(clipFilePath);
    }

    // Resolve thumbnail file path if provided
    if (thumbnailUrl) {
      const thumbFileName = path.basename(thumbnailUrl);
      const thumbFilePath = path.join(thumbsDir, thumbFileName);
      if (fs.existsSync(thumbFilePath)) {
        fs.unlinkSync(thumbFilePath);
        deleted.push(thumbFilePath);
      }
    }

    // Delete ALL associated DB records (handle duplicates)
    const allClipRecords = await db.query.clips.findMany({
      where: (c, { eq }) => eq(c.clipUrl, clipUrl),
    });
    for (const clipRecord of allClipRecords) {
      await db.delete(shots).where(eq(shots.clipId, clipRecord.id));
      await db.delete(clips).where(eq(clips.id, clipRecord.id));
    }

    // Also clear any shot rows that were stored before a clip record existed.
    const sourceClipId = path.parse(clipFileName).name;
    await db.delete(shots).where(eq(shots.sourceClipId, sourceClipId));

    // Delete associated shot video files and their thumbnails
    const shotsDir = path.join(clipsDir, 'shots');
    const shotsThumbsDir = path.join(shotsDir, 'thumbnails');

    if (fs.existsSync(shotsDir)) {
      const shotFiles = fs.readdirSync(shotsDir).filter(
        (f) => f.startsWith(`${sourceClipId}_shot_`) && f.endsWith('.mp4')
      );
      for (const f of shotFiles) {
        const shotPath = path.join(shotsDir, f);
        if (fs.existsSync(shotPath)) {
          fs.unlinkSync(shotPath);
          deleted.push(shotPath);
        }
        // Delete corresponding shot thumbnail
        const thumbName = f.replace('.mp4', '.jpg');
        const thumbPath = path.join(shotsThumbsDir, thumbName);
        if (fs.existsSync(thumbPath)) {
          fs.unlinkSync(thumbPath);
          deleted.push(thumbPath);
        }
      }
    }

    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete clip' });
  }
});
