export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export interface Clip {
  start: number;
  end: number;
  title: string;
  description?: string;
  videoId?: string;      // For X posts where each clip may belong to a different video
  sourceUrl?: string;    // Original source URL for non-YouTube videos
}

export interface SubtitleItem {
  start: number;
  end: number;
  text: string;
}

export interface AnalyzeResponse {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
  clips: Clip[];
  subtitles: SubtitleItem[];
  jobId: string;
}

export interface DownloadResponse {
  videoPath: string;
}

export interface RenderResponse {
  outputPath: string;
  clipUrl: string;
  thumbnailUrl: string;
  jobId: string;
}

export interface ProgressEvent {
  jobId: string;
  stage: string;
  progress: number;
  message: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Subscribe to progress events for a job via WebSocket
 * Returns an unsubscribe function
 */
export function subscribeProgress(
  jobId: string,
  onProgress: ProgressCallback,
  onDone?: () => void,
  onError?: (message: string) => void
): () => void {
  // Use ws:// or wss:// based on the API base URL
  const wsUrl = API_BASE_URL.replace(/^http/, 'ws') + '/ws/progress';
  const ws = new WebSocket(wsUrl);
  let closed = false;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', jobId }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'done') {
        onDone?.();
        ws.close();
        return;
      }

      if (data.stage === 'error') {
        onError?.(data.message);
        ws.close();
        return;
      }

      onProgress(data as ProgressEvent);
    } catch (err) {
      console.error('Failed to parse progress event:', err);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error for job', jobId, err);
    if (!closed) {
      onError?.('Progress connection failed');
    }
  };

  ws.onclose = () => {
    closed = true;
  };

  return () => {
    closed = true;
    ws.close();
  };
}

/**
 * Analyze YouTube video and get clip suggestions
 */
export async function analyzeVideo(url: string, jobId?: string): Promise<AnalyzeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, jobId }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to analyze video');
  }

  return response.json();
}

/**
 * Download video file
 */
export async function downloadVideo(videoId: string): Promise<DownloadResponse> {
  const response = await fetch(`${API_BASE_URL}/api/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoId }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to download video');
  }

  return response.json();
}

/**
 * Render a clip from video
 */
export async function renderClip(
  videoId: string,
  start: number,
  end: number,
  outputName?: string,
  title?: string,
  subtitles?: SubtitleItem[],
  jobId?: string,
  sourceUrl?: string
): Promise<RenderResponse> {
  const response = await fetch(`${API_BASE_URL}/api/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoId, start, end, outputName, title, subtitles, jobId, sourceUrl }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to render clip');
  }

  return response.json();
}

/**
 * Delete a clip (video file + thumbnail)
 */
export async function deleteClip(clipUrl: string, thumbnailUrl?: string): Promise<{ success: boolean; deleted: string[] }> {
  const response = await fetch(`${API_BASE_URL}/api/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clipUrl, thumbnailUrl }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete clip');
  }

  return response.json();
}

/**
 * Delete all clips and shots for a given video (by videoId)
 */
export async function deleteVideoClips(videoId: string): Promise<{ success: boolean; deletedFiles: string[]; deletedClipCount: number }> {
  const response = await fetch(`${API_BASE_URL}/api/delete/video/${encodeURIComponent(videoId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete video clips');
  }

  return response.json();
}

/**
 * Clear all gallery data (DB records + local files)
 */
export async function clearGallery(): Promise<{ success: boolean; deletedFiles: number }> {
  const response = await fetch(`${API_BASE_URL}/api/gallery/clear`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to clear gallery');
  }

  return response.json();
}

export interface GridResponse {
  gridUrl: string;
}

/**
 * Generate a multi-frame grid screenshot for a clip
 */
export async function generateGrid(
  clipUrl: string,
  options?: { fps?: number; diffThreshold?: number; maxGridSize?: number }
): Promise<GridResponse> {
  const response = await fetch(`${API_BASE_URL}/api/grid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clipUrl, ...options }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate grid');
  }

  return response.json();
}

export interface GalleryClip {
  id: string;
  videoId: string;
  fileName: string;
  clipUrl: string;
  thumbnailUrl: string | null;
  start: number;
  end: number;
  duration: string;
  title: string;
  size: number;
  shots?: Array<{
    idx: number;
    clipUrl: string;
    thumbnailUrl: string | null;
    size: number;
    label?: string;
    duration?: string;
  }>;
}

export interface GalleryGroup {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  clips: GalleryClip[];
}

export interface GalleryResponse {
  updatedAt: string | null;
  groups: GalleryGroup[];
}

/**
 * Fetch gallery state from server (reads SQLite DB)
 */
export async function fetchGallery(): Promise<GalleryResponse> {
  const response = await fetch(`${API_BASE_URL}/api/gallery`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch gallery');
  }
  return response.json();
}

/**
 * Refresh gallery from DB
 */
export async function refreshGallery(): Promise<GalleryResponse> {
  const response = await fetch(`${API_BASE_URL}/api/gallery/refresh`, { method: 'POST' });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to refresh gallery');
  }
  return response.json();
}

/**
 * List all existing clips from the server
 */
export interface ListClipItem {
  id: string;
  videoId: string;
  fileName: string;
  clipUrl: string;
  thumbnailUrl: string | undefined;
  start: number;
  end: number;
  duration: string;
  title: string;
  size: number;
}

export interface ListClipsResponse {
  clips: ListClipItem[];
  groups: { videoId: string; clips: ListClipItem[] }[];
}

export async function listClips(): Promise<ListClipsResponse> {
  const response = await fetch(`${API_BASE_URL}/api/clips/list`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list clips');
  }
  return response.json();
}

/**
 * Check if clips already exist for a given videoId
 */
export async function checkVideoExists(videoId: string): Promise<{ exists: boolean; clipCount: number }> {
  const response = await fetch(`${API_BASE_URL}/api/clips/exists/${encodeURIComponent(videoId)}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to check video existence');
  }
  return response.json();
}

/**
 * Health check
 */
export async function healthCheck(): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE_URL}/health`);
  return response.json();
}

/**
 * Shot segment info returned from shot segmentation API
 */
export interface ShotInfo {
  start: number;
  end: number;
  label: string;
  category: string;
  clipUrl: string;
  thumbnailUrl: string;
  duration: string;
}

export interface SegmentShotsResult {
  shots: ShotInfo[];
  gridUrl: string;
  jobId: string;
}

/**
 * Segment shots from a clip using VL model
 */
export async function segmentShots(
  clipUrl: string,
  clipId: string,
  subtitles?: Array<{ start: number; end: number; text: string }>,
  jobId?: string
): Promise<SegmentShotsResult> {
  const response = await fetch(`${API_BASE_URL}/api/shots`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clipUrl, clipId, subtitles, jobId }),
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const error = await response.json();
      message = error.error || message;
    } catch {
      const text = await response.text();
      message = text.slice(0, 200) || message;
    }
    throw new Error(message);
  }

  return response.json();
}

/**
 * List shots for a given clip
 */
export async function listShots(clipId: string): Promise<{ shots: Array<{ idx: number; clipUrl: string; thumbnailUrl: string | null; size: number; label?: string; duration?: string }> }> {
  const response = await fetch(`${API_BASE_URL}/api/shots/${clipId}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list shots');
  }
  return response.json();
}

