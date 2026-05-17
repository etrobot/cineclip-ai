# Data

## File Storage Structure

```
project-root/
├── videos/              # Downloaded YouTube videos (full-length)
│   └── {videoId}.mp4
├── clips/               # Extracted clip segments
│   ├── thumbnails/      # Clip thumbnail images
│   │   └── {clipId}.jpg
│   ├── shots/           # Shot segments
│   │   └── {clipId}_shot_{idx}.mp4
│   └── {videoId}_{start}_{end}.mp4
├── storage/             # Persistent storage
│   ├── cineclip.db      # SQLite database (metadata, single source of truth)
│   └── temp/            # Temporary files (subtitle PNGs, etc.)
└── metadata.json        # Project metadata
```

## Data Dictionary

### SQLite Database Schema

The database is stored at `storage/cineclip.db` and managed via Drizzle ORM.

#### author
Stores content creators across platforms.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `INTEGER PK` | Author unique ID |
| `platform` | `TEXT` | Platform: `youtube` / `x` |
| `platformId` | `TEXT` | Platform-side author identifier |
| `name` | `TEXT` | Author display name |
| `avatarUrl` | `TEXT` | Avatar image URL |
| `createdAt` | `timestamp` | Creation time |

#### original_post
Stores original video/post metadata.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `INTEGER PK` | Post unique ID |
| `authorId` | `INTEGER FK` | References `author.id` |
| `platform` | `TEXT` | Platform: `youtube` / `x` |
| `postUrl` | `TEXT` | Original video/post URL |
| `title` | `TEXT` | Title |
| `description` | `TEXT` | Description / post content |
| `subtitlesJson` | `TEXT` | JSON-formatted subtitle data |
| `coverImageUrl` | `TEXT` | Cover/thumbnail URL |
| `publishedAt` | `timestamp` | Original publish time |
| `createdAt` | `timestamp` | Record creation time |

#### clips
Stores extracted clip segments.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `INTEGER PK` | Clip unique ID |
| `originalPostId` | `INTEGER FK` | References `original_post.id` |
| `fileName` | `TEXT` | MP4 filename |
| `clipUrl` | `TEXT` | Relative URL path |
| `thumbnailUrl` | `TEXT` | Thumbnail URL |
| `startTime` | `REAL` | Start time in seconds |
| `endTime` | `REAL` | End time in seconds |
| `duration` | `TEXT` | Human-readable duration |
| `title` | `TEXT` | Clip title |
| `size` | `INTEGER` | File size in bytes |
| `createdAt` | `timestamp` | Creation time |

#### shots
Stores segmented shot data within clips.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `INTEGER PK` | Shot unique ID |
| `clipId` | `INTEGER FK` | References `clips.id` |
| `idx` | `INTEGER` | Shot order index |
| `clipUrl` | `TEXT` | Shot video URL |
| `thumbnailUrl` | `TEXT` | Shot thumbnail URL |
| `size` | `INTEGER` | File size in bytes |
| `createdAt` | `timestamp` | Creation time |

### API Response Types

**GalleryGroup** (returned by `/api/gallery`)

| Field | Type | Description |
|-------|------|-------------|
| `videoId` | `string` | Platform video ID / post ID |
| `title` | `string` | Video title |
| `thumbnailUrl` | `string` | Cover thumbnail URL |
| `clips` | `GalleryClip[]` | Clips in this group |

**GalleryClip**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Clip ID |
| `videoId` | `string` | Source video ID |
| `fileName` | `string` | MP4 filename |
| `clipUrl` | `string` | Relative URL path |
| `thumbnailUrl` | `string` | Thumbnail URL |
| `start` | `number` | Start time in seconds |
| `end` | `number` | End time in seconds |
| `duration` | `string` | Human-readable duration |
| `title` | `string` | Clip title |
| `size` | `number` | File size in bytes |
| `shots` | `ShotEntry[]?` | Nested shots |

**ShotEntry**

| Field | Type | Description |
|-------|------|-------------|
| `idx` | `number` | Shot index |
| `clipUrl` | `string` | Shot video URL |
| `thumbnailUrl` | `string` | Shot thumbnail URL |
| `size` | `number` | File size |
| `label` | `string` | Shot description |
| `duration` | `string` | Human-readable duration |

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

### VideoContext
Shared context passed to all LLM/VL analysis modules.
```typescript
interface VideoContext {
  videoTitle: string;
  videoDescription: string;
  subtitles: SubtitleSegment[];
}
```

### Clip (LLM Output)
```typescript
interface Clip {
  start: number;       // seconds
  end: number;         // seconds
  title: string;       // clip title
  description?: string;
}
```

### Shot (VL Output)
```typescript
interface ShotSegment {
  start: number;   // seconds, relative to clip start
  end: number;     // seconds, relative to clip start
  label: string;   // scene description
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
  → LLM: analyze subtitles → Clip[] (start, end, title)
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