# Data

## File Storage Structure

```
project-root/
├── videos/              # Downloaded YouTube videos (full-length)
│   └── {videoId}.mp4
├── clips/               # Extracted clip segments
│   ├── thumbnails/      # Clip thumbnail images
│   │   └── {clipId}.jpg
│   └── {videoId}_{start}_{end}.mp4
├── storage/             # Persistent storage (configurable via STORAGE_PATH)
│   └── temp/            # Temporary files (subtitle PNGs, etc.)
├── clips.json           # Gallery metadata (single source of truth)
└── metadata.json        # Project metadata
```

## Data Dictionary

### clips.json

Root-level gallery state file, read/written by server.

| Field | Type | Description |
|-------|------|-------------|
| `updatedAt` | `string (ISO 8601)` | Last update timestamp |
| `groups` | `GalleryGroup[]` | Clips grouped by source video |

**GalleryGroup**

| Field | Type | Description |
|-------|------|-------------|
| `videoId` | `string` | YouTube video ID |
| `title` | `string` | Video title |
| `thumbnailUrl` | `string` | First clip's thumbnail URL |
| `clips` | `GalleryClip[]` | Clips in this group |

**GalleryClip**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique clip ID (format: `{videoId}_{start}_{end}`) |
| `videoId` | `string` | Source YouTube video ID |
| `fileName` | `string` | MP4 filename |
| `clipUrl` | `string` | Relative URL path (`/api/clips/{fileName}`) |
| `thumbnailUrl` | `string` | Relative URL path to thumbnail |
| `start` | `number` | Start time in seconds (1 decimal) |
| `end` | `number` | End time in seconds (1 decimal) |
| `duration` | `string` | Human-readable duration (`M:SS`) |
| `title` | `string` | Clip title (from LLM or filename) |
| `size` | `number` | File size in bytes |

### metadata.json

Project-level metadata (static).

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Application name |
| `description` | `string` | One-line description |
| `requestFramePermissions` | `any[]` | (Unused, AI Studio compat) |
| `majorCapabilities` | `any[]` | (Unused, AI Studio compat) |

## Core Data Models (TypeScript)

### SubtitleSegment
```typescript
interface SubtitleSegment {
  start: number;  // seconds
  end: number;    // seconds
  text: string;   // cleaned subtitle text
}
```

### Clip (LLM Output)
```typescript
interface Clip {
  start: number;       // seconds
  end: number;         // seconds
  title: string;       // clip title
  category: string;    // e.g. "High Intensity Moments"
  description?: string;
}
```

### ProgressEvent
```typescript
interface ProgressEvent {
  jobId: string;    // unique job identifier
  stage: string;    // "downloading" | "thumbnail" | "rendering" | "complete" | "error"
  progress: number; // 0-100
  message: string;  // user-friendly status text
}
```

## Data Flow

```
YouTube URL
  → yt-dlp: extract subtitles (VTT format)
  → parseVTT(): clean & convert to SubtitleSegment[]
  → LLM: analyze subtitles → Clip[] (start, end, title, category)
  → yt-dlp: download full video → videos/{videoId}.mp4
  → FFmpeg: extractClip() → clips/{videoId}_{start}_{end}.mp4
  → Sharp: generate thumbnail → clips/thumbnails/{clipId}.jpg
  → update clips.json (add clip to gallery)
```

## Security

- **API Key**: `OPENAI_API_KEY` stored in `.env` (git-ignored), never committed
- **Proxy**: Optional `HTTPS_PROXY` for restricted networks
- **Cookies**: Optional `YT_DLP_COOKIES_BROWSER` for age-restricted videos
- **No user auth**: Local-only application, no authentication required
- **File serving**: Express static middleware serves clips/thumbnails directly