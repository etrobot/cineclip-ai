import { Router } from 'express';
import { runYtDlp } from '../utils/ytDlp.js';

export const channelRoute = Router();

/**
 * GET /api/channel/videos?url=<channel_or_playlist_url>
 * List all videos from a YouTube channel or playlist.
 * Uses yt-dlp --flat-playlist --dump-json to get video metadata without downloading.
 */
channelRoute.get('/videos', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    return res.status(400).json({ error: 'Channel/playlist URL is required' });
  }

  try {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
    const commonArgs: string[] = ['--no-warnings'];
    if (proxy) {
      commonArgs.push('--proxy', proxy);
    }

    // Use --flat-playlist to only list entries without downloading
    // --dump-json-flat gives us metadata for each entry
    const args = [
      ...commonArgs,
      '--flat-playlist',
      '--dump-json',
      '--skip-download',
      url,
    ];

    console.log(`[Channel] Listing videos from: ${url}`);
    const result = await runYtDlp(args);

    // yt-dlp outputs one JSON object per line for each video
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const videos: Array<{
      videoId: string;
      title: string;
      duration: number | null;
      thumbnail: string;
      url: string;
    }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Extract video ID from various possible fields
        const videoId = entry.id || entry.url || '';
        if (!videoId) continue;

        // Skip entries that are not videos (e.g. playlists)
        if (entry._type === 'playlist') continue;

        const title = entry.title || 'Untitled';
        const duration = entry.duration ?? null;
        const thumbnail = entry.thumbnail || entry.thumbnails?.[0]?.url || '';
        const videoUrl = entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${videoId}`;

        videos.push({
          videoId,
          title,
          duration,
          thumbnail,
          url: videoUrl,
        });
      } catch (parseErr) {
        // Skip unparseable lines
        console.warn('[Channel] Failed to parse entry:', line.substring(0, 100));
      }
    }

    console.log(`[Channel] Found ${videos.length} videos`);

    // Determine if this is a channel or playlist
    const isChannel = url.includes('/@') || url.includes('/channel/') || url.includes('/c/');
    const isPlaylist = url.includes('list=');

    res.json({
      url,
      type: isChannel ? 'channel' : isPlaylist ? 'playlist' : 'unknown',
      videoCount: videos.length,
      videos,
    });
  } catch (error: any) {
    console.error('[Channel] Failed to list videos:', error);
    res.status(500).json({ error: error.message || 'Failed to list channel videos' });
  }
});