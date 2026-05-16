# Business

## Core Flow: Video-to-Clips Pipeline

### End-to-End Process

```
User Input (YouTube URL)
  │
  ├─ 1. Analyze ──────────────────────────────────────────────
  │   ├─ yt-dlp: extract video metadata (title, duration, thumbnail)
  │   ├─ yt-dlp: download VTT subtitles (auto/manual)
  │   ├─ parseVTT(): clean & normalize → SubtitleSegment[]
  │   └─ LLM: analyze subtitles → Clip[] suggestions
  │
  ├─ 2. Download ─────────────────────────────────────────────
  │   └─ yt-dlp: download full video → videos/{videoId}.mp4
  │
  ├─ 3. Render ───────────────────────────────────────────────
  │   ├─ FFmpeg extractClip(): cut segment (codec: copy)
  │   ├─ Sharp: generate thumbnail
  │   └─ Update clips.json
  │
  └─ 4. Gallery ──────────────────────────────────────────────
      └─ Read clips.json → display grouped clips
```

### Progress Tracking

Each job gets a unique `jobId` (`job_{timestamp}_{random}`). Progress events are:
1. Emitted server-side via `ProgressEmitter` (EventEmitter)
2. Pushed to client via WebSocket (`/ws/progress`)
3. Client subscribes with `{ type: "subscribe", jobId }`
4. Stream ends with `{ type: "done" }` when progress >= 100 or stage = complete/error

**Stages**: `downloading` → `thumbnail` → `rendering` → `complete`

## Business Rules

### Subtitle Processing
- VTT format only; HTML tags and inline cues are stripped via `cleanVTTLine()`
- Duplicate segments (same start+end) are deduplicated
- If no subtitles found, analysis cannot proceed (error returned to user)

### LLM Analysis
- Subtitles are batched into ~60-second windows with 10-second overlap
- Each batch is analyzed independently; results are merged and deduplicated
- Overlapping clips from different batches are resolved by keeping the higher-confidence one
- LLM returns structured JSON: `{ clips: Clip[] }` with robust parsing (handles markdown code blocks, partial JSON)

### Clip Extraction
- Start/end times preserved to 1 decimal place (e.g., 130.1)
- Filename format: `{videoId}_{start}p{end}.mp4` (dots → `p` for filesystem safety)
- Codec `copy` used by default (no re-encode); re-encode available for overlay needs

### Gallery State
- `clips.json` is the single source of truth for all clip metadata
- Updated after each successful render
- Can be refreshed via `POST /api/gallery/refresh` (re-scans filesystem)
- Clips deleted from filesystem are removed on next scan

## API Interfaces

### POST /api/analyze
Analyze YouTube video and return clip suggestions.

**Request**: `{ url: string, jobId?: string }`
**Response**: `AnalyzeResponse` — video metadata + clip suggestions + subtitles + jobId

### POST /api/download
Download YouTube video to local storage.

**Request**: `{ videoId: string }`
**Response**: `{ videoPath: string }`

### POST /api/render
Render a single clip segment.

**Request**: `{ videoId, start, end, outputName?, title?, subtitles?, jobId? }`
**Response**: `{ outputPath, clipUrl, thumbnailUrl, jobId }`

### POST /api/delete
Delete a clip file and its thumbnail.

**Request**: `{ clipUrl: string, thumbnailUrl?: string }`
**Response**: `{ success: boolean, deleted: string[] }`

### POST /api/grid
Generate multi-frame grid screenshot for a clip.

**Request**: `{ clipUrl: string, fps?, diffThreshold?, maxGridSize? }`
**Response**: `{ gridUrl: string }`

### GET /api/gallery
Fetch gallery state from clips.json.

**Response**: `GalleryResponse` — groups of clips

### POST /api/gallery/refresh
Re-scan clips directory and rebuild clips.json.

**Response**: `GalleryResponse`

### GET /health
Health check endpoint.

**Response**: `{ status: "ok" }`

### WebSocket: /ws/progress
Subscribe to job progress events.

**Client → Server**: `{ type: "subscribe", jobId: string }`
**Server → Client**: `ProgressEvent` | `{ type: "done", jobId }`

## Module Design

### Server Services

| Module | File | Responsibility |
|--------|------|---------------|
| YouTube Service | `server/services/youtube.ts` | Video metadata, subtitle extraction, VTT parsing |
| LLM Service | `server/services/llm.ts` | Subtitle analysis, clip suggestion via OpenAI API |
| FFmpeg Service | `server/services/ffmpeg.ts` | Video cutting, format conversion, subtitle overlay, grid generation |
| Render Service | `server/services/render.ts` | Clip rendering orchestration (cut + thumbnail) |
| Progress Emitter | `server/services/progressEmitter.ts` | Server-side progress event bus (EventEmitter) |
| WebSocket Manager | `server/services/wsManager.ts` | WS connection lifecycle, subscription management |
| Grid Service | `server/services/grid.ts` | Multi-frame grid screenshot generation |
| yt-dlp Utils | `server/utils/ytDlp.ts` | Shell execution wrapper for yt-dlp |

### Frontend Modules

| Module | File | Responsibility |
|--------|------|---------------|
| API Client | `src/api/client.ts` | All HTTP + WebSocket communication |
| App | `src/App.tsx` | Main view routing, state management, pipeline orchestration |
| Render Queue Hook | `src/hooks/useRenderQueue.ts` | Queue-based clip rendering with progress tracking |
| Persisted Clips Hook | `src/hooks/usePersistedClips.ts` | localStorage persistence for session restoration |