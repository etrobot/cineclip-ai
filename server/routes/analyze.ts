import { Router } from 'express';
import { extractVideoId } from '../utils/youtube';
import { getVideoWithSubtitles } from '../services/youtube';
import { analyzeClips } from '../services/llm';

export const analyzeVideoRoute = Router();

/**
 * POST /api/analyze
 * Body: { url: string }
 * Returns: { videoId, title, clips: Array<{start, end, title, category}> }
 */
analyzeVideoRoute.post('/', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Get video metadata and subtitles
    const videoData = await getVideoWithSubtitles(videoId);
    if (!videoData) {
      return res.status(404).json({ error: 'Video not found or no subtitles available' });
    }

    // Analyze with LLM to find clips
    const clips = await analyzeClips(videoData.subtitles, videoData.title);

    res.json({
      videoId: videoData.videoId,
      title: videoData.title,
      duration: videoData.duration,
      thumbnail: videoData.thumbnail,
      clips,
    });
  } catch (error: any) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze video' });
  }
});
