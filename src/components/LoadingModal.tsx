import { motion, AnimatePresence } from "motion/react";
import { Settings } from "lucide-react";

interface LoadingModalProps {
  isOpen: boolean;
  status: string;
}

export default function LoadingModal({ isOpen, status }: LoadingModalProps) {
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

          <div className="relative flex flex-col items-center gap-12 text-center">
            {/* Centered Rotating Gear with Light Effects */}
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
                className="w-24 h-24 bg-zinc-900 rounded-3xl flex items-center justify-center border border-red-600/30 relative z-10"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 3,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                >
                  <Settings className="w-12 h-12 text-red-600 drop-shadow-[0_0_10px_rgba(220,38,38,0.8)]" />
                </motion.div>
              </motion.div>
              
              {/* Spinning light rings */}
              <motion.div
                animate={{ rotate: -360 }}
                transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                className="absolute inset-[-10px] border border-dashed border-red-600/20 rounded-full"
              />
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                className="absolute inset-[-20px] border border-zinc-800 rounded-full"
              />
            </div>

            <div className="flex flex-col items-center gap-4 relative z-10">
               <AnimatePresence mode="wait">
                 <motion.p
                   key={status}
                   initial={{ y: 20, opacity: 0, filter: "blur(4px)" }}
                   animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                   exit={{ y: -20, opacity: 0, filter: "blur(4px)" }}
                   className="text-2xl font-black tracking-[0.3em] text-white uppercase italic drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]"
                 >
                   {status}
                 </motion.p>
               </AnimatePresence>
               
               <div className="w-48 h-1 bg-zinc-800 rounded-full overflow-hidden relative shadow-[0_0_10px_rgba(0,0,0,0.5)]">
                  <motion.div
                    animate={{
                      left: ["-100%", "100%"],
                    }}
                    transition={{
                      duration: 2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                    className="absolute inset-y-0 w-2/3 bg-gradient-to-r from-transparent via-red-600 to-transparent shadow-[0_0_15px_#e50914]"
                  />
               </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
