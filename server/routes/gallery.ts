import { Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export const galleryRoute = Router();

const CLIPS_JSON = path.join(process.cwd(), 'clips.json');

/** Run scan-clips to regenerate clips.json */
export function refreshClipsJson(): void {
  try {
    execSync('npx tsx scripts/scan-clips.ts', {
      cwd: process.cwd(),
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch (err) {
    console.warn('Failed to refresh clips.json:', err);
  }
}

/**
 * GET /api/gallery
 * Returns the persisted clips state from clips.json.
 */
galleryRoute.get('/', (_req, res) => {
  try {
    if (!fs.existsSync(CLIPS_JSON)) {
      // Auto-generate on first request
      refreshClipsJson();
    }
    const raw = fs.readFileSync(CLIPS_JSON, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err: any) {
    console.error('Gallery error:', err);
    res.json({ updatedAt: null, groups: [] });
  }
});

/**
 * POST /api/gallery/refresh
 * Manually trigger a scan to update clips.json.
 */
galleryRoute.post('/refresh', (_req, res) => {
  refreshClipsJson();
  const raw = fs.readFileSync(CLIPS_JSON, 'utf-8');
  res.json(JSON.parse(raw));
});