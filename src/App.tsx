import { useState, useRef, useCallback, useEffect } from "react";
import Hero from "./components/Hero";
import LoadingModal from "./components/LoadingModal";
import GlowBackground from "./components/GlowBackground";
import { ClipRow } from "./components/ClipRow";
import { motion, AnimatePresence } from "motion/react";
import { LogOut, Plus, Trash2, ListVideo } from "lucide-react";
import { ShotSearch } from "./components/ShotSearch";
import { ChannelBrowser } from "./components/ChannelBrowser";
import { QueueView } from "./components/QueueView";
import {
  analyzeVideo,
  subscribeProgress,
  generateJobId,
  deleteClip,
  deleteVideoClips,
  clearGallery,
  listClips,
  renderClip,
  type Clip,
  type ProgressEvent,
  type SubtitleItem,
  type ListClipItem,
} from "./api/client";
import { useChannelQueue } from "./hooks/useChannelQueue";
import { useShotQueue } from "./hooks/useShotQueue";

type AppView = "home" | "loading" | "results" | "queue";

type ClipStatus = "pending" | "rendering" | "done" | "error";

export interface ClipItem {
  id: string;
  videoId: string;
  title: string;
  duration: string;
  thumbnail: string;
  start: number;
  end: number;
  subtitles?: SubtitleItem[];
  sourceUrl?: string; // For non-YouTube videos (e.g. X posts)
  // render state
  status: ClipStatus;
  progress: number;
  stage: string;
  errorMessage?: string;
  clipUrl?: string;
  renderedThumbnailUrl?: string;
}

