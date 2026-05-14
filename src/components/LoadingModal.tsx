import { motion, AnimatePresence } from "motion/react";
import { Settings, Check } from "lucide-react";

interface LoadingModalProps {
  isOpen: boolean;
  status: string;       // Current stage key
  progress: number;     // 0-100
}

/**
 * Pipeline stages shown in the loading modal.
 * Each stage has a label and the progress range it covers.
 */
const STAGES = [
  { key: "subtitles",  label: "Getting Subtitles", icon: "📝" },
  { key: "analyzing",  label: "Analyzing",         icon: "🧠" },
  { key: "splitting",  label: "Splitting",         icon: "✂️" },
] as const;

function getStageIndex(status: string): number {
  // Map backend stage names to UI stage index
  const stageMap: Record<string, number> = {
    extracting: 0,
    subtitles: 0,
    analyzing: 1,
    splitting: 2,
    downloading: 2,   // download happens alongside splitting
    complete: 2,
  };
  return stageMap[status] ?? 0;
}

export default function LoadingModal({ isOpen, status, progress }: LoadingModalProps) {
  const currentStageIdx = getStageIndex(status);
  const isComplete = status === "complete" || progress >= 100;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md"
        >
          {/* Background light pulse */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <motion.div
              animate={{
                scale: [1, 1.1, 1],
                opacity: [0.3, 0.6, 0.3],
              }}
              transition={{ duration: 4, repeat: Infinity }}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-red-600/10 rounded-full blur-[120px]"
            />
          </div>

          <div className="relative flex flex-col items-center gap-10 text-center">
            {/* Rotating Gear */}
            <div className="relative">
              <motion.div
                animate={{
                  boxShadow: [
                    "0 0 20px rgba(220, 38, 38, 0.2)",
                    "0 0 60px rgba(220, 38, 38, 0.5)",
                    "0 0 20px rgba(220, 38, 38, 0.2)",
                  ],
                }}
                transition={{ duration: 2, repeat: Infinity }}
                className="w-20 h-20 bg-zinc-900 rounded-2xl flex items-center justify-center border border-red-600/30 relative z-10"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                >
                  <Settings className="w-10 h-10 text-red-600 drop-shadow-[0_0_10px_rgba(220,38,38,0.8)]" />
                </motion.div>
              </motion.div>

              {/* Spinning light rings */}
              <motion.div
                animate={{ rotate: -360 }}
                transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                className="absolute inset-[-8px] border border-dashed border-red-600/20 rounded-full"
              />
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                className="absolute inset-[-16px] border border-zinc-800 rounded-full"
              />
            </div>

            {/* Stage Steps */}
            <div className="flex flex-col items-center gap-5 relative z-10">

              {/* Current step detail text with animation */}
              <AnimatePresence mode="wait">
                <motion.p
                  key={status}
                  initial={{ y: 15, opacity: 0, filter: "blur(4px)" }}
                  animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                  exit={{ y: -15, opacity: 0, filter: "blur(4px)" }}
                  transition={{ duration: 0.3 }}
                  className="text-lg font-black tracking-[0.2em] text-white uppercase italic drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                >
                  {isComplete ? "Done" : STAGES[currentStageIdx]?.label || status}
                </motion.p>
              </AnimatePresence>

              {/* Overall progress bar */}
              <div className="w-56 h-1 bg-zinc-800 rounded-full overflow-hidden relative shadow-[0_0_10px_rgba(0,0,0,0.5)]">
                <motion.div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-red-700 via-red-500 to-red-600 shadow-[0_0_15px_#e50914] rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
                <motion.div
                  animate={{ left: ["-100%", "200%"] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                />
              </div>

              {/* Percentage */}
              <span className="text-xs font-mono font-bold text-red-500/60 tabular-nums">
                {Math.round(progress)}%
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
