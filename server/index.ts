import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { createServer } from 'http';
import { analyzeVideoRoute } from './routes/analyze';
import { downloadRoute } from './routes/download';
import { renderRoute } from './routes/render';
import { deleteRoute } from './routes/delete';
import { testRoute } from './routes/test';
import { gridRoute } from './routes/grid';
import { galleryRoute } from './routes/gallery';
import { shotsRoute } from './routes/shots';
import { clipsRoute } from './routes/clips';
import { channelRoute } from './routes/channel';
import { storyboardRoute } from './routes/storyboard';
import { wsManager } from './services/wsManager';
import { runMigrations } from './db';
import { runConsistencyCheck, printConsistencyReport } from './services/consistencyCheck';

dotenv.config({ override: true });

// Run database migrations on startup
runMigrations();

// Run consistency check on startup (report only, no auto-cleanup to avoid race conditions with in-flight requests)
setTimeout(async () => {
  try {
    const report = await runConsistencyCheck();
    printConsistencyReport(report);
  } catch (err) {
    console.error('Consistency check failed:', err);
  }
}, 0);

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Register clips API route BEFORE static middleware
app.use('/api/clips', clipsRoute);

// Serve clip files (rendered videos)
const clipsDir = path.join(process.cwd(), 'clips');
if (!fs.existsSync(clipsDir)) {
  fs.mkdirSync(clipsDir, { recursive: true });
}
app.use('/api/clips', express.static(clipsDir));

// Serve thumbnail files
const thumbsDir = path.join(clipsDir, 'thumbnails');
if (!fs.existsSync(thumbsDir)) {
  fs.mkdirSync(thumbsDir, { recursive: true });
}
app.use('/api/clips/thumbnails', express.static(thumbsDir));

// Serve shot files
const shotsDir = path.join(clipsDir, 'shots');
if (!fs.existsSync(shotsDir)) {
  fs.mkdirSync(shotsDir, { recursive: true });
}
app.use('/api/clips/shots', express.static(shotsDir));

// Serve shot thumbnail files
const shotThumbsDir = path.join(shotsDir, 'thumbnails');
if (!fs.existsSync(shotThumbsDir)) {
  fs.mkdirSync(shotThumbsDir, { recursive: true });
}
app.use('/api/clips/shots/thumbnails', express.static(shotThumbsDir));

// Routes
app.use('/api/analyze', analyzeVideoRoute);
app.use('/api/download', downloadRoute);
app.use('/api/render', renderRoute);
app.use('/api/delete', deleteRoute);
app.use('/api/test', testRoute);
app.use('/api/grid', gridRoute);
app.use('/api/gallery', galleryRoute);
app.use('/api/shots', shotsRoute);
app.use('/api/channel', channelRoute);
app.use('/api/storyboard', storyboardRoute);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Server config (exposes non-sensitive config to frontend)
app.get('/api/config', (req, res) => {
  res.json({
    vlModel: process.env.VL_MODEL || null,
  });
});

// Attach WebSocket manager to HTTP server
wsManager.attach(server);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
