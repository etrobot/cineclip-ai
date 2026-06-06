import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeVideo,
  generateJobId,
  renderClip,
  segmentShots,
  subscribeProgress,
  checkVideoExists,
  deleteVideoClips,
  type ChannelVideo,
  type ProgressEvent,
  type SubtitleItem,
} from "../api/client";

export type FetchStatus = "idle" | "analyzing" | "downloading" | "rendering" | "segmenting" | "done" | "error";

export interface FetchItem {
  video: ChannelVideo;
  status: FetchStatus;
  progress: number;
  message: string;
  error?: string;
  needsConfirm?: boolean;      // video already has extracted clips, awaiting user confirmation
  confirmDelete?: boolean;     // user confirmed: delete existing clips before re-extracting
  existingClipCount?: number;  // how many clips already exist for this video
}

const STORAGE_KEY = "cineclip_channel_queue";

function makeClipId(videoId: string, start: number, end: number): string {
  const safeStart = String(start).replace(/\./g, "p");
  const safeEnd = String(end).replace(/\./g, "p");
  return `${videoId}_${safeStart}_${safeEnd}`;
}

function isChannelVideo(value: unknown): value is ChannelVideo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChannelVideo>;
  return (
    typeof candidate.videoId === "string" &&
    candidate.videoId.length > 0 &&
    typeof candidate.title === "string" &&
    typeof candidate.url === "string"
  );
}

function sanitizeFetchItem(value: unknown): FetchItem | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<FetchItem>;
  if (!isChannelVideo(candidate.video)) return null;

  const status = candidate.status;
  if (
    status !== "idle" &&
    status !== "analyzing" &&
    status !== "downloading" &&
    status !== "rendering" &&
    status !== "segmenting" &&
    status !== "done" &&
    status !== "error"
  ) {
    return null;
  }

  const resumableStatus: FetchStatus =
    status === "done" || status === "error" || status === "idle" ? status : "idle";

  return {
    video: candidate.video,
    status: resumableStatus,
    progress: resumableStatus === "idle" ? 0 : typeof candidate.progress === "number" ? candidate.progress : 0,
    message: resumableStatus === "idle" ? "Waiting..." : typeof candidate.message === "string" ? candidate.message : "Waiting...",
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    needsConfirm: typeof candidate.needsConfirm === "boolean" ? candidate.needsConfirm : undefined,
    confirmDelete: typeof candidate.confirmDelete === "boolean" ? candidate.confirmDelete : undefined,
    existingClipCount: typeof candidate.existingClipCount === "number" ? candidate.existingClipCount : undefined,
  };
}

function hasFetchVideo(value: FetchItem | undefined): value is FetchItem {
  return isChannelVideo(value?.video);
}