export interface VideoGroup {
  videoId: string;
  title: string;
  thumbnail: string;
  items: ClipItem[];
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function makeClipId(videoId: string, start: number, end: number): string {
  const safeStart = String(start).replace(/\./g, "p");
  const safeEnd = String(end).replace(/\./g, "p");
  return `${videoId}_${safeStart}_${safeEnd}`;
}

function getClipSubtitles(
  allSubtitles: SubtitleItem[],
  clipStart: number,
  clipEnd: number
): SubtitleItem[] {
  return allSubtitles.filter((s) => s.end > clipStart && s.start < clipEnd);
}

function groupClipsByVideo(
  clipsData: Clip[],
  videoId: string,
  title: string,
  thumbnail: string,
  allSubtitles?: SubtitleItem[]
): VideoGroup[] {
  const items: ClipItem[] = clipsData.map((clip) => {
    // For X posts, each clip may have its own videoId
    const clipVideoId = clip.videoId || videoId;
    const id = makeClipId(clipVideoId, clip.start, clip.end);
    return {
      id,
      videoId: clipVideoId,
      title: clip.title,
      duration: formatDuration(clip.end - clip.start),
      thumbnail,
      start: clip.start,
      end: clip.end,
      subtitles: allSubtitles
        ? getClipSubtitles(allSubtitles, clip.start, clip.end)
        : undefined,
      sourceUrl: clip.sourceUrl,
      status: "pending",
      progress: 0,
      stage: "",
    };
  });

  return [{ videoId, title, thumbnail, items }];
}

function groupClipsByVideoFlat(items: ClipItem[]): VideoGroup[] {
  const grouped = new Map<string, VideoGroup>();
  for (const item of items) {
    if (!grouped.has(item.videoId)) {
      grouped.set(item.videoId, {
        videoId: item.videoId,
        title: item.title,
        thumbnail: item.renderedThumbnailUrl || item.thumbnail,
        items: [],
      });
    }
    grouped.get(item.videoId)!.items.push(item);
  }
  return Array.from(grouped.values());
}

function mapListClipsToItems(clips: ListClipItem[]): ClipItem[] {
  return clips.map((c) => ({
    // Use fileName-based id so shots API can resolve sourceClipId (e.g. _y9v0xuz9lA_0_51)
    id: c.fileName.replace(/\.mp4$/i, ""),
    videoId: c.videoId,
    title: c.title || c.fileName.replace(/\.mp4$/i, "").replace(/_/g, " "),
    duration: c.duration,
    thumbnail: c.thumbnailUrl || "",
    start: c.start,
    end: c.end,
    status: "done" as const,
    progress: 100,
    stage: "",
    clipUrl: c.clipUrl,
    renderedThumbnailUrl: c.thumbnailUrl,
  }));
}

function getStageLabel(stage: string, message: string): string {
  const stageMap: Record<string, string> = {
    subtitles: "Getting Subtitles",
    analyzing: "Analyzing",
    splitting: "Splitting",
    downloading: "Downloading",
    rendering: "Rendering",
    thumbnail: "Screenshot",
    complete: "Done",
    error: "Error",
  };
  return message || stageMap[stage] || stage;
}

export default function App() {
  const [view, setView] = useState<AppView>("home");
  const [status, setStatus] = useState("Initializing");
  const [progress, setProgress] = useState(0);
  const [currentStage, setCurrentStage] = useState("subtitles");
  const [analyzedClips, setAnalyzedClips] = useState<VideoGroup[]>([]);
  const [videoData, setVideoData] = useState<{
    videoId: string;
    title: string;
    thumbnail: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverClipsLoaded, setServerClipsLoaded] = useState(false);
  const [showChannel, setShowChannel] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reloadGallery = useCallback(() => {
    console.log("[Gallery] reloading from server...");
    return listClips()
      .then((data) => {
        console.log("[Gallery] server clips:", data.clips.length);
        setAnalyzedClips((prev) => {
          const serverItems = mapListClipsToItems(data.clips);
          if (serverItems.length === 0) return prev;

          const serverKeys = new Set(
            serverItems.map((c) => `${c.videoId}:${c.start}:${c.end}`)
          );
          const pendingItems = prev.flatMap((g) =>
            g.items.filter(
              (item) =>
                (item.status === "pending" || item.status === "rendering") &&
                !serverKeys.has(`${item.videoId}:${item.start}:${item.end}`)
            )
          );

          return groupClipsByVideoFlat([...serverItems, ...pendingItems]);
        });
      })
      .catch((err) => {
        console.warn("[Gallery] reload failed:", err);
      });
  }, []);
  const {
    queueItems,
    isFetching: isChannelFetching,
    addVideosToQueue,
    removeFromQueue,
    confirmVideoDelete,
    cancelVideoConfirm,
    clearDone: clearDoneQueue,
    clearQueue,
    startFetch: startChannelFetch,
    stopFetch: stopChannelFetch,
  } = useChannelQueue(reloadGallery);
  const queuedVideoIds = new Set(queueItems.map((item) => item.video.videoId));

  // Shot detection queue — serial processing to avoid 429 from VL model API
  const {
    items: shotQueueItems,
    enqueue: enqueueShot,
    retry: retryShot,
  } = useShotQueue();

  // Load existing clips from server on mount
  useEffect(() => {
    if (serverClipsLoaded) return;
    reloadGallery().finally(() => setServerClipsLoaded(true));
  }, [serverClipsLoaded, reloadGallery]);

  const updateClipItem = useCallback(
    (clipId: string, patch: Partial<ClipItem>) => {
      setAnalyzedClips((prev) =>
        prev.map((group) => ({
          ...group,
          items: group.items.map((item) =>
            item.id === clipId ? { ...item, ...patch } : item
          ),
        }))
      );
    },
    []
  );

  const renderOneClip = useCallback(
    async (item: ClipItem): Promise<void> => {
      const jobId = generateJobId();
      const clipId = item.id;

      updateClipItem(clipId, {
        status: "rendering",
        progress: 0,
        stage: "Preparing...",
      });

      let unsubscribe: (() => void) | null = null;

      try {
        // Subscribe to progress first
        const progressPromise = new Promise<void>((resolve, reject) => {
          unsubscribe = subscribeProgress(
            jobId,
            (event: ProgressEvent) => {
              updateClipItem(clipId, {
                progress: event.progress,
                stage: event.message || event.stage,
              });
            },
            () => resolve(),
            (msg: string) => reject(new Error(msg))
          );
        });

        // Call render API
        const result = await renderClip(
          item.videoId,
          item.start,
          item.end,
          undefined,
          item.title,
          item.subtitles,
          jobId,
          item.sourceUrl
        );

        // Wait for progress to complete (or timeout after 2 minutes)
        await Promise.race([
          progressPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 120000)),
        ]);

        updateClipItem(clipId, {
          status: "done",
          progress: 100,
          clipUrl: result.clipUrl,
          renderedThumbnailUrl: result.thumbnailUrl,
        });
      } catch (err: any) {
        console.error(`Render error for ${clipId}:`, err);
        updateClipItem(clipId, {
          status: "error",
          errorMessage: err.message || "Render failed",
        });
      } finally {
        unsubscribe?.();
      }
    },
    [updateClipItem]
  );

  const renderAllClips = useCallback(
    async (items: ClipItem[]) => {
      for (const item of items) {
        try {
          await renderOneClip(item);
        } catch (err: any) {
          console.error(`Clip ${item.id} render failed:`, err);
          // Continue with next clip — don't let one failure stop the queue
        }
      }
      await reloadGallery();
    },
    [renderOneClip, reloadGallery]
  );

  const handleRetryClip = useCallback(
    (clipId: string) => {
      const allItems = analyzedClips.flatMap((group) => group.items);
      const clip = allItems.find((item) => item.id === clipId);
      if (!clip) {
        console.warn(`[Retry] Clip not found: ${clipId}`);
        return;
      }

      if (clip.status === 'rendering' || clip.status === 'pending') {
        return;
      }

      renderOneClip(clip);
    },
    [analyzedClips, renderOneClip]
  );

  const startAnalysis = useCallback(
    async (url: string) => {
      console.log("Analyzing URL:", url);
      setView("loading");
      setError(null);
      setProgress(0);
      setStatus("Initializing");
      setCurrentStage("subtitles");

      const jobId = generateJobId();
      abortRef.current = new AbortController();

      const unsubscribe = subscribeProgress(
        jobId,
        (event: ProgressEvent) => {
          setProgress(event.progress);
          setCurrentStage(event.stage);
          setStatus(getStageLabel(event.stage, event.message));
        },
        () => {
          setProgress(100);
        },
        (message: string) => {
          setError(message);
          setStatus("Error");
        }
      );

      unsubscribeRef.current = unsubscribe;

      try {
        const result = await analyzeVideo(url, jobId);

        if (!result.clips || result.clips.length === 0) {
          throw new Error("No clips suggested by AI. Try a different video.");
        }

        const groupedClips = groupClipsByVideo(
          result.clips,
          result.videoId,
          result.title,
          result.thumbnail,
          result.subtitles
        );
        setAnalyzedClips(groupedClips);
        setVideoData({
          videoId: result.videoId,
          title: result.title,
          thumbnail: result.thumbnail,
        });

        await new Promise((resolve) => setTimeout(resolve, 600));
        setStatus("Redirecting");
        await new Promise((resolve) => setTimeout(resolve, 400));
        setView("results");

        // Start rendering clips sequentially in background
        // Don't await — let user interact while clips render
        const allItems = groupedClips.flatMap((g) => g.items);
        renderAllClips(allItems).catch((err) => {
          console.error("Background render error:", err);
        });
      } catch (err: any) {
        console.error("Analysis error:", err);
        setError(err.message || "Failed to analyze video");
        setStatus("Error");
        // Only auto-return home on analysis error, not render error
        setTimeout(() => {
          setView("home");
          setError(null);
        }, 3000);
      } finally {
        unsubscribe();
        unsubscribeRef.current = null;
      }
    },
    [renderAllClips]
  );

  const handleClearGallery = useCallback(async () => {
    console.log("[ClearGallery] clearing all clips and returning home");
    setAnalyzedClips([]);
    setVideoData(null);
    setView("home");

    try {
      await clearGallery();
      console.log("[ClearGallery] server clear ok");
    } catch (err) {
      console.error("[ClearGallery] server clear failed:", err);
    }
  }, []);

  const handleGoToGallery = useCallback(() => {
    reloadGallery().finally(() => setView("results"));
  }, [reloadGallery]);

  const handleDeleteClip = useCallback(
    async (clipId: string) => {
      // Find the clip before removing it from state
      let clipUrl: string | undefined;
      let thumbUrl: string | undefined;

      setAnalyzedClips((prev) => {
        for (const group of prev) {
          const item = group.items.find((i) => i.id === clipId);
          if (item) {
            clipUrl = item.clipUrl;
            thumbUrl = item.renderedThumbnailUrl;
            break;
          }
        }
        const next = prev
          .map((group) => ({
            ...group,
            items: group.items.filter((item) => item.id !== clipId),
          }))
          .filter((group) => group.items.length > 0);
        console.log("[Delete] clipId:", clipId, "remaining groups:", next.length);
        return next;
      });

      if (clipUrl) {
        try {
          await deleteClip(clipUrl, thumbUrl);
          console.log("[Delete] server delete ok:", clipId);
        } catch (err) {
          console.error("[Delete] server delete failed:", clipId, err);
        }
      }
    },
    []
  );

  const handleDeleteVideoClips = useCallback(
    async (videoId: string) => {
      // Remove all clips for this video from state
      setAnalyzedClips((prev) => {
        const next = prev.filter((group) => group.videoId !== videoId);
        console.log("[DeleteVideo] videoId:", videoId, "remaining groups:", next.length);
        return next;
      });

      try {
        await deleteVideoClips(videoId);
        console.log("[DeleteVideo] server delete ok:", videoId);
      } catch (err) {
        console.error("[DeleteVideo] server delete failed:", videoId, err);
      }
    },
    []
  );

  const hasClips = analyzedClips.some((row) => row.items.length > 0);

  return (
    <div className="min-h-screen text-white font-sans selection:bg-red-600/30 selection:text-red-500 bg-black">
      <GlowBackground />

      <AnimatePresence mode="wait">
        {view === "home" && (
          <motion.div
            key="home"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.5 }}
          >
            <Hero
              onSearch={startAnalysis}
              onGoToGallery={handleGoToGallery}
              onGoToQueue={() => setView("queue")}
              onOpenChannel={() => setShowChannel(true)}
            />
          </motion.div>
        )}

        {view === "results" && (
          <motion.div
            key="results"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, type: "spring", damping: 20 }}
            className="pt-24 pb-12"
          >
            {/* Header / Navbar */}
            <nav className="fixed top-0 left-0 right-0 z-40 bg-black/60 backdrop-blur-xl border-b border-zinc-900">
              <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between">
                <div className="flex items-center gap-8">
                  <h1
                    className="text-2xl font-black text-red-600 tracking-tighter uppercase italic cursor-pointer"
                    onClick={() => setView("home")}
                  >
                    CineClip
                  </h1>
                  <div className="hidden md:flex items-center gap-6 text-sm font-bold text-zinc-400 uppercase tracking-widest leading-none">
                    <span className="text-white border-b-2 border-red-600 pb-1">
                      Gallery
                    </span>
                    <button
                      onClick={() => setView("queue")}
                      className="hover:text-white transition-colors"
                    >
                      Queue
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <ShotSearch />
                  <button
                    onClick={() => setView("queue")}
                    className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-white"
                    title="Open queue"
                  >
                    <ListVideo className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => setView("home")}
                    className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-white"
                    title="New analysis"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                  {hasClips && (
                    <button
                      onClick={handleClearGallery}
                      className="p-2 hover:bg-red-900/30 rounded-full transition-colors text-red-500"
                      title="Clear gallery"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                  <button
                    onClick={() => setView("home")}
                    className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-500"
                  >
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </nav>

            {/* Clip Rows */}
            <div className="pt-8 max-w-4xl mx-auto px-6 space-y-6">
              {hasClips ? (
                analyzedClips.map((row) =>
                  row.items.length > 0 ? (
                    <div key={row.videoId}>
        <ClipRow
          videoTitle={row.title}
          videoThumbnail={row.thumbnail}
          clips={row.items}
          onDeleteClip={handleDeleteClip}
          onDeleteVideo={handleDeleteVideoClips}
          onRetryClip={handleRetryClip}
          subtitles={row.items[0]?.subtitles}
          videoId={row.videoId}
          shotQueueItems={shotQueueItems}
          onEnqueueShot={enqueueShot}
          onRetryShot={retryShot}
        />
                    </div>
                  ) : null
                )
              ) : (
                <div className="flex flex-col items-center justify-center text-zinc-500 py-20 gap-4">
                  <p className="text-xl">
                    Gallery is empty.
                  </p>
                  <p className="text-sm text-zinc-600">
                    Clips you analyze will appear here.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {view === "queue" && (
          <QueueView
            items={queueItems}
            isFetching={isChannelFetching}
            onBack={() => setView(hasClips ? "results" : "home")}
            onStart={startChannelFetch}
            onStop={stopChannelFetch}
            onRemove={removeFromQueue}
            onConfirmDelete={confirmVideoDelete}
            onCancelConfirm={cancelVideoConfirm}
            onClearDone={clearDoneQueue}
            onClearQueue={clearQueue}
          />
        )}
      </AnimatePresence>

      <LoadingModal
        isOpen={view === "loading"}
        status={error || currentStage}
        progress={progress}
      />

      <AnimatePresence>
        {showChannel && (
          <ChannelBrowser
            onClose={() => setShowChannel(false)}
            queuedVideoIds={queuedVideoIds}
            onAddToQueue={addVideosToQueue}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
