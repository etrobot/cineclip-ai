import { Router, type Request, type Response } from 'express';
import { progressEmitter, type ProgressEvent } from '../services/progressEmitter';

export const progressRoute = Router();

/**
 * GET /api/progress/:jobId
 * SSE endpoint for streaming progress events to the client
 */
progressRoute.get('/:jobId', (req: Request, res: Response) => {
  const { jobId } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', jobId })}\n\n`);

  // Send any already-accumulated events for this job
  const existingEvents = progressEmitter.getJobEvents(jobId);
  for (const event of existingEvents) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Listen for new progress events
  const unsubscribe = progressEmitter.onProgress(jobId, (event: ProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    // If progress is 100 or stage is 'complete'/'error', end the stream
    if (event.progress >= 100 || event.stage === 'complete' || event.stage === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'done', jobId })}\n\n`);
      unsubscribe();
      progressEmitter.cleanupJob(jobId);
      res.end();
    }
  });

  // Clean up on client disconnect
  req.on('close', () => {
    unsubscribe();
    progressEmitter.cleanupJob(jobId);
  });
});
