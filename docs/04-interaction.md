# Interaction

## UI Design Standard

### Visual Style
- **Theme**: Dark mode (Netflix-inspired), deep blacks with red accent
- **Primary color**: Red-600 (`#DC2626`) — used for branding, CTAs, accents
- **Background**: Zinc-950 / Zinc-900 with subtle gradient overlays
- **Typography**: Bold, uppercase, tight tracking for headings; relaxed leading for body
- **Motion**: Smooth spring animations via Motion (Framer Motion), staggered list entry

### Layout Principles
- Full-screen hero with centered search input
- Card-based results layout with grouped clips by video
- Modal overlay for loading/progress states
- Responsive: mobile-first with max-width containers

### Animation Patterns
- **Page entry**: Fade up with spring physics (opacity 0→1, y 30→0)
- **Icon entrance**: Scale from 0 with spring (stiffness: 200, damping: 10)
- **Cards**: Staggered AnimatePresence for list add/remove
- **Buttons**: whileHover scale 1.05, whileTap scale 0.95
- **Background glow**: Red/purple gradient blur with hover opacity transition

## Core Components

### Hero (`src/components/Hero.tsx`)
- **Purpose**: Landing page with YouTube URL input
- **Key elements**: Logo (YouTube icon + "CineClip" text), search form, Gallery nav button
- **Interaction**: Submit → triggers `onSearch(url)` callback
- **Visual**: Glowing input border on hover, particle background

### LoadingModal (`src/components/LoadingModal.tsx`)
- **Purpose**: Full-screen overlay showing pipeline progress
- **Key elements**: Animated spinner, stage label, progress bar, status messages
- **Data source**: WebSocket `ProgressEvent` stream
- **Stages displayed**: Downloading → Screenshot → Rendering → Done

### ClipRow / ClipCard (`src/components/ClipRow.tsx`)
- **Purpose**: Individual clip display with action buttons
- **Key elements**: Thumbnail preview, title, action buttons
- **Actions**:
  - Play: open clip URL in new tab
  - Download: trigger browser download
  - Grid: generate/show multi-frame grid screenshot
  - Delete: remove clip (with confirmation)
- **States**: pending → rendering (spinner) → done / error
- **Grid overlay**: Modal-style overlay showing grid screenshot of clip frames

### GlowBackground (`src/components/GlowBackground.tsx`)
- **Purpose**: Decorative animated background with particle effects
- **Library**: tsparticles with slim preset
- **Effect**: Subtle floating particles with red/purple tones

### ShotSearch (`src/components/ShotSearch.tsx`)
- **Purpose**: Search shots by label or category keyword
- **Key elements**: Search icon button in navbar, fullscreen modal overlay with search input
- **Interaction**: Click search icon → modal opens → type keyword → Enter/search → results grouped by clip
- **Result display**: Each group shows clip info (thumbnail, title, time range) + matching shots (mini thumbnail, label, category badge, time range)
- **Categories displayed**: Category badge (e.g. 讲座, 纪录, 访谈) in uppercase with zinc styling

### ChannelBrowser (`src/components/ChannelBrowser.tsx`)
- **Purpose**: Browse and select videos from a YouTube channel or playlist
- **Key elements**: URL input, video list with checkboxes, add-to-queue button
- **Interaction**: Enter channel/playlist URL → click "List" → select videos → click "Add to queue"
- **Selection**: Toggle individual videos, or use "All"/"None" quick-select buttons
- **Already-queued videos**: Displayed as checked and disabled (cannot be re-added)
- **State persistence**: Channel URL, type, and video list saved to localStorage for session restore

### QueueView (`src/components/QueueView.tsx`)
- **Purpose**: Manage batch video extraction queue
- **Key elements**: Batch progress bar, start/stop controls, per-video progress with status indicators
- **Actions**: Start fetch, stop, remove individual video, clear done, clear entire queue
- **Duplicate detection**: Videos with existing clips show an amber warning bar with Yes/No buttons
  - "Yes" → confirms deletion of existing clips, video will re-extract (delete first)
  - "No" → removes the video from the queue
- **Status indicators**: idle, analyzing, rendering, segmenting, done, error
- **Confirmed re-extract**: Shows amber progress bar with "Will re-extract" label

## User Paths

### Path 1: Analyze & Clip (Primary Flow)
1. User lands on Hero page
2. Types or pastes YouTube URL in search input
3. Clicks "Analyze" or presses Enter
4. LoadingModal appears with progress stages
5. System extracts subtitles → LLM analyzes → suggests clips
6. Video downloads automatically
7. Clips render one by one (queue-based)
8. Results view shows grouped clips with thumbnails
9. User can play, download, or delete individual clips

### Path 2: Gallery View
1. User clicks "Gallery" button (top-right of Hero)
2. App queries `/api/gallery` (reads SQLite DB) and shows all previously rendered clips
3. Grouped by source video with thumbnails
4. Same action buttons available (play, download, grid, delete)