/**
 * Shot search result types
 */
export interface ShotSearchShot {
  id: number;
  idx: number;
  label: string | null;
  category: string | null;
  start: number | null;
  end: number | null;
  duration: string | null;
  clipUrl: string | null;
  thumbnailUrl: string | null;
  size: number | null;
}

export interface ShotSearchClip {
  fileName: string | null;
  clipUrl: string | null;
  thumbnailUrl: string | null;
  title: string | null;
  startTime: number | null;
  endTime: number | null;
  duration: string | null;
}

export interface ShotSearchGroup {
  sourceClipId: string;
  clip: ShotSearchClip;
  shots: ShotSearchShot[];
}

export interface ShotSearchResponse {
  query: string;
  results: ShotSearchGroup[];
}

/**
 * Search shots by label or category keyword
 */
export async function searchShots(query: string): Promise<ShotSearchResponse> {
  const response = await fetch(`${API_BASE_URL}/api/shots/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to search shots');
  }
  return response.json();
}

/**
 * Check server configuration (e.g. VL model availability)
 */
export interface ServerConfig {
  vlModel?: string;
}

export async function getServerConfig(): Promise<ServerConfig> {
  const response = await fetch(`${API_BASE_URL}/api/config`);
  if (!response.ok) return {};
  return response.json();
}

/**
 * Generate a unique job ID
 */
export function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Channel / Playlist APIs ───────────────────────────────────────────

export interface ChannelVideo {
  videoId: string;
  title: string;
  duration: number | null;
  thumbnail: string;
  url: string;
}

export interface ChannelVideosResponse {
  url: string;
  type: 'channel' | 'playlist' | 'unknown';
  videoCount: number;
  videos: ChannelVideo[];
}

/**
 * List all videos from a YouTube channel or playlist URL
 */
export async function listChannelVideos(url: string): Promise<ChannelVideosResponse> {
  const response = await fetch(`${API_BASE_URL}/api/channel/videos?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list channel videos');
  }
  return response.json();
}

// ─── Storyboard API ─────────────────────────────────────────────────────

export interface StoryboardEntry {
  shotNumber: number;
  clipTitle: string;
  shotLabel: string;
  timeRange: string;
  absoluteStart: number;
  absoluteEnd: number;
  shotType: string;
  cameraMovement: string;
  visualContent: string;
  dialogue: string;
  narrativeRole: string;
  notes: string;
}

export interface StoryboardResult {
  videoId: string;
  videoTitle: string;
  summary: string;
  storyboard: StoryboardEntry[];
  totalShots: number;
  totalClips: number;
}

/**
 * Generate a storyboard (分镜表) for a video by sending its complete subtitles
 * and all extracted shot descriptions to the LLM.
 *
 * Returns 400 with a descriptive error if clips have no shots detected.
 */
export async function generateStoryboard(videoId: string): Promise<StoryboardResult> {
  const response = await fetch(`${API_BASE_URL}/api/storyboard`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoId }),
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const error = await response.json();
      message = error.error || message;
    } catch {
      const text = await response.text();
      message = text.slice(0, 200) || message;
    }
    throw new Error(message);
  }

  return response.json();
}