export function useChannelQueue(onClipComplete?: () => void) {
  const [fetchQueue, setFetchQueue] = useState<FetchItem[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const abortRef = useRef(false);
  const hydratedRef = useRef(false);

  const queueItems = fetchQueue.filter(hasFetchVideo);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setFetchQueue(
          Array.isArray(parsed)
            ? parsed.map(sanitizeFetchItem).filter((item): item is FetchItem => item !== null)
            : []
        );
      }
    } catch {
      // Ignore corrupted local state.
    } finally {
      hydratedRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queueItems));
    } catch {
      // Ignore storage failures.
    }
  }, [queueItems]);

  const updateFetchItem = useCallback((videoId: string, patch: Partial<FetchItem>) => {
    setFetchQueue((prev) =>
      prev.map((item) => (item.video?.videoId === videoId ? { ...item, ...patch } : item))
    );
  }, []);

  const processOneVideo = useCallback(
    async (item: FetchItem): Promise<void> => {
      const videoId = item.video.videoId;
      const videoUrl = item.video.url;

      // If user confirmed deletion of existing clips, delete them first
      if (item.confirmDelete) {
        updateFetchItem(videoId, { status: "analyzing", progress: 2, message: "Deleting existing clips..." });
        try {
          await deleteVideoClips(videoId);
        } catch (err: any) {
          console.warn(`Failed to delete existing clips for ${videoId}:`, err.message);
        }
      }

      updateFetchItem(videoId, { status: "analyzing", progress: 5, message: "Analyzing subtitles..." });
      const jobId = generateJobId();

      let unsubscribe: (() => void) | null = null;

      const progressPromise = new Promise<void>((resolve, reject) => {
        unsubscribe = subscribeProgress(
          jobId,
          (event: ProgressEvent) => {
            updateFetchItem(videoId, {
              progress: Math.min(event.progress * 0.4, 40),
              message: event.message || event.stage,
            });
          },
          () => resolve(),
          (msg: string) => reject(new Error(msg))
        );
      });

      let analyzeResult;
      try {
        analyzeResult = await analyzeVideo(videoUrl, jobId);
        await Promise.race([progressPromise, new Promise<void>((r) => setTimeout(r, 5000))]);
      } finally {
        unsubscribe?.();
      }

      if (!analyzeResult.clips || analyzeResult.clips.length === 0) {
        throw new Error("No clips suggested");
      }

      updateFetchItem(videoId, { status: "rendering", progress: 40, message: `Rendering ${analyzeResult.clips.length} clips...` });

      let renderedCount = 0;
      for (const clip of analyzeResult.clips) {
        if (abortRef.current) throw new Error("Aborted");

        const clipJobId = generateJobId();
        const clipVideoId = clip.videoId || videoId;
        const clipId = makeClipId(clipVideoId, clip.start, clip.end);

        const clipSubtitles = analyzeResult.subtitles
          ? (analyzeResult.subtitles as SubtitleItem[]).filter((s) => s.end > clip.start && s.start < clip.end)
          : undefined;

        let clipUnsubscribe: (() => void) | null = null;
        const clipProgressPromise = new Promise<void>((resolve, reject) => {
          clipUnsubscribe = subscribeProgress(
            clipJobId,
            (event: ProgressEvent) => {
              const clipProgress = 40 + (renderedCount / analyzeResult.clips.length) * 40 + (event.progress / analyzeResult.clips.length) * 0.4;
              updateFetchItem(videoId, {
                progress: Math.min(clipProgress, 80),
                message: `Rendering clip ${renderedCount + 1}/${analyzeResult.clips.length}: ${clip.title}`,
              });
            },
            () => resolve(),
            (msg: string) => reject(new Error(msg))
          );
        });

        try {
          const renderResult = await renderClip(
            clipVideoId,
            clip.start,
            clip.end,
            undefined,
            clip.title,
            clipSubtitles,
            clipJobId,
            clip.sourceUrl
          );

          await Promise.race([clipProgressPromise, new Promise<void>((r) => setTimeout(r, 3000))]);

          updateFetchItem(videoId, {
            status: "segmenting",
            progress: 80 + (renderedCount / analyzeResult.clips.length) * 15,
            message: `Segmenting shots for clip ${renderedCount + 1}/${analyzeResult.clips.length}...`,
          });

          const shotJobId = generateJobId();
          try {
            await segmentShots(renderResult.clipUrl, clipId, analyzeResult.subtitles, shotJobId);
          } catch (shotErr: any) {
            console.warn(`Shot segmentation failed for ${clipId}:`, shotErr.message);
          }
        } finally {
          clipUnsubscribe?.();
        }

        renderedCount++;
      }

      updateFetchItem(videoId, { status: "done", progress: 100, message: "Complete" });
    },
    [updateFetchItem]
  );

  const addVideosToQueue = useCallback(async (videos: ChannelVideo[]) => {
    // Check which videos already have extracted clips
    const existenceChecks = await Promise.allSettled(
      videos.filter(isChannelVideo).map(async (video) => {
        try {
          const result = await checkVideoExists(video.videoId);
          return { videoId: video.videoId, exists: result.exists, clipCount: result.clipCount };
        } catch {
          return { videoId: video.videoId, exists: false, clipCount: 0 };
        }
      })
    );

    const existenceMap = new Map<string, { exists: boolean; clipCount: number }>();
    for (const result of existenceChecks) {
      if (result.status === "fulfilled" && result.value) {
        existenceMap.set(result.value.videoId, { exists: result.value.exists, clipCount: result.value.clipCount });
      }
    }

    let addedCount = 0;

    setFetchQueue((prev) => {
      const existingIds = new Set(
        prev
          .map((item) => item.video?.videoId)
          .filter((videoId): videoId is string => typeof videoId === "string" && videoId.length > 0)
      );

      const newItems = videos
        .filter((video) => isChannelVideo(video) && !existingIds.has(video.videoId))
        .map((video) => {
          const info = existenceMap.get(video.videoId);
          return {
            video,
            status: "idle" as const,
            progress: 0,
            message: info?.exists ? "Already extracted — confirm to re-extract" : "Waiting...",
            needsConfirm: info?.exists ? true : undefined,
            confirmDelete: undefined,
            existingClipCount: info?.clipCount,
          };
        });

      addedCount = newItems.length;
      return [...prev, ...newItems];
    });

    return addedCount;
  }, []);

  const removeFromQueue = useCallback((videoId: string) => {
    setFetchQueue((prev) => prev.filter((item) => item.video?.videoId !== videoId));
  }, []);

  const confirmVideoDelete = useCallback((videoId: string) => {
    setFetchQueue((prev) =>
      prev.map((item) =>
        item.video?.videoId === videoId
          ? { ...item, needsConfirm: undefined, confirmDelete: true, message: "Waiting... (will re-extract)" }
          : item
      )
    );
  }, []);

  const cancelVideoConfirm = useCallback((videoId: string) => {
    setFetchQueue((prev) => prev.filter((item) => item.video?.videoId !== videoId));
  }, []);

  const clearDone = useCallback(() => {
    setFetchQueue((prev) => prev.filter((item) => item.status !== "done"));
  }, []);

  const clearQueue = useCallback(() => {
    setFetchQueue([]);
    setIsFetching(false);
    abortRef.current = true;
  }, []);

  const startFetch = useCallback(async () => {
    const idleItems = fetchQueue.filter(
      (item): item is FetchItem =>
        hasFetchVideo(item) &&
        (item.status === "idle" || item.status === "error") &&
        !item.needsConfirm   // skip items that still need user confirmation
    );
    if (idleItems.length === 0) return;

    setIsFetching(true);
    abortRef.current = false;

    for (const item of idleItems) {
      if (abortRef.current) break;

      try {
        await processOneVideo(item);
      } catch (err: any) {
        updateFetchItem(item.video.videoId, {
          status: "error",
          message: err.message || "Failed",
          error: err.message || "Failed",
        });
      }
    }

    setIsFetching(false);
    onClipComplete?.();
  }, [fetchQueue, onClipComplete, processOneVideo, updateFetchItem]);

  const stopFetch = useCallback(() => {
    abortRef.current = true;
    setIsFetching(false);
  }, []);

  return {
    queueItems,
    isFetching,
    addVideosToQueue,
    removeFromQueue,
    confirmVideoDelete,
    cancelVideoConfirm,
    clearDone,
    clearQueue,
    startFetch,
    stopFetch,
  };
}
