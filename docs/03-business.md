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
  │   ├─ FFmpeg: detect scene boundaries in the clip
  │   ├─ Extract one keyframe from each scene's first frame
  │   ├─ Build grid image with yellow timestamp overlays (m:ss.xxxxxx)
  │   ├─ VL Model: label + categorize each scene from grid + subtitles + context → Shot[]
  │   ├─ FFmpeg: reencode-cut each shot → clips/shots/{clipId}_shot_{idx}.mp4
  │   ├─ Generate thumbnails for each shot
  │   └─ Save grid image to clips/shots/{clipId}_grid.jpg
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
- **Two-stage process**:
  1. **Scene Detection** (FFmpeg): Uses FFmpeg's scene change detection filter (`select=gt(scene,threshold)`) to identify precise frame-level boundaries
  2. **Scene Classification** (VL Model): Labels each scene by analyzing a grid image with timestamp overlays
- Detailed workflow:
  - FFmpeg detects scene boundaries with configurable threshold (default 0.3)
  - Keyframes extracted at each scene's first frame
  - Grid image built from keyframes with yellow timestamp overlays (format: `m:ss.xxxxxx`, microsecond precision)
  - VL model receives: grid image + subtitles + full video context (single unified prompt)
  - VL model returns: `{ start, end, label, category }` for each shot segment
  - Shot boundaries are snapped to the nearest scene boundary via `snapToBoundary()`
  - Adjacent shots with the same label are automatically merged
- **Timestamp precision**: Microsecond-level (6 decimal places) preserved throughout the pipeline — no rounding or truncation
- **Shot cutting**: Uses FFmpeg reencode (not stream copy) for frame-accurate cuts
- **Category classification**: Each shot gets a category tag (讲座, 标题, 图表, 纪录, 卡通, 访谈, 新闻主持人, etc.)
- **Grid image**: Saved to `clips/shots/{clipId}_grid.jpg` and returned as `gridUrl` in the response
- **Error handling**: No fallback — if VL model or FFmpeg fails, the error is thrown directly
- Results persisted to database with label, category, start, end, duration, and metadata
- Returns JSON: `{ shots: [{ start, end, label, category, clipUrl, thumbnailUrl, duration }], gridUrl }` with times relative to clip start

### Clip Extraction
- Start/end times preserved to 1 decimal place (e.g., 130.1)
- Filename format: `{videoId}_{start}p{end}.mp4` (dots → `p` for filesystem safety)
- Codec `copy` used for clip extraction; shot segmentation uses reencode for frame-accurate cuts

### Gallery State
- SQLite database (`storage/cineclip.db`) is the single source of truth for all clip metadata
- Updated after each successful render via Drizzle ORM inserts
- `GET /api/gallery` queries the database with nested relations (author → post → clips → shots)
- Response is sorted: posts by creation time, clips by start time, shots by index
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
Segment shots from a clip using FFmpeg scene detection + VL labeling.

**Request**: `{ clipUrl, clipId, subtitles?, videoTitle?, videoDescription?, jobId? }`
**Response**: `{ shots: ShotInfo[], gridUrl: string, jobId: string }`

- `videoTitle` and `videoDescription` are optional but strongly recommended — they provide full video context for more accurate shot labels
- `subtitles` should be the **full** subtitle array (absolute timestamps); the server will compute clip-relative timestamps
- The server detects scene boundaries with FFmpeg, extracts keyframes at scene starts, builds a grid image with timestamp overlays, and asks the VL model to label and categorize each shot
- Each shot includes `category` (e.g. 讲座, 标题, 图表, 纪录, 卡通, 访谈, 新闻主持人)
- Shot cutting uses reencode for frame-accurate cuts (not stream copy)
- The grid image is saved to disk and its URL returned as `gridUrl`

### GET /api/shots/search?q=keyword
Search shots by label or category keyword, grouped by source clip.

**Query params**: `q` (required) — search keyword
**Response**: `{ query: string, results: ShotSearchGroup[] }`

- Searches `label` and `category` fields with LIKE matching
- Results are LEFT JOINed with `clips` table to include parent clip info
- Grouped by `sourceClipId` — same clip's matching shots appear together
- Each group contains: clip metadata + array of matching shots

### GET /api/shots/:clipId
List previously segmented shots for a clip.

**Response**: `{ shots: ShotListItem[] }`

### GET /api/gallery
Fetch gallery state from SQLite database.

**Response**: `GalleryResponse` — groups of clips with nested shots

### POST /api/gallery/refresh
Re-query gallery state from database.

**Response**: `GalleryResponse`

### GET /api/clips/list
List all clips from SQLite database.

**Response**: `{ clips: ListClipItem[], groups: { videoId, clips }[] }`

### GET /api/clips/exists/:videoId
Check whether clips already exist for a given videoId (platformId in the author table).

**Response**: `{ exists: boolean, clipCount: number }`

- Returns `exists: true` if the author has at least one clip in the database
- Used by the channel queue to detect previously extracted videos and prompt the user to confirm deletion before re-extracting

### POST /api/delete/video/:videoId
Delete ALL clips, shots, and associated records for a given video.

**Response**: `{ success: boolean, deletedFiles: string[], deletedClipCount: number }`

- Cascading delete: shots → clips → original_posts → author
- Also deletes filesystem files: clip videos, thumbnails, shot videos, shot thumbnails, grid images

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
| Shot Segmentation | `server/services/shotSegmentation.ts` | FFmpeg scene detection + VL-based scene labeling + category classification within a clip |
| FFmpeg Service | `server/services/ffmpeg.ts` | Video cutting, format conversion, subtitle overlay, scene detection, grid generation |
| Render Service | `server/services/render.ts` | Clip rendering orchestration (cut + thumbnail) |
| Progress Emitter | `server/services/progressEmitter.ts` | Server-side progress event bus (EventEmitter) |
| WebSocket Manager | `server/services/wsManager.ts` | WS connection lifecycle, subscription management |
| Grid Service | `server/services/grid.ts` | Multi-frame grid screenshot generation; exports shared functions (extractFrameAt, getSceneTimestamps, addTimestampToBuffer, MAX_GRID_*) for shotSegmentation reuse |
| yt-dlp Utils | `server/utils/ytDlp.ts` | Shell execution wrapper for yt-dlp |

### Frontend Modules

| Module | File | Responsibility |
|--------|------|---------------|
| API Client | `src/api/client.ts` | All HTTP + WebSocket communication |
| App | `src/App.tsx` | Main view routing, state management, pipeline orchestration |
| Channel Queue Hook | `src/hooks/useChannelQueue.ts` | Batch video queue with duplicate detection, confirm-delete flow, and sequential processing (analyze → render → segment) |
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
- Shot segmentation prompt uses a single unified systemContent (not separate system + user prompts) — the grid image and text context are combined to avoid confusing the model
- Grid image timestamps are yellow overlays in `m:ss.xxxxxx` format (microsecond precision), and the prompt provides the exact list of available timestamps for the model to choose from
- The prompt uses real category examples (讲座, 标题, 图表, 纪录, etc.) instead of placeholder labels to prevent the VL model from generating generic "描述" labels
- No fallback: if VL model returns invalid JSON or unexpected format, the error is thrown directly rather than falling back to generic labels
