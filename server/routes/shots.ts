import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { asc, eq, or, like, sql } from 'drizzle-orm';
import { segmentShots } from '../services/shotSegmentation';
import { progressEmitter } from '../services/progressEmitter';
import { db } from '../db';
import { shots as shotsTable, clips as clipsTable } from '../db/schema';

export const shotsRoute = Router();

/**
 * GET /api/shots/search?q=keyword
 * Search shots by label or category, grouped by sourceClipId with clip info
 */
shotsRoute.get('/search', async (req, res) => {
  const q = req.query.q as string;
  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Search query parameter "q" is required' });
  }

  const keyword = `%${q.trim()}%`;

  const rows = await db
    .select({
      id: shotsTable.id,
      sourceClipId: shotsTable.sourceClipId,
      idx: shotsTable.idx,
      label: shotsTable.label,
      category: shotsTable.category,
      start: shotsTable.start,
      end: shotsTable.end,
      duration: shotsTable.duration,
      clipUrl: shotsTable.clipUrl,
      thumbnailUrl: shotsTable.thumbnailUrl,
      size: shotsTable.size,
      // clip fields via JOIN
      clipFileName: clipsTable.fileName,
      clipClipUrl: clipsTable.clipUrl,
      clipThumbnailUrl: clipsTable.thumbnailUrl,
      clipTitle: clipsTable.title,
      clipStartTime: clipsTable.startTime,
      clipEndTime: clipsTable.endTime,
      clipDuration: clipsTable.duration,
    })
    .from(shotsTable)
    .leftJoin(clipsTable, eq(shotsTable.clipId, clipsTable.id))
    .where(or(
      like(shotsTable.label, keyword),
      like(shotsTable.category, keyword),
    ))
    .orderBy(asc(shotsTable.sourceClipId), asc(shotsTable.idx));

  // Group by sourceClipId
  const groups: Record<string, {
    sourceClipId: string;
    clip: {
      fileName: string | null;
      clipUrl: string | null;
      thumbnailUrl: string | null;
      title: string | null;
      startTime: number | null;
      endTime: number | null;
      duration: string | null;
    };
    shots: Array<{
      id: number;
      idx: number;
      label: string | null;
      category: string | null;
      start: number | null;
      end: number | null;
      duration: string | null;
      clipUrl: string | null;
      thumbnailUrl: string | null;
      size: number | null;
    }>;
  }> = {};

  for (const row of rows) {
    const key = row.sourceClipId || `unknown_${row.id}`;
    if (!groups[key]) {
      groups[key] = {
        sourceClipId: key,
        clip: {
          fileName: row.clipFileName,
          clipUrl: row.clipClipUrl,
          thumbnailUrl: row.clipThumbnailUrl,
          title: row.clipTitle,
          startTime: row.clipStartTime,
          endTime: row.clipEndTime,
          duration: row.clipDuration,
        },
        shots: [],
      };
    }
    groups[key].shots.push({
      id: row.id,
      idx: row.idx,
      label: row.label,
      category: row.category,
      start: row.start,
      end: row.end,
      duration: row.duration,
      clipUrl: row.clipUrl,
      thumbnailUrl: row.thumbnailUrl,
      size: row.size,
    });
  }

  res.json({ query: q, results: Object.values(groups) });
});

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

    // ── Retrieve clip record for DB cleanup ───────────────────────────
    const clipRecord = await db.query.clips.findFirst({
      where: (c, { eq }) => eq(c.clipUrl, clipUrl),
    });

    // ── Clear old shots BEFORE re-segmentation ────────────────────────
    // NOTE: Must delete old files BEFORE segmentShots() generates new ones,
    // or the cleanup will delete freshly created files.
    const shotsDir = path.join(process.cwd(), 'clips', 'shots');
    const thumbsDir = path.join(shotsDir, 'thumbnails');

    // Delete old shot files on disk for this clipId
    if (fs.existsSync(shotsDir)) {
      const oldFiles = fs.readdirSync(shotsDir).filter(f => f.startsWith(`${clipId}_shot_`) && f.endsWith('.mp4'));
      for (const f of oldFiles) {
        try {
          fs.unlinkSync(path.join(shotsDir, f));
          const thumbName = f.replace('.mp4', '.jpg');
          const thumbPath = path.join(thumbsDir, thumbName);
          if (fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
          }
        } catch (err) {
          console.warn(`Failed to delete old shot file: ${f}`, err);
        }
      }
    }

    // Delete old shot records from DB
    const deleteConditions = [eq(shotsTable.sourceClipId, clipId)];
    if (clipRecord) {
      deleteConditions.push(eq(shotsTable.clipId, clipRecord.id));
    }
    await db.delete(shotsTable).where(
      deleteConditions.length === 1
        ? deleteConditions[0]
        : or(...deleteConditions)
    );

    progressEmitter.emitProgress(jid, 'extracting', 5, 'Extracting sampling frames...');

    // Adjust subtitle timestamps to be relative to clip start
    let relativeSubtitles: Array<{ start: number; end: number; text: string }> | undefined;
    let fullSubtitles: Array<{ start: number; end: number; text: string }> = [];
    if (subtitles && Array.isArray(subtitles)) {
      fullSubtitles = subtitles;
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
    const { shots: shotSegments, gridUrl } = await segmentShots(clipPath, clipId, relativeSubtitles, videoCtx);

    const shotRows = shotSegments.map((shot, idx) => {
      const shotFileName = `${clipId}_shot_${idx}.mp4`;
      const shotFilePath = path.join(process.cwd(), 'clips', 'shots', shotFileName);
      const thumbnailUrl = shot.thumbnailUrl || `/api/clips/shots/thumbnails/${clipId}_shot_${idx}.jpg`;
      return {
        clipId: clipRecord?.id ?? null,
        sourceClipId: clipId,
        idx,
        label: shot.label,
        category: shot.category,
        start: shot.start,
        end: shot.end,
        duration: shot.duration,
        clipUrl: shot.clipUrl,
        thumbnailUrl,
        size: fs.existsSync(shotFilePath) ? fs.statSync(shotFilePath).size : 0,
      };
    });

    if (shotRows.length > 0) {
      await db.insert(shotsTable).values(shotRows);
    }

    progressEmitter.emitProgress(jid, 'complete', 100, `${shotSegments.length} shots detected`);

    res.json({ shots: shotSegments, gridUrl, jobId: jid });
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
    const bySourceId = await db.select({
      idx: shotsTable.idx,
      clipUrl: shotsTable.clipUrl,
      thumbnailUrl: shotsTable.thumbnailUrl,
      size: shotsTable.size,
      label: shotsTable.label,
    }).from(shotsTable).where(eq(shotsTable.sourceClipId, clipId)).orderBy(asc(shotsTable.idx));

    if (bySourceId.length > 0) {
      return res.json({
        shots: bySourceId.map((shot, i) => ({
          idx: shot.idx,
          clipUrl: shot.clipUrl || `/api/clips/shots/${clipId}_shot_${i}.mp4`,
          thumbnailUrl: shot.thumbnailUrl,
          size: shot.size || 0,
          label: shot.label || `Shot ${shot.idx + 1}`,
          duration: '',
        })),
      });
    }

    const clipIdNum = Number(clipId);
    if (Number.isFinite(clipIdNum)) {
      const byDbClipId = await db.select({
        idx: shotsTable.idx,
        clipUrl: shotsTable.clipUrl,
        thumbnailUrl: shotsTable.thumbnailUrl,
        size: shotsTable.size,
        label: shotsTable.label,
      }).from(shotsTable).where(eq(shotsTable.clipId, clipIdNum)).orderBy(asc(shotsTable.idx));

      if (byDbClipId.length > 0) {
        return res.json({
          shots: byDbClipId.map((shot) => ({
            idx: shot.idx,
            clipUrl: shot.clipUrl || '',
            thumbnailUrl: shot.thumbnailUrl,
            size: shot.size || 0,
            label: shot.label || `Shot ${shot.idx + 1}`,
            duration: '',
          })),
        });
      }
    }

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
