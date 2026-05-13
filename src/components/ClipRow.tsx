import { motion } from "motion/react";
import { Download, Play, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";

interface Clip {
  id: string;
  thumbnail: string;
  duration: string;
  title: string;
  videoUrl?: string;
}

interface ClipCardProps {
  clip: Clip;
  index: number;
}

export function ClipCard({ clip, index }: ClipCardProps) {
  const [isRendering, setIsRendering] = useState(true);

  const handlePlay = () => {
    if (clip.videoUrl) {
      window.open(clip.videoUrl, '_blank');
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsRendering(false);
    }, 2000 + index * 500); // Staggered rendering finish
    return () => clearTimeout(timer);
  }, [index]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.1 }}
      onClick={!isRendering ? handlePlay : undefined}
      className="relative group min-w-[280px] h-[160px] bg-zinc-900 rounded-md overflow-hidden cursor-pointer"
    >
      <img
        src={clip.thumbnail}
        alt={clip.title}
        className={`w-full h-full object-cover transition-transform duration-500 group-hover:scale-110 ${isRendering ? 'blur-sm grayscale' : ''}`}
      />
      
      <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors" />

      {isRendering ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
          <Loader2 className="w-8 h-8 text-red-600 animate-spin mb-2" />
          <span className="text-xs font-bold text-white uppercase tracking-tighter">Rendering...</span>
        </div>
      ) : (
        <>
          <div className="absolute top-2 right-2 bg-black/60 px-2 py-1 rounded text-[10px] font-bold text-white">
            {clip.duration}
          </div>
          
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex gap-4">
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-black shadow-xl"
              >
                <Play className="w-6 h-6 fill-current" />
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                className="w-12 h-12 bg-zinc-800/80 rounded-full flex items-center justify-center text-white backdrop-blur-sm shadow-xl"
              >
                <Download className="w-6 h-6" />
              </motion.button>
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black to-transparent">
            <p className="text-sm font-medium text-white line-clamp-1">{clip.title}</p>
          </div>
        </>
      )}
    </motion.div>
  );
}

interface ClipRowProps {
  title: string;
  clips: Clip[];
}

export function ClipRow({ title, clips }: ClipRowProps) {
  return (
    <div className="mb-12 last:mb-24">
      <h2 className="text-xl font-bold text-white px-8 mb-4 tracking-tight">{title}</h2>
      <div className="flex gap-4 overflow-x-auto px-8 pb-4 scrollbar-hide no-scrollbar">
        {clips.map((clip, i) => (
          <ClipCard key={clip.id} clip={clip} index={i} />
        ))}
      </div>
    </div>
  );
}
