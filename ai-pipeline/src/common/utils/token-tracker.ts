import { Logger } from '@nestjs/common';
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

export type TokenPhase = 'plan' | 'gen' | 'review' | 'fix';
export type TokenScope = 'base' | 'edit-request';
type TokenEntry = {
  timestamp: string;
  model: string;
  label: string;
  phase: TokenPhase | 'unclassified';
  scope: TokenScope;
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

export interface TokenUsagePhaseSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface TokenUsageSummary {
  generatedAt: string;
  totals: TokenUsagePhaseSummary;
  phases: Record<string, TokenUsagePhaseSummary>;
  scopes: Record<string, TokenUsagePhaseSummary>;
  scopePhases: Record<string, Record<string, TokenUsagePhaseSummary>>;
  entries: Array<
    TokenEntry & {
      costUsd: number;
    }
  >;
}

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
    if (logPath.endsWith('.json')) return logPath;
    return join(dirname(logPath), 'tokens', 'total.tokens.log');
  }

  private ensureLogInitialized(logFile: string): void {
    const session = this.getSession(logFile);
    if (!session || session.initialized) return;
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
    scope: TokenScope,
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
      scope,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
    });

    return costUsd;
  }

  /** Gọi đầu mỗi job để reset bộ đếm và set file log riêng */
  async init(logFile: string): Promise<void> {
    this.baseLogFile = logFile;
    this.ensureLogInitialized(logFile);
    for (const phase of TOKEN_PHASES) {
      const phaseFile = this.buildPhaseLogFile(phase);
      if (!phaseFile) continue;
      this.ensureLogInitialized(phaseFile);
    }
  }

  async track(
    model: string,
    inputTokens: number,
    outputTokens: number,
    label = '',
    options?: { scope?: TokenScope },
  ): Promise<void> {
    const tag = label || model;
    if (!this.baseLogFile) return;
    const phase = this.classifyPhase(tag) ?? 'unclassified';
    const scope = options?.scope ?? 'base';

    const costUsd = await this.appendEntry(
      this.baseLogFile,
      model,
      inputTokens,
      outputTokens,
      tag,
      phase,
      scope,
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
        scope,
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

      const phaseName =
        logFile === this.baseLogFile
          ? 'Total'
          : (logFile.match(/\.([a-z]+)\.tokens\.log$/)?.[1]?.toUpperCase() ??
            'UNKNOWN');
      this.logger.log(
        `[${phaseName}] in=${session.totalInput} out=${session.totalOutput} cost=$${session.totalCost.toFixed(4)}`,
      );
      session.summaryWritten = true;
    }
  }

  getTotalCost(): number {
    return this.getSession(this.baseLogFile)?.totalCost ?? 0;
  }

  getSummary(logFile = this.baseLogFile): TokenUsageSummary | null {
    const session = this.getSession(logFile);
    if (!session) return null;
    return this.buildJsonSummary(session);
  }

  clear(logFile = this.baseLogFile): void {
    if (!logFile) return;
    TokenTracker.sessions.delete(logFile);
    for (const phase of TOKEN_PHASES) {
      TokenTracker.sessions.delete(
        join(dirname(logFile), `${phase}.tokens.log`),
      );
    }
    if (this.baseLogFile === logFile) {
      this.baseLogFile = undefined;
    }
  }

  private buildJsonSummary(session: TokenSession): TokenUsageSummary {
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
    const scopeTotals = new Map<
      TokenEntry['scope'],
      {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        costUsd: number;
        calls: number;
      }
    >();
    const scopePhaseTotals = new Map<
      TokenEntry['scope'],
      Map<
        TokenEntry['phase'],
        {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          costUsd: number;
          calls: number;
        }
      >
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

      const currentScope = scopeTotals.get(entry.scope) ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        calls: 0,
      };
      currentScope.inputTokens += entry.inputTokens;
      currentScope.outputTokens += entry.outputTokens;
      currentScope.totalTokens += entry.totalTokens;
      currentScope.costUsd += entry.costUsd;
      currentScope.calls += 1;
      scopeTotals.set(entry.scope, currentScope);

      const phaseMap =
        scopePhaseTotals.get(entry.scope) ??
        new Map<
          TokenEntry['phase'],
          {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            costUsd: number;
            calls: number;
          }
        >();
      const currentScopePhase = phaseMap.get(entry.phase) ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        calls: 0,
      };
      currentScopePhase.inputTokens += entry.inputTokens;
      currentScopePhase.outputTokens += entry.outputTokens;
      currentScopePhase.totalTokens += entry.totalTokens;
      currentScopePhase.costUsd += entry.costUsd;
      currentScopePhase.calls += 1;
      phaseMap.set(entry.phase, currentScopePhase);
      scopePhaseTotals.set(entry.scope, phaseMap);
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
      scopes: Object.fromEntries(
        Array.from(scopeTotals.entries()).map(([scope, totals]) => [
          scope,
          {
            ...totals,
            costUsd: Number(totals.costUsd.toFixed(6)),
          },
        ]),
      ),
      scopePhases: Object.fromEntries(
        Array.from(scopePhaseTotals.entries()).map(([scope, phaseMap]) => [
          scope,
          Object.fromEntries(
            Array.from(phaseMap.entries()).map(([phase, totals]) => [
              phase,
              {
                ...totals,
                costUsd: Number(totals.costUsd.toFixed(6)),
              },
            ]),
          ),
        ]),
      ),
      entries: session.entries.map((entry) => ({
        ...entry,
        costUsd: Number(entry.costUsd.toFixed(6)),
      })),
    };
  }
}
