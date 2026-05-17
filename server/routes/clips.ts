import { Router } from "express";
import { db } from "../db";

export const clipsRoute = Router();

/**
 * GET /api/clips/list
 * Returns all clips from SQLite database.
 */
clipsRoute.get("/list", async (_req, res) => {
  try {
    const posts = await db.query.originalPost.findMany({
      with: {
        author: true,
        clips: {
          with: {
            shots: true,
          },
        },
      },
    });

    const flatClips: {
      id: string;
      videoId: string;
      fileName: string;
      clipUrl: string;
      thumbnailUrl: string | null;
      start: number;
      end: number;
      duration: string;
      title: string;
      size: number;
    }[] = [];

    for (const post of posts) {
      const videoId = post.author?.platformId || String(post.id);
      for (const clip of post.clips) {
        flatClips.push({
          id: String(clip.id),
          videoId,
          fileName: clip.fileName,
          clipUrl: clip.clipUrl,
          thumbnailUrl: clip.thumbnailUrl,
          start: clip.startTime || 0,
          end: clip.endTime || 0,
          duration: clip.duration || "0:00",
          title: clip.title || clip.fileName,
          size: clip.size || 0,
        });
      }
    }

    // Group by videoId
    const grouped = new Map<string, { videoId: string; clips: typeof flatClips }>();
    for (const clip of flatClips) {
      if (!grouped.has(clip.videoId)) {
        grouped.set(clip.videoId, { videoId: clip.videoId, clips: [] });
      }
      grouped.get(clip.videoId)!.clips.push(clip);
    }

    res.json({
      clips: flatClips,
      groups: Array.from(grouped.values()),
    });
  } catch (error: any) {
    console.error("List clips error:", error);
    res.status(500).json({ error: error.message || "Failed to list clips" });
  }
});