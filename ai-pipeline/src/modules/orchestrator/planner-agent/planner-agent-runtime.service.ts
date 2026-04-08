import { Injectable, Logger } from '@nestjs/common';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { PlannerToolRegistryService } from './planner-tool-registry.service.js';
import type {
  PlannerAgentDecision,
  PlannerAgentHistoryItem,
  PlannerAgentInput,
  PlannerAgentResult,
  PlannerAgentState,
  PlannerToolDefinition,
  PlannerToolName,
} from './planner-agent.types.js';
import { summarizePlan } from './planner-agent.types.js';

@Injectable()
export class PlannerAgentRuntimeService {
  private readonly logger = new Logger(PlannerAgentRuntimeService.name);

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly toolRegistry: PlannerToolRegistryService,
  ) {}

  async run(input: PlannerAgentInput): Promise<PlannerAgentResult> {
    const state: PlannerAgentState = {
      history: [],
      visualsAttached: false,
    };
    const maxRounds = input.maxRounds ?? 6;
    const tools = this.toolRegistry.createTools(input);

    for (let round = 1; round <= maxRounds; round++) {
      const decision = await this.chooseNextAction(input, state, tools, round);
      if (decision.action === 'finish') {
        if (state.review?.isValid && state.visualsAttached) {
          return {
            reviewResult: state.review,
            history: state.history,
          };
        }
        throw new Error(
          `Planner agent tried to finish before producing a valid reviewed visual plan: ${decision.finalReason ?? 'no reason provided'}`,
        );
      }

      const toolName = decision.tool;
      if (!toolName) {
        throw new Error(
          'Planner agent returned action=tool without a tool name',
        );
      }
      const tool = tools.find((item) => item.name === toolName);
      if (!tool) {
        throw new Error(`Planner agent chose unknown tool "${toolName}"`);
      }

      const toolInput = decision.input ?? {};
      const result = await tool.execute(state, toolInput);
      const historyItem: PlannerAgentHistoryItem = {
        round,
        tool: toolName,
        input: toolInput,
        summary: result.summary,
      };
      state.history.push(historyItem);
      await this.logRound(input, state, historyItem);

      if (state.review?.isValid && state.visualsAttached) {
        return {
          reviewResult: state.review,
          history: state.history,
        };
      }
    }

    throw new Error(
      `Planner agent exhausted ${maxRounds} round(s) without reaching a valid reviewed visual plan`,
    );
  }

  private async chooseNextAction(
    input: PlannerAgentInput,
    state: PlannerAgentState,
    tools: PlannerToolDefinition[],
    round: number,
  ): Promise<PlannerAgentDecision> {
    const response = await this.llmFactory.chat({
      model: input.modelName,
      systemPrompt: this.buildSystemPrompt(tools),
      userPrompt: this.buildUserPrompt(input, state, round),
      maxTokens: 900,
      temperature: 0,
    });

    const decision = this.parseDecision(response.text);
    if (!decision) {
      throw new Error(`Planner agent returned invalid JSON: ${response.text}`);
    }
    return decision;
  }

  private buildSystemPrompt(tools: PlannerToolDefinition[]): string {
    const toolList = tools
      .map(
        (tool) =>
          `- ${tool.name}: ${tool.description}\n  input: ${tool.inputHint}`,
      )
      .join('\n');

    return [
      'You are the planner supervisor for a migration pipeline.',
      'Your job is to choose the next tool call that moves the planner toward a valid reviewed plan with visual sections.',
      'You do not generate the plan directly in this step. You only choose tools.',
      'Rules:',
      '- Return JSON only. No markdown.',
      '- Choose exactly one action.',
      '- Prefer deterministic review before regenerating.',
      '- If review found errors, pass them back into generate_plan.planReviewErrors.',
      '- After attach_visual_plans, you must run review_visual_plan before finishing.',
      '- Finish only when there is a valid reviewed plan and visual sections are attached.',
      'Available tools:',
      toolList,
      'JSON schema:',
      '{"thought":"short reason","action":"tool|finish","tool":"tool_name_if_action_is_tool","input":{},"finalReason":"reason_if_finish"}',
    ].join('\n');
  }

  private buildUserPrompt(
    input: PlannerAgentInput,
    state: PlannerAgentState,
    round: number,
  ): string {
    const siteSummary = [
      `jobId: ${input.jobId}`,
      `round: ${round}`,
      `themeType: ${input.normalizedTheme.type}`,
      `siteName: ${input.content.siteInfo.siteName}`,
      `siteUrl: ${input.content.siteInfo.siteUrl}`,
      `templatesExpected: ${input.expectedTemplateNames.join(', ')}`,
      `currentPlan: ${summarizePlan(state.plan)}`,
      `currentReviewValid: ${state.review?.isValid === true ? 'yes' : 'no'}`,
      `currentReviewErrors: ${
        state.review?.errors?.length ? state.review.errors.join('; ') : 'none'
      }`,
      `visualsAttached: ${state.visualsAttached ? 'yes' : 'no'}`,
      `history: ${this.formatHistory(state.history)}`,
    ];

    return [
      'Current pipeline state:',
      ...siteSummary,
      '',
      'Pick the next best action.',
    ].join('\n');
  }

  private formatHistory(history: PlannerAgentHistoryItem[]): string {
    if (!history.length) return 'none';
    return history
      .slice(-4)
      .map(
        (item) =>
          `round ${item.round}: ${item.tool} -> ${item.summary.replace(/\s+/g, ' ').trim()}`,
      )
      .join(' | ');
  }

  private parseDecision(raw: string): PlannerAgentDecision | null {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;

    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      const action =
        parsed?.action === 'finish'
          ? 'finish'
          : parsed?.action === 'tool'
            ? 'tool'
            : null;
      if (!action) return null;
      const tool = this.normalizeToolName(parsed?.tool);
      return {
        thought:
          typeof parsed?.thought === 'string'
            ? parsed.thought.trim()
            : undefined,
        action,
        tool,
        input:
          parsed?.input &&
          typeof parsed.input === 'object' &&
          !Array.isArray(parsed.input)
            ? parsed.input
            : {},
        finalReason:
          typeof parsed?.finalReason === 'string'
            ? parsed.finalReason.trim()
            : undefined,
      };
    } catch {
      return null;
    }
  }

  private normalizeToolName(value: unknown): PlannerToolName | undefined {
    return value === 'generate_plan' ||
      value === 'review_plan' ||
      value === 'attach_visual_plans' ||
      value === 'review_visual_plan'
      ? value
      : undefined;
  }

  private async logRound(
    input: PlannerAgentInput,
    state: PlannerAgentState,
    historyItem: PlannerAgentHistoryItem,
  ): Promise<void> {
    const line =
      `[planner-agent] round ${historyItem.round} tool=${historyItem.tool} ` +
      `input=${JSON.stringify(historyItem.input)} summary=${historyItem.summary}`;
    this.logger.log(line);
    if (!input.logPath) return;
    try {
      const fs = await import('fs/promises');
      await fs.appendFile(
        input.logPath,
        `${new Date().toISOString()} ${line}\n`,
      );
      if (state.review?.errors?.length) {
        await fs.appendFile(
          input.logPath,
          `${new Date().toISOString()} [planner-agent] review-errors=${state.review.errors.join('; ')}\n`,
        );
      }
    } catch {
      // logging is best-effort
    }
  }
}
