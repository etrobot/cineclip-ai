import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { extractVideoId } from '../utils/youtube';
import { extractXPostId, isXPostUrl } from '../utils/x';
import { getVideoWithSubtitles, downloadVideo } from '../services/youtube';
import {
  extractXPostVideos,
  extractXSubtitles,
  analyzeXVideoClips,
  planXVideoClips,
  downloadXVideo,
  type XVideoInfo,
} from '../services/x';
import { analyzeClips } from '../services/llm';
import { progressEmitter } from '../services/progressEmitter';
import { db } from '../db';
import { author, originalPost } from '../db/schema';

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

    // ── Stage 1: Platform Detection & Metadata (0% → 30%) ───────────
    progressEmitter.emitProgress(jid, 'subtitles', 5, 'Detecting platform...');

    if (isXPostUrl(url)) {
      // ═══════════════════════════════════════════════════════════════
      // X POST FLOW
      // ═══════════════════════════════════════════════════════════════
      const postId = extractXPostId(url);
      if (!postId) {
        progressEmitter.emitProgress(jid, 'error', 0, 'Invalid X post URL');
        return res.status(400).json({ error: 'Invalid X post URL' });
      }

      progressEmitter.emitProgress(jid, 'subtitles', 10, 'Fetching X post videos...');
      const postResult = await extractXPostVideos(url, postId);

      if (postResult.videos.length === 0) {
        progressEmitter.emitProgress(jid, 'error', 0, 'No videos found in X post');
        return res.status(404).json({ error: 'No videos found in X post' });
      }

      console.log(`[Analyze] X post ${postId} has ${postResult.videos.length} video(s)`);

      // Build clip plans for each video
      const clipPlans = postResult.videos.map(v => planXVideoClips(v));

      // Count how many need analysis
      const needsAnalysisCount = clipPlans.filter(p => p.needsAnalysis).length;
      let analyzedCount = 0;

      // Process each video
      const allClips: Array<{
        start: number;
        end: number;
        title: string;
        videoId: string;
        sourceUrl: string;
      }> = [];
      let allSubtitles: import('../services/youtube').SubtitleSegment[] = [];

      for (const plan of clipPlans) {
        if (plan.needsAnalysis) {
          // Long video: extract subtitles, then LLM analyze
          progressEmitter.emitProgress(
            jid,
            'subtitles',
            15 + Math.floor((analyzedCount / needsAnalysisCount) * 15),
            `Extracting subtitles for video ${plan.video.index + 1}...`
          );

          plan.subtitles = await extractXSubtitles(plan.video.videoId, plan.video.url);
          allSubtitles = allSubtitles.concat(plan.subtitles);

          if (plan.subtitles.length > 0) {
            progressEmitter.emitProgress(
              jid,
              'analyzing',
              35 + Math.floor((analyzedCount / needsAnalysisCount) * 35),
              `AI analyzing video ${plan.video.index + 1}...`
            );

            const analyzed = await analyzeXVideoClips(
              plan.subtitles,
              plan.video.title,
              plan.video.description,
              plan.video.duration
            );
            plan.clips = analyzed;
          } else {
            // No subtitles available for long video — fall back to single clip
            console.warn(`[Analyze] No subtitles for X video ${plan.video.videoId}, using single clip`);
            plan.clips = [{
              start: 0,
              end: plan.video.duration,
              title: plan.video.title || `X Video ${plan.video.index + 1}`,
            }];
          }

          analyzedCount++;
        } else {
          // Short video: already has single clip plan
          progressEmitter.emitProgress(
            jid,
            'subtitles',
            20,
            `Video ${plan.video.index + 1} is short (${plan.video.duration}s), skipping analysis`
          );
        }

        // Add video-specific ID to each clip for rendering
        for (const clip of plan.clips) {
          allClips.push({
            ...clip,
            videoId: plan.video.videoId,
            sourceUrl: plan.video.url,
          });
        }
      }

      progressEmitter.emitProgress(jid, 'analyzing', 70, 'Analysis complete');
      progressEmitter.emitProgress(jid, 'splitting', 75, 'Generating clip tasks...');

      // Trigger downloads in background for all videos
      for (const plan of clipPlans) {
        if (plan.clips.length > 0) {
          const videoPath = path.join(process.cwd(), 'videos', `${plan.video.videoId}.mp4`);
          if (!fs.existsSync(videoPath)) {
            downloadXVideo(plan.video.videoId, plan.video.url)
              .then(() => console.log(`[Analyze] Background download complete: ${plan.video.videoId}`))
              .catch((err: any) => console.warn(`[Analyze] Background download failed: ${plan.video.videoId}`, err.message));
          }
        }
      }

      // Save to database
      let existingAuthor = await db.query.author.findFirst({
        where: (a, { eq }) => eq(a.platformId, postId),
      });

      if (!existingAuthor) {
        [existingAuthor] = await db.insert(author).values({
          platform: 'x',
          platformId: postId,
          name: postResult.authorName,
        }).returning();
      }

      let existingPost = await db.query.originalPost.findFirst({
        where: (p, { eq }) => eq(p.postUrl, url),
      });

      if (!existingPost) {
        [existingPost] = await db.insert(originalPost).values({
          authorId: existingAuthor.id,
          platform: 'x',
          postUrl: url,
          title: postResult.content?.substring(0, 100),
          description: postResult.content,
          subtitlesJson: JSON.stringify(allSubtitles),
          coverImageUrl: postResult.videos[0]?.thumbnail || '',
        }).returning();
      }

      progressEmitter.emitProgress(jid, 'splitting', 90, `${allClips.length} clips ready`);
      progressEmitter.emitProgress(jid, 'complete', 100, 'Done');

      // Return response
      // videoId uses postId so render route can look it up
      // Each clip carries its own videoId for rendering
      res.json({
        videoId: postId,
        title: postResult.content?.substring(0, 100) || `X Post ${postId}`,
        description: postResult.content,
        duration: postResult.videos.reduce((sum, v) => sum + v.duration, 0),
        thumbnail: postResult.videos[0]?.thumbnail || '',
        clips: allClips.map(c => ({
          start: c.start,
          end: c.end,
          title: c.title,
          videoId: c.videoId, // Frontend will pass this to render
          sourceUrl: c.sourceUrl,
        })),
        subtitles: allSubtitles,
        jobId: jid,
      });
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // YOUTUBE FLOW (existing)
    // ═══════════════════════════════════════════════════════════════
    progressEmitter.emitProgress(jid, 'subtitles', 10, 'Extracting YouTube ID...');
    const videoId = extractVideoId(url);
    if (!videoId) {
      progressEmitter.emitProgress(jid, 'error', 0, 'Invalid YouTube URL');
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    progressEmitter.emitProgress(jid, 'subtitles', 15, 'Fetching subtitles...');
    const videoData = await getVideoWithSubtitles(videoId);
    if (!videoData) {
      progressEmitter.emitProgress(jid, 'error', 0, 'Video not found or no subtitles');
      return res.status(404).json({ error: 'Video not found or no subtitles available' });
    }

    progressEmitter.emitProgress(jid, 'subtitles', 30, 'Subtitles fetched');

    // ── Stage 2: Analyzing (30% → 70%) ─────────────────────────────
    progressEmitter.emitProgress(jid, 'analyzing', 35, 'AI analyzing content...');
    const clips = await analyzeClips(videoData.subtitles, videoData.title, videoData.description);

    progressEmitter.emitProgress(jid, 'analyzing', 70, 'Analysis complete');

    // ── Stage 3: Splitting (70% → 100%) ─────────────────────────────
    progressEmitter.emitProgress(jid, 'splitting', 75, 'Generating clip tasks...');

    // Trigger video download in background (non-blocking)
    const videosDir = path.join(process.cwd(), 'videos');
    const videoPath = path.join(videosDir, `${videoId}.mp4`);
    if (!fs.existsSync(videoPath)) {
      downloadVideo(videoId).then(() => {
        console.log(`Background download complete: ${videoId}`);
      }).catch((err: any) => {
        console.warn(`Background download failed for ${videoId}:`, err.message);
      });
    }

    // Save video metadata to database
    const postUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let existingPost = await db.query.originalPost.findFirst({
      where: (post, { eq }) => eq(post.postUrl, postUrl),
    });

    if (!existingPost) {
      let existingAuthor = await db.query.author.findFirst({
        where: (a, { eq }) => eq(a.platformId, videoId),
      });

      if (!existingAuthor) {
        [existingAuthor] = await db.insert(author).values({
          platform: 'youtube',
          platformId: videoId,
          name: 'Unknown',
        }).returning();
      }

      [existingPost] = await db.insert(originalPost).values({
        authorId: existingAuthor.id,
        platform: 'youtube',
        postUrl,
        title: videoData.title,
        description: videoData.description,
        subtitlesJson: JSON.stringify(videoData.subtitles),
        coverImageUrl: videoData.thumbnail,
      }).returning();
    }

    progressEmitter.emitProgress(jid, 'splitting', 90, `${clips.length} clips ready`);
    progressEmitter.emitProgress(jid, 'complete', 100, 'Done');

    res.json({
      videoId: videoData.videoId,
      title: videoData.title,
      description: videoData.description,
      duration: videoData.duration,
      thumbnail: videoData.thumbnail,
      clips,
      subtitles: videoData.subtitles,
      jobId: jid,
    });
  } catch (error: any) {
    console.error('Analysis error:', error);
    progressEmitter.emitProgress(jid, 'error', 0, error.message || 'Failed to analyze video');
    res.status(500).json({ error: error.message || 'Failed to analyze video' });
  }
});