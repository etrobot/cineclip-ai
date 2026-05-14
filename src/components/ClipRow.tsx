import { motion } from "motion/react";
import { Download, Play, Loader2, Trash2 } from "lucide-react";
import React, { useState } from "react";
import { API_BASE_URL } from "../api/client";
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
  const [isHovered, setIsHovered] = useState(false);

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

  const fullThumbnailSrc = clip.renderedThumbnailUrl
    ? `${API_BASE_URL}${clip.renderedThumbnailUrl}`
    : clip.thumbnail;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.1 }}
      onClick={isDone ? handlePlay : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative group min-w-[180px] w-[180px] h-[320px] bg-zinc-900 rounded-xl overflow-hidden cursor-pointer"
    >
      <img
        src={fullThumbnailSrc}
        alt={clip.title}
        className={`w-full h-full object-cover transition-all duration-700 group-hover:scale-110 ${
          isRendering ? "blur-sm grayscale opacity-60" : "opacity-100"
        }`}
      />

      <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors" />

      {isRendering ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
          <Loader2 className="w-7 h-7 text-red-600 animate-spin mb-2" />
          <span className="text-xs font-bold text-white uppercase tracking-tighter mb-2">
            {clip.status === "pending"
              ? "Waiting..."
              : getRenderStageLabel(clip.stage, clip.stage) || "Preparing..."}
          </span>
          <div className="w-32 h-1 bg-zinc-700 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-red-700 via-red-500 to-red-600 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${clip.progress}%` }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            />
          </div>
          <span className="text-[10px] font-mono text-red-400/70 mt-1 tabular-nums">
            {Math.round(clip.progress)}%
          </span>
        </div>
      ) : isError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
          <span className="text-xs font-bold text-red-500 uppercase tracking-tighter">
            Render Failed
          </span>
          <span className="text-[10px] text-zinc-400 mt-1 px-4 text-center line-clamp-2">
            {clip.errorMessage}
          </span>
        </div>
      ) : (
        <>
          <div className="absolute top-2 right-2 bg-black/60 px-2 py-1 rounded text-[10px] font-bold text-white">
            {clip.duration}
          </div>

          {/* Delete button */}
          {onDelete && (
            <motion.button
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: isHovered ? 1 : 0, scale: isHovered ? 1 : 0.8 }}
              transition={{ duration: 0.2 }}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(clip.id);
              }}
              className="absolute top-2 left-2 w-8 h-8 bg-red-600/80 hover:bg-red-600 rounded-full flex items-center justify-center text-white backdrop-blur-sm shadow-lg z-20"
            >
              <Trash2 className="w-4 h-4" />
            </motion.button>
          )}

          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex gap-4">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={(e) => {
                  e.stopPropagation();
                  handlePlay();
                }}
                className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-black shadow-xl"
              >
                <Play className="w-6 h-6 fill-current" />
              </motion.button>
              {clip.clipUrl && (
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDownload();
                  }}
                  className="w-12 h-12 bg-zinc-800/80 rounded-full flex items-center justify-center text-white backdrop-blur-sm shadow-xl"
                >
                  <Download className="w-6 h-6" />
                </motion.button>
              )}
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black to-transparent">
            <p className="text-sm font-medium text-white line-clamp-2">
              {clip.title}
            </p>
          </div>
        </>
      )}
    </motion.div>
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
    <div className="mb-12 last:mb-24">
      <div className="flex items-center gap-4 px-8 mb-4">
        <img
          src={videoThumbnail}
          alt={videoTitle}
          className="w-10 h-10 rounded-lg object-cover border border-zinc-800"
        />
        <h2 className="text-xl font-bold text-white tracking-tight line-clamp-1">
          {videoTitle}
        </h2>
      </div>
      <div className="flex gap-4 overflow-x-auto px-8 pb-4 scrollbar-hide no-scrollbar">
        {clips.map((clip, i) => (
          <ClipCard key={clip.id} clip={clip} index={i} onDelete={onDeleteClip} />
        ))}
      </div>
    </div>
  );
}
