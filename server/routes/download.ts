import { Router } from 'express';
import { downloadVideo } from '../services/youtube';

export const downloadRoute = Router();

/**
 * POST /api/download
 * Body: { videoId: string }
 * Returns: { videoPath: string }
 */
downloadRoute.post('/', async (req, res) => {
  try {
    const { videoId } = req.body;

    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    const videoPath = await downloadVideo(videoId);

    res.json({ videoPath });
  } catch (error: any) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message || 'Failed to download video' });
  }
});
