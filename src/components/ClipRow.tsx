import { motion, AnimatePresence } from "motion/react";
import { Download, Play, Loader2, Trash2, Grid3X3, X } from "lucide-react";
import React, { useState } from "react";
import { API_BASE_URL, generateGrid } from "../api/client";
import type { QueuedClip } from "../hooks/useRenderQueue";

interface ClipCardProps {
  clip: QueuedClip;
  index: number;
  onDelete?: (clipId: string) => void;
}

/** Map backend render stage to user-friendly label */
const RENDER_STAGE_LABELS: Record<string, string> = {
  downloading: "Downloading",
  thumbnail: "Screenshot",
  rendering: "Rendering",
  complete: "Done",
};

function getRenderStageLabel(stage: string, message: string): string {
  return message || RENDER_STAGE_LABELS[stage] || stage;
}

export const ClipCard: React.FC<ClipCardProps> = ({ clip, index, onDelete }) => {
  const isRendering = clip.status === "pending" || clip.status === "rendering";
  const isError = clip.status === "error";
  const isDone = clip.status === "done";
  const [gridUrl, setGridUrl] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [showGrid, setShowGrid] = useState(false);

  const handlePlay = () => {
    if (clip.clipUrl) {
      const url = clip.clipUrl.startsWith("http")
        ? clip.clipUrl
        : `${API_BASE_URL}${clip.clipUrl}`;
      window.open(url, "_blank");
    }
  };

  const handleDownload = () => {
    if (clip.clipUrl) {
      const url = clip.clipUrl.startsWith("http")
        ? clip.clipUrl
        : `${API_BASE_URL}${clip.clipUrl}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = `${clip.title || "clip"}.mp4`;
      a.click();
    }
  };

  const handleGrid = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (gridLoading) return;

    if (gridUrl) {
      setShowGrid(true);
      return;
    }

    if (!clip.clipUrl) return;

    setGridLoading(true);
    try {
      const result = await generateGrid(clip.clipUrl);
      setGridUrl(result.gridUrl);
      setShowGrid(true);
    } catch (err) {
      console.error("Failed to generate grid:", err);
    } finally {
      setGridLoading(false);
    }
  };

  const fullThumbnailSrc = clip.renderedThumbnailUrl
    ? `${API_BASE_URL}${clip.renderedThumbnailUrl}`
    : clip.thumbnail;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.06 }}
        className="flex gap-4 items-stretch bg-zinc-900/60 hover:bg-zinc-900/90 rounded-xl p-3 transition-colors group"
      >
        {/* Left: Video thumbnail (1:1 square from grid first cell) */}
        <div
          onClick={isDone ? handlePlay : undefined}
          className="relative w-28 h-28 flex-shrink-0 rounded-lg overflow-hidden cursor-pointer"
        >
          <img
            src={fullThumbnailSrc}
            alt={clip.title}
            className={`w-full h-full object-cover transition-all duration-500 group-hover:scale-105 ${
              isRendering ? "blur-sm grayscale opacity-60" : "opacity-100"
            }`}
          />
          <div className="absolute inset-0 bg-black/10 group-hover:bg-black/30 transition-colors" />

          {isRendering ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
              <Loader2 className="w-6 h-6 text-red-600 animate-spin mb-1" />
              <span className="text-[10px] font-bold text-white uppercase tracking-tighter mb-1">
                {clip.status === "pending"
                  ? "Waiting..."
                  : getRenderStageLabel(clip.stage, clip.stage) || "Preparing..."}
              </span>
              <div className="w-24 h-1 bg-zinc-700 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-red-700 via-red-500 to-red-600 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${clip.progress}%` }}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                />
              </div>
              <span className="text-[9px] font-mono text-red-400/70 mt-0.5 tabular-nums">
                {Math.round(clip.progress)}%
              </span>
            </div>
          ) : isError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
              <span className="text-[10px] font-bold text-red-500 uppercase tracking-tighter">
                Failed
              </span>
              <span className="text-[9px] text-zinc-400 mt-1 px-2 text-center line-clamp-2">
                {clip.errorMessage}
              </span>
            </div>
          ) : (
            <>
              {/* Duration badge */}
              <div className="absolute top-1.5 right-1.5 bg-black/60 px-1.5 py-0.5 rounded text-[9px] font-bold text-white">
                {clip.duration}
              </div>

              {/* Play icon overlay */}
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="w-9 h-9 bg-white/90 rounded-full flex items-center justify-center text-black shadow-xl">
                  <Play className="w-4 h-4 fill-current" />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Right: Info + Grid preview */}
        <div className="flex-1 flex flex-col justify-between min-w-0 py-0.5">
          {/* Top: title + actions */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white line-clamp-1">
                {clip.title}
              </p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {clip.duration}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {isDone && clip.clipUrl && (
                <>
                  <button
                    onClick={handleGrid}
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-amber-400 transition-colors"
                    title="Multi-frame grid"
                  >
                    {gridLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Grid3X3 className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload();
                    }}
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                    title="Download"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(clip.id);
                  }}
                  className="p-1.5 rounded-lg hover:bg-red-900/30 text-zinc-400 hover:text-red-500 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Bottom: Grid preview thumbnail */}
          <div className="mt-2">
            {gridUrl ? (
              <img
                src={`${API_BASE_URL}${gridUrl}`}
                alt="Frame grid"
                className="h-20 w-auto max-w-full rounded-md object-contain bg-zinc-950 cursor-pointer hover:ring-2 hover:ring-amber-500/50 transition-all"
                onClick={handleGrid}
              />
            ) : (
              isDone && clip.clipUrl && (
                <button
                  onClick={handleGrid}
                  className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-amber-400 transition-colors py-1"
                >
                  <Grid3X3 className="w-3.5 h-3.5" />
                  Generate grid preview
                </button>
              )
            )}
          </div>
        </div>
      </motion.div>

      {/* Grid Modal */}
      <AnimatePresence>
        {showGrid && gridUrl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-8"
            onClick={() => setShowGrid(false)}
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              className="relative max-w-[90vw] max-h-[90vh] overflow-auto rounded-2xl bg-zinc-900 p-2 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowGrid(false)}
                className="absolute top-3 right-3 z-10 w-8 h-8 bg-zinc-800 hover:bg-zinc-700 rounded-full flex items-center justify-center text-white shadow-lg"
              >
                <X className="w-4 h-4" />
              </button>
              <img
                src={`${API_BASE_URL}${gridUrl}`}
                alt="Frame grid"
                className="max-w-full max-h-[85vh] object-contain rounded-xl"
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

interface ClipRowProps {
  videoTitle: string;
  videoThumbnail: string;
  clips: QueuedClip[];
  onDeleteClip?: (clipId: string) => void;
}

export function ClipRow({ videoTitle, videoThumbnail, clips, onDeleteClip }: ClipRowProps) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <img
          src={videoThumbnail}
          alt={videoTitle}
          className="w-9 h-9 rounded-lg object-cover border border-zinc-800"
        />
        <h2 className="text-lg font-bold text-white tracking-tight line-clamp-1">
          {videoTitle}
        </h2>
      </div>
      <div className="flex flex-col gap-2">
        {clips.map((clip, i) => (
          <ClipCard key={clip.id} clip={clip} index={i} onDelete={onDeleteClip} />
        ))}
      </div>
    </div>
  );
}