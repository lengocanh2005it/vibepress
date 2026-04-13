import { Logger } from '@nestjs/common';
import { appendFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

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
  'devstral-2512': { input: 0.4, output: 2.0 },
  'labs-devstral-small-2512': { input: 0.1, output: 0.3 },
  'open-mistral-nemo': { input: 0.15, output: 0.15 },
};

type TokenPhase = 'plan' | 'gen' | 'review' | 'fix';
type TokenEntry = {
  timestamp: string;
  model: string;
  label: string;
  phase: TokenPhase | 'unclassified';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};
type TokenSession = {
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  entries: TokenEntry[];
  initialized: boolean;
  summaryWritten: boolean;
};

const TOKEN_PHASES: TokenPhase[] = ['plan', 'gen', 'review', 'fix'];

export class TokenTracker {
  private static readonly sessions = new Map<string, TokenSession>();
  private readonly logger = new Logger('TokenTracker');
  private baseLogFile: string | undefined;

  private getSession(logFile: string | undefined) {
    if (!logFile) return null;
    let session = TokenTracker.sessions.get(logFile);
    if (!session) {
      session = {
        totalInput: 0,
        totalOutput: 0,
        totalCost: 0,
        entries: [],
        initialized: false,
        summaryWritten: false,
      };
      TokenTracker.sessions.set(logFile, session);
    }
    return session;
  }

  private buildPhaseLogFile(phase: TokenPhase): string | undefined {
    if (!this.baseLogFile) return undefined;
    return join(dirname(this.baseLogFile), `${phase}.tokens.log`);
  }

  private getAllLogFiles(): string[] {
    if (!this.baseLogFile) return [];
    return [
      this.baseLogFile,
      ...TOKEN_PHASES.map((phase) => this.buildPhaseLogFile(phase)).filter(
        Boolean,
      ),
    ] as string[];
  }

  static getTokenLogPath(logPath: string | undefined): string | undefined {
    if (!logPath) return undefined;
    return join(dirname(logPath), 'tokens', 'total.tokens.log');
  }

  private async ensureLogInitialized(
    logFile: string,
    title = 'TOKEN USAGE LOG',
  ): Promise<void> {
    const session = this.getSession(logFile);
    if (!session || session.initialized) return;

    await writeFile(
      logFile,
      `${'─'.repeat(80)}\n` +
        `${title}  ${new Date().toISOString()}\n` +
        `${'─'.repeat(80)}\n` +
        `${'TIMESTAMP'.padEnd(26)}${'COMPONENT'.padEnd(36)} ${'IN'.padStart(7)} ${'OUT'.padStart(7)}  ${'COST (USD)'.padStart(12)}\n` +
        `${'─'.repeat(80)}\n`,
    );
    session.initialized = true;
    session.summaryWritten = false;
  }

  private classifyPhase(label: string): TokenPhase | null {
    const normalized = label.toLowerCase().trim();
    if (!normalized) return null;

    if (
      normalized.startsWith('planner:') ||
      /:visual-plan:\d+$/.test(normalized)
    ) {
      return 'plan';
    }

    if (
      normalized.startsWith('backend-fix') ||
      /(^|:)(autofix|fix-agent|fix)(:|$)/.test(normalized)
    ) {
      return 'fix';
    }

    if (
      normalized.startsWith('backend-review:') ||
      normalized.includes(':generated-review:')
    ) {
      return 'review';
    }

    if (
      normalized.startsWith('backend-gen') ||
      normalized.includes(':precomputed-plan') ||
      normalized.includes(':direct-ai') ||
      normalized.includes(':fragment:') ||
      /:visual-plan(?::|$)/.test(normalized)
    ) {
      return 'gen';
    }

    return null;
  }

  private async appendEntry(
    logFile: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    tag: string,
    phase: TokenPhase | 'unclassified',
  ): Promise<number> {
    const session = this.getSession(logFile);
    if (!session) return 0;

    const pricing = MODEL_PRICING[model] ?? { input: 1.0, output: 3.0 };
    const costUsd =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;

    session.totalInput += inputTokens;
    session.totalOutput += outputTokens;
    session.totalCost += costUsd;
    session.entries.push({
      timestamp: new Date().toISOString(),
      model,
      label: tag,
      phase,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
    });

    const line =
      `${session.entries[session.entries.length - 1].timestamp}  ` +
      `${tag.padEnd(36)} ` +
      `${String(inputTokens).padStart(7)} ` +
      `${String(outputTokens).padStart(7)}  ` +
      `$${costUsd.toFixed(6).padStart(11)}\n`;
    await appendFile(logFile, line).catch(() => {});
    return costUsd;
  }

