import { Router } from 'express';
import { renderClip } from '../services/render';

export const renderRoute = Router();

/**
 * POST /api/render
 * Body: { videoId: string, start: number, end: number, outputName: string }
 * Returns: { outputPath: string }
 */
renderRoute.post('/', async (req, res) => {
  try {
    const { videoId, start, end, outputName } = req.body;

    if (!videoId || start === undefined || end === undefined) {
      return res.status(400).json({ error: 'videoId, start, and end are required' });
    }

    const outputPath = await renderClip(videoId, start, end, outputName);

    res.json({ outputPath });
  } catch (error: any) {
    console.error('Render error:', error);
    res.status(500).json({ error: error.message || 'Failed to render clip' });
  }
});
