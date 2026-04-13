import { Injectable } from '@nestjs/common';

export interface AttemptLog {
  attemptNumber: number;
  promptSent: {
    system: string;
    user: string;
  };
  response: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
    cached?: number;
  };
  timestamp: string;
  success: boolean;
  error?: string;
  validationFeedback?: string;
}

export interface CotLogEntry {
  jobId: string;
  step: 'planning' | 'code-generation' | 'section-generation';
  componentName?: string;
  model: string;
  startTime: string;
  endTime: string;
  totalAttempts: number;
  attempts: AttemptLog[];
  finalSuccess: boolean;
  totalTokenCost: number;
  totalTokens: {
    input: number;
    output: number;
  };
  finalError?: string;
  durationMs?: number;
  retryCount?: number;
}

export interface AiLogEntry {
  jobId: string;
  step: 'planning' | 'code-generation' | 'section-generation';
  timestamp: string;
  rawResponse: string;
  tokenCost: number;
  model: string;
  success: boolean;
  error?: string;
}

export interface AiLoggerJobSummary {
  totalCotEntries: number;
  totalActivityEntries: number;
  totalTokenCost: number;
  totalTokens: {
    input: number;
    output: number;
    total: number;
  };
  retries: {
    total: number;
    byStep: Record<CotLogEntry['step'], number>;
  };
  attempts: {
    total: number;
    byStep: Record<CotLogEntry['step'], number>;
  };
  failures: {
    total: number;
    byStep: Record<CotLogEntry['step'], number>;
  };
}

interface AiLogSession {
  totalCotEntries: number;
  totalActivityEntries: number;
  totalTokenCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  retriesByStep: Record<CotLogEntry['step'], number>;
  attemptsByStep: Record<CotLogEntry['step'], number>;
  failuresByStep: Record<CotLogEntry['step'], number>;
}

const AI_LOG_STEPS: Array<CotLogEntry['step']> = [
  'planning',
  'code-generation',
  'section-generation',
];

@Injectable()
export class AiLoggerService {
  private static readonly sessions = new Map<string, AiLogSession>();

  async logCotProcess(entry: CotLogEntry): Promise<void> {
    const session = this.getSession(entry.jobId);
    const retryCount =
      entry.retryCount ??
      Math.max(0, entry.attempts.filter((attempt) => !attempt.success).length);

    session.totalCotEntries += 1;
    session.totalTokenCost += entry.totalTokenCost;
    session.totalInputTokens += entry.totalTokens.input;
    session.totalOutputTokens += entry.totalTokens.output;
    session.retriesByStep[entry.step] += retryCount;
    session.attemptsByStep[entry.step] += entry.totalAttempts;
    if (!entry.finalSuccess) {
      session.failuresByStep[entry.step] += 1;
    }
  }

  async logAiActivity(
    jobId: string,
    step: 'planning' | 'code-generation',
    rawResponse: string,
    tokenCost: number,
    model: string,
    success: boolean,
    error?: string,
  ): Promise<void> {
    void rawResponse;
    void model;
    void error;

    const session = this.getSession(jobId);
    session.totalActivityEntries += 1;
    session.totalTokenCost += tokenCost;
    if (!success) {
      session.failuresByStep[step] += 1;
    }
  }

  getJobSummary(jobId: string): AiLoggerJobSummary {
    const session = AiLoggerService.sessions.get(jobId);
    if (!session) {
      return {
        totalCotEntries: 0,
        totalActivityEntries: 0,
        totalTokenCost: 0,
        totalTokens: {
          input: 0,
          output: 0,
          total: 0,
        },
        retries: {
          total: 0,
          byStep: this.createStepCounter(),
        },
        attempts: {
          total: 0,
          byStep: this.createStepCounter(),
        },
        failures: {
          total: 0,
          byStep: this.createStepCounter(),
        },
      };
    }

    return {
      totalCotEntries: session.totalCotEntries,
      totalActivityEntries: session.totalActivityEntries,
      totalTokenCost: Number(session.totalTokenCost.toFixed(6)),
      totalTokens: {
        input: session.totalInputTokens,
        output: session.totalOutputTokens,
        total: session.totalInputTokens + session.totalOutputTokens,
      },
      retries: {
        total: Object.values(session.retriesByStep).reduce(
          (sum, value) => sum + value,
          0,
        ),
        byStep: { ...session.retriesByStep },
      },
      attempts: {
        total: Object.values(session.attemptsByStep).reduce(
          (sum, value) => sum + value,
          0,
        ),
        byStep: { ...session.attemptsByStep },
      },
      failures: {
        total: Object.values(session.failuresByStep).reduce(
          (sum, value) => sum + value,
          0,
        ),
        byStep: { ...session.failuresByStep },
      },
    };
  }

  clearJob(jobId: string): void {
    AiLoggerService.sessions.delete(jobId);
  }

  private getSession(jobId: string): AiLogSession {
    let session = AiLoggerService.sessions.get(jobId);
    if (!session) {
      session = {
        totalCotEntries: 0,
        totalActivityEntries: 0,
        totalTokenCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        retriesByStep: this.createStepCounter(),
        attemptsByStep: this.createStepCounter(),
        failuresByStep: this.createStepCounter(),
      };
      AiLoggerService.sessions.set(jobId, session);
    }
    return session;
  }

  private createStepCounter(): Record<CotLogEntry['step'], number> {
    return Object.fromEntries(AI_LOG_STEPS.map((step) => [step, 0])) as Record<
      CotLogEntry['step'],
      number
    >;
  }
}
