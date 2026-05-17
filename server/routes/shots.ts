import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { segmentShots } from '../services/shotSegmentation';
import { progressEmitter } from '../services/progressEmitter';

export const shotsRoute = Router();

/**
 * POST /api/shots
 * Body: {
 *   clipUrl: string,    // e.g. "/api/clips/eV3lAY77IpU_0p6_130p1.mp4"
 *   clipId: string,     // e.g. "eV3lAY77IpU_0p6_130p1"
 *   subtitles?: Array<{start:number,end:number,text:string}>,
 *   videoTitle?: string,
 *   videoDescription?: string,
 *   jobId?: string
 * }
 * Returns: { shots: ShotInfo[], jobId: string }
 *
 * Pipeline stages:
 *   1. Extracting frames (0-30%)
 *   2. Analyzing with VL (30-80%)
 *   3. Cutting shots (80-100%)
 */
shotsRoute.post('/', async (req, res) => {
  const { clipUrl, clipId, subtitles, videoTitle, videoDescription, jobId } = req.body;
  const jid = jobId || `shots_${Date.now()}`;

  try {
    if (!clipUrl || !clipId) {
      return res.status(400).json({ error: 'clipUrl and clipId are required' });
    }

    // Resolve clip file path from URL
    const clipFileName = clipUrl.replace('/api/clips/', '');
    const clipPath = path.join(process.cwd(), 'clips', clipFileName);

    if (!fs.existsSync(clipPath)) {
      return res.status(404).json({ error: `Clip file not found: ${clipFileName}` });
    }

    progressEmitter.emitProgress(jid, 'extracting', 5, 'Extracting sampling frames...');

    // Adjust subtitle timestamps to be relative to clip start
    // We need to know the clip's absolute start time from the filename
    let relativeSubtitles: Array<{ start: number; end: number; text: string }> | undefined;
    let fullSubtitles: Array<{ start: number; end: number; text: string }> = [];
    if (subtitles && Array.isArray(subtitles)) {
      fullSubtitles = subtitles;
      // Parse clip start time from filename pattern: videoId_START_END.mp4
      // e.g. "eV3lAY77IpU_0p6_130p1.mp4" -> start=0.6
      const baseName = path.parse(clipFileName).name;
      const parts = baseName.split('_');
      let clipStartTime = 0;
      if (parts.length >= 3) {
        const videoId = parts[0];
        const timePart = baseName.slice(videoId.length + 1);
        const timeParts = timePart.split('_');
        if (timeParts.length >= 2) {
          clipStartTime = parseFloat(timeParts[0].replace(/p/g, '.')) || 0;
        }
      }

      // Convert absolute subtitle timestamps to relative ones
      relativeSubtitles = subtitles
        .filter(s => s.end > clipStartTime)
        .map(s => ({
          start: Math.max(0, s.start - clipStartTime),
          end: s.end - clipStartTime,
          text: s.text,
        }));
    }

    progressEmitter.emitProgress(jid, 'analyzing', 35, 'Analyzing with vision model...');

    // Build video context if title/description are provided
    const videoCtx = videoTitle
      ? { videoTitle, videoDescription: videoDescription || '', subtitles: fullSubtitles }
      : undefined;

    // Run segmentation
    const shots = await segmentShots(clipPath, clipId, relativeSubtitles, videoCtx);

    progressEmitter.emitProgress(jid, 'complete', 100, `${shots.length} shots detected`);

    res.json({ shots, jobId: jid });
  } catch (error: any) {
    console.error('Shot segmentation error:', error);
    const message = error?.message || 'Failed to segment shots';
    progressEmitter.emitProgress(jid, 'error', 0, message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/shots/:clipId
 * List shots for a given clipId (reads from filesystem)
 */
shotsRoute.get('/:clipId', async (req, res) => {
  const { clipId } = req.params;
  const shotsDir = path.join(process.cwd(), 'clips', 'shots');

  try {
    if (!fs.existsSync(shotsDir)) {
      return res.json({ shots: [] });
    }

    const files = fs.readdirSync(shotsDir).filter(f =>
      f.startsWith(`${clipId}_shot_`) && f.endsWith('.mp4')
    );

    const shots = files.map(fileName => {
      const idxMatch = fileName.match(/_shot_(\d+)\.mp4$/);
      const idx = idxMatch ? parseInt(idxMatch[1]) : 0;
      const thumbName = fileName.replace('.mp4', '.jpg');
      const thumbPath = path.join(shotsDir, 'thumbnails', thumbName);
      const filePath = path.join(shotsDir, fileName);
      const stat = fs.statSync(filePath);

      // Parse shot boundaries from filename if available
      // The cutShots function produces files like clipId_shot_0.mp4
      // Without exact timestamps in filename, we can't know duration from filename alone
      // Use ffprobe to get duration if needed, but for now keep it simple

      return {
        idx,
        clipUrl: `/api/clips/shots/${fileName}`,
        thumbnailUrl: fs.existsSync(thumbPath) ? `/api/clips/shots/thumbnails/${thumbName}` : null,
        size: stat.size,
        label: `Shot ${idx + 1}`,
        duration: '', // Will be populated by segmentShots response which has precise timing
      };
    }).sort((a, b) => a.idx - b.idx);

    res.json({ shots });
  } catch (error: any) {
    console.error('List shots error:', error);
    res.status(500).json({ error: error.message || 'Failed to list shots' });
  }
});