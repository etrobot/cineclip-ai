const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export interface Clip {
  start: number;
  end: number;
  title: string;
  category: string;
  description?: string;
}

export interface AnalyzeResponse {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
  clips: Clip[];
}

export interface DownloadResponse {
  videoPath: string;
}

export interface RenderResponse {
  outputPath: string;
}

/**
 * Analyze YouTube video and get clip suggestions
 */
export async function analyzeVideo(url: string): Promise<AnalyzeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
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
  outputName?: string
): Promise<RenderResponse> {
  const response = await fetch(`${API_BASE_URL}/api/render`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoId, start, end, outputName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to render clip');
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