  /** Gọi đầu mỗi job để reset bộ đếm và set file log riêng */
  async init(logFile: string): Promise<void> {
    this.baseLogFile = logFile;
    await this.ensureLogInitialized(logFile, 'TOKEN USAGE LOG [TOTAL]');
    for (const phase of TOKEN_PHASES) {
      const phaseFile = this.buildPhaseLogFile(phase);
      if (!phaseFile) continue;
      await this.ensureLogInitialized(
        phaseFile,
        `TOKEN USAGE LOG [${phase.toUpperCase()}]`,
      );
    }
  }

  async track(
    model: string,
    inputTokens: number,
    outputTokens: number,
    label = '',
  ): Promise<void> {
    const tag = label || model;
    if (!this.baseLogFile) return;
    const phase = this.classifyPhase(tag) ?? 'unclassified';

    const costUsd = await this.appendEntry(
      this.baseLogFile,
      model,
      inputTokens,
      outputTokens,
      tag,
      phase,
    );

    const phaseFile =
      phase === 'unclassified' ? undefined : this.buildPhaseLogFile(phase);
    if (phaseFile) {
      await this.appendEntry(
        phaseFile,
        model,
        inputTokens,
        outputTokens,
        tag,
        phase,
      );
    }

    this.logger.log(
      `[${tag}] in=${inputTokens} out=${outputTokens} cost=$${costUsd.toFixed(6)}`,
    );
  }

  async writeSummary(): Promise<void> {
    for (const logFile of this.getAllLogFiles()) {
      const session = this.getSession(logFile);
      if (!session || session.summaryWritten) continue;

      const line =
        `${'─'.repeat(80)}\n` +
        `${''.padEnd(26)}${'TOTAL'.padEnd(36)} ` +
        `${String(session.totalInput).padStart(7)} ` +
        `${String(session.totalOutput).padStart(7)}  ` +
        `$${session.totalCost.toFixed(6).padStart(11)}\n` +
        `${'─'.repeat(80)}\n`;

      const phaseName =
        logFile === this.baseLogFile
          ? 'Total'
          : (logFile.match(/\.([a-z]+)\.tokens\.log$/)?.[1]?.toUpperCase() ??
            'UNKNOWN');
      this.logger.log(
        `[${phaseName}] in=${session.totalInput} out=${session.totalOutput} cost=$${session.totalCost.toFixed(4)}`,
      );
      await appendFile(logFile, line).catch(() => {});
      if (logFile === this.baseLogFile) {
        await writeFile(
          join(dirname(logFile), 'summary.tokens.json'),
          JSON.stringify(this.buildJsonSummary(session), null, 2),
        ).catch(() => {});
      }
      session.summaryWritten = true;
    }
  }

  getTotalCost(): number {
    return this.getSession(this.baseLogFile)?.totalCost ?? 0;
  }

  private buildJsonSummary(session: TokenSession) {
    const phaseTotals = new Map<
      TokenEntry['phase'],
      {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costUsd: number;
        calls: number;
      }
    >();

    for (const entry of session.entries) {
      const current = phaseTotals.get(entry.phase) ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        calls: 0,
      };
      current.inputTokens += entry.inputTokens;
      current.outputTokens += entry.outputTokens;
      current.totalTokens += entry.totalTokens;
      current.costUsd += entry.costUsd;
      current.calls += 1;
      phaseTotals.set(entry.phase, current);
    }

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        inputTokens: session.totalInput,
        outputTokens: session.totalOutput,
        totalTokens: session.totalInput + session.totalOutput,
        costUsd: Number(session.totalCost.toFixed(6)),
        calls: session.entries.length,
      },
      phases: Object.fromEntries(
        Array.from(phaseTotals.entries()).map(([phase, totals]) => [
          phase,
          {
            ...totals,
            costUsd: Number(totals.costUsd.toFixed(6)),
          },
        ]),
      ),
      entries: session.entries.map((entry) => ({
        ...entry,
        costUsd: Number(entry.costUsd.toFixed(6)),
      })),
    };
  }
}
