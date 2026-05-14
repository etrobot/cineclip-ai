import { useState, useCallback, useRef } from "react";
import {
  renderClip,
  subscribeProgress,
  generateJobId,
  type ProgressEvent,
} from "../api/client";
import type { ClipItem } from "../App";

export interface QueuedClip extends ClipItem {
  status: "pending" | "rendering" | "done" | "error";
  progress: number;
  stage: string;
  errorMessage?: string;
  clipUrl?: string;
  renderedThumbnailUrl?: string;
}

export function useRenderQueue() {
  const [clips, setClips] = useState<QueuedClip[]>([]);
  const clipsRef = useRef<QueuedClip[]>([]);
  const runningRef = useRef(false);

  // Keep ref in sync with state
  const syncRef = useCallback((next: QueuedClip[] | ((prev: QueuedClip[]) => QueuedClip[])) => {
    setClips((prev) => {
      const updated = typeof next === "function" ? next(prev) : next;
      clipsRef.current = updated;
      return updated;
    });
  }, []);

  const updateClip = useCallback(
    (clipId: string, patch: Partial<QueuedClip>) => {
      syncRef((prev) =>
        prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c))
      );
    },
    [syncRef]
  );

  const processQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    while (true) {
      const nextClip = clipsRef.current.find((c) => c.status === "pending");
      if (!nextClip) break;

      const jobId = generateJobId();
      updateClip(nextClip.id, {
        status: "rendering",
        progress: 0,
        stage: "Preparing...",
      });

      let unsubscribe: (() => void) | null = null;
      let progressDone = false;

      try {
        const renderPromise = renderClip(
          nextClip.videoId,
          nextClip.start,
          nextClip.end,
          undefined,
          nextClip.title,
          nextClip.subtitles,
          jobId
        );

        const progressPromise = new Promise<void>((resolve, reject) => {
          unsubscribe = subscribeProgress(
            jobId,
            (event: ProgressEvent) => {
              updateClip(nextClip.id, {
                progress: event.progress,
                stage: event.message || event.stage,
              });
            },
            () => {
              progressDone = true;
              resolve();
            },
            (message: string) => {
              updateClip(nextClip.id, {
                status: "error",
                errorMessage: message,
              });
              reject(new Error(message));
            }
          );
        });

        const result = await renderPromise;

        // Wait for progress to also complete (or timeout after 30s)
        if (!progressDone) {
          await Promise.race([
            progressPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 30000)),
          ]);
        }

        updateClip(nextClip.id, {
          status: "done",
          progress: 100,
          clipUrl: result.clipUrl,
          renderedThumbnailUrl: result.thumbnailUrl,
        });
      } catch (err: any) {
        updateClip(nextClip.id, {
          status: "error",
          errorMessage: err.message || "Render failed",
        });
      } finally {
        unsubscribe?.();
      }
    }

    runningRef.current = false;
  }, [updateClip]);

  const removeClip = useCallback(
    (clipId: string) => {
      syncRef((prev) => prev.filter((c) => c.id !== clipId));
    },
    [syncRef]
  );

  const startQueue = useCallback(
    (initialClips: ClipItem[]) => {
      const queued: QueuedClip[] = initialClips.map((clip) => ({
        ...clip,
        status: "pending",
        progress: 0,
        stage: "",
      }));
      clipsRef.current = queued;
      setClips(queued);
      // Start processing
      setTimeout(() => {
        runningRef.current = false;
        processQueue();
      }, 0);
    },
    [processQueue]
  );

  return { clips, startQueue, updateClip, removeClip };
}
