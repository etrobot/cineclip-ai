import { useState, useCallback, useRef } from "react";
import { segmentShots, generateJobId, type SegmentShotsResult, type SubtitleItem } from "../api/client";

export type ShotQueueStatus = "pending" | "processing" | "done" | "error";

export interface ShotQueueItem {
  clipId: string;
  clipUrl: string;
  clipTitle: string;
  subtitles?: SubtitleItem[];
  status: ShotQueueStatus;
  errorMessage?: string;
  result?: SegmentShotsResult;
}

export interface EnqueueShotParams {
  clipUrl: string;
  clipId: string;
  clipTitle: string;
  subtitles?: SubtitleItem[];
}

/**
 * Shot detection queue — processes clip shot-detection requests one at a time
 * to avoid overwhelming the VL model API (which easily returns 429).
 *
 * Each click on "Detect shots" enqueues a task; the queue runs serially.
 */
export function useShotQueue() {
  const [items, setItems] = useState<ShotQueueItem[]>([]);
  const itemsRef = useRef<ShotQueueItem[]>([]);
  const runningRef = useRef(false);

  // Keep ref in sync with state (same pattern as useRenderQueue)
  const syncRef = useCallback(
    (next: ShotQueueItem[] | ((prev: ShotQueueItem[]) => ShotQueueItem[])) => {
      setItems((prev) => {
        const updated = typeof next === "function" ? next(prev) : next;
        itemsRef.current = updated;
        return updated;
      });
    },
    []
  );

  const updateItem = useCallback(
    (clipId: string, patch: Partial<ShotQueueItem>) => {
      syncRef((prev) =>
        prev.map((item) => (item.clipId === clipId ? { ...item, ...patch } : item))
      );
    },
    [syncRef]
  );

  const processQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    while (true) {
      const nextItem = itemsRef.current.find((item) => item.status === "pending");
      if (!nextItem) break;

      updateItem(nextItem.clipId, { status: "processing", errorMessage: undefined });

      try {
        const jobId = generateJobId();
        const result = await segmentShots(
          nextItem.clipUrl,
          nextItem.clipId,
          nextItem.subtitles,
          jobId
        );
        updateItem(nextItem.clipId, { status: "done", result });
      } catch (err: any) {
        updateItem(nextItem.clipId, {
          status: "error",
          errorMessage: err?.message || "Shot detection failed",
        });
      }
    }

    runningRef.current = false;
  }, [updateItem]);

  /**
   * Enqueue a clip for shot detection.
   * - If the clip is already pending or processing, the call is ignored.
   * - If the clip was previously done or errored, it is re-queued (status reset to pending).
   */
  const enqueue = useCallback(
    (params: EnqueueShotParams) => {
      const { clipId, clipUrl, clipTitle, subtitles } = params;

      let alreadyActive = false;

      syncRef((prev) => {
        const existing = prev.find((item) => item.clipId === clipId);
        if (existing) {
          // Ignore if already pending or processing
          if (existing.status === "pending" || existing.status === "processing") {
            alreadyActive = true;
            return prev;
          }
          // Reset to pending for re-queue (was done or error)
          return prev.map((item) =>
            item.clipId === clipId
              ? { ...item, status: "pending" as const, errorMessage: undefined, result: undefined }
              : item
          );
        }
        // New entry
        return [
          ...prev,
          {
            clipId,
            clipUrl,
            clipTitle,
            subtitles,
            status: "pending" as const,
          },
        ];
      });

      if (!alreadyActive) {
        // Kick off processing (will no-op if already running)
        setTimeout(() => processQueue(), 0);
      }
    },
    [syncRef, processQueue]
  );

  /**
   * Retry a failed clip (reset to pending and resume queue).
   */
  const retry = useCallback(
    (clipId: string) => {
      syncRef((prev) =>
        prev.map((item) =>
          item.clipId === clipId
            ? { ...item, status: "pending" as const, errorMessage: undefined, result: undefined }
            : item
        )
      );
      setTimeout(() => processQueue(), 0);
    },
    [syncRef, processQueue]
  );

  /**
   * Remove a finished item from the queue (cleanup).
   */
  const removeItem = useCallback(
    (clipId: string) => {
      syncRef((prev) => prev.filter((item) => item.clipId !== clipId));
    },
    [syncRef]
  );

  /**
   * Get the queue item for a given clipId (or undefined if not in queue).
   */
  const getItem = useCallback(
    (clipId: string): ShotQueueItem | undefined => {
      return itemsRef.current.find((item) => item.clipId === clipId);
    },
    []
  );

  /**
   * Get the position of a pending item in the queue (1-based).
   * Returns 0 if not pending or not found.
   */
  const getQueuePosition = useCallback((clipId: string): number => {
    const pendingItems = itemsRef.current.filter((item) => item.status === "pending");
    const idx = pendingItems.findIndex((item) => item.clipId === clipId);
    return idx >= 0 ? idx + 1 : 0;
  }, []);

  return {
    items,
    enqueue,
    retry,
    removeItem,
    getItem,
    getQueuePosition,
  };
}
