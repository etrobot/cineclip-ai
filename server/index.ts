import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { analyzeVideoRoute } from './routes/analyze';
import { downloadRoute } from './routes/download';
import { renderRoute } from './routes/render';
import { testRoute } from './routes/test';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/analyze', analyzeVideoRoute);
app.use('/api/download', downloadRoute);
app.use('/api/render', renderRoute);
app.use('/api/test', testRoute);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
