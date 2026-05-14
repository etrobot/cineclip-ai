export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export interface Clip {
  start: number;
  end: number;
  title: string;
  category: string;
  description?: string;
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
  jobId?: string
): Promise<RenderResponse> {
  const response = await fetch(`${API_BASE_URL}/api/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoId, start, end, outputName, title, subtitles, jobId }),
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
 * Health check
 */
export async function healthCheck(): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE_URL}/health`);
  return response.json();
}

/**
 * Generate a unique job ID
 */
export function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
