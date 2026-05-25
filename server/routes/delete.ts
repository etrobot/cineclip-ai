import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { clips, shots } from '../db/schema';

export const deleteRoute = Router();

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
