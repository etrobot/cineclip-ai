import { Router } from "express";
import { db } from "../db";

export const galleryRoute = Router();

function buildGalleryResponse(posts: any[]) {
  return posts.map((post) => ({
    videoId: post.author?.platformId || String(post.id),
    title: post.title || "Untitled",
    thumbnailUrl: post.coverImageUrl || "",
    clips: post.clips.map((clip: any) => ({
      id: String(clip.id),
      videoId: post.author?.platformId || String(post.id),
      fileName: clip.fileName,
      clipUrl: clip.clipUrl,
      thumbnailUrl: clip.thumbnailUrl,
      start: clip.startTime || 0,
      end: clip.endTime || 0,
      duration: clip.duration || "0:00",
      title: clip.title || clip.fileName,
      size: clip.size || 0,
      shots: clip.shots.map((shot: any) => ({
        idx: shot.idx,
        clipUrl: shot.clipUrl,
        thumbnailUrl: shot.thumbnailUrl,
        size: shot.size,
      })),
    })),
  }));
}

/**
 * GET /api/gallery
 * Returns clips data from SQLite database.
 */
galleryRoute.get("/", async (_req, res) => {
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

    res.json({
      updatedAt: new Date().toISOString(),
      groups: buildGalleryResponse(posts),
    });
  } catch (err: any) {
    console.error("Gallery error:", err);
    res.json({ updatedAt: null, groups: [] });
  }
});

/**
 * POST /api/gallery/refresh
 */
galleryRoute.post("/refresh", async (_req, res) => {
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

  res.json({
    updatedAt: new Date().toISOString(),
    groups: buildGalleryResponse(posts),
  });
});