### Path 3: Session Restore
1. User revisits the app after closing browser
2. App checks localStorage for persisted clip data
3. If found, restores analyzed clips and queued clip states
4. Also loads server-side clips from `/api/gallery`
5. Merges both sources to show current state

### Path 4: Shot Segmentation
1. User clicks "Segment Shots" on a rendered clip card
2. App calls `POST /api/shots` with:
   - `clipUrl`, `clipId`
   - `subtitles` (full subtitles with absolute timestamps)
   - `videoTitle`, `videoDescription` (from analyze response)
3. Server uses FFmpeg to detect scene boundaries in the clip
4. Server extracts keyframes at scene starts and builds a grid image with yellow timestamp overlays
5. VL model labels and categorizes each scene using the grid + clip subtitles + full video context
6. Server cuts each shot via FFmpeg (reencode for frame accuracy) → `clips/shots/`
7. UI displays nested shot cards under the parent clip, each showing label, category badge, and time range

### Path 5: Shot Search
1. User clicks search icon in the navbar (results view)
2. Search modal opens with text input (auto-focused)
3. User types keyword and presses Enter or clicks Search
4. App calls `GET /api/shots/search?q=keyword`
5. Results are grouped by source clip — each group shows clip thumbnail, title, and time range
6. Matching shots within each group display: mini thumbnail, label, category badge, time range
7. User clicks X to close the modal

### Path 6: Delete Clip
1. User clicks trash icon on a clip card
2. App calls `POST /api/delete` with clip and thumbnail URLs
3. Server deletes files from filesystem
4. clips.json is updated
5. UI removes the clip card with exit animation

### Path 7: Channel Batch Queue
1. User clicks channel icon on Hero page → ChannelBrowser modal opens
2. User enters YouTube channel or playlist URL and clicks "List"
3. Video list appears; user selects videos via checkboxes (or All/None)
4. User clicks "Add N videos to queue"
5. System checks each video against `GET /api/clips/exists/:videoId`:
   - **New video**: Added with "Waiting..." status
   - **Already extracted**: Added with amber "Already extracted (N clips). Delete & re-extract?" warning bar
6. User navigates to Queue view
7. For videos with the duplicate warning:
   - Click **Yes** → existing clips will be deleted before re-extraction (status changes to "Will re-extract")
   - Click **No** → video is removed from the queue
8. User clicks "Start Fetch" → queue processes sequentially:
   - For confirmed re-extract videos: calls `POST /api/delete/video/:videoId` first, then proceeds
   - Per video: analyze → render clips → segment shots
9. Progress shown per video with percentage and stage labels
10. User can stop fetch at any time; completed videos remain in queue

### Path 8: Delete All Video Clips
1. User clicks delete icon on a video group in Gallery view
2. App calls `POST /api/delete/video/:videoId`
3. Server cascading deletes: shots → clips → original_posts → author records + all associated files
4. UI removes the video group from gallery

## Frontend State Management

### App-level State (src/App.tsx)
| State | Type | Purpose |
|-------|------|---------|
| `view` | `"home" \| "loading" \| "results" \| "queue"` | Current view |
| `analyzedClips` | `VideoGroup[]` | Clip suggestions from LLM |
| `videoData` | `{ videoId, title, thumbnail }` | Current video metadata |
| `progress` | `number` | Current job progress (0-100) |
| `status` | `string` | Current status message |
| `error` | `string \| null` | Error message display |
| `showChannel` | `boolean` | ChannelBrowser modal visibility |

### Channel Queue (useChannelQueue hook)
- Manages batch video queue with duplicate detection and sequential processing
- Each queue item (`FetchItem`) tracks:
  - `status`: `idle` → `analyzing` → `rendering` → `segmenting` → `done` / `error`
  - `needsConfirm`: true if video already has extracted clips (awaiting user confirmation)
  - `confirmDelete`: true if user confirmed deletion of existing clips
  - `existingClipCount`: number of clips already in the database for this video
- **Duplicate detection flow**:
  1. On `addVideosToQueue()`, calls `checkVideoExists()` for each video
  2. Videos with existing clips are marked `needsConfirm: true`
  3. These videos show an amber warning bar with Yes/No buttons
  4. `confirmVideoDelete()` → sets `confirmDelete: true`, clears `needsConfirm`
  5. `cancelVideoConfirm()` → removes video from queue
  6. `startFetch()` skips `needsConfirm` items (must confirm first)
- **Processing flow**: When a `confirmDelete` video is processed, `deleteVideoClips()` is called first to clean up existing data
- Queue state persisted to localStorage (`cineclip_channel_queue`)

### Render Queue (useRenderQueue hook)
- Manages queue of clips to render sequentially
- Each queued clip has status: `pending` → `rendering` → `done` / `error`
- Progress updates via WebSocket per-clip

### Persisted Clips (usePersistedClips hook)
- Saves clip data to localStorage for session restore
- Includes both analyzed clips and queued clip states
