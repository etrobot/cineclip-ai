import { useState } from "react";
import Hero from "./components/Hero";
import LoadingModal from "./components/LoadingModal";
import GlowBackground from "./components/GlowBackground";
import { ClipRow } from "./components/ClipRow";
import { motion, AnimatePresence } from "motion/react";
import { LogOut, Plus } from "lucide-react";
import { analyzeVideo, downloadVideo, type Clip } from "./api/client";

type AppView = "home" | "loading" | "results";

interface ClipItem {
  id: string;
  videoUrl: string;
  title: string;
  duration: string;
  thumbnail: string;
  start: number;
  end: number;
}

interface ClipCategory {
  category: string;
  items: ClipItem[];
}

export default function App() {
  const [view, setView] = useState<AppView>("home");
  const [status, setStatus] = useState("Getting Subtitle");
  const [clips, setClips] = useState<ClipCategory[]>([]);
  const [videoData, setVideoData] = useState<{ videoId: string; title: string; thumbnail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const groupClipsByCategory = (clipsData: Clip[], videoId: string, thumbnail: string): ClipCategory[] => {
    const grouped = new Map<string, ClipItem[]>();

    clipsData.forEach((clip, index) => {
      const category = clip.category || "Highlights";
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }

      grouped.get(category)!.push({
        id: `${videoId}_${index}`,
        videoUrl: `https://youtube.com/watch?v=${videoId}`,
        title: clip.title,
        duration: formatDuration(clip.end - clip.start),
        thumbnail,
        start: clip.start,
        end: clip.end,
      });
    });

    return Array.from(grouped.entries()).map(([category, items]) => ({
      category,
      items,
    }));
  };

  const startAnalysis = async (url: string) => {
    console.log("Analyzing URL:", url);
    setView("loading");
    setError(null);
    setStatus("Getting Subtitle");

    try {
      // Step 1: Get subtitles
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Step 2: Analyze with LLM
      setStatus("Analyzing");
      const result = await analyzeVideo(url);
      
      // Step 3: Download video
      setStatus("Downloading Video");
      await downloadVideo(result.videoId);
      
      // Step 4: Process clips
      setStatus("Processing Clips");
      const groupedClips = groupClipsByCategory(result.clips, result.videoId, result.thumbnail);
      setClips(groupedClips);
      setVideoData({
        videoId: result.videoId,
        title: result.title,
        thumbnail: result.thumbnail,
      });

      // Step 5: Done
      await new Promise(resolve => setTimeout(resolve, 500));
      setStatus("Redirecting");
      await new Promise(resolve => setTimeout(resolve, 500));
      setView("results");
    } catch (err: any) {
      console.error("Analysis error:", err);
      setError(err.message || "Failed to analyze video");
      setStatus("Error");
      // Return to home after showing error
      setTimeout(() => {
        setView("home");
        setError(null);
      }, 3000);
    }
  };

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
            <Hero onSearch={startAnalysis} onGoToGallery={() => setView("results")} />
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
                  <h1 className="text-2xl font-black text-red-600 tracking-tighter uppercase italic cursor-pointer" onClick={() => setView("home")}>
                    CineClip
                  </h1>
                  <div className="hidden md:flex items-center gap-6 text-sm font-bold text-zinc-400 uppercase tracking-widest leading-none">
                    <span className="text-white border-b-2 border-red-600 pb-1">Gallery</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <button onClick={() => setView("home")} className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-white">
                    <Plus className="w-5 h-5" />
                  </button>
                  <button onClick={() => setView("home")} className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-500">
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </nav>

            {/* Clip Rows */}
            <div className="pt-8">
              {clips.length > 0 ? (
                clips.map((row) => (
                  <ClipRow key={row.category} title={row.category} clips={row.items} />
                ))
              ) : (
                <div className="text-center text-zinc-500 py-20">
                  <p className="text-xl">No clips available. Analyze a video to get started.</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <LoadingModal isOpen={view === "loading"} status={error || status} />
    </div>
  );
}
