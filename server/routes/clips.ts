import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';

export const clipsRoute = Router();

/**
 * GET /api/clips/list
 * Scans the clips directory and returns metadata about all existing clips.
 * Uses the videos/ directory to correctly identify videoIds from filenames.
 */
clipsRoute.get('/list', (_req, res) => {
  try {
    const clipsDir = path.join(process.cwd(), 'clips');
    const thumbsDir = path.join(clipsDir, 'thumbnails');
    const videosDir = path.join(process.cwd(), 'videos');

    if (!fs.existsSync(clipsDir)) {
      return res.json({ clips: [], groups: [] });
    }

    // Build a set of known videoIds from the videos/ directory
    const knownVideoIds = new Set<string>();
    if (fs.existsSync(videosDir)) {
      for (const f of fs.readdirSync(videosDir)) {
        if (f.endsWith('.mp4')) {
          knownVideoIds.add(path.parse(f).name);
        }
      }
    }

    const files = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.mp4'));
    const thumbnails = fs.existsSync(thumbsDir)
      ? fs.readdirSync(thumbsDir).filter((f) => f.endsWith('.jpg'))
      : [];

    // Build a thumbnail lookup map (filename without extension -> thumbnail filename)
    const thumbMap = new Map<string, string>();
    for (const t of thumbnails) {
      const baseName = path.parse(t).name;
      thumbMap.set(baseName, t);
    }

    const clips = files.map((fileName) => {
      const baseName = path.parse(fileName).name;
      const stat = fs.statSync(path.join(clipsDir, fileName));

      // Extract videoId: try matching against known videoIds first
      let videoId = baseName;
      let start = 0;
      let end = 0;

      if (knownVideoIds.size > 0) {
        // Try each known videoId as a prefix of the filename
        for (const vid of knownVideoIds) {
          if (baseName.startsWith(vid + '_')) {
            videoId = vid;
            const timePart = baseName.slice(vid.length + 1); // after "videoId_"
            const timeParts = timePart.split('_');
            if (timeParts.length >= 2) {
              start = parseFloat(timeParts[0].replace(/p/g, '.'));
              end = parseFloat(timeParts[1].replace(/p/g, '.'));
            } else if (timeParts.length === 1) {
              // Single number after videoId (e.g. "cnbc_final_test")
              // Keep start/end as 0
            }
            break;
          }
        }
      } else {
        // Fallback: parse from filename pattern
        const parts = baseName.split('_');
        for (let i = 1; i < parts.length; i++) {
          if (parts[i].includes('p')) {
            videoId = parts.slice(0, i).join('_');
            if (i + 1 < parts.length) {
              start = parseFloat(parts[i].replace(/p/g, '.'));
              end = parseFloat(parts[i + 1].replace(/p/g, '.'));
            }
            break;
          }
        }
      }

      // Check for matching thumbnail
      const thumbnailUrl = thumbMap.has(baseName)
        ? `/api/clips/thumbnails/${thumbMap.get(baseName)}`
        : undefined;

      // Duration
      const durationSec = end - start;
      const mins = Math.floor(durationSec / 60);
      const secs = Math.floor(durationSec % 60);
      const duration = `${mins}:${secs.toString().padStart(2, '0')}`;

      return {
        id: baseName,
        videoId,
        fileName,
        clipUrl: `/api/clips/${fileName}`,
        thumbnailUrl,
        start,
        end,
        duration,
        size: stat.size,
      };
    });

    // Group by videoId
    const grouped = new Map<string, {
      videoId: string;
      clips: typeof clips;
    }>();

    for (const clip of clips) {
      if (!grouped.has(clip.videoId)) {
        grouped.set(clip.videoId, { videoId: clip.videoId, clips: [] });
      }
      grouped.get(clip.videoId)!.clips.push(clip);
    }

    res.json({
      clips,
      groups: Array.from(grouped.values()),
    });
  } catch (error: any) {
    console.error('List clips error:', error);
    res.status(500).json({ error: error.message || 'Failed to list clips' });
  }
});