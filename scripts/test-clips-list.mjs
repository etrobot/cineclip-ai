const API = 'http://localhost:3001';
const data = await (await fetch(API + '/api/clips/list')).json();

const clipItems = data.clips.map(c => ({
  id: c.id,
  videoId: c.videoId,
  title: c.fileName.replace(/\.mp4$/, '').replace(/_/g, ' '),
  category: 'Clips',
  duration: c.duration,
  thumbnail: c.thumbnailUrl || '',
  start: c.start,
  end: c.end,
}));

// Simulate groupClipsByVideoFlat
const grouped = new Map();
for (const item of clipItems) {
  if (!grouped.has(item.videoId)) {
    grouped.set(item.videoId, {
      videoId: item.videoId,
      title: item.title,
      thumbnail: item.thumbnail,
      items: [],
    });
  }
  grouped.get(item.videoId).items.push(item);
}
const groups = Array.from(grouped.values());

console.log('=== Data Flow Analysis ===');
console.log('Total clips from API:', data.clips.length);
console.log('Total groups:', groups.length);
console.log('');
for (const g of groups) {
  console.log(`Group: videoId="${g.videoId}"`);
  console.log(`  title="${g.title.substring(0, 50)}"`);
  console.log(`  thumbnail="${g.thumbnail.substring(0, 60)}"`);
  console.log(`  items: ${g.items.length}`);
  // Check if thumbnail is a valid URL
  const hasValidThumb = g.thumbnail.startsWith('/api/clips/') || g.thumbnail.startsWith('http');
  console.log(`  thumbnail valid: ${hasValidThumb}`);
  // Check first item
  const first = g.items[0];
  console.log(`  first item id="${first.id}"`);
  console.log(`  first item thumbnail="${first.thumbnail.substring(0, 60)}"`);
}

// Now simulate the QueuedClip matching (groupedQueuedVideos logic)
console.log('\n=== QueuedClip Matching Analysis ===');
const queuedClips = data.clips.map(c => ({
  id: c.id,
  videoId: c.videoId,
  status: 'done',
  clipUrl: c.clipUrl,
  renderedThumbnailUrl: c.thumbnailUrl,
}));

for (const g of groups) {
  const matchedItems = g.items
    .map(item => queuedClips.find(q => q.id === item.id))
    .filter(Boolean);
  console.log(`Group "${g.videoId}": ${g.items.length} ClipItems, ${matchedItems.length} matched QueuedClips`);
  if (matchedItems.length !== g.items.length) {
    console.log('  *** MISMATCH! Some ClipItems have no matching QueuedClip ***');
    const unmatched = g.items.filter(item => !queuedClips.find(q => q.id === item.id));
    for (const u of unmatched) {
      console.log(`  unmatched: id="${u.id}"`);
    }
  }
}