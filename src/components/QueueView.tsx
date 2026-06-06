import { motion } from "motion/react";
import { Loader2, Play, Trash2, X, ListVideo, ArrowLeft, AlertTriangle, Check } from "lucide-react";
import type { FetchItem } from "../hooks/useChannelQueue";

interface QueueViewProps {
  items: FetchItem[];
  isFetching: boolean;
  onBack: () => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: (videoId: string) => void;
  onConfirmDelete: (videoId: string) => void;
  onCancelConfirm: (videoId: string) => void;
  onClearDone: () => void;
  onClearQueue: () => void;
}

export function QueueView({
  items,
  isFetching,
  onBack,
  onStart,
  onStop,
  onRemove,
  onConfirmDelete,
  onCancelConfirm,
  onClearDone,
  onClearQueue,
}: QueueViewProps) {
  const idleOrErrorCount = items.filter((item) => (item.status === "idle" || item.status === "error") && !item.needsConfirm).length;
  const needsConfirmCount = items.filter((item) => item.needsConfirm).length;
  const doneCount = items.filter((item) => item.status === "done").length;

  return (
    <motion.div
      key="queue"
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, type: "spring", damping: 20 }}
      className="pt-24 pb-12"
    >
      <nav className="fixed top-0 left-0 right-0 z-40 bg-black/60 backdrop-blur-xl border-b border-zinc-900">
        <div className="max-w-7xl mx-auto px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <h1
              className="text-2xl font-black text-red-600 tracking-tighter uppercase italic cursor-pointer"
              onClick={onBack}
            >
              CineClip
            </h1>
            <div className="hidden md:flex items-center gap-6 text-sm font-bold text-zinc-400 uppercase tracking-widest leading-none">
              <span className="text-white border-b-2 border-red-600 pb-1">
                Queue
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 rounded-full transition-colors text-white text-sm font-bold uppercase tracking-widest"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={onClearDone}
              disabled={doneCount === 0}
              className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-950 disabled:text-zinc-600 rounded-full transition-colors text-white text-sm font-bold uppercase tracking-widest"
            >
              Clear Done
            </button>
            <button
              onClick={onClearQueue}
              disabled={items.length === 0}
              className="p-2 hover:bg-red-900/30 disabled:hover:bg-transparent rounded-full transition-colors text-red-500 disabled:text-zinc-700"
              title="Clear queue"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-6">
        <div className="mb-6 p-5 rounded-2xl border border-zinc-800 bg-zinc-950/80 backdrop-blur-xl flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-widest text-zinc-400">Batch Queue</p>
            <p className="text-zinc-200 mt-1">{doneCount}/{items.length} done</p>
          </div>
          {isFetching ? (
            <button
              onClick={onStop}
              className="px-5 py-3 bg-zinc-700 hover:bg-zinc-600 text-white rounded-xl font-bold uppercase tracking-widest text-sm flex items-center gap-2 transition-colors"
            >
              <X className="w-4 h-4" />
              Stop
            </button>
          ) : (
            <button
              onClick={onStart}
              disabled={idleOrErrorCount === 0}
              className="px-5 py-3 bg-red-600 hover:bg-red-700 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-xl font-bold uppercase tracking-widest text-sm flex items-center gap-2 transition-colors"
            >
              <Play className="w-4 h-4" />
              {idleOrErrorCount > 0 ? `Start Fetch (${idleOrErrorCount})` : needsConfirmCount > 0 ? "Confirm First" : "All Done"}
            </button>
          )}
        </div>

        {items.length > 0 ? (
          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.video.videoId}
                className="flex items-center gap-4 px-4 py-3 bg-zinc-950/80 border border-zinc-800 rounded-2xl"
              >
                {item.video.thumbnail ? (
                  <img
                    src={item.video.thumbnail}
                    alt=""
                    className="w-24 h-14 object-cover rounded-lg flex-shrink-0 bg-zinc-900"
                  />
                ) : (
                  <div className="w-24 h-14 rounded-lg bg-zinc-900 flex items-center justify-center flex-shrink-0">
                    <ListVideo className="w-5 h-5 text-zinc-600" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-100 truncate">{item.video.title}</p>
                  {item.needsConfirm && (
                    <div className="flex items-center gap-2 mt-1.5 px-2 py-1.5 rounded-lg bg-amber-900/20 border border-amber-600/30">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                      <span className="text-xs text-amber-400">
                        Already extracted ({item.existingClipCount} clips). Delete &amp; re-extract?
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onConfirmDelete(item.video.videoId); }}
                        className="ml-auto px-2 py-0.5 bg-amber-600 hover:bg-amber-500 text-black rounded text-xs font-bold uppercase tracking-wider"
                      >
                        Yes
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onCancelConfirm(item.video.videoId); }}
                        className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded text-xs font-bold uppercase tracking-wider"
                      >
                        No
                      </button>
                    </div>
                  )}
                  {!item.needsConfirm && (
                    <>
                      <div className="flex items-center gap-2 mt-2">
                        <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              item.status === "error"
                                ? "bg-red-600"
                                : item.status === "done"
                                ? "bg-green-500"
                                : item.confirmDelete
                                ? "bg-amber-500"
                                : "bg-red-500"
                            }`}
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                        <span className="text-xs text-zinc-500 w-10 text-right">{Math.round(item.progress)}%</span>
                      </div>
                      <p className={`text-xs mt-1 ${
                        item.status === "error" ? "text-red-400" : item.status === "done" ? "text-green-400" : item.confirmDelete ? "text-amber-400" : "text-zinc-500"
                      }`}>
                        {item.status === "idle" && (item.confirmDelete ? "Will re-extract (delete first)" : "Waiting...")}
                        {item.status === "analyzing" && "Analyzing..."}
                        {item.status === "rendering" && "Rendering clips..."}
                        {item.status === "segmenting" && "Segmenting shots..."}
                        {item.status === "done" && "Complete"}
                        {item.status === "error" && `Error: ${item.error || item.message}`}
                      </p>
                    </>
                  )}
                </div>
                {isFetching && (item.status === "analyzing" || item.status === "rendering" || item.status === "segmenting") ? (
                  <Loader2 className="w-4 h-4 animate-spin text-red-500 flex-shrink-0" />
                ) : (
                  <button
                    onClick={() => onRemove(item.video.videoId)}
                    disabled={isFetching && item.status !== "done" && item.status !== "error" && item.status !== "idle"}
                    className="p-2 hover:bg-zinc-800 disabled:hover:bg-transparent rounded-full transition-colors text-zinc-500 hover:text-red-400 disabled:text-zinc-800"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-zinc-500 py-24 gap-4">
            <ListVideo className="w-12 h-12 text-zinc-700" />
            <p className="text-xl">Queue is empty.</p>
            <p className="text-sm text-zinc-600">Add videos from Channel Browser to start a batch.</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
