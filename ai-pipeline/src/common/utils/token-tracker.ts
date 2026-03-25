import { Logger } from '@nestjs/common';
import { appendFile, writeFile } from 'fs/promises';

// Pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic — https://www.anthropic.com/pricing
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0 },
  // Mistral — https://mistral.ai/technology/#pricing
  'mistral-large-latest': { input: 2.0, output: 6.0 },
  'mistral-small-latest': { input: 0.1, output: 0.3 },
  'codestral-latest': { input: 0.3, output: 0.9 },
  'open-mistral-nemo': { input: 0.15, output: 0.15 },
};

export class TokenTracker {
  private readonly logger = new Logger('TokenTracker');
  private logFile: string | undefined;
  private totalInput = 0;
  private totalOutput = 0;
  private totalCost = 0;

  /** Gọi đầu mỗi job để reset bộ đếm và set file log riêng */
  async init(logFile: string): Promise<void> {
    this.logFile = logFile;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalCost = 0;
    await writeFile(
      logFile,
      `${'─'.repeat(80)}\n` +
        `TOKEN USAGE LOG  ${new Date().toISOString()}\n` +
        `${'─'.repeat(80)}\n` +
        `${'TIMESTAMP'.padEnd(26)}${'COMPONENT'.padEnd(36)} ${'IN'.padStart(7)} ${'OUT'.padStart(7)}  ${'COST (USD)'.padStart(12)}\n` +
        `${'─'.repeat(80)}\n`,
    );
  }

  async track(
    model: string,
    inputTokens: number,
    outputTokens: number,
    label = '',
  ): Promise<void> {
    const pricing = MODEL_PRICING[model] ?? { input: 1.0, output: 3.0 };
    const costUsd =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;

    this.totalInput += inputTokens;
    this.totalOutput += outputTokens;
    this.totalCost += costUsd;

    const tag = label || model;
    this.logger.log(
      `[${tag}] in=${inputTokens} out=${outputTokens} cost=$${costUsd.toFixed(6)}`,
    );

    if (this.logFile) {
      const line =
        `${new Date().toISOString()}  ` +
        `${tag.padEnd(36)} ` +
        `${String(inputTokens).padStart(7)} ` +
        `${String(outputTokens).padStart(7)}  ` +
        `$${costUsd.toFixed(6).padStart(11)}\n`;
      await appendFile(this.logFile, line).catch(() => {});
    }
  }

  async writeSummary(): Promise<void> {
    const line =
      `${'─'.repeat(80)}\n` +
      `${''.padEnd(26)}${'TOTAL'.padEnd(36)} ` +
      `${String(this.totalInput).padStart(7)} ` +
      `${String(this.totalOutput).padStart(7)}  ` +
      `$${this.totalCost.toFixed(6).padStart(11)}\n` +
      `${'─'.repeat(80)}\n`;

    this.logger.log(
      `[Total] in=${this.totalInput} out=${this.totalOutput} cost=$${this.totalCost.toFixed(4)}`,
    );

    if (this.logFile) {
      await appendFile(this.logFile, line).catch(() => {});
    }
  }
}
