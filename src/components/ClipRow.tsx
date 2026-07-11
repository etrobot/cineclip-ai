import { motion, AnimatePresence } from "motion/react";
import { Download, Play, Loader2, Trash2, Film, ChevronDown, ChevronUp, RotateCcw, Grid2x2, Trash2 as TrashVideo, Table2, ExternalLink } from "lucide-react";
import React, { useState, useEffect } from "react";
import { API_BASE_URL, listShots, getServerConfig, type ShotInfo, type SubtitleItem } from "../api/client";
import type { ClipItem } from "../App";
import type { ShotQueueItem, EnqueueShotParams } from "../hooks/useShotQueue";
import { StoryboardView } from "./StoryboardView";

interface ClipCardProps {
  clip: ClipItem;
  index: number;
  onDelete?: (clipId: string) => void;
  onRetry?: (clipId: string) => void;
  subtitles?: SubtitleItem[];
  shotQueueItem?: ShotQueueItem;
  queuePosition: number;
  onEnqueueShot: (params: EnqueueShotParams) => void;
  onRetryShot: (clipId: string) => void;
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

export const ClipCard: React.FC<ClipCardProps> = ({ clip, index, onDelete, onRetry, subtitles, shotQueueItem, queuePosition, onEnqueueShot, onRetryShot }) => {
  const isRendering = clip.status === "pending" || clip.status === "rendering";
  const isError = clip.status === "error";
  const isDone = clip.status === "done";
  // Shot segmentation state
  const [shots, setShots] = useState<ShotInfo[]>([]);
  const [showShots, setShowShots] = useState(false);
  const [vlEnabled, setVlEnabled] = useState<boolean | null>(null);
  const [gridUrl, setGridUrl] = useState<string>('');
  const [showGrid, setShowGrid] = useState(false);

  // Derive shot-detection status from queue item
  const shotStatus = shotQueueItem?.status;
  const isShotQueued = shotStatus === "pending";
  const isShotProcessing = shotStatus === "processing";
  const isShotError = shotStatus === "error";

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

  // Check if VL model is configured
  useEffect(() => {
    getServerConfig().then(cfg => {
      setVlEnabled(!!cfg.vlModel);
    }).catch(() => setVlEnabled(false));
  }, []);

  // Load existing shots on mount
  useEffect(() => {
    if (!isDone) return;
    listShots(clip.id)
      .then(data => {
        if (data.shots.length > 0) {
          const mapped = data.shots.map(s => ({
            start: 0,
            end: 0,
            label: s.label || `Shot ${s.idx + 1}`,
            clipUrl: s.clipUrl,
            thumbnailUrl: s.thumbnailUrl || '',
            duration: s.duration || '',
          }));
          setShots(mapped);
        }
      })
      .catch(() => {});
  }, [clip.id, isDone]);

  // React to shot-queue status changes: populate shots when detection completes
  useEffect(() => {
    if (shotQueueItem?.status === "done" && shotQueueItem.result) {
      setShots(shotQueueItem.result.shots);
      if (shotQueueItem.result.gridUrl) {
        setGridUrl(shotQueueItem.result.gridUrl);
      }
      setShowShots(true);
    }
  }, [shotQueueItem?.status, shotQueueItem?.result]);

  const handleDetectShots = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!clip.clipUrl) return;
    // Ignore if already pending or processing
    if (isShotQueued || isShotProcessing) return;
    // Clear old shots when (re-)queueing
    setShots([]);
    onEnqueueShot({
      clipUrl: clip.clipUrl,
      clipId: clip.id,
      clipTitle: clip.title,
      subtitles,
    });
  };

  const handleRetryShot = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRetryShot(clip.id);
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
                {onRetry && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry(clip.id);
                    }}
                    className="mt-2 inline-flex items-center gap-1 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-red-600/90 hover:bg-red-500/90 text-white"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Retry
                  </button>
                )}
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
                  {/* Detect Shots button - only show when VL model configured */}
                  {vlEnabled && (
                    <>
                      <button
                        onClick={isShotError ? handleRetryShot : handleDetectShots}
                        disabled={isShotQueued || isShotProcessing}
                        className={`relative p-1.5 rounded-lg transition-colors disabled:opacity-60 ${
                          isShotError
                            ? "hover:bg-red-900/30 text-red-500 hover:text-red-400"
                            : isShotProcessing
                            ? "text-emerald-400"
                            : "hover:bg-zinc-800 text-zinc-400 hover:text-emerald-400"
                        }`}
                        title={
                          isShotError
                            ? `Error: ${shotQueueItem?.errorMessage || "Failed"}. Click to retry.`
                            : isShotProcessing
                            ? "Detecting shots..."
                            : isShotQueued
                            ? `Queued #${queuePosition}`
                            : "Detect shots"
                        }
                      >
                        {isShotProcessing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : isShotError ? (
                          <RotateCcw className="w-4 h-4" />
                        ) : (
                          <Film className="w-4 h-4" />
                        )}
                        {isShotQueued && (
                          <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-black text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
                            {queuePosition}
                          </span>
                        )}
                      </button>
                    </>
                  )}
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

          {/* Bottom: Shots toggle */}
          <div className="mt-2 space-y-2">
            {/* Shots + Grid toggle */}
            {shots.length > 0 && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowShots(!showShots)}
                  className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-emerald-400 transition-colors py-1"
                >
                  {showShots ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                  {shots.length} shot{shots.length > 1 ? 's' : ''} detected
                </button>
                {gridUrl && (
                  <button
                    onClick={() => setShowGrid(!showGrid)}
                    className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-amber-400 transition-colors py-1"
                  >
                    <Grid2x2 className="w-3.5 h-3.5" />
                    {showGrid ? 'Hide' : 'Show'} grid
                  </button>
                )}
              </div>
            )}

            {/* Grid image preview */}
            <AnimatePresence>
              {showGrid && gridUrl && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <a
                    href={gridUrl.startsWith('http') ? gridUrl : `${API_BASE_URL}${gridUrl}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-600 transition-colors"
                  >
                    <img
                      src={gridUrl.startsWith('http') ? gridUrl : `${API_BASE_URL}${gridUrl}`}
                      alt="Scene grid"
                      className="w-full h-auto"
                    />
                  </a>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Shots list */}
            <AnimatePresence>
              {showShots && shots.length > 0 && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 pt-1">
                    {shots.map((shot, idx) => (
                      <div
                        key={shot.clipUrl || `${idx}-${shot.label}`}
                        className="group/shot relative rounded-lg overflow-hidden bg-zinc-950 cursor-pointer"
                        onClick={() => {
                          const url = shot.clipUrl.startsWith('http')
                            ? shot.clipUrl
                            : `${API_BASE_URL}${shot.clipUrl}`;
                          window.open(url, '_blank');
                        }}
                      >
                        <div className="aspect-video relative">
                          {shot.thumbnailUrl ? (
                            <img
                              src={shot.thumbnailUrl.startsWith('http') ? shot.thumbnailUrl : `${API_BASE_URL}${shot.thumbnailUrl}`}
                              alt={shot.label}
                              className="w-full h-full object-cover group-hover/shot:scale-105 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                              <Film className="w-5 h-5 text-zinc-600" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/20 group-hover/shot:bg-black/40 transition-colors" />
                          {/* Duration badge */}
                          {shot.duration && (
                            <div className="absolute bottom-1 right-1 bg-black/70 px-1 py-0.5 rounded text-[9px] font-bold text-white">
                              {shot.duration}
                            </div>
                          )}
                          {/* Play overlay */}
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/shot:opacity-100 transition-opacity">
                            <div className="w-7 h-7 bg-white/90 rounded-full flex items-center justify-center text-black shadow-lg">
                              <Play className="w-3 h-3 fill-current" />
                            </div>
                          </div>
                        </div>
                        <div className="px-1.5 py-1">
                          <p className="text-[10px] text-zinc-400 truncate">{shot.label}</p>
                          {shot.category && <p className="text-[9px] text-zinc-600 truncate">{shot.category}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>

    </>
  );
};

interface ClipRowProps {
  videoTitle: string;
  videoThumbnail: string;
  clips: ClipItem[];
  videoId: string;
  postUrl?: string;
  onDeleteClip?: (clipId: string) => void;
  onDeleteVideo?: (videoId: string) => void;
  onRetryClip?: (clipId: string) => void;
  subtitles?: SubtitleItem[];
  shotQueueItems: ShotQueueItem[];
  onEnqueueShot: (params: EnqueueShotParams) => void;
  onRetryShot: (clipId: string) => void;
}

export function ClipRow({ videoTitle, videoThumbnail, clips, videoId, postUrl, onDeleteClip, onDeleteVideo, onRetryClip, subtitles, shotQueueItems, onEnqueueShot, onRetryShot }: ClipRowProps) {
  // Pre-compute pending items list for position calculation
  const pendingItems = shotQueueItems.filter((item) => item.status === "pending");
  const [showStoryboard, setShowStoryboard] = useState(false);

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
        {postUrl && (
          <a
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-blue-400 transition-colors"
            title="打开原视频"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            onClick={() => setShowStoryboard(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-emerald-400 transition-colors text-xs font-medium"
            title="Generate storyboard"
          >
            <Table2 className="w-4 h-4" />
            <span className="hidden sm:inline">Sheet</span>
          </button>
          {onDeleteVideo && (
            <button
              onClick={() => onDeleteVideo(videoId)}
              className="p-1.5 rounded-lg hover:bg-red-900/30 text-zinc-400 hover:text-red-500 transition-colors"
              title="Delete all clips for this video"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {clips.map((clip, i) => {
          const shotItem = shotQueueItems.find((item) => item.clipId === clip.id);
          const queuePosition = shotItem?.status === "pending"
            ? pendingItems.findIndex((item) => item.clipId === clip.id) + 1
            : 0;
          return (
            <ClipCard
              key={clip.id}
              clip={clip}
              index={i}
              onDelete={onDeleteClip}
              onRetry={onRetryClip}
              subtitles={subtitles}
              shotQueueItem={shotItem}
              queuePosition={queuePosition}
              onEnqueueShot={onEnqueueShot}
              onRetryShot={onRetryShot}
            />
          );
        })}
      </div>

      {/* Storyboard Modal */}
      <StoryboardView
        isOpen={showStoryboard}
        onClose={() => setShowStoryboard(false)}
        videoId={videoId}
        videoTitle={videoTitle}
      />
    </div>
  );
}
