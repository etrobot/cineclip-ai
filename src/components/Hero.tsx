import { motion } from "motion/react";
import { Search, Youtube, TrendingUp, Star, Award, Grid } from "lucide-react";
import React, { useState } from "react";

interface HeroProps {
  onSearch: (url: string) => void;
  onGoToGallery: () => void;
}

export default function Hero({ onSearch, onGoToGallery }: HeroProps) {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url) onSearch(url);
  };

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 overflow-hidden">
      {/* Top Navigation for Gallery */}
      <div className="absolute top-0 right-0 p-8 z-20">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onGoToGallery}
          className="flex items-center gap-2 px-6 py-3 bg-zinc-900/50 hover:bg-zinc-800/80 backdrop-blur-xl border border-white/5 rounded-full text-white font-bold tracking-widest text-xs uppercase"
        >
          <Grid className="w-4 h-4 text-red-600" />
          <span>Gallery</span>
        </motion.button>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="z-10 text-center w-full max-w-4xl"
      >
        <div className="flex items-center justify-center gap-3 mb-6">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, damping: 10, delay: 0.2 }}
            className="p-3 bg-red-600 rounded-2xl shadow-[0_0_40px_rgba(229,9,20,0.4)]"
          >
            <Youtube className="w-8 h-8 text-white fill-current" />
          </motion.div>
          <h1 className="text-5xl md:text-7xl font-black text-white tracking-tighter uppercase italic">
            Cine<span className="text-red-600">Clip</span>
          </h1>
        </div>
        
        <p className="text-zinc-400 text-lg md:text-xl mb-12 max-w-2xl mx-auto leading-relaxed">
          Transform any long-form video into high-impact, short-form viral clips instantly with AI.
        </p>

        <form onSubmit={handleSubmit} className="relative max-w-2xl mx-auto group">
          <div className="absolute -inset-1 bg-gradient-to-r from-red-600 to-purple-600 rounded-2xl blur opacity-25 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
          <div className="relative flex p-1 bg-zinc-950 border border-zinc-800/50 rounded-2xl overflow-hidden backdrop-blur-2xl">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste YouTube link here..."
              className="flex-1 bg-transparent border-none outline-none px-6 py-4 text-white text-lg placeholder:text-zinc-600"
            />
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              type="submit"
              className="relative overflow-hidden group/btn bg-red-600 text-white px-8 py-4 rounded-xl font-black uppercase tracking-widest flex items-center gap-2 transition-all shadow-[0_0_20px_rgba(229,9,20,0.4)] hover:shadow-[0_0_40px_rgba(229,9,20,0.6)]"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover/btn:animate-[shimmer_1.5s_infinite]" />
              <Search className="w-5 h-5" />
              <span>Extract</span>
            </motion.button>
          </div>
        </form>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="mt-16 flex flex-wrap justify-center gap-12"
        >
          {[
            { icon: TrendingUp, label: "Viral Indexing" },
            { icon: Star, label: "AI Selection" },
            { icon: Award, label: "Studio Quality" }
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3 text-zinc-500">
              <item.icon className="w-5 h-5 text-red-600/60" />
              <span className="text-sm font-bold uppercase tracking-widest">{item.label}</span>
            </div>
          ))}
        </motion.div>
      </motion.div>

      {/* Decorative lines */}
      <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-red-600/20 to-transparent shadow-[0_0_20px_rgba(229,9,20,0.1)]" />
      <div className="absolute bottom-0 right-0 w-full h-px bg-gradient-to-r from-transparent via-purple-600/20 to-transparent shadow-[0_0_20px_rgba(147,51,234,0.1)]" />
    </div>
  );
}
