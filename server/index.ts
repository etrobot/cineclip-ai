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
import { wsManager } from './services/wsManager';

dotenv.config({ override: true });

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

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

// Routes
app.use('/api/analyze', analyzeVideoRoute);
app.use('/api/download', downloadRoute);
app.use('/api/render', renderRoute);
app.use('/api/delete', deleteRoute);
app.use('/api/test', testRoute);
app.use('/api/grid', gridRoute);
app.use('/api/gallery', galleryRoute);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Attach WebSocket manager to HTTP server
wsManager.attach(server);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
