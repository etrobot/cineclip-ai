import { motion, AnimatePresence } from "motion/react";
import {
  Search,
  X,
  CheckSquare,
  Square,
  ListPlus,
  Loader2,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  Check,
} from "lucide-react";
import React, { useState, useCallback, useEffect } from "react";
import { listChannelVideos, type ChannelVideo } from "../api/client";

interface ChannelBrowserProps {
  onClose: () => void;
  queuedVideoIds: Set<string>;
  onAddToQueue: (videos: ChannelVideo[]) => number;
}

interface PersistedChannelBrowserState {
  channelUrl: string;
  channelType: string;
  videos: ChannelVideo[];
}

const STORAGE_KEY = "cineclip_channel_browser";

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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

export const ChannelBrowser: React.FC<ChannelBrowserProps> = ({ onClose, queuedVideoIds, onAddToQueue }) => {
  const [hydrated, setHydrated] = useState(false);
  const [channelUrl, setChannelUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channelType, setChannelType] = useState<string>("");
  const [videos, setVideos] = useState<ChannelVideo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedList, setExpandedList] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setHydrated(true);
        return;
      }

      const parsed = JSON.parse(raw) as Partial<PersistedChannelBrowserState>;
      setChannelUrl(typeof parsed.channelUrl === "string" ? parsed.channelUrl : "");
      setChannelType(typeof parsed.channelType === "string" ? parsed.channelType : "");
      setVideos(Array.isArray(parsed.videos) ? parsed.videos.filter(isChannelVideo) : []);
    } catch {
      // Ignore corrupted local state.
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          channelUrl,
          channelType,
          videos,
        } satisfies PersistedChannelBrowserState)
      );
    } catch {
      // Ignore storage failures.
    }
  }, [hydrated, channelUrl, channelType, videos]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleListVideos = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelUrl.trim()) return;

    setLoading(true);
    setError(null);
    setVideos([]);
    setSelectedIds(new Set());

    try {
      const result = await listChannelVideos(channelUrl.trim());
      setVideos(Array.isArray(result.videos) ? result.videos.filter(isChannelVideo) : []);
      setChannelType(result.type);
    } catch (err: any) {
      setError(err.message || "Failed to list videos");
    } finally {
      setLoading(false);
    }
  }, [channelUrl]);

  const toggleSelect = useCallback((videoId: string) => {
    if (queuedVideoIds.has(videoId)) return;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
  }, [queuedVideoIds]);

  const selectAll = useCallback(() => {
    setSelectedIds(
      new Set(
        videos
          .filter((video) => !queuedVideoIds.has(video.videoId))
          .map((video) => video.videoId)
      )
    );
  }, [queuedVideoIds, videos]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const addToQueue = useCallback(() => {
    const selected = videos.filter(
      (video) => selectedIds.has(video.videoId) && !queuedVideoIds.has(video.videoId)
    );
    if (selected.length === 0) return;
    const addedCount = onAddToQueue(selected);
    if (addedCount > 0) {
      setToast(`${addedCount} video${addedCount > 1 ? "s" : ""} added to queue`);
    }
    setSelectedIds(new Set());
  }, [onAddToQueue, queuedVideoIds, selectedIds, videos]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="absolute top-6 left-1/2 -translate-x-1/2 z-50"
          >
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500 text-black text-sm font-bold shadow-lg">
              <Check className="w-4 h-4" />
              <span>{toast}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ scale: 0.9, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 30 }}
        className="w-full max-w-4xl max-h-[90vh] bg-zinc-950 border border-zinc-800/50 rounded-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/50">
          <h2 className="text-lg font-bold text-white uppercase tracking-widest">
            Channel Browser
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 border-b border-zinc-800/30">
          <form onSubmit={handleListVideos} className="flex gap-2">
            <input
              type="text"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              placeholder="Paste YouTube channel or playlist URL..."
              className="flex-1 bg-zinc-900 border border-zinc-700/50 rounded-xl px-4 py-3 text-white text-sm placeholder:text-zinc-600 outline-none focus:border-red-600/50 transition-colors"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-3 bg-red-600 hover:bg-red-700 disabled:bg-zinc-700 text-white rounded-xl font-bold uppercase tracking-widest text-sm flex items-center gap-2 transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              List
            </button>
          </form>
          {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {videos.length > 0 && (
            <div className="border-b border-zinc-800/30">
              <div
                onClick={() => setExpandedList(!expandedList)}
                className="w-full flex items-center justify-between px-6 py-3 hover:bg-zinc-900/50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <Film className="w-4 h-4 text-red-500" />
                  <span className="text-sm font-bold text-zinc-300 uppercase tracking-widest">
                    {channelType === "channel" ? "Channel" : channelType === "playlist" ? "Playlist" : "Videos"} — {videos.length} videos
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-zinc-500">{selectedIds.size} selected</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); selectAll(); }}
                      className="text-xs text-red-400 hover:text-red-300 font-bold uppercase"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deselectAll(); }}
                      className="text-xs text-zinc-500 hover:text-zinc-400 font-bold uppercase"
                    >
                      None
                    </button>
                  </div>
                  {expandedList ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
                </div>
              </div>

              <AnimatePresence>
                {expandedList && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="px-6 pb-4 space-y-1 max-h-[50vh] overflow-y-auto">
                      {videos.map((video) => {
                        const isSelected = selectedIds.has(video.videoId);
                        const isQueued = queuedVideoIds.has(video.videoId);
                        return (
                          <div
                            key={video.videoId}
                            onClick={() => !isQueued && toggleSelect(video.videoId)}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                              isQueued
                                ? "bg-zinc-900/60 border border-zinc-800 opacity-45 cursor-not-allowed"
                                : isSelected
                                ? "bg-red-600/10 border border-red-600/30"
                                : "hover:bg-zinc-900 border border-transparent cursor-pointer"
                            }`}
                          >
                            {isQueued ? (
                              <CheckSquare className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                            ) : isSelected ? (
                              <CheckSquare className="w-4 h-4 text-red-500 flex-shrink-0" />
                            ) : (
                              <Square className="w-4 h-4 text-zinc-600 flex-shrink-0" />
                            )}
                            {video.thumbnail && (
                              <img
                                src={video.thumbnail}
                                alt=""
                                className="w-16 h-9 object-cover rounded flex-shrink-0 bg-zinc-800"
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm truncate ${isQueued ? "text-zinc-500" : "text-zinc-200"}`}>
                                {video.title}
                              </p>
                              {isQueued && (
                                <p className="text-[11px] text-zinc-600 uppercase tracking-widest mt-0.5">
                                  Already in queue
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-zinc-500 flex-shrink-0">
                              <Clock className="w-3 h-3" />
                              <span className="text-xs">{formatDuration(video.duration)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {selectedIds.size > 0 && (
                      <div className="px-6 pb-4">
                        <button
                          onClick={addToQueue}
                          className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg font-bold text-sm uppercase tracking-widest flex items-center justify-center gap-2 transition-colors"
                        >
                          <ListPlus className="w-4 h-4" />
                          Add {selectedIds.size} video{selectedIds.size > 1 ? "s" : ""} to queue
                        </button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {videos.length === 0 && !loading && !error && (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-600">
              <Film className="w-12 h-12 mb-4 text-zinc-700" />
              <p className="text-sm">Enter a YouTube channel or playlist URL to list videos</p>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};
