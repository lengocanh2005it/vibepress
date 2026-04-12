import { Injectable } from '@nestjs/common';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export interface AttemptLog {
  attemptNumber: number;
  /** Full prompt sent to the model — system + user message */
  promptSent: {
    system: string;
    user: string;
  };
  /** Full raw response from the model (not truncated) */
  response: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
    cached?: number;
  };
  timestamp: string;
  success: boolean;
  /** Validation error that caused this attempt to fail (if any) */
  error?: string;
  /** Human-readable label for the outcome of this attempt */
  validationFeedback?: string;
}

export interface CotLogEntry {
  jobId: string;
  step: 'planning' | 'code-generation' | 'section-generation';
  componentName?: string; // for code-generation
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

@Injectable()
export class AiLoggerService {
  /**
   * Log toàn bộ Chain of Thought process (tất cả attempts, validations, fixes)
   */
  async logCotProcess(entry: CotLogEntry): Promise<void> {
    const logDir = join('./temp/logs', entry.jobId, 'ai-logs', entry.step);
    await mkdir(logDir, { recursive: true });

    // Tạo tên file với component name nếu có, để log từng component riêng
    // planning-cot-<timestamp>.json
    // code-generation-NotFound-cot-<timestamp>.json
    // section-generation-HeroSection-cot-<timestamp>.json
    let fileName: string;
    if (entry.componentName) {
      fileName = `${entry.step}-${entry.componentName}-cot-${Date.now()}.json`;
    } else {
      fileName = `${entry.step}-cot-${Date.now()}.json`;
    }

    await writeFile(join(logDir, fileName), JSON.stringify(entry, null, 2));
  }

  /**
   * Log simple activity (backwards compatibility)
   */
  async logAiActivity(
    jobId: string,
    step: 'planning' | 'code-generation',
    rawResponse: string,
    tokenCost: number,
    model: string,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const logDir = join('./temp/logs', jobId, 'ai-logs', step);
    await mkdir(logDir, { recursive: true });

    const entry: AiLogEntry = {
      jobId,
      step,
      timestamp: new Date().toISOString(),
      rawResponse,
      tokenCost,
      model,
      success,
      error,
    };

    const fileName = `${step}-${Date.now()}.json`;
    await writeFile(join(logDir, fileName), JSON.stringify(entry, null, 2));
  }
}
