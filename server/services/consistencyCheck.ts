import * as path from 'path';
import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { clips, shots } from '../db/schema';

interface ConsistencyReport {
  clips: {
    dbCount: number;
    fileCount: number;
    orphanDbRecords: { id: number; fileName: string; clipUrl: string }[];
    orphanFiles: string[];
  };
  shots: {
    dbCount: number;
    fileCount: number;
    orphanDbRecords: { id: number; sourceClipId: string | null; clipUrl: string | null }[];
    orphanFiles: string[];
  };
}

export async function runConsistencyCheck(): Promise<ConsistencyReport> {
  const clipsDir = path.join(process.cwd(), 'clips');
  const shotsDir = path.join(clipsDir, 'shots');
  const thumbsDir = path.join(clipsDir, 'thumbnails');
  const shotThumbsDir = path.join(shotsDir, 'thumbnails');

  // ── Collect DB records ──────────────────────────────────────────
  const allClips = await db.select().from(clips);
  const allShots = await db.select().from(shots);

  // ── Collect files on disk ───────────────────────────────────────
  const clipFiles = fs.existsSync(clipsDir)
    ? fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4'))
    : [];

  const shotFiles = fs.existsSync(shotsDir)
    ? fs.readdirSync(shotsDir).filter(f => f.endsWith('.mp4'))
    : [];

  // ── Find orphan DB records (record exists but file missing) ─────
  const orphanClipRecords = allClips.filter(c => {
    const fileName = path.basename(c.clipUrl);
    return !clipFiles.includes(fileName);
  }).map(c => ({
    id: c.id,
    fileName: c.fileName,
    clipUrl: c.clipUrl,
  }));

  const orphanShotRecords = allShots.filter(s => {
    if (!s.clipUrl) return true; // no URL means definitely orphan
    const fileName = path.basename(s.clipUrl);
    return !shotFiles.includes(fileName);
  }).map(s => ({
    id: s.id,
    sourceClipId: s.sourceClipId,
    clipUrl: s.clipUrl,
  }));

  // ── Find orphan files (file exists but no DB record) ────────────
  const clipFileUrls = new Set(allClips.map(c => path.basename(c.clipUrl)));
  const orphanClipFiles = clipFiles.filter(f => !clipFileUrls.has(f));

  const shotFileUrls = new Set(allShots.map(s => s.clipUrl ? path.basename(s.clipUrl) : ''));
  const orphanShotFiles = shotFiles.filter(f => !shotFileUrls.has(f));

  return {
    clips: {
      dbCount: allClips.length,
      fileCount: clipFiles.length,
      orphanDbRecords: orphanClipRecords,
      orphanFiles: orphanClipFiles,
    },
    shots: {
      dbCount: allShots.length,
      fileCount: shotFiles.length,
      orphanDbRecords: orphanShotRecords,
      orphanFiles: orphanShotFiles,
    },
  };
}

export async function cleanupOrphans(report: ConsistencyReport): Promise<{ deletedClips: number; deletedShots: number; deletedFiles: string[] }> {
  const clipsDir = path.join(process.cwd(), 'clips');
  const shotsDir = path.join(clipsDir, 'shots');
  const thumbsDir = path.join(clipsDir, 'thumbnails');
  const shotThumbsDir = path.join(shotsDir, 'thumbnails');

  let deletedClips = 0;
  let deletedShots = 0;
  const deletedFiles: string[] = [];

  // Clean orphan clip DB records
  for (const clip of report.clips.orphanDbRecords) {
    await db.delete(clips).where(eq(clips.id, clip.id));
    deletedClips++;
  }

  // Clean orphan shot DB records
  for (const shot of report.shots.orphanDbRecords) {
    await db.delete(shots).where(eq(shots.id, shot.id));
    deletedShots++;
  }

  // Clean orphan clip files
  for (const file of report.clips.orphanFiles) {
    const filePath = path.join(clipsDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deletedFiles.push(filePath);
    }
    // Also clean thumbnail
    const thumbPath = path.join(thumbsDir, file.replace('.mp4', '.jpg'));
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
      deletedFiles.push(thumbPath);
    }
  }

  // Clean orphan shot files
  for (const file of report.shots.orphanFiles) {
    const filePath = path.join(shotsDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      deletedFiles.push(filePath);
    }
    // Also clean thumbnail
    const thumbPath = path.join(shotThumbsDir, file.replace('.mp4', '.jpg'));
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
      deletedFiles.push(thumbPath);
    }
  }

  return { deletedClips, deletedShots, deletedFiles };
}

export function printConsistencyReport(report: ConsistencyReport): void {
  console.log('\n' + '='.repeat(60));
  console.log('  DATABASE / FILESYSTEM CONSISTENCY REPORT');
  console.log('='.repeat(60));

  // Clips
  console.log('\n  【Clips】');
  console.log(`    DB records:  ${report.clips.dbCount}`);
  console.log(`    Files:       ${report.clips.fileCount}`);

  if (report.clips.orphanDbRecords.length > 0) {
    console.log(`    ⚠️  DB records WITHOUT file (${report.clips.orphanDbRecords.length}):`);
    for (const r of report.clips.orphanDbRecords) {
      console.log(`       #${r.id} | ${r.fileName}`);
    }
  }

  if (report.clips.orphanFiles.length > 0) {
    console.log(`    ⚠️  Files WITHOUT DB record (${report.clips.orphanFiles.length}):`);
    for (const f of report.clips.orphanFiles) {
      console.log(`       ${f}`);
    }
  }

  if (report.clips.orphanDbRecords.length === 0 && report.clips.orphanFiles.length === 0) {
    console.log('    ✓ All clips consistent');
  }

  // Shots
  console.log('\n  【Shots】');
  console.log(`    DB records:  ${report.shots.dbCount}`);
  console.log(`    Files:       ${report.shots.fileCount}`);

  if (report.shots.orphanDbRecords.length > 0) {
    console.log(`    ⚠️  DB records WITHOUT file (${report.shots.orphanDbRecords.length}):`);
    for (const r of report.shots.orphanDbRecords) {
      console.log(`       #${r.id} | source=${r.sourceClipId}`);
    }
  }

  if (report.shots.orphanFiles.length > 0) {
    console.log(`    ⚠️  Files WITHOUT DB record (${report.shots.orphanFiles.length}):`);
    for (const f of report.shots.orphanFiles) {
      console.log(`       ${f}`);
    }
  }

  if (report.shots.orphanDbRecords.length === 0 && report.shots.orphanFiles.length === 0) {
    console.log('    ✓ All shots consistent');
  }

  console.log('\n' + '='.repeat(60) + '\n');
}