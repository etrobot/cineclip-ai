import { Router } from "express";
import { db } from "../db";
import { author } from "../db/schema";
import { eq } from "drizzle-orm";

export const clipsRoute = Router();

/**
 * GET /api/clips/exists/:videoId
 * Checks whether clips already exist for the given videoId (platformId).
 * Returns { exists: boolean, clipCount: number }
 */
clipsRoute.get("/exists/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!videoId) {
      return res.status(400).json({ error: "videoId is required" });
    }

    const authorRecord = await db.query.author.findFirst({
      where: eq(author.platformId, videoId),
      with: {
        originalPosts: {
          with: {
            clips: true,
          },
        },
      },
    });

    if (!authorRecord || authorRecord.originalPosts.length === 0) {
      return res.json({ exists: false, clipCount: 0 });
    }

    const clipCount = authorRecord.originalPosts.reduce(
      (sum, post) => sum + post.clips.length,
      0
    );

    res.json({ exists: clipCount > 0, clipCount });
  } catch (error: any) {
    console.error("Check exists error:", error);
    res.status(500).json({ error: error.message || "Failed to check existence" });
  }
});

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
      postUrl: string;
    }[] = [];

    for (const post of posts) {
      const videoId = post.author?.platformId || String(post.id);
      const sortedClips = [...post.clips].sort((a, b) => {
        const aStart = a.startTime ?? 0;
        const bStart = b.startTime ?? 0;
        if (aStart !== bStart) return aStart - bStart;
        return (a.id ?? 0) - (b.id ?? 0);
      });

      for (const clip of sortedClips) {
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
          postUrl: post.postUrl || "",
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
