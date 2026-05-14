import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { extractVideoId } from '../utils/youtube';
import { getVideoWithSubtitles, downloadVideo } from '../services/youtube';
import { analyzeClips } from '../services/llm';
import { progressEmitter } from '../services/progressEmitter';

export const analyzeVideoRoute = Router();

/**
 * POST /api/analyze
 * Body: { url: string, jobId?: string }
 * Returns: { videoId, title, clips, jobId }
 *
 * Pipeline stages:
 *   1. Getting Subtitles (0-30%)
 *   2. Analyzing         (30-70%)
 *   3. Splitting         (70-100%)  — clip results finalized, video download triggered
 */
analyzeVideoRoute.post('/', async (req, res) => {
  const { url, jobId } = req.body;
  const jid = jobId || `job_${Date.now()}`;

  try {
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // ── Stage 1: Getting Subtitles (0% → 30%) ──────────────────────
    progressEmitter.emitProgress(jid, 'subtitles', 5, 'Extracting video ID...');
    const videoId = extractVideoId(url);
    if (!videoId) {
      progressEmitter.emitProgress(jid, 'error', 0, 'Invalid YouTube URL');
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    progressEmitter.emitProgress(jid, 'subtitles', 10, 'Fetching subtitles...');
    const videoData = await getVideoWithSubtitles(videoId);
    if (!videoData) {
      progressEmitter.emitProgress(jid, 'error', 0, 'Video not found or no subtitles');
      return res.status(404).json({ error: 'Video not found or no subtitles available' });
    }

    progressEmitter.emitProgress(jid, 'subtitles', 30, 'Subtitles fetched');

    // ── Stage 2: Analyzing (30% → 70%) ─────────────────────────────
    progressEmitter.emitProgress(jid, 'analyzing', 35, 'AI analyzing content...');
    const clips = await analyzeClips(videoData.subtitles, videoData.title);

    progressEmitter.emitProgress(jid, 'analyzing', 70, 'Analysis complete');

    // ── Stage 3: Splitting (70% → 100%) ─────────────────────────────
    progressEmitter.emitProgress(jid, 'splitting', 75, 'Generating clip tasks...');

    // Trigger video download in background (non-blocking) so it's ready when render is requested
    const videosDir = path.join(process.cwd(), 'videos');
    const videoPath = path.join(videosDir, `${videoId}.mp4`);
    if (!fs.existsSync(videoPath)) {
      // Fire-and-forget download — don't block the response
      downloadVideo(videoId).then(() => {
        console.log(`Background download complete: ${videoId}`);
      }).catch((err: any) => {
        console.warn(`Background download failed for ${videoId}:`, err.message);
      });
    }

    progressEmitter.emitProgress(jid, 'splitting', 90, `${clips.length} clips ready`);
    progressEmitter.emitProgress(jid, 'complete', 100, 'Done');

    res.json({
      videoId: videoData.videoId,
      title: videoData.title,
      duration: videoData.duration,
      thumbnail: videoData.thumbnail,
      clips,
      subtitles: videoData.subtitles, // Full subtitle data for frontend to slice per clip
      jobId: jid,
    });
  } catch (error: any) {
    console.error('Analysis error:', error);
    progressEmitter.emitProgress(jid, 'error', 0, error.message || 'Failed to analyze video');
    res.status(500).json({ error: error.message || 'Failed to analyze video' });
  }
});
