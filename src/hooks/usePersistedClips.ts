import { useState, useEffect, useCallback } from "react";
import type { ClipItem } from "../App";
import type { QueuedClip } from "./useRenderQueue";

const STORAGE_KEY = "cineclip_gallery";

export interface PersistedData {
  clips: ClipItem[];
  videoData: {
    videoId: string;
    title: string;
    thumbnail: string;
  } | null;
  queuedClips: QueuedClip[];
}

export function usePersistedClips() {
  const [persisted, setPersisted] = useState<PersistedData | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as PersistedData;
        setPersisted(data);
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  const save = useCallback((data: PersistedData) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      setPersisted(data);
    } catch {
      // ignore storage errors (e.g. quota exceeded)
    }
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setPersisted(null);
  }, []);

  return { persisted, save, clear };
}
