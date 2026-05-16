import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { refreshClipsJson } from './gallery';

export const deleteRoute = Router();

/**
 * POST /api/delete
 * Body: { clipUrl: string, thumbnailUrl?: string }
 * Deletes the clip video file and optionally its thumbnail
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

    // Update clips.json after deletion
    setImmediate(() => refreshClipsJson());

    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete clip' });
  }
});
