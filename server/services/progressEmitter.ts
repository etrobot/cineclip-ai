import { EventEmitter } from 'events';

export interface ProgressEvent {
  jobId: string;
  stage: string;
  progress: number; // 0-100
  message: string;
}

class ProgressEmitter extends EventEmitter {
  private jobs = new Map<string, ProgressEvent[]>();

  emitProgress(jobId: string, stage: string, progress: number, message: string) {
    const event: ProgressEvent = { jobId, stage, progress, message };
    const events = this.jobs.get(jobId) || [];
    events.push(event);
    this.jobs.set(jobId, events);
    this.emit(`progress:${jobId}`, event);
  }

  onProgress(jobId: string, callback: (event: ProgressEvent) => void) {
    this.on(`progress:${jobId}`, callback);
    return () => {
      this.off(`progress:${jobId}`, callback);
    };
  }

  cleanupJob(jobId: string) {
    this.jobs.delete(jobId);
    this.removeAllListeners(`progress:${jobId}`);
  }

  getJobEvents(jobId: string): ProgressEvent[] {
    return this.jobs.get(jobId) || [];
  }
}

// Singleton
export const progressEmitter = new ProgressEmitter();
