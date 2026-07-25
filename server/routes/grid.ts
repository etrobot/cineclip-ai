import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { generateVideoGrid } from '../services/grid';

export const gridRoute = Router();

/**
 * POST /api/grid
 * Body: {
 *   clipUrl: string,      // e.g. "/api/clips/c4sRc5NhFjw_10_30.mp4"
 *   fps?: number,         // sampling FPS (default: 2.0)
 *   diffThreshold?: number, // scene change threshold (default: 0.15)
 *   maxGridSize?: number,   // max grid dimension (default: 2000)
 * }
 * Returns: { gridUrl: string }
 */
gridRoute.post('/', async (req, res) => {
  const { clipUrl, fps, diffThreshold, maxGridSize } = req.body;

  try {
    if (!clipUrl) {
      return res.status(400).json({ error: 'clipUrl is required' });
    }

    // Resolve the clip file path from the URL
    // clipUrl format: "/api/clips/c4sRc5NhFjw_10_30.mp4"
    const clipFileName = clipUrl.replace('/api/clips/', '');
    const clipPath = path.join(process.cwd(), 'clips', clipFileName);

    if (!fs.existsSync(clipPath)) {
      return res.status(404).json({ error: `Clip file not found: ${clipFileName}` });
    }

    // Extract videoId from clip filename: "{videoId}_{start}_{end}.mp4" → videoId
    const baseName = path.parse(clipFileName).name;
    const videoId = baseName.replace(/_[-\dp]+$/, '');
    const gridFileName = `${baseName}_grid.jpg`;
    const gridPath = path.join(process.cwd(), 'clips', 'thumbnails', videoId, gridFileName);

    if (fs.existsSync(gridPath)) {
      const gridUrl = `/api/clips/thumbnails/${videoId}/${gridFileName}`;
      return res.json({ gridUrl });
    }

    // Generate grid using TypeScript service (ffmpeg + sharp)
    await generateVideoGrid(clipPath, {
      maxGridSize,
    });

    const gridUrl = `/api/clips/thumbnails/${videoId}/${gridFileName}`;
    console.log(`Grid generated: ${gridUrl}`);
    res.json({ gridUrl });
  } catch (error: any) {
    console.error('Grid generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate grid' });
  }
});