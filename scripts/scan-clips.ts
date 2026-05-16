/**
 * Scan the clips/ directory and generate clips.json as the persistent state.
 * Run manually: npx tsx scripts/scan-clips.ts
 * Also called by the server after render/delete operations.
 */
import * as path from 'path';
import * as fs from 'fs';

interface ClipEntry {
  id: string;
  videoId: string;
  fileName: string;
  clipUrl: string;
  thumbnailUrl: string | null;
  start: number;
  end: number;
  duration: string;
  title: string;
  size: number;
}

interface ClipGroup {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  clips: ClipEntry[];
}

const cwd = process.cwd();
const clipsDir = path.join(cwd, 'clips');
const thumbsDir = path.join(clipsDir, 'thumbnails');
const videosDir = path.join(cwd, 'videos');
const outputFile = path.join(cwd, 'clips.json');

// Build known videoIds from videos/ directory
const knownVideoIds: string[] = [];
if (fs.existsSync(videosDir)) {
  for (const f of fs.readdirSync(videosDir)) {
    if (f.endsWith('.mp4')) {
      knownVideoIds.push(path.parse(f).name);
    }
  }
}

// Sort by length descending so longer IDs match first (e.g. "EibhUi-FnTs" before "EibhUi")
knownVideoIds.sort((a, b) => b.length - a.length);

// Build thumbnail map
const thumbMap = new Map<string, string>();
if (fs.existsSync(thumbsDir)) {
  for (const t of fs.readdirSync(thumbsDir)) {
    if (t.endsWith('.jpg') || t.endsWith('.png')) {
      thumbMap.set(path.parse(t).name, t);
    }
  }
}

// Scan clip files
const clipFiles = fs.existsSync(clipsDir)
  ? fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4'))
  : [];

const clips: ClipEntry[] = clipFiles.map(fileName => {
  const baseName = path.parse(fileName).name;
  const stat = fs.statSync(path.join(clipsDir, fileName));

  // Find videoId by matching against known videoIds
  let videoId = baseName;
  let start = 0;
  let end = 0;

  for (const vid of knownVideoIds) {
    if (baseName.startsWith(vid + '_')) {
      videoId = vid;
      const timePart = baseName.slice(vid.length + 1);
      const timeParts = timePart.split('_');
      if (timeParts.length >= 2) {
        start = parseFloat(timeParts[0].replace(/p/g, '.'));
        end = parseFloat(timeParts[1].replace(/p/g, '.'));
      }
      break;
    }
  }

  const durationSec = end - start;
  const mins = Math.floor(durationSec / 60);
  const secs = Math.floor(durationSec % 60);
  const duration = `${mins}:${secs.toString().padStart(2, '0')}`;

  const thumbnailFileName = thumbMap.get(baseName);
  const thumbnailUrl = thumbnailFileName
    ? `/api/clips/thumbnails/${thumbnailFileName}`
    : null;

  return {
    id: baseName,
    videoId,
    fileName,
    clipUrl: `/api/clips/${fileName}`,
    thumbnailUrl,
    start,
    end,
    duration,
    title: baseName,
    size: stat.size,
  };
});

// Group by videoId
const groups: ClipGroup[] = [];
const groupMap = new Map<string, ClipGroup>();

for (const clip of clips) {
  if (!groupMap.has(clip.videoId)) {
    groupMap.set(clip.videoId, {
      videoId: clip.videoId,
      title: clip.videoId,
      thumbnailUrl: clip.thumbnailUrl,
      clips: [],
    });
  }
  groupMap.get(clip.videoId)!.clips.push(clip);
}
groups.push(...groupMap.values());

const data = { updatedAt: new Date().toISOString(), groups };
fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
console.log(`Scanned ${clips.length} clips in ${groups.length} groups → ${outputFile}`);