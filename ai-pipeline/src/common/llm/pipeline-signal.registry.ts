import { Injectable } from '@nestjs/common';

/**
 * Singleton registry that maps a pipeline jobId to an AbortController.
 * The LlmFactoryService injects this registry and automatically threads
 * the per-job AbortSignal into every LLM HTTP call so that calling
 * `abort(jobId)` immediately cancels any in-flight request for that job.
 */
@Injectable()
export class PipelineSignalRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Register a new AbortController for a job. Returns the associated signal. */
  register(jobId: string): AbortSignal {
    const ctrl = new AbortController();
    this.controllers.set(jobId, ctrl);
    return ctrl.signal;
  }

  /** Abort all in-flight LLM calls for this job. */
  abort(jobId: string): void {
    const ctrl = this.controllers.get(jobId);
    if (ctrl) {
      ctrl.abort();
      this.controllers.delete(jobId);
    }
  }

  /** Return the signal for a job, or undefined if not registered. */
  getSignal(jobId: string): AbortSignal | undefined {
    return this.controllers.get(jobId)?.signal;
  }

  /** Remove the entry when the job finishes normally. */
  unregister(jobId: string): void {
    this.controllers.delete(jobId);
  }
}
