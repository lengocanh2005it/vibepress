import { Injectable } from '@nestjs/common';
import { appendFile, mkdir, writeFile } from 'fs/promises';
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

interface AiLogIndexEntry {
  kind: 'cot' | 'activity';
  jobId: string;
  step: string;
  componentName?: string;
  timestamp: string;
  model: string;
  success: boolean;
  durationMs?: number;
  totalAttempts?: number;
  retryCount?: number;
  totalTokens?: {
    input: number;
    output: number;
    total: number;
  };
  totalTokenCost?: number;
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
    const normalizedEntry = this.normalizeCotEntry(entry);

    // Tạo tên file với component name nếu có, để log từng component riêng
    // planning-cot-<timestamp>.json
    // code-generation-NotFound-cot-<timestamp>.json
    // section-generation-HeroSection-cot-<timestamp>.json
    let fileName: string;
    if (normalizedEntry.componentName) {
      fileName = `${normalizedEntry.step}-${normalizedEntry.componentName}-cot-${Date.now()}.json`;
    } else {
      fileName = `${normalizedEntry.step}-cot-${Date.now()}.json`;
    }

    await writeFile(
      join(logDir, fileName),
      JSON.stringify(normalizedEntry, null, 2),
    );
    await this.appendIndexEntry(normalizedEntry.jobId, {
      kind: 'cot',
      jobId: normalizedEntry.jobId,
      step: normalizedEntry.step,
      componentName: normalizedEntry.componentName,
      timestamp: normalizedEntry.endTime,
      model: normalizedEntry.model,
      success: normalizedEntry.finalSuccess,
      durationMs: normalizedEntry.durationMs,
      totalAttempts: normalizedEntry.totalAttempts,
      retryCount: normalizedEntry.retryCount,
      totalTokens: {
        input: normalizedEntry.totalTokens.input,
        output: normalizedEntry.totalTokens.output,
        total:
          normalizedEntry.totalTokens.input +
          normalizedEntry.totalTokens.output,
      },
      totalTokenCost: normalizedEntry.totalTokenCost,
      error: normalizedEntry.finalError,
    });
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
    await this.appendIndexEntry(jobId, {
      kind: 'activity',
      jobId,
      step,
      timestamp: entry.timestamp,
      model,
      success,
      totalTokenCost: tokenCost,
      error,
    });
  }

  private normalizeCotEntry(entry: CotLogEntry): CotLogEntry {
    const durationMs =
      entry.durationMs ??
      Math.max(
        0,
        new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime(),
      );
    const retryCount =
      entry.retryCount ??
      Math.max(0, entry.attempts.filter((attempt) => !attempt.success).length);
    return {
      ...entry,
      durationMs,
      retryCount,
    };
  }

  private async appendIndexEntry(
    jobId: string,
    entry: AiLogIndexEntry,
  ): Promise<void> {
    const indexPath = join('./temp/logs', jobId, 'ai-logs', 'index.jsonl');
    await mkdir(join('./temp/logs', jobId, 'ai-logs'), { recursive: true });
    await appendFile(indexPath, `${JSON.stringify(entry)}\n`);
  }
}
