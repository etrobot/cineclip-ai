import { Router } from "express";
import { db } from "../db";

export const galleryRoute = Router();

function buildGalleryResponse(posts: any[]) {
  const sortedPosts = [...posts].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  });

  return sortedPosts.map((post) => ({
    videoId: post.author?.platformId || String(post.id),
    title: post.title || "Untitled",
    thumbnailUrl: post.coverImageUrl || "",
    clips: [...(post.clips ?? [])]
      .sort((a: any, b: any) => {
        const aStart = a.startTime ?? 0;
        const bStart = b.startTime ?? 0;
        if (aStart !== bStart) return aStart - bStart;
        return (a.id ?? 0) - (b.id ?? 0);
      })
      .map((clip: any) => ({
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
        shots: [...(clip.shots ?? [])]
          .sort((a: any, b: any) => (a.idx ?? 0) - (b.idx ?? 0))
          .map((shot: any) => ({
            idx: shot.idx,
            clipUrl: shot.clipUrl,
            thumbnailUrl: shot.thumbnailUrl,
            size: shot.size,
            label: shot.label,
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
