import { Router } from 'express';
import { generateStoryboard } from '../services/storyboard';

export const storyboardRoute = Router();

/**
 * POST /api/storyboard
 * Body: { videoId: string }
 *
 * Generates a storyboard (分镜表) by sending the video's complete subtitles
 * and all extracted shot descriptions to the LLM.
 *
 * Returns:
 *   200: { summary, storyboard, videoTitle, totalShots, totalClips }
 *   400: { error: "Please detect shots first..." } — when clips have no shots
 *   404: { error: "Video not found" }
 *   500: { error: "Internal error" }
 */
storyboardRoute.post('/', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'videoId is required' });
  }

  try {
    const result = await generateStoryboard(videoId);
    res.json(result);
  } catch (error: any) {
    const message = error?.message || 'Failed to generate storyboard';

    // Distinguish "no shots" errors (client should prompt user to detect shots)
    if (message.includes('Detect shots') || message.includes('检测镜头') || message.includes('缺少镜头')) {
      console.warn(`[Storyboard] ${message}`);
      return res.status(400).json({ error: message });
    }

    if (message.includes('No video found')) {
      return res.status(404).json({ error: message });
    }

    console.error('[Storyboard] Error:', error);
    res.status(500).json({ error: message });
  }
});
