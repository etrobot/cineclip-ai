# Business

## Core Flow: Video-to-Clips Pipeline

### End-to-End Process

```
User Input (YouTube URL)
  │
  ├─ 1. Analyze ──────────────────────────────────────────────
  │   ├─ yt-dlp: extract video metadata (title, description, duration, thumbnail)
  │   ├─ yt-dlp: download VTT subtitles (auto/manual)
  │   ├─ parseVTT(): clean & normalize → SubtitleSegment[]
  │   └─ LLM: analyze subtitles + title + description → Clip[] suggestions
  │
  ├─ 2. Download ─────────────────────────────────────────────
  │   └─ yt-dlp: download full video → videos/{videoId}.mp4
  │
  ├─ 3. Render ───────────────────────────────────────────────
  │   ├─ FFmpeg extractClip(): cut segment (codec: copy)
  │   ├─ Sharp: generate thumbnail
  │   └─ Save clip metadata to SQLite (original_post, clips tables)
  │
  ├─ 4. Shot Segmentation (Optional) ─────────────────────────
  │   ├─ Extract sampling frames from clip (1 FPS)
  │   ├─ VL Model: analyze frames + clip subtitles + full video context → Shot[]
  │   ├─ FFmpeg: cut each shot → clips/shots/{clipId}_shot_{idx}.mp4
  │   └─ Generate thumbnails for each shot
  │
  └─ 5. Gallery ──────────────────────────────────────────────
      └─ Read clips.json → display grouped clips (with shots nested)
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
- LLM receives **full video context**: title + description + complete subtitles (up to 300 lines)
- Prompt building is centralized in `llmPrompt.ts` to ensure all analysis modules share the same context format
- Subtitles are formatted with 1-based index and timestamps: `#1 [0:00.0-0:05.2] text`
- LLM returns structured JSON: `{ clips: Clip[] }` with robust parsing (handles markdown code blocks, partial JSON)

### Shot Segmentation
- Operates on an already-extracted **clip** (not the full video)
- VL model receives:
  - Full video context (title + description + all subtitles) for thematic understanding
  - Clip-local subtitles (timestamps relative to clip start)
  - Up to 8 evenly-distributed sampling frames from the clip
- System prompt explicitly states: "你看到的是从完整视频中提取出来的一个 clip（片段），下方字幕也只包含该 clip 范围"
- Returns JSON: `{ shots: [{ start, end, label }] }` with times relative to clip start (0 = clip beginning)

### Clip Extraction
- Start/end times preserved to 1 decimal place (e.g., 130.1)
- Filename format: `{videoId}_{start}p{end}.mp4` (dots → `p` for filesystem safety)
- Codec `copy` used by default (no re-encode); re-encode available for overlay needs

### Gallery State
- SQLite database (`storage/cineclip.db`) is the single source of truth for all clip metadata
- Updated after each successful render via Drizzle ORM inserts
- `GET /api/gallery` queries the database with nested relations (author → post → clips → shots)
- `POST /api/gallery/refresh` re-queries the database (no filesystem scan needed)

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

### POST /api/shots
Segment shots from a clip using VL model.

**Request**: `{ clipUrl, clipId, subtitles?, videoTitle?, videoDescription?, jobId? }`
**Response**: `{ shots: ShotInfo[], jobId: string }`

- `videoTitle` and `videoDescription` are optional but strongly recommended — they provide full video context for more accurate shot labels
- `subtitles` should be the **full** subtitle array (absolute timestamps); the server will compute clip-relative timestamps

### GET /api/shots/:clipId
List previously segmented shots for a clip.

**Response**: `{ shots: ShotListItem[] }`

### GET /api/gallery
Fetch gallery state from SQLite database.

**Response**: `GalleryResponse` — groups of clips with nested shots

### POST /api/gallery/refresh
Re-query gallery state from database.

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
| YouTube Service | `server/services/youtube.ts` | Video metadata (incl. description), subtitle extraction, VTT parsing |
| LLM Prompt | `server/services/llmPrompt.ts` | Centralized prompt building for all LLM/VL analysis modules |
| LLM Service | `server/services/llm.ts` | Subtitle analysis, clip suggestion via OpenAI API |
| Shot Segmentation | `server/services/shotSegmentation.ts` | VL-based shot segmentation within a clip |
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

## Prompt Engineering

### VideoContext
All LLM/VL analysis modules share a common `VideoContext` structure:
```typescript
interface VideoContext {
  videoTitle: string;
  videoDescription: string;
  subtitles: SubtitleSegment[];
}
```
- `buildVideoContextBlock(ctx)` generates the consistent prefix: title + description + formatted subtitles
- Both `llm.ts` (clip analysis) and `shotSegmentation.ts` (shot analysis) use this to ensure the model always understands the full video context

### Design Rationale
- Centralizing prompt building prevents drift between modules
- Shot segmentation explicitly tells the model it's looking at a clip, not the full video
- Full subtitles (not just clip-local ones) help the model understand thematic context