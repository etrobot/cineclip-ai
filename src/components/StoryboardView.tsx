import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Loader2, Table2, AlertCircle, RotateCcw, Download } from "lucide-react";
import { generateStoryboard, type StoryboardResult } from "../api/client";

interface StoryboardViewProps {
  isOpen: boolean;
  onClose: () => void;
  videoId: string;
  videoTitle: string;
}

export function StoryboardView({ isOpen, onClose, videoId, videoTitle }: StoryboardViewProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<StoryboardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStoryboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await generateStoryboard(videoId);
      setResult(data);
    } catch (err: any) {
      setError(err?.message || "Failed to generate storyboard");
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    if (isOpen && videoId) {
      fetchStoryboard();
    }
  }, [isOpen, videoId, fetchStoryboard]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setResult(null);
      setError(null);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="relative w-full max-w-6xl max-h-[85vh] bg-zinc-900 rounded-2xl border border-zinc-800 shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <Table2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-white truncate">
                    分镜表
                  </h2>
                  <p className="text-xs text-zinc-500 truncate">{videoTitle}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {result && !loading && !error && (
                  <button
                    onClick={() => exportAsCSV(result)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-medium transition-colors"
                    title="Export as CSV"
                  >
                    <Download className="w-3.5 h-3.5" />
                    CSV
                  </button>
                )}
                {error && !loading && (
                  <button
                    onClick={fetchStoryboard}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Loading state */}
              {loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                  <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                  <p className="text-sm text-zinc-400">正在生成分镜表...</p>
                  <p className="text-xs text-zinc-600">LLM 正在分析字幕和镜头数据</p>
                </div>
              )}

              {/* Error state */}
              {error && !loading && (
                <div className="flex flex-col items-center justify-center py-20 gap-4 max-w-md mx-auto text-center">
                  <AlertCircle className="w-10 h-10 text-amber-400" />
                  <p className="text-sm text-zinc-300 font-medium">{error}</p>
                  {error.includes("Detect shots") || error.includes("检测镜头") || error.includes("缺少镜头") ? (
                    <p className="text-xs text-zinc-500">
                      请先返回 Gallery，点击每个 clip 的镜头检测按钮，完成后再生成分镜表。
                    </p>
                  ) : null}
                </div>
              )}

              {/* Result */}
              {result && !loading && !error && (
                <div className="space-y-4">
                  {/* Summary */}
                  {result.summary && (
                    <div className="bg-zinc-800/50 rounded-lg p-4 border border-zinc-700/50">
                      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">视频概述</p>
                      <p className="text-sm text-zinc-200 leading-relaxed">{result.summary}</p>
                    </div>
                  )}

                  {/* Stats */}
                  <div className="flex items-center gap-4 text-xs text-zinc-500">
                    <span>{result.totalClips} 个片段</span>
                    <span className="text-zinc-700">|</span>
                    <span>{result.totalShots} 个镜头</span>
                  </div>

                  {/* Storyboard Table */}
                  <div className="overflow-x-auto rounded-lg border border-zinc-800">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-zinc-800/80 text-zinc-400">
                          <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap w-10">#</th>
                          <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">时间码</th>
                          <th className="px-3 py-2.5 text-left font-semibold min-w-[120px]">片段</th>
                          <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap w-20">景别</th>
                          <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap w-20">运镜</th>
                          <th className="px-3 py-2.5 text-left font-semibold min-w-[200px]">画面内容</th>
                          <th className="px-3 py-2.5 text-left font-semibold min-w-[150px]">台词</th>
                          <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap w-20">叙事</th>
                          <th className="px-3 py-2.5 text-left font-semibold min-w-[100px]">备注</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.storyboard.map((entry, idx) => (
                          <tr
                            key={idx}
                            className="border-t border-zinc-800 hover:bg-zinc-800/30 transition-colors"
                          >
                            <td className="px-3 py-2.5 text-zinc-500 font-mono text-xs">
                              {entry.shotNumber}
                            </td>
                            <td className="px-3 py-2.5 text-zinc-400 font-mono text-xs whitespace-nowrap">
                              {entry.timeRange}
                            </td>
                            <td className="px-3 py-2.5 text-zinc-300 text-xs">
                              {entry.clipTitle}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-700/50 text-zinc-300">
                                {entry.shotType || '-'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900/30 text-blue-300">
                                {entry.cameraMovement || '-'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-zinc-300 text-xs leading-relaxed">
                              {entry.visualContent || '-'}
                            </td>
                            <td className="px-3 py-2.5 text-zinc-400 text-xs italic leading-relaxed">
                              {entry.dialogue || '-'}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${getRoleColor(entry.narrativeRole)}`}>
                                {entry.narrativeRole || '-'}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-zinc-500 text-xs">
                              {entry.notes || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function getRoleColor(role: string): string {
  const r = (role || '').toLowerCase();
  if (r.includes('开场') || r.includes('opening')) return 'bg-green-900/30 text-green-300';
  if (r.includes('高潮') || r.includes('climax')) return 'bg-red-900/30 text-red-300';
  if (r.includes('结尾') || r.includes('ending')) return 'bg-purple-900/30 text-purple-300';
  if (r.includes('转场') || r.includes('transition')) return 'bg-amber-900/30 text-amber-300';
  if (r.includes('铺垫') || r.includes('setup')) return 'bg-blue-900/30 text-blue-300';
  return 'bg-zinc-700/50 text-zinc-300';
}

/** Export storyboard as CSV file */
function exportAsCSV(result: StoryboardResult) {
  const headers = ['Shot #', 'Time Range', 'Clip', 'Shot Type', 'Camera Movement', 'Visual Content', 'Dialogue', 'Narrative Role', 'Notes'];
  const rows = result.storyboard.map(entry => [
    entry.shotNumber,
    entry.timeRange,
    entry.clipTitle,
    entry.shotType,
    entry.cameraMovement,
    entry.visualContent,
    entry.dialogue,
    entry.narrativeRole,
    entry.notes,
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `storyboard_${result.videoId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
