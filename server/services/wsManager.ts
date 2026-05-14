import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { progressEmitter, type ProgressEvent } from './progressEmitter';

interface ClientInfo {
  ws: WebSocket;
  jobId: string;
}

class WSManager {
  private wss?: WebSocketServer;
  private clients = new Map<WebSocket, ClientInfo>();

  attach(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws/progress' });

    this.wss.on('connection', (ws: WebSocket, req) => {
      // Handle CORS for WebSocket upgrade
      const origin = req.headers.origin || '';
      const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
      if (origin && !allowedOrigins.includes(origin)) {
        // Allow all origins in dev; in production, restrict this
      }

      // Wait for client to send subscribe message with jobId
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'subscribe' && msg.jobId) {
            const { jobId } = msg;
            this.clients.set(ws, { ws, jobId });

            // Send any already-accumulated events for this job
            const existingEvents = progressEmitter.getJobEvents(jobId);
            for (const event of existingEvents) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(event));
              }
            }

            // Listen for new progress events
            const unsubscribe = progressEmitter.onProgress(jobId, (event: ProgressEvent) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(event));
              }

              // If progress is 100 or stage is 'complete'/'error', end the stream
              if (event.progress >= 100 || event.stage === 'complete' || event.stage === 'error') {
                unsubscribe();
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'done', jobId }));
                }
                // Don't cleanup job here — let the client disconnect first
                // or give a small grace period
                setTimeout(() => {
                  progressEmitter.cleanupJob(jobId);
                }, 5000);
                ws.close();
              }
            });

            // Store unsubscribe so we can clean up on disconnect
            (ws as any)._unsubscribe = unsubscribe;
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        const info = this.clients.get(ws);
        if (info) {
          const unsubscribe = (ws as any)._unsubscribe;
          if (typeof unsubscribe === 'function') {
            unsubscribe();
          }
          this.clients.delete(ws);
        }
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        ws.terminate();
      });
    });
  }

  broadcast(jobId: string, data: unknown) {
    const payload = JSON.stringify(data);
    for (const [, info] of this.clients) {
      if (info.jobId === jobId && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(payload);
      }
    }
  }
}

export const wsManager = new WSManager();
