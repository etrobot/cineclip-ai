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
- **Key elements**: Thumbnail preview, title, category badge, action buttons
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
2. App reads clips.json and shows all previously rendered clips
3. Grouped by source video with thumbnails
4. Same action buttons available (play, download, grid, delete)

### Path 3: Session Restore
1. User revisits the app after closing browser
2. App checks localStorage for persisted clip data
3. If found, restores analyzed clips and queued clip states
4. Also loads server-side clips from `/api/gallery`
5. Merges both sources to show current state

### Path 4: Delete Clip
1. User clicks trash icon on a clip card
2. App calls `POST /api/delete` with clip and thumbnail URLs
3. Server deletes files from filesystem
4. clips.json is updated
5. UI removes the clip card with exit animation

## Frontend State Management

### App-level State (src/App.tsx)
| State | Type | Purpose |
|-------|------|---------|
| `view` | `"home" \| "loading" \| "results"` | Current view |
| `analyzedClips` | `VideoGroup[]` | Clip suggestions from LLM |
| `videoData` | `{ videoId, title, thumbnail }` | Current video metadata |
| `progress` | `number` | Current job progress (0-100) |
| `status` | `string` | Current status message |
| `error` | `string \| null` | Error message display |

### Render Queue (useRenderQueue hook)
- Manages queue of clips to render sequentially
- Each queued clip has status: `pending` → `rendering` → `done` / `error`
- Progress updates via WebSocket per-clip

### Persisted Clips (usePersistedClips hook)
- Saves clip data to localStorage for session restore
- Includes both analyzed clips and queued clip states