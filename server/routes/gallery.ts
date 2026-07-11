import { Router } from "express";
import * as path from "path";
import * as fs from "fs";
import { db } from "../db";
import { clips, shots, author, originalPost } from "../db/schema";

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
    postUrl: post.postUrl || "",
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

/**
 * POST /api/gallery/clear
 * Clears all clips, shots, posts, authors from the database,
 * and deletes all local clip/thumbnail/shot video files.
 */
galleryRoute.post("/clear", async (_req, res) => {
  // 1. Delete all DB records (order matters due to foreign keys: shots → clips → posts → authors)
  await db.delete(shots);
  await db.delete(clips);
  await db.delete(originalPost);
  await db.delete(author);

  // 2. Delete all local video/thumbnail/shot files under clips/
  const clipsDir = path.join(process.cwd(), "clips");
  const deletedFiles: string[] = [];

  const dirsToClean = [
    clipsDir,
    path.join(clipsDir, "thumbnails"),
    path.join(clipsDir, "shots"),
    path.join(clipsDir, "shots", "thumbnails"),
  ];

  for (const dir of dirsToClean) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        // Only delete media files, skip directories and hidden files
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isFile() && !file.startsWith(".")) {
          fs.unlinkSync(filePath);
          deletedFiles.push(filePath);
        }
      }
    }
  }

  console.log("[Gallery] Clear: deleted", deletedFiles.length, "files, cleared all DB records");

  res.json({
    success: true,
    deletedFiles: deletedFiles.length,
    updatedAt: new Date().toISOString(),
    groups: [],
  });
});
