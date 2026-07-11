import { Router } from 'express';
import { extractVideoId } from '../utils/youtube';
import { getVideoWithSubtitles } from '../services/youtube';

export const testRoute = Router();

/**
 * POST /api/test/subtitles
 * Test subtitle extraction without LLM
 */
testRoute.post('/subtitles', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const videoData = await getVideoWithSubtitles(videoId);
    if (!videoData) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Return mock clips based on subtitle segments
    const mockClips = videoData.subtitles.slice(0, 3).map((seg, i) => ({
      start: seg.start,
      end: seg.end + 10, // Add 10 seconds
      title: `Clip ${i + 1}: ${seg.text.slice(0, 30)}...`,
      description: `Mock clip from ${seg.text}`,
    }));

    res.json({
      videoId: videoData.videoId,
      title: videoData.title,
      duration: videoData.duration,
      thumbnail: videoData.thumbnail,
      subtitleCount: videoData.subtitles.length,
      clips: mockClips,
    });
  } catch (error: any) {
    console.error('Test error:', error);
    res.status(500).json({ error: error.message || 'Test failed' });
  }
});
