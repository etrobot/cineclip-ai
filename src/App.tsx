import { useState, useRef, useCallback, useEffect } from "react";
import Hero from "./components/Hero";
import LoadingModal from "./components/LoadingModal";
import GlowBackground from "./components/GlowBackground";
import { ClipRow } from "./components/ClipRow";
import { motion, AnimatePresence } from "motion/react";
import { LogOut, Plus, Trash2 } from "lucide-react";
import {
  analyzeVideo,
  subscribeProgress,
  generateJobId,
  deleteClip,
  type Clip,
  type ProgressEvent,
} from "./api/client";
import { useRenderQueue, type QueuedClip } from "./hooks/useRenderQueue";
import { usePersistedClips } from "./hooks/usePersistedClips";

type AppView = "home" | "loading" | "results";

export interface ClipItem {
  id: string;
  videoId: string;
  title: string;
  category: string;
  duration: string;
  thumbnail: string;
  start: number;
  end: number;
  subtitles?: Array<{ start: number; end: number; text: string }>;
}

export interface VideoGroup {
  videoId: string;
  title: string;
  thumbnail: string;
  items: ClipItem[];
}

export default function App() {
  const [view, setView] = useState<AppView>("home");
  const [status, setStatus] = useState("Initializing");
  const [progress, setProgress] = useState(0);
  const [analyzedClips, setAnalyzedClips] = useState<VideoGroup[]>([]);
  const [videoData, setVideoData] = useState<{
    videoId: string;
    title: string;
    thumbnail: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const { clips: queuedClips, startQueue, updateClip, removeClip } = useRenderQueue();
  const { persisted, save, clear } = usePersistedClips();
  const restoredRef = useRef(false);

  // Restore from localStorage on mount (only once)
  useEffect(() => {
    if (persisted && !restoredRef.current) {
      restoredRef.current = true;
      setAnalyzedClips(groupClipsByVideoFlat(persisted.clips));
      setVideoData(persisted.videoData);
      // Restore queued clips state — batch into a single update to avoid loops
      if (persisted.queuedClips.length > 0) {
        const updates = persisted.queuedClips;
        // Use a small timeout to ensure updateClip is ready
        setTimeout(() => {
          for (const q of updates) {
            updateClip(q.id, q);
          }
        }, 0);
      }
    }
  }, [persisted]);

  // Persist whenever data changes (debounced to avoid excessive writes)
  useEffect(() => {
    if (analyzedClips.length === 0) return;
    const allItems = analyzedClips.flatMap((g) => g.items);
    const timer = setTimeout(() => {
      save({
        clips: allItems,
        videoData,
        queuedClips,
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [analyzedClips, videoData, queuedClips, save]);

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  /** Slice the full subtitles array to get only those within a clip's time range */
  const getClipSubtitles = (
    allSubtitles: Array<{ start: number; end: number; text: string }>,
    clipStart: number,
    clipEnd: number
  ): Array<{ start: number; end: number; text: string }> => {
    return allSubtitles.filter(
      (s) => s.end > clipStart && s.start < clipEnd
    );
  };

  const groupClipsByVideo = (
    clipsData: Clip[],
    videoId: string,
    title: string,
    thumbnail: string,
    allSubtitles?: Array<{ start: number; end: number; text: string }>
  ): VideoGroup[] => {
    const items: ClipItem[] = clipsData.map((clip, index) => ({
      id: `${videoId}_${index}`,
      videoId,
      title: clip.title,
      category: clip.category || "Highlights",
      duration: formatDuration(clip.end - clip.start),
      thumbnail,
      start: clip.start,
      end: clip.end,
      subtitles: allSubtitles
        ? getClipSubtitles(allSubtitles, clip.start, clip.end)
        : undefined,
    }));

    return [
      {
        videoId,
        title,
        thumbnail,
        items,
      },
    ];
  };

  const groupClipsByVideoFlat = (items: ClipItem[]): VideoGroup[] => {
    const grouped = new Map<string, VideoGroup>();
    for (const item of items) {
      if (!grouped.has(item.videoId)) {
        grouped.set(item.videoId, {
          videoId: item.videoId,
          title: item.title,
          thumbnail: item.thumbnail,
          items: [],
        });
      }
      grouped.get(item.videoId)!.items.push(item);
    }
    return Array.from(grouped.values());
  };

  const getStageLabel = (stage: string, message: string): string => {
    const stageMap: Record<string, string> = {
      extracting: "Getting Subtitles",
      subtitles: "Getting Subtitles",
      analyzing: "Analyzing",
      splitting: "Splitting",
      downloading: "Splitting",
      complete: "Done",
      error: "Error",
    };
    return message || stageMap[stage] || stage;
  };

  const startAnalysis = useCallback(
    async (url: string) => {
      console.log("Analyzing URL:", url);
      setView("loading");
      setError(null);
      setProgress(0);
      setStatus("Initializing");

      const jobId = generateJobId();

      const unsubscribe = subscribeProgress(
        jobId,
        (event: ProgressEvent) => {
          console.log("Progress event:", event);
          setProgress(event.progress);
          setStatus(getStageLabel(event.stage, event.message));
        },
        () => {
          console.log("Job completed");
          setProgress(100);
        },
        (message: string) => {
          console.error("Progress error:", message);
          setError(message);
          setStatus("Error");
        }
      );

      unsubscribeRef.current = unsubscribe;

      try {
        const result = await analyzeVideo(url, jobId);

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

        // Start render queue with all clips
        const allClips = groupedClips.flatMap((g) => g.items);
        startQueue(allClips);
      } catch (err: any) {
        console.error("Analysis error:", err);
        setError(err.message || "Failed to analyze video");
        setStatus("Error");
        setTimeout(() => {
          setView("home");
          setError(null);
        }, 3000);
      } finally {
        unsubscribe();
        unsubscribeRef.current = null;
      }
    },
    [startQueue]
  );

  const handleClearGallery = useCallback(() => {
    clear();
    setAnalyzedClips([]);
    setVideoData(null);
    setView("home");
  }, [clear]);

  const handleGoToGallery = useCallback(() => {
    if (analyzedClips.length > 0) {
      setView("results");
    }
  }, [analyzedClips]);

  const handleDeleteClip = useCallback(
    async (clipId: string) => {
      const clip = queuedClips.find((c) => c.id === clipId);
      if (!clip) return;

      // Delete files from server if rendered
      if (clip.clipUrl) {
        try {
          await deleteClip(clip.clipUrl, clip.renderedThumbnailUrl);
        } catch (err) {
          console.error("Failed to delete clip files:", err);
        }
      }

      // Remove from queue state
      removeClip(clipId);

      // Remove from analyzedClips
      setAnalyzedClips((prev) => {
        const updated = prev
          .map((group) => ({
            ...group,
            items: group.items.filter((item) => item.id !== clipId),
          }))
          .filter((group) => group.items.length > 0);
        return updated;
      });
    },
    [queuedClips, removeClip]
  );

  // Group queued clips by video for display
  const groupedQueuedVideos = analyzedClips.map((row) => ({
    videoId: row.videoId,
    title: row.title,
    thumbnail: row.thumbnail,
    items: row.items
      .map((item) => queuedClips.find((q) => q.id === item.id))
      .filter(Boolean) as QueuedClip[],
  }));

  const hasClips = groupedQueuedVideos.some((row) => row.items.length > 0);

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
                  </div>
                </div>
                <div className="flex items-center gap-4">
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
            <div className="pt-8 space-y-12">
              {hasClips ? (
                groupedQueuedVideos.map((row) =>
                  row.items.length > 0 ? (
                    <div key={row.videoId}>
                      <ClipRow
                        videoTitle={row.title}
                        videoThumbnail={row.thumbnail}
                        clips={row.items}
                        onDeleteClip={handleDeleteClip}
                      />
                    </div>
                  ) : null
                )
              ) : (
                <div className="flex flex-col items-center justify-center text-zinc-500 py-20 gap-4">
                  <p className="text-xl">
                    No clips available. Analyze a video to get started.
                  </p>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setView("home")}
                    className="px-6 py-3 bg-red-600 hover:bg-red-700 rounded-xl font-bold text-white uppercase tracking-widest text-sm"
                  >
                    Analyze Video
                  </motion.button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <LoadingModal
        isOpen={view === "loading"}
        status={error || status}
        progress={progress}
      />
    </div>
  );
}
