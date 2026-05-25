import React from 'react';
import { useState, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { searchShots, type ShotSearchGroup, type ShotSearchShot } from '../api/client';
import { motion, AnimatePresence } from 'motion/react';

function formatTime(seconds: number | null): string {
  if (seconds === null) return '--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function ShotSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShotSearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    const data = await searchShots(query.trim());
    setResults(data.results);
    setLoading(false);
  }, [query]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setResults([]);
    setQuery('');
    setError(null);
  }, []);

  return (
    <>
      {/* Search toggle button */}
      <button
        onClick={() => setIsOpen(true)}
        className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-400 hover:text-white"
        title="Search shots"
      >
        <Search className="w-5 h-5" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            key="shot-search"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"
          >
            <div className="max-w-3xl mx-auto pt-24 px-6">
              {/* Search bar */}
              <div className="flex items-center gap-3 mb-6">
                <div className="flex-1 flex items-center bg-zinc-900 rounded-lg border border-zinc-700 px-4 py-3">
                  <Search className="w-4 h-4 text-zinc-500 mr-3" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search shots by label or category..."
                    className="flex-1 bg-transparent text-white outline-none placeholder:text-zinc-500 text-sm"
                    autoFocus
                  />
                </div>
                <button
                  onClick={handleSearch}
                  disabled={loading || !query.trim()}
                  className="px-4 py-3 bg-red-600 text-white rounded-lg font-bold text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? '...' : 'Search'}
                </button>
                <button
                  onClick={handleClose}
                  className="p-3 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {error && (
                <div className="text-red-500 text-sm mb-4">{error}</div>
              )}

              {/* Results */}
              {results.length > 0 ? (
                <div className="space-y-4">
                  {results.map((group) => (
                    <div key={group.sourceClipId} className="bg-zinc-900/80 rounded-lg border border-zinc-800 p-4">
                      {/* Clip header */}
                      <div className="flex items-center gap-3 mb-3">
                        {group.clip.thumbnailUrl && (
                          <img
                            src={group.clip.thumbnailUrl}
                            alt=""
                            className="w-10 h-10 rounded object-cover"
                          />
                        )}
                        <div>
                          <div className="text-white font-bold text-sm">
                            {group.clip.title || group.sourceClipId}
                          </div>
                          <div className="text-zinc-500 text-xs">
                            {group.clip.fileName}
                            {group.clip.startTime !== null && group.clip.endTime !== null && (
                              <> &middot; {formatTime(group.clip.startTime)} - {formatTime(group.clip.endTime)}</>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Shot list */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {group.shots.map((shot) => (
                          <ShotCard key={shot.id} shot={shot} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : !loading && query && results.length === 0 ? (
                <div className="text-zinc-500 text-center py-10">
                  No shots found for "{query}"
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

const ShotCard: React.FC<{ shot: ShotSearchShot }> = ({ shot }) => {
  return (
    <div className="flex items-center gap-2 bg-zinc-800/60 rounded px-3 py-2 text-sm">
      {shot.thumbnailUrl && (
        <img
          src={shot.thumbnailUrl}
          alt=""
          className="w-12 h-8 rounded object-cover flex-shrink-0"
        />
      )}
      <div className="min-w-0">
        <div className="text-white truncate">{shot.label || `Shot ${shot.idx + 1}`}</div>
        <div className="text-zinc-500 text-xs flex items-center gap-2">
          {shot.category && (
            <span className="bg-zinc-700 text-zinc-300 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {shot.category}
            </span>
          )}
          <span>{formatTime(shot.start)} - {formatTime(shot.end)}</span>
        </div>
      </div>
    </div>
  );
}