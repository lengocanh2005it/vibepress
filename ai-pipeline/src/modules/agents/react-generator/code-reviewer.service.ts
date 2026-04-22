import { Inject, Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import OpenAI from 'openai';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { OPENAI_CLIENT } from '../../../common/providers/openai/openai.provider.js';
import {
  TokenTracker,
  type TokenScope,
} from '../../../common/utils/token-tracker.js';
import {
  AiLoggerService,
  type AttemptLog,
} from '../../ai-logger/ai-logger.service.js';
import {
  ValidatorService,
  type CodeValidationContext,
} from '../validator/validator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';
import { getComponentStrategy } from '../component-strategy.registry.js';
import {
  buildComponentPrompt,
  buildInlineSectionPrompt,
  buildSectionPrompt,
  type ComponentPromptContext,
} from './prompts/component.prompt.js';
import {
  buildFragmentPrompt,
  FRAGMENT_SYSTEM_PROMPT,
} from './prompts/fragment.prompt.js';
import { INVENTED_AUXILIARY_SECTION_LABELS } from './auxiliary-section.guard.js';
import {
  buildVisualPlanPrompt,
  extractStaticImageSources,
  parseVisualPlanDetailed,
} from './prompts/visual-plan.prompt.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type {
  ThemeInteractionTarget,
  ThemeTokens,
} from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type { ComponentVisualPlan, DataNeed } from './visual-plan.schema.js';

export interface ReviewInput {
  componentName: string;
  templateSource: string;
  modelName: string;
  /** Model for the Fix Agent (R3 repair pass). Defaults to modelName if omitted. */
  fixAgentModel?: string;
  /** Prefer direct block-tree prompting over visual-plan-first codegen for this call. */
  preferDirectAi?: boolean;
  systemPrompt: string;
  content: DbContentResult;
  tokens?: ThemeTokens;
  repoManifest?: RepoThemeManifest;
  componentPlan?: PlanResult[number];
  editRequestContextNote?: string;
  logPath?: string;
  jobId?: string;
}

export interface SectionReviewInput {
  sectionName: string;
  parentName: string;
  sectionIndex: number;
  totalSections: number;
  nodesJson: string;
  modelName: string;
  /** Model for the Fix Agent (R3 repair pass). Defaults to modelName if omitted. */
  fixAgentModel?: string;
  /** Prefer direct block-tree prompting over visual-plan context for this section. */
  preferDirectAi?: boolean;
  systemPrompt?: string;
  content: DbContentResult;
  tokens?: ThemeTokens;
  repoManifest?: RepoThemeManifest;
  componentPlan?: PlanResult[number];
  editRequestContextNote?: string;
  logPath?: string;
  jobId?: string;
}

export interface ReviewResult {
  component: GeneratedComponent;
  /** true when code was sourced from the deterministic plan path */
  fromVisualPlan: boolean;
  /** 'deterministic' = CodeGeneratorService only, no LLM TSX gen; 'ai' = LLM was used */
  generationMode: 'deterministic' | 'ai';
  /** number of AI generation attempts used */
  attempts: number;
  /** raw response from AI for logging */
  rawResponse: string;
}

/**
 * Code Reviewer — maps to the REVIEW subgraph in the pipeline diagram:
 *
 *   Code Reviewer → Match? ──No──▶ Fix Agent ──▶ loop back
 *                      └──Yes──▶ pass
 *
 * Responsibilities:
 *  1. Use AI to generate TSX from a pre-computed visual plan when available.
 *  2. Fallback to AI visual plan → AI TSX generation.
 *  3. Keep deterministic codegen as a safety net when plan-guided AI output is invalid.
 *  4. Self-fix repair pass if all 3 attempts fail.
 */
@Injectable()
export class CodeReviewerService {
  private readonly logger = new Logger(CodeReviewerService.name);
  private readonly tokenTracker = new TokenTracker();
  private readonly componentSystemPrompt =
    'You are a senior React + TypeScript + Tailwind engineer. Generate a complete component from the provided migration context and return ONLY raw TSX code.';
  private readonly rawOutputDivider = '\n----- RAW OUTPUT BEGIN -----\n';

  constructor(
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
    private readonly llmFactory: LlmFactoryService,
    private readonly validator: ValidatorService,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly frameGenerator: FrameGeneratorService,
    private readonly aiLogger?: AiLoggerService,
  ) {}

  private readonly selfFixSystemPrompt =
    'You are a React/TypeScript expert. Fix the exact validation or targeted UI issue in the component. Preserve unrelated code, keep existing source-tracking attributes intact, and do not return the input unchanged when the request requires a scoped refinement. Return ONLY the corrected TSX code, no explanation.';

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Review + generate a single component.
   * Mirrors the `generateSingle()` logic that previously lived in ReactGeneratorService.
   */
  async reviewComponent(input: ReviewInput): Promise<ReviewResult> {
    const {
      componentName,
      templateSource,
      modelName,
      fixAgentModel = modelName,
      preferDirectAi = false,
      systemPrompt: upstreamSystemPrompt,
      content,
      tokens,
      repoManifest,
      componentPlan,
      editRequestContextNote,
      logPath,
      jobId,
    } = input;

    // MAX_ROUNDS implements R3 → D1 in the pipeline diagram:
    // after Fix Agent fails, restart from D1 (Visual Plan?) for one more round.
    const MAX_ROUNDS = 2;
    const forceDirectAi =
      preferDirectAi || process.env.REACT_GEN_FORCE_DIRECT_AI === 'true';
    const startTime = new Date().toISOString();

    let code = '';
    let attempts = 0;
    let lastError: string | undefined;
    const cotAttempts: AttemptLog[] = [];
    // Set when both AI codegen AND deterministic fallback from the pre-computed
    // plan have failed. Signals D2 to generate a fresh AI visual plan instead
    // of running direct-AI with the same broken plan context.
    let precomputedPlanAllFailed = false;
    const componentSystemPrompt = [
      upstreamSystemPrompt?.trim(),
      this.componentSystemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
    let promptContext = this.buildPromptContext(componentPlan, undefined, {
      includeVisualPlan: !forceDirectAi,
    });
    // Merge node-level customClassNames from templateSource into promptContext
    // so that custom classes on buttons, images, links, cards are not lost even
    // when the AI-generated visual plan omits them at the section level.
    const nodeCustomClassNames =
      this.collectCustomClassNamesFromNodesJson(templateSource);
    if (nodeCustomClassNames.length > 0) {
      const merged = [
        ...new Set([
          ...(promptContext?.requiredCustomClassNames ?? []),
          ...nodeCustomClassNames,
        ]),
      ];
      promptContext = promptContext
        ? { ...promptContext, requiredCustomClassNames: merged }
        : { requiredCustomClassNames: merged };
    }
    let validationContext = this.buildValidationContext(
      promptContext,
      componentName,
      false,
      undefined,
      this.resolveRequiredCustomClassTargets(
        promptContext?.requiredCustomClassNames,
        tokens,
      ),
    );

    if (preferDirectAi && componentPlan?.visualPlan) {
      await this.log(
        logPath,
        `[reviewer] "${componentName}": preferDirectAi enabled; bypassing visual-plan-first path to preserve WordPress block fidelity`,
      );
    }

    if (
      !forceDirectAi &&
      this.shouldUseSectionLevelAssembly(componentPlan, componentName)
    ) {
      this.logger.log(
        `[reviewer] "${componentName}": using section-level one-file assembly (${componentPlan?.visualPlan?.sections.length ?? 0} sections)`,
      );
      await this.log(
        logPath,
        `[reviewer] "${componentName}": using section-level one-file assembly (${componentPlan?.visualPlan?.sections.length ?? 0} sections)`,
      );
      try {
        const assembled = await this.generateComponentWithSectionAssembly({
          componentName,
          modelName,
          content,
          tokens,
          repoManifest,
          componentPlan: promptContext,
          editRequestContextNote,
          logPath,
          systemPrompt: componentSystemPrompt,
        });
        if (assembled.isValid) {
          return {
            component: {
              name: componentName,
              filePath: '',
              code: assembled.code,
              requiredCustomClassNames: promptContext?.requiredCustomClassNames,
            },
            fromVisualPlan: true,
            generationMode: 'ai',
            attempts: assembled.attemptsUsed,
            rawResponse: assembled.lastRawOutput || '',
          };
        }
        lastError = assembled.lastError;
        this.logger.warn(
          `[reviewer] "${componentName}" section-level assembly failed: ${assembled.lastError} — falling back to full-file generation`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" section-level assembly failed: ${assembled.lastError} — falling back to full-file generation`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        lastError = message;
        this.logger.warn(
          `[reviewer] "${componentName}" section-level assembly failed: ${message} — full-file fallback`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" section-level assembly failed: ${message} — full-file fallback`,
        );
      }
    }

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const isRetry = round > 1;

      // ── D1: Reviewed pre-computed visual plan → AI codegen first ────────────
      if (!forceDirectAi && !isRetry && componentPlan?.visualPlan) {
        if (this.shouldUseDeterministicFirst(componentPlan, componentName)) {
          const deterministic = await this.tryDeterministicPlan(
            componentName,
            componentPlan.visualPlan,
            validationContext,
            logPath,
            'deterministic-first reviewed plan',
          );
          if (deterministic.isValid) {
            this.logger.log(
              `[reviewer] "${componentName}" ✓ deterministic-first codegen succeeded`,
            );
            return {
              component: {
                name: componentName,
                filePath: '',
                code: deterministic.code,
                requiredCustomClassNames:
                  promptContext?.requiredCustomClassNames,
              },
              fromVisualPlan: true,
              generationMode: 'deterministic',
              attempts,
              rawResponse: '',
            };
          }
          // Deterministic-first components must NOT escalate to AI codegen.
          // Return best-effort code as-is; the build-fix loop will patch any
          // TypeScript errors without giving AI free rein over the structure.
          this.logger.warn(
            `[reviewer] "${componentName}" deterministic-first plan produced invalid code (${deterministic.error}) — returning best-effort, AI generation blocked`,
          );
          return {
            component: {
              name: componentName,
              filePath: '',
              code: deterministic.code,
              requiredCustomClassNames: promptContext?.requiredCustomClassNames,
            },
            fromVisualPlan: true,
            generationMode: 'deterministic',
            attempts,
            rawResponse: '',
          };
        }

        promptContext = this.buildPromptContext(
          componentPlan,
          componentPlan.visualPlan,
        );
        if (nodeCustomClassNames.length > 0) {
          const merged = [
            ...new Set([
              ...(promptContext?.requiredCustomClassNames ?? []),
              ...nodeCustomClassNames,
            ]),
          ];
          promptContext = promptContext
            ? { ...promptContext, requiredCustomClassNames: merged }
            : { requiredCustomClassNames: merged };
        }
        validationContext = this.buildValidationContext(
          promptContext,
          componentName,
          false,
          undefined,
          this.resolveRequiredCustomClassTargets(
            promptContext?.requiredCustomClassNames,
            tokens,
          ),
        );
        await this.log(
          logPath,
          `[reviewer] "${componentName}": using reviewed pre-computed visual plan for AI codegen (${componentPlan.visualPlan.sections.length} sections)`,
        );

        const planned = await this.generateComponentWithPlan({
          componentName,
          templateSource,
          modelName,
          content,
          tokens,
          repoManifest,
          componentPlan: promptContext,
          editRequestContextNote,
          logPath,
          logLabel: 'precomputed-plan',
          systemPrompt: componentSystemPrompt,
        });
        attempts += planned.attemptsUsed;
        code = planned.code;
        this.appendCotAttempts(cotAttempts, planned.cotAttempts);
        if (planned.isValid) {
          this.logger.log(
            `[reviewer] "${componentName}" ✓ AI codegen succeeded using reviewed visual plan`,
          );

          await this.logCotProcessIfEnabled({
            jobId,
            step: 'code-generation',
            componentName,
            model: modelName,
            startTime,
            attempts: cotAttempts,
            finalSuccess: true,
          });

          return {
            component: {
              name: componentName,
              filePath: '',
              code,
              requiredCustomClassNames: promptContext?.requiredCustomClassNames,
            },
            fromVisualPlan: true,
            generationMode: 'ai',
            attempts,
            rawResponse: planned.lastRawOutput || '',
          };
        }
        lastError = planned.lastError ?? lastError;
        this.logger.warn(
          `[reviewer] "${componentName}" AI pre-computed plan codegen failed: ${planned.lastError} — deterministic fallback`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" AI pre-computed plan codegen failed: ${planned.lastError} — deterministic fallback`,
        );

        const deterministic = await this.tryDeterministicPlan(
          componentName,
          componentPlan.visualPlan,
          validationContext,
          logPath,
          'pre-computed plan',
        );
        if (deterministic.isValid) {
          cotAttempts.push({
            attemptNumber: cotAttempts.length + 1,
            promptSent: {
              system: 'deterministic-fallback',
              user: 'rule-based generation fallback',
            },
            response: 'Deterministic fallback (rule-based generation)',
            tokensUsed: { input: 0, output: 0, total: 0 },
            timestamp: new Date().toISOString(),
            success: true,
            validationFeedback:
              'Deterministic pre-computed plan codegen succeeded',
          });
          await this.logCotProcessIfEnabled({
            jobId,
            step: 'code-generation',
            componentName,
            model: modelName,
            startTime,
            attempts: cotAttempts,
            finalSuccess: true,
          });

          return {
            component: {
              name: componentName,
              filePath: '',
              code: deterministic.code,
              requiredCustomClassNames: promptContext?.requiredCustomClassNames,
            },
            fromVisualPlan: true,
            generationMode: 'deterministic',
            attempts,
            rawResponse: '',
          };
        }
        lastError = deterministic.error ?? lastError;
        precomputedPlanAllFailed = true;
        this.logger.warn(
          `[reviewer] "${componentName}" deterministic pre-computed plan failed: ${deterministic.error} — skipping direct-AI, requesting fresh visual plan`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" deterministic pre-computed plan failed: ${deterministic.error} — skipping direct-AI, requesting fresh visual plan`,
        );
      }

      // ── D2: AI visual plan → AI codegen ─────────────────────────────────────
      // Used when: no pre-computed plan on round 1, after R3→D1 retry, or when
      // the pre-computed plan path has failed end-to-end (both AI and deterministic).
      if (
        !forceDirectAi &&
        (isRetry || !componentPlan?.visualPlan || precomputedPlanAllFailed)
      ) {
        await this.log(
          logPath,
          isRetry
            ? `[reviewer] "${componentName}" R3→D1: restarting with fresh AI visual plan (round ${round}/${MAX_ROUNDS})`
            : precomputedPlanAllFailed
              ? `[reviewer] "${componentName}" pre-computed plan failed end-to-end — generating fresh AI visual plan`
              : `[reviewer] Stage 1: requesting AI visual plan for "${componentName}"`,
        );
        const visualDataNeeds = componentPlan
          ? this.toVisualDataNeeds(componentPlan.dataNeeds)
          : undefined;
        const visualContract = componentPlan
          ? {
              componentType: componentPlan.type,
              route: componentPlan.route,
              isDetail: componentPlan.isDetail,
              dataNeeds: visualDataNeeds,
              stripLayoutChrome: componentPlan.type === 'page',
              sourceBackedAuxiliaryLabels:
                componentPlan.sourceBackedAuxiliaryLabels,
            }
          : undefined;

        const { systemPrompt: s1System, userPrompt: s1User } =
          buildVisualPlanPrompt({
            componentName,
            templateSource,
            content,
            tokens,
            repoManifest,
            componentType: componentPlan?.type,
            route: componentPlan?.route,
            isDetail: componentPlan?.isDetail,
            dataNeeds: visualDataNeeds,
            sourceBackedAuxiliaryLabels:
              componentPlan?.sourceBackedAuxiliaryLabels,
            editRequestContextNote,
          });

        try {
          const { text: s1Raw } = await this.generateWithRetry(
            modelName,
            s1System,
            s1User,
            3,
            logPath,
            `${componentName}:plan`,
            editRequestContextNote ? 'edit-request' : 'base',
          );
          const parsedPlan = parseVisualPlanDetailed(s1Raw, componentName, {
            allowedImageSrcs: extractStaticImageSources(templateSource),
            contract: visualContract,
          });
          const visualPlan = parsedPlan.plan;

          if (visualPlan) {
            promptContext = this.buildPromptContext(componentPlan, visualPlan);
            if (nodeCustomClassNames.length > 0) {
              const merged = [
                ...new Set([
                  ...(promptContext?.requiredCustomClassNames ?? []),
                  ...nodeCustomClassNames,
                ]),
              ];
              promptContext = promptContext
                ? { ...promptContext, requiredCustomClassNames: merged }
                : { requiredCustomClassNames: merged };
            }
            validationContext = this.buildValidationContext(
              promptContext,
              componentName,
              false,
              undefined,
              this.resolveRequiredCustomClassTargets(
                promptContext?.requiredCustomClassNames,
                tokens,
              ),
            );
            await this.log(
              logPath,
              `[reviewer] Stage 2: generating TSX with AI from visual plan (${visualPlan.sections.length} sections)`,
            );
            const planned = await this.generateComponentWithPlan({
              componentName,
              templateSource,
              modelName,
              content,
              tokens,
              repoManifest,
              componentPlan: promptContext,
              editRequestContextNote,
              logPath,
              logLabel: 'visual-plan',
              systemPrompt: componentSystemPrompt,
            });
            attempts += planned.attemptsUsed;
            code = planned.code;
            this.appendCotAttempts(cotAttempts, planned.cotAttempts);
            if (planned.isValid) {
              this.logger.log(
                `[reviewer] "${componentName}" ✓ AI codegen succeeded using AI-generated visual plan`,
              );

              await this.logCotProcessIfEnabled({
                jobId,
                step: 'code-generation',
                componentName,
                model: modelName,
                startTime,
                attempts: cotAttempts,
                finalSuccess: true,
              });

              return {
                component: {
                  name: componentName,
                  filePath: '',
                  code,
                  requiredCustomClassNames:
                    promptContext?.requiredCustomClassNames,
                },
                fromVisualPlan: true,
                generationMode: 'ai',
                attempts,
                rawResponse: planned.lastRawOutput || '',
              };
            }
            lastError = planned.lastError ?? lastError;
            this.logger.warn(
              `[reviewer] "${componentName}" AI plan-guided codegen failed: ${planned.lastError} — deterministic fallback`,
            );
            await this.log(
              logPath,
              `WARN [reviewer] "${componentName}" AI plan-guided codegen failed: ${planned.lastError} — deterministic fallback`,
            );

            const deterministic = await this.tryDeterministicPlan(
              componentName,
              visualPlan,
              validationContext,
              logPath,
              'AI visual plan',
            );
            if (deterministic.isValid) {
              return {
                component: {
                  name: componentName,
                  filePath: '',
                  code: deterministic.code,
                  requiredCustomClassNames:
                    promptContext?.requiredCustomClassNames,
                },
                fromVisualPlan: true,
                generationMode: 'deterministic',
                attempts,
                rawResponse: '',
              };
            }
            lastError = deterministic.error ?? lastError;
          } else {
            const reason =
              parsedPlan.diagnostic?.reason ??
              'unknown visual plan parse failure';
            const dropped = parsedPlan.diagnostic?.droppedSections?.length
              ? ` | droppedSections: ${parsedPlan.diagnostic.droppedSections.join('; ')}`
              : '';
            this.logger.warn(
              `[reviewer] "${componentName}" AI plan parse failed: ${reason}${dropped} — direct AI fallback${this.formatRawOutput(s1Raw)}`,
            );
            await this.log(
              logPath,
              `WARN [reviewer] "${componentName}" plan parse failed: ${reason}${dropped}${this.formatRawOutput(s1Raw)}`,
            );
          }
        } catch (err: any) {
          this.logger.warn(
            `[reviewer] "${componentName}" Stage 1 error: ${err?.message} — direct AI fallback`,
          );
          await this.log(
            logPath,
            `WARN [reviewer] "${componentName}" Stage 1 error — direct AI`,
          );
        }
      }

      // ── D3 + Match? loop: direct AI TSX (up to 3 attempts per round) ────────
      await this.log(
        logPath,
        `[reviewer] direct-AI path for "${componentName}" (round ${round}/${MAX_ROUNDS})`,
      );
      const direct = await this.generateComponentWithPlan({
        componentName,
        templateSource,
        modelName,
        content,
        tokens,
        repoManifest,
        componentPlan: promptContext,
        editRequestContextNote,
        logPath,
        logLabel: 'direct-ai',
        systemPrompt: componentSystemPrompt,
      });
      attempts += direct.attemptsUsed;
      code = direct.code;
      lastError = direct.lastError ?? lastError;
      this.appendCotAttempts(cotAttempts, direct.cotAttempts);

      if (direct.isValid) {
        this.logger.log(
          `[reviewer] "${componentName}" ✓ AI codegen succeeded using direct template prompt`,
        );

        await this.logCotProcessIfEnabled({
          jobId,
          step: 'code-generation',
          componentName,
          model: modelName,
          startTime,
          attempts: cotAttempts,
          finalSuccess: true,
        });

        return {
          component: {
            name: componentName,
            filePath: '',
            code,
            requiredCustomClassNames: promptContext?.requiredCustomClassNames,
          },
          fromVisualPlan: false,
          generationMode: 'ai',
          attempts,
          rawResponse: direct.lastRawOutput || '',
        };
      }

      // ── R3: Fix Agent — targeted AI repair pass ──────────────────────────────
      await this.log(
        logPath,
        `[reviewer:fix-agent] repairing "${componentName}": ${lastError}`,
      );
      try {
        const fixResult = await this.selfFixDetailed(
          fixAgentModel,
          code,
          lastError!,
          logPath,
          componentName,
        );
        code = fixResult.code;
        cotAttempts.push({
          attemptNumber: cotAttempts.length + 1,
          promptSent: {
            system: fixResult.systemPrompt,
            user: fixResult.userPrompt,
          },
          response: fixResult.rawResponse,
          tokensUsed: {
            input: fixResult.inputTokens,
            output: fixResult.outputTokens,
            total: fixResult.inputTokens + fixResult.outputTokens,
            ...(typeof fixResult.cachedTokens === 'number'
              ? { cached: fixResult.cachedTokens }
              : {}),
          },
          timestamp: new Date().toISOString(),
          success: false,
          validationFeedback: 'Fix Agent produced a repair candidate',
        });
        const check = this.validator.checkCodeStructure(
          code,
          validationContext,
        );
        if (check.fixedCode) code = check.fixedCode;
        if (check.isValid) {
          this.logger.log(`[reviewer:fix-agent] "${componentName}" ✓ repaired`);
          await this.log(
            logPath,
            `[reviewer:fix-agent] "${componentName}" ✓ repaired`,
          );

          cotAttempts[cotAttempts.length - 1] = {
            ...cotAttempts[cotAttempts.length - 1],
            success: true,
            error: undefined,
            validationFeedback: 'Fix Agent repair resolved validation errors',
          };
          await this.logCotProcessIfEnabled({
            jobId,
            step: 'code-generation',
            componentName,
            model: fixAgentModel,
            startTime,
            attempts: cotAttempts,
            finalSuccess: true,
          });

          return {
            component: {
              name: componentName,
              filePath: '',
              code,
              requiredCustomClassNames: promptContext?.requiredCustomClassNames,
            },
            fromVisualPlan: false,
            generationMode: 'ai',
            attempts,
            rawResponse: '',
          };
        }
        // R3 → D1: Fix Agent did not resolve the issue — loop back to D1
        lastError = check.error;
        this.logger.warn(
          `[reviewer:fix-agent] "${componentName}" still invalid: ${lastError}${round < MAX_ROUNDS ? ' — restarting from D1' : ' — giving up'}`,
        );
        await this.log(
          logPath,
          `WARN [reviewer:fix-agent] "${componentName}" still invalid: ${lastError}${round < MAX_ROUNDS ? ' — R3→D1 restart' : ' — giving up'}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `[reviewer:fix-agent] "${componentName}" repair call failed: ${err?.message}${round < MAX_ROUNDS ? ' — restarting from D1' : ' — giving up'}`,
        );
        await this.log(
          logPath,
          `WARN [reviewer:fix-agent] "${componentName}" repair call failed: ${err?.message}${round < MAX_ROUNDS ? ' — R3→D1 restart' : ' — giving up'}`,
        );
      }
    }

    // All retries exhausted — log final failure
    cotAttempts.push({
      attemptNumber: cotAttempts.length + 1,
      promptSent: {
        system: 'exhausted-retries',
        user: 'all retry paths exhausted',
      },
      response: `All retry paths exhausted after ${MAX_ROUNDS} rounds`,
      tokensUsed: { input: 0, output: 0, total: 0 },
      timestamp: new Date().toISOString(),
      success: false,
      error: lastError,
    });
    await this.logCotProcessIfEnabled({
      jobId,
      step: 'code-generation',
      componentName,
      model: modelName,
      startTime,
      attempts: cotAttempts,
      finalSuccess: false,
      finalError: lastError,
    });

    throw new Error(
      `[reviewer] "${componentName}" failed after ${MAX_ROUNDS} rounds + fix-agent: ${lastError}`,
    );
  }

  /**
   * Review + generate a section sub-component.
   * Mirrors the `generateSection()` logic previously in ReactGeneratorService.
   */
  async reviewSection(input: SectionReviewInput): Promise<GeneratedComponent> {
    const {
      sectionName,
      parentName,
      sectionIndex,
      totalSections,
      nodesJson,
      modelName,
      fixAgentModel = modelName,
      preferDirectAi = false,
      systemPrompt = '',
      content,
      tokens,
      repoManifest,
      componentPlan,
      editRequestContextNote,
      logPath,
      jobId,
    } = input;

    const startTime = new Date().toISOString();
    const cotAttempts: AttemptLog[] = [];
    const promptContext = this.buildPromptContext(componentPlan, undefined, {
      includeVisualPlan: !preferDirectAi,
      includeRequiredCustomClasses: false,
    });
    const requiredCustomClassNames =
      this.collectCustomClassNamesFromNodesJson(nodesJson);
    const requiredCustomClassTargets = this.resolveRequiredCustomClassTargets(
      requiredCustomClassNames,
      tokens,
    );

    const userPrompt = buildSectionPrompt({
      sectionName,
      parentName,
      sectionIndex,
      totalSections,
      nodesJson,
      siteInfo: content.siteInfo,
      menus: content.menus,
      tokens,
      repoManifest,
      content,
      componentPlan: promptContext,
      editRequestContextNote,
    });

    let code = '';
    let lastError: string | undefined;
    let isValid = false;
    const validationContext = this.buildValidationContext(
      promptContext,
      sectionName,
      true,
      requiredCustomClassNames,
      requiredCustomClassTargets,
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens,
      } = await this.generateWithRetry(
        modelName,
        systemPrompt,
        userPrompt,
        5,
        logPath,
        sectionName,
        editRequestContextNote ? 'edit-request' : 'base',
      );
      code = this.stripMarkdownFences(raw);
      code = this.mergeClassNames(code);
      code = this.fixDoublebraces(code);
      code = this.normalizeTailwindFunctionSpacing(code);

      const check = this.validator.checkCodeStructure(code, validationContext);
      if (check.fixedCode) code = check.fixedCode;
      cotAttempts.push({
        attemptNumber: cotAttempts.length + 1,
        promptSent: {
          system: systemPrompt,
          user: userPrompt,
        },
        response: raw,
        tokensUsed: {
          input: inTok,
          output: outTok,
          total: inTok + outTok,
          ...(typeof cachedTokens === 'number' ? { cached: cachedTokens } : {}),
        },
        timestamp: new Date().toISOString(),
        success: check.isValid,
        error: check.isValid ? undefined : check.error,
        validationFeedback: check.isValid
          ? 'Section generation succeeded'
          : undefined,
      });
      if (check.isValid) {
        isValid = true;
        break;
      }

      lastError = check.error;
      this.logger.warn(
        `[reviewer] Section "${sectionName}" attempt ${attempt}/3: ${lastError}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer] section "${sectionName}" attempt ${attempt}/3: ${lastError}${this.formatRawOutput(raw)}\n----- PROCESSED OUTPUT BEGIN -----\n${code || '(empty)'}\n----- PROCESSED OUTPUT END -----`,
      );
    }

    if (!isValid && lastError) {
      try {
        const fixResult = await this.selfFixDetailed(
          fixAgentModel,
          code,
          lastError,
          logPath,
          sectionName,
        );
        code = fixResult.code;
        cotAttempts.push({
          attemptNumber: cotAttempts.length + 1,
          promptSent: {
            system: fixResult.systemPrompt,
            user: fixResult.userPrompt,
          },
          response: fixResult.rawResponse,
          tokensUsed: {
            input: fixResult.inputTokens,
            output: fixResult.outputTokens,
            total: fixResult.inputTokens + fixResult.outputTokens,
            ...(typeof fixResult.cachedTokens === 'number'
              ? { cached: fixResult.cachedTokens }
              : {}),
          },
          timestamp: new Date().toISOString(),
          success: false,
          validationFeedback: 'Section fix agent produced a repair candidate',
        });
        const check = this.validator.checkCodeStructure(
          code,
          validationContext,
        );
        if (check.fixedCode) code = check.fixedCode;
        if (check.isValid) {
          isValid = true;
          cotAttempts[cotAttempts.length - 1] = {
            ...cotAttempts[cotAttempts.length - 1],
            success: true,
            error: undefined,
            validationFeedback: 'Section fix agent resolved validation errors',
          };
          await this.log(
            logPath,
            `[reviewer:fix-agent] section "${sectionName}" ✓ repaired`,
          );
        }
      } catch {
        // swallow — let the hard error below handle it
      }
    }

    if (!isValid) {
      cotAttempts.push({
        attemptNumber: cotAttempts.length + 1,
        promptSent: {
          system: 'section-generation-failed',
          user: 'section generation exhausted all attempts',
        },
        response: `Section generation failed after all attempts`,
        tokensUsed: { input: 0, output: 0, total: 0 },
        timestamp: new Date().toISOString(),
        success: false,
        error: lastError,
      });
      await this.logCotProcessIfEnabled({
        jobId,
        step: 'section-generation',
        componentName: sectionName,
        model: modelName,
        startTime,
        attempts: cotAttempts,
        finalSuccess: false,
        finalError: lastError,
      });

      throw new Error(
        `[reviewer] Section "${sectionName}" failed after 3 attempts: ${lastError}`,
      );
    }

    await this.logCotProcessIfEnabled({
      jobId,
      step: 'section-generation',
      componentName: sectionName,
      model: modelName,
      startTime,
      attempts: cotAttempts,
      finalSuccess: true,
    });

    return {
      name: sectionName,
      filePath: '',
      code,
      isSubComponent: true,
      requiredCustomClassNames,
      requiredCustomClassTargets,
    };
  }

  // ── Self-fix (Fix Agent) ───────────────────────────────────────────────────

  private buildPromptContext(
    componentPlan?: PlanResult[number] | ComponentPromptContext,
    visualPlan?: ComponentVisualPlan,
    options?: {
      includeVisualPlan?: boolean;
      includeRequiredCustomClasses?: boolean;
    },
  ): ComponentPromptContext | undefined {
    if (!componentPlan && !visualPlan) return undefined;

    const resolvedVisualPlan =
      options?.includeVisualPlan === false
        ? undefined
        : (visualPlan ?? componentPlan?.visualPlan);
    const hasExplicitDataNeeds = Array.isArray(componentPlan?.dataNeeds);
    const dataNeeds = hasExplicitDataNeeds
      ? [...(componentPlan?.dataNeeds ?? [])]
      : resolvedVisualPlan?.dataNeeds
        ? [...resolvedVisualPlan.dataNeeds]
        : undefined;
    const requiredCustomClassNames =
      options?.includeRequiredCustomClasses === false
        ? undefined
        : this.resolveRequiredCustomClassNames(
            componentPlan,
            resolvedVisualPlan,
          );

    return {
      description: componentPlan?.description,
      route: componentPlan?.route,
      isDetail: componentPlan?.isDetail,
      type: componentPlan?.type,
      dataNeeds,
      requiredCustomClassNames,
      sourceBackedAuxiliaryLabels: componentPlan?.sourceBackedAuxiliaryLabels,
      visualPlan: resolvedVisualPlan,
    };
  }

  private buildValidationContext(
    componentPlan?: ComponentPromptContext,
    componentName?: string,
    isSubComponent = false,
    requiredCustomClassNames?: string[],
    requiredCustomClassTargets?: Record<string, ThemeInteractionTarget>,
  ): CodeValidationContext {
    const commentSection = componentPlan?.visualPlan?.sections.find(
      (section) => section.type === 'comments',
    );
    return {
      componentName,
      route: componentPlan?.route,
      isDetail: componentPlan?.isDetail,
      dataNeeds: componentPlan?.dataNeeds,
      type: componentPlan?.type,
      isSubComponent,
      visualPlan: componentPlan?.visualPlan,
      allowedRelativeImports: componentPlan?.visualPlan?.layout.includes ?? [],
      requiredCustomClassNames:
        requiredCustomClassNames ?? componentPlan?.requiredCustomClassNames,
      requiredCustomClassTargets,
      requireCommentForm:
        commentSection?.type === 'comments' ? commentSection.showForm : false,
    };
  }

  private resolveRequiredCustomClassTargets(
    requiredCustomClassNames: string[] | undefined,
    tokens?: ThemeTokens,
  ): Record<string, ThemeInteractionTarget> | undefined {
    const precise = tokens?.interactions?.precise ?? [];
    if (!requiredCustomClassNames?.length || precise.length === 0) {
      return undefined;
    }

    const targetMap: Record<string, ThemeInteractionTarget> = {};
    for (const className of requiredCustomClassNames) {
      const normalized = className.trim();
      if (!normalized) continue;
      const match = precise.find((entry) => entry.className === normalized);
      if (match) targetMap[normalized] = match.target;
    }

    return Object.keys(targetMap).length > 0 ? targetMap : undefined;
  }

  private resolveRequiredCustomClassNames(
    componentPlan?: PlanResult[number] | ComponentPromptContext,
    visualPlan?: ComponentVisualPlan,
  ): string[] | undefined {
    const classNames = [
      ...(componentPlan && 'customClassNames' in componentPlan
        ? (componentPlan.customClassNames ?? [])
        : []),
      ...((visualPlan ?? componentPlan?.visualPlan)?.sections.flatMap(
        (section) => section.customClassNames ?? [],
      ) ?? []),
    ]
      .map((className) => className.trim())
      .filter(Boolean);
    if (classNames.length === 0) return undefined;
    return [...new Set(classNames)];
  }

  private collectCustomClassNamesFromNodesJson(nodesJson: string): string[] {
    try {
      const parsed = JSON.parse(nodesJson) as Array<{
        customClassNames?: string[];
        children?: unknown[];
      }>;
      const result = new Set<string>();
      const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const node = value as {
          customClassNames?: string[];
          children?: unknown[];
        };
        for (const className of node.customClassNames ?? []) {
          const normalized = className.trim();
          if (normalized) result.add(normalized);
        }
        for (const child of node.children ?? []) visit(child);
      };
      for (const node of parsed) visit(node);
      return [...result];
    } catch {
      return [];
    }
  }

  private shouldUseDeterministicFirst(
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
  ): boolean {
    if (!componentPlan?.visualPlan) return false;
    if (componentPlan.route === '*') return true;
    return getComponentStrategy(componentName).deterministicFirst;
  }

  private shouldUseFramePath(
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
  ): boolean {
    if (!componentPlan?.dataNeeds || !componentPlan?.type) return false;

    const strategy = getComponentStrategy(componentName);
    if (strategy.allowFramePath) return true;

    // Default deny: frame+fragment improves syntax stability but tends to
    // flatten structure and drift away from the original WordPress layout.
    // Keep it only for narrowly-scoped utility/meta components unless
    // explicitly allowlisted in the strategy registry.
    return false;
  }

  private shouldUseSectionLevelAssembly(
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
  ): boolean {
    return (
      componentName === 'Home' &&
      componentPlan?.type === 'page' &&
      Boolean(componentPlan.visualPlan) &&
      (componentPlan.visualPlan?.sections?.length ?? 0) >= 5
    );
  }

  private toVisualDataNeeds(dataNeeds?: string[]): DataNeed[] {
    const ordered: DataNeed[] = [
      'postDetail',
      'pageDetail',
      'comments',
      'posts',
      'pages',
      'menus',
      'siteInfo',
    ];
    const mapped = new Set<DataNeed>();

    for (const need of dataNeeds ?? []) {
      switch (need) {
        case 'site-info':
          mapped.add('siteInfo');
          break;
        case 'post-detail':
          mapped.add('postDetail');
          break;
        case 'page-detail':
          mapped.add('pageDetail');
          break;
        case 'comments':
          mapped.add('comments');
          break;
        case 'posts':
        case 'pages':
        case 'menus':
          mapped.add(need);
          break;
      }
    }

    return ordered.filter((need) => mapped.has(need));
  }

  // ── D0: Frame + Fragment generation ─────────────────────────────────────────
  //
  // Deterministically generates the TypeScript frame (imports, interfaces,
  // useState, useEffect, loading guard) from the component plan, then asks the
  // AI to fill in ONLY the JSX return body (~100–200 tokens instead of ~1500).
  //
  // On failure the TypeScript compiler is run against the assembled file and
  // the exact error messages (line/column/code) are fed back to the AI so it
  // can make a targeted fix instead of regenerating from scratch.
  //
  // Falls back to full-file generation (generateComponentWithPlan) when:
  //  - No dataNeeds or type in the plan (cannot build a frame)
  //  - Both fragment attempts produce invalid code

  private async generateComponentWithFrame(input: {
    componentName: string;
    templateSource: string;
    modelName: string;
    componentPlan: ComponentPromptContext;
    tokens?: ThemeTokens;
    editRequestContextNote?: string;
    logPath?: string;
  }): Promise<{
    code: string;
    isValid: boolean;
    attemptsUsed: number;
    lastError?: string;
    cotAttempts: AttemptLog[];
  }> {
    const {
      componentName,
      templateSource,
      modelName,
      componentPlan,
      editRequestContextNote,
      logPath,
    } = input;

    const frame = this.frameGenerator.generateFrame({
      componentName,
      type: componentPlan.type ?? 'page',
      dataNeeds: componentPlan.dataNeeds ?? [],
      isDetail: componentPlan.isDetail ?? false,
      route: componentPlan.route,
    });

    const availableVariables = this.frameGenerator.describeVariables({
      type: componentPlan.type ?? 'page',
      dataNeeds: componentPlan.dataNeeds ?? [],
      isDetail: componentPlan.isDetail ?? false,
    });

    const validationContext = this.buildValidationContext(
      componentPlan,
      componentName,
      false,
      undefined,
      this.resolveRequiredCustomClassTargets(
        componentPlan?.requiredCustomClassNames,
        input.tokens,
      ),
    );

    let lastFragment = '';
    let lastError = '';
    const cotAttempts: AttemptLog[] = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      const userPrompt = buildFragmentPrompt({
        componentName,
        availableVariables,
        templateSource,
        visualPlan: componentPlan.visualPlan,
        componentType: componentPlan.type,
        editRequestContextNote,
        retryError: attempt > 1 ? lastError : undefined,
        previousFragment: attempt > 1 ? lastFragment : undefined,
      });

      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens,
      } = await this.generateWithRetry(
        modelName,
        FRAGMENT_SYSTEM_PROMPT,
        userPrompt,
        3,
        logPath,
        `${componentName}:fragment:${attempt}`,
        editRequestContextNote ? 'edit-request' : 'base',
      );

      lastFragment = raw
        .replace(/^```(?:tsx|jsx|ts|js)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      const assembled = this.frameGenerator.assembleComponent(
        frame,
        lastFragment,
      );
      const sanitized = this.validator.sanitizeGeneratedCode(
        this.stripSpuriousHardcodedSections(
          this.postProcessCode(assembled),
          input.componentName,
        ),
      );
      const check = this.validator.checkCodeStructure(
        sanitized,
        validationContext,
      );
      const code = check.fixedCode ?? sanitized;
      cotAttempts.push({
        attemptNumber: attempt,
        promptSent: {
          system: FRAGMENT_SYSTEM_PROMPT,
          user: userPrompt,
        },
        response: raw,
        tokensUsed: {
          input: inTok,
          output: outTok,
          total: inTok + outTok,
          ...(typeof cachedTokens === 'number' ? { cached: cachedTokens } : {}),
        },
        timestamp: new Date().toISOString(),
        success: check.isValid,
        error: check.isValid ? undefined : check.error,
        validationFeedback: check.isValid
          ? 'frame-fragment generation succeeded'
          : undefined,
      });

      if (check.isValid) {
        await this.log(
          logPath,
          `[reviewer:frame] "${componentName}" fragment attempt ${attempt}/2 ✓`,
        );
        return { code, isValid: true, attemptsUsed: attempt, cotAttempts };
      }

      // Prefer TypeScript compiler diagnostics over generic validator message
      const tsErrors = this.validator.extractTypeScriptErrors(
        code,
        componentName,
      );
      lastError =
        tsErrors.length > 0
          ? tsErrors.join('\n')
          : (check.error ?? 'unknown validation error');

      this.logger.warn(
        `[reviewer:frame] "${componentName}" fragment attempt ${attempt}/2 failed: ${lastError}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer:frame] "${componentName}" fragment attempt ${attempt}/2 failed:\n${lastError}`,
      );
    }

    return {
      code: '',
      isValid: false,
      attemptsUsed: 2,
      lastError,
      cotAttempts,
    };
  }

  private async generateComponentWithPlan(input: {
    componentName: string;
    templateSource: string;
    modelName: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    repoManifest?: RepoThemeManifest;
    componentPlan?: ComponentPromptContext;
    editRequestContextNote?: string;
    logPath?: string;
    logLabel: string;
    systemPrompt: string;
    maxAttempts?: number;
  }): Promise<{
    code: string;
    isValid: boolean;
    attemptsUsed: number;
    lastError?: string;
    lastRawOutput?: string;
    /** Per-attempt CoT records — caller merges into its own cotAttempts */
    cotAttempts: import('../../ai-logger/ai-logger.service.js').AttemptLog[];
  }> {
    const {
      componentName,
      templateSource,
      modelName,
      content,
      tokens,
      repoManifest,
      componentPlan,
      editRequestContextNote,
      logPath,
      logLabel,
      systemPrompt,
      maxAttempts = 3,
    } = input;

    let code = '';
    let lastError: string | undefined;
    let lastRawOutput = '';
    const cotAttempts: import('../../ai-logger/ai-logger.service.js').AttemptLog[] =
      [];
    const validationContext = this.buildValidationContext(
      componentPlan,
      componentName,
      false,
      undefined,
      this.resolveRequiredCustomClassTargets(
        componentPlan?.requiredCustomClassNames,
        tokens,
      ),
    );

    // ── D0: Frame + Fragment — try before full-file generation ──────────────
    // Skipped when the plan lacks enough context to build a frame (no dataNeeds
    // or no type), or when direct-AI / section-chunk paths explicitly request
    // full-file output (logLabel === 'direct-ai' has already exhausted D2).
    if (
      componentPlan &&
      this.shouldUseFramePath(componentPlan, componentName)
    ) {
      const frameResult = await this.generateComponentWithFrame({
        componentName,
        templateSource,
        modelName,
        componentPlan,
        tokens,
        editRequestContextNote,
        logPath,
      });
      if (frameResult.isValid) {
        this.logger.log(
          `[reviewer:frame] "${componentName}" ✓ frame+fragment succeeded (${frameResult.attemptsUsed} attempt(s))`,
        );
        return {
          code: frameResult.code,
          isValid: true,
          attemptsUsed: frameResult.attemptsUsed,
          lastRawOutput: '',
          cotAttempts: frameResult.cotAttempts,
        };
      }
      lastError = frameResult.lastError;
      this.logger.warn(
        `[reviewer:frame] "${componentName}" frame+fragment failed (${frameResult.lastError}) — falling back to full-file generation`,
      );
      await this.log(
        logPath,
        `WARN [reviewer:frame] "${componentName}" frame+fragment failed — full-file fallback`,
      );
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const userPromptForAttempt = buildComponentPrompt(
        componentName,
        templateSource,
        content.siteInfo,
        content,
        tokens,
        repoManifest,
        componentPlan,
        editRequestContextNote,
        attempt > 1
          ? this.buildRetryAppendix({
              componentName,
              code,
              lastError,
              validationContext,
              componentPlan,
            })
          : undefined,
      );
      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens,
      } = await this.generateWithRetry(
        modelName,
        systemPrompt,
        userPromptForAttempt,
        5,
        logPath,
        `${componentName}:${logLabel}`,
        editRequestContextNote ? 'edit-request' : 'base',
      );

      lastRawOutput = raw;
      code = this.stripSpuriousHardcodedSections(
        this.postProcessCode(raw),
        componentName,
      );

      const check = this.validator.checkCodeStructure(code, validationContext);
      if (check.fixedCode) code = check.fixedCode;

      cotAttempts.push({
        attemptNumber: attempt,
        promptSent: {
          system: systemPrompt,
          user: userPromptForAttempt,
        },
        response: raw,
        tokensUsed: {
          input: inTok,
          output: outTok,
          total: inTok + outTok,
          ...(typeof cachedTokens === 'number' ? { cached: cachedTokens } : {}),
        },
        timestamp: new Date().toISOString(),
        success: check.isValid,
        error: check.isValid ? undefined : check.error,
        validationFeedback: check.isValid ? `${logLabel} succeeded` : undefined,
      });

      if (check.isValid) {
        return {
          code,
          isValid: true,
          attemptsUsed: attempt,
          lastRawOutput,
          cotAttempts,
        };
      }

      lastError = check.error;
      this.logger.warn(
        `[reviewer] "${componentName}" ${logLabel} attempt ${attempt}/${maxAttempts} failed: ${lastError}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer] "${componentName}" ${logLabel} attempt ${attempt}/${maxAttempts}: ${lastError}${this.formatRawOutput(raw)}\n----- PROCESSED OUTPUT BEGIN -----\n${code || '(empty)'}\n----- PROCESSED OUTPUT END -----`,
      );

      // Auto repair for specific failure modes at last attempt before falling back up the pipeline
      if (attempt === maxAttempts) {
        const isNoJsx = lastError?.includes('No JSX return found');
        const isPageContract = lastError?.includes(
          'Page detail contract violated',
        );
        const isVisualPlanFidelity = lastError?.includes(
          'Visual plan fidelity violated',
        );

        if (isNoJsx || isPageContract || isVisualPlanFidelity) {
          const reason = isNoJsx
            ? 'No JSX return found'
            : isPageContract
              ? 'Page detail contract violated'
              : 'Visual plan fidelity violated';
          this.logger.warn(
            `[reviewer:autofix] "${componentName}" ${reason}; invoking self-fix agent`,
          );
          await this.log(
            logPath,
            `[reviewer:autofix] "${componentName}" ${reason}; invoking self-fix agent`,
          );

          try {
            const fixedResult = await this.selfFixDetailed(
              modelName,
              code,
              this.buildAutoFixErrorContext(
                reason,
                lastError,
                componentPlan,
                componentName,
              ),
              logPath,
              `${componentName}:${logLabel}:autofix`,
            );
            code = fixedResult.code;

            const finalCheck = this.validator.checkCodeStructure(
              code,
              validationContext,
            );
            if (finalCheck.fixedCode) code = finalCheck.fixedCode;

            if (finalCheck.isValid) {
              this.logger.log(
                `[reviewer:autofix] "${componentName}" ✓ repaired no-JSX and validated`,
              );
              await this.log(
                logPath,
                `[reviewer:autofix] "${componentName}" ✓ repaired no-JSX and validated`,
              );
              cotAttempts.push({
                attemptNumber: cotAttempts.length + 1,
                promptSent: {
                  system: fixedResult.systemPrompt,
                  user: fixedResult.userPrompt,
                },
                response: fixedResult.rawResponse,
                tokensUsed: {
                  input: fixedResult.inputTokens,
                  output: fixedResult.outputTokens,
                  total: fixedResult.inputTokens + fixedResult.outputTokens,
                  ...(typeof fixedResult.cachedTokens === 'number'
                    ? { cached: fixedResult.cachedTokens }
                    : {}),
                },
                timestamp: new Date().toISOString(),
                success: true,
                validationFeedback: `autofix resolved: ${reason}`,
              });
              return {
                code,
                isValid: true,
                attemptsUsed: attempt,
                lastRawOutput: raw,
                cotAttempts,
              };
            }

            lastError = finalCheck.error ?? lastError;
            this.logger.warn(
              `[reviewer:autofix] "${componentName}" self-fix still invalid: ${lastError}`,
            );
            await this.log(
              logPath,
              `WARN [reviewer:autofix] "${componentName}" self-fix still invalid: ${lastError}`,
            );
          } catch (fixErr: unknown) {
            const fixErrMessage =
              fixErr instanceof Error
                ? fixErr.message
                : typeof fixErr === 'string'
                  ? fixErr
                  : JSON.stringify(fixErr);
            this.logger.warn(
              `[reviewer:autofix] "${componentName}" self-fix failed: ${fixErrMessage}`,
            );
            await this.log(
              logPath,
              `WARN [reviewer:autofix] "${componentName}" self-fix failed: ${fixErrMessage}`,
            );
          }
        }
      }
    }

    return {
      code,
      isValid: false,
      attemptsUsed: maxAttempts,
      lastError,
      lastRawOutput,
      cotAttempts,
    };
  }

  private async tryDeterministicPlan(
    componentName: string,
    visualPlan: ComponentVisualPlan,
    validationContext: CodeValidationContext,
    logPath?: string,
    label = 'visual plan',
  ): Promise<{ code: string; isValid: boolean; error?: string }> {
    let code = this.codeGenerator.generate(visualPlan);
    const check = this.validator.checkCodeStructure(code, {
      ...validationContext,
      dataNeeds: validationContext.dataNeeds ?? visualPlan.dataNeeds,
      allowedRelativeImports:
        validationContext.allowedRelativeImports ?? visualPlan.layout.includes,
    });
    if (check.fixedCode) code = check.fixedCode;

    if (check.isValid) {
      this.logger.log(
        `[reviewer] "${componentName}" ✓ deterministic codegen fallback succeeded from ${label}`,
      );
      await this.log(
        logPath,
        `[reviewer] "${componentName}" ✓ deterministic codegen fallback succeeded from ${label}`,
      );
      return { code, isValid: true };
    }

    this.logger.warn(
      `[reviewer] "${componentName}" deterministic fallback from ${label} failed: ${check.error}`,
    );
    await this.log(
      logPath,
      `WARN [reviewer] "${componentName}" deterministic fallback from ${label} failed: ${check.error}`,
    );
    return {
      code,
      isValid: false,
      error: check.error,
    };
  }

  public async selfFix(
    model: string,
    brokenCode: string,
    error: string,
    logPath?: string,
    label?: string,
    visionImageUrls: string[] = [],
    tokenScope: TokenScope = 'base',
  ): Promise<string> {
    const result = await this.selfFixDetailed(
      model,
      brokenCode,
      error,
      logPath,
      label,
      visionImageUrls,
      tokenScope,
    );
    return result.code;
  }

  private async selfFixDetailed(
    model: string,
    brokenCode: string,
    error: string,
    logPath?: string,
    label?: string,
    visionImageUrls: string[] = [],
    tokenScope: TokenScope = 'base',
  ): Promise<{
    code: string;
    systemPrompt: string;
    userPrompt: string;
    rawResponse: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  }> {
    const normalizedVisionUrls = visionImageUrls
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3);

    const userPrompt = `This component has a validation error or targeted edit request:\n${error}\n\nFix it and return the complete corrected code. When exact target regions or capture instructions are included, modify those regions first while preserving unrelated code.\n\`\`\`tsx\n${brokenCode}\n\`\`\``;

    if (
      normalizedVisionUrls.length > 0 &&
      this.canUseOpenAiVisionModel(model)
    ) {
      try {
        const openAiModel = this.resolveOpenAiModelName(model);
        const response = await this.llmFactory.runWithRetry(
          `openai-vision-fix:${openAiModel}`,
          () =>
            this.openai.chat.completions.create({
              model: openAiModel,
              temperature: 0,
              max_completion_tokens: this.llmFactory.getMaxTokens(),
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a React/TypeScript expert. Fix the exact scoped UI issue in the component. Preserve unrelated code, keep existing source-tracking attributes intact, and do not return the input unchanged when the request requires a scoped refinement. Return ONLY the corrected TSX code.',
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text:
                        `This component has a validation or targeted edit request:\n${error}\n\n` +
                        `Fix it and return the complete corrected code. When exact target regions or capture instructions are included, modify those regions first while preserving unrelated code.\n\`\`\`tsx\n${brokenCode}\n\`\`\``,
                    },
                    ...normalizedVisionUrls.map((url) => ({
                      type: 'image_url' as const,
                      image_url: { url, detail: 'high' as const },
                    })),
                  ],
                },
              ],
            }),
        );
        const text = response.choices[0]?.message?.content;
        if (text) {
          const usage = response.usage;
          const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
          if (tokenLogPath) {
            await this.tokenTracker.init(tokenLogPath);
            await this.tokenTracker.track(
              model,
              usage?.prompt_tokens ?? 0,
              usage?.completion_tokens ?? 0,
              label ? `${label}:fix` : model,
              { scope: tokenScope },
            );
          }
          return {
            code: this.postProcessCode(text),
            systemPrompt:
              'You are a React/TypeScript expert. Fix the exact scoped UI issue in the component. Preserve unrelated code, keep existing source-tracking attributes intact, and do not return the input unchanged when the request requires a scoped refinement. Return ONLY the corrected TSX code.',
            userPrompt,
            rawResponse: text,
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `[reviewer] Vision self-fix failed for "${label ?? model}" (${err?.message ?? 'unknown error'}) — falling back to text-only repair`,
        );
        await this.log(
          logPath,
          `[reviewer] Vision self-fix failed for "${label ?? model}" (${err?.message ?? 'unknown error'}) — falling back to text-only repair`,
        );
      }
    }

    const {
      text: raw,
      inputTokens,
      outputTokens,
      cachedTokens,
    } = await this.generateWithRetry(
      model,
      this.selfFixSystemPrompt,
      userPrompt,
      3,
      logPath,
      label ? `${label}:fix` : undefined,
      tokenScope,
    );
    return {
      code: this.postProcessCode(raw),
      systemPrompt: this.selfFixSystemPrompt,
      userPrompt,
      rawResponse: raw,
      inputTokens,
      outputTokens,
      cachedTokens,
    };
  }

  private appendCotAttempts(
    target: AttemptLog[],
    attempts: AttemptLog[],
  ): void {
    for (const attempt of attempts) {
      target.push({
        ...attempt,
        attemptNumber: target.length + 1,
      });
    }
  }

  private summarizeCotAttempts(attempts: AttemptLog[]): {
    input: number;
    output: number;
    totalCost: number;
  } {
    return attempts.reduce(
      (acc, attempt) => {
        acc.input += attempt.tokensUsed.input;
        acc.output += attempt.tokensUsed.output;
        return acc;
      },
      { input: 0, output: 0, totalCost: 0 },
    );
  }

  private async logCotProcessIfEnabled(input: {
    jobId?: string;
    step: 'code-generation' | 'section-generation';
    componentName: string;
    model: string;
    startTime: string;
    attempts: AttemptLog[];
    finalSuccess: boolean;
    finalError?: string;
  }): Promise<void> {
    const {
      jobId,
      step,
      componentName,
      model,
      startTime,
      attempts,
      finalSuccess,
      finalError,
    } = input;
    if (!this.aiLogger || !jobId) return;

    const totals = this.summarizeCotAttempts(attempts);
    await this.aiLogger.logCotProcess({
      jobId,
      step,
      componentName,
      model,
      startTime,
      endTime: new Date().toISOString(),
      totalAttempts: attempts.length,
      attempts,
      finalSuccess,
      totalTokenCost: totals.totalCost,
      totalTokens: {
        input: totals.input,
        output: totals.output,
      },
      finalError,
    });
  }

  private canUseOpenAiVisionModel(modelName: string): boolean {
    return this.resolveOpenAiModelName(modelName) === 'gpt-5.4';
  }

  private resolveOpenAiModelName(modelName: string): string {
    return modelName.startsWith('openai/')
      ? modelName.slice('openai/'.length)
      : modelName;
  }

  // ── LLM call with exponential back-off ───────────────────────────────────

  private async generateWithRetry(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxRetries = 5,
    logPath?: string,
    label?: string,
    tokenScope: TokenScope = 'base',
  ): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  }> {
    let delay = 30_000;
    let maxTokens = this.llmFactory.getMaxTokens();
    let lastTruncatedResult: {
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    } | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.llmFactory.chat({
          model,
          systemPrompt,
          userPrompt,
          maxTokens,
        });
        const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
        if (tokenLogPath) {
          await this.tokenTracker.init(tokenLogPath);
          await this.tokenTracker.track(
            model,
            result.inputTokens,
            result.outputTokens,
            label ?? model,
            { scope: tokenScope },
          );
        }
        if (
          typeof result.cachedTokens === 'number' &&
          result.cachedTokens > 0
        ) {
          await this.log(
            logPath,
            `[llm-cache] ${label ?? model} cachedTokens=${result.cachedTokens}`,
          );
        }
        if (result.truncated) {
          lastTruncatedResult = {
            text: result.text,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cachedTokens: result.cachedTokens,
          };
          const nextMaxTokens = Math.max(
            maxTokens + 1,
            Math.ceil(maxTokens * 1.5),
          );
          const msg =
            `Output truncated at maxTokens=${maxTokens}; ` +
            `retrying with maxTokens=${nextMaxTokens} (attempt ${attempt}/${maxRetries})`;
          if (attempt < maxRetries) {
            this.logger.warn(msg);
            await this.log(logPath, `WARN ${msg}${label ? ` [${label}]` : ''}`);
            maxTokens = nextMaxTokens;
            continue;
          }
          this.logger.warn(
            `${msg} — max retries reached, returning truncated output`,
          );
          await this.log(
            logPath,
            `WARN ${msg} — max retries reached, returning truncated output${label ? ` [${label}]` : ''}`,
          );
          return lastTruncatedResult;
        }
        return {
          text: result.text,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedTokens: result.cachedTokens,
        };
      } catch (err: any) {
        const isRateLimit = err?.status === 429;
        const isServerError = err?.status === 500 || err?.status === 529;
        const isTimeout =
          err?.name === 'APIConnectionTimeoutError' ||
          err?.name === 'APIConnectionError';
        if (
          (isRateLimit || isTimeout || isServerError) &&
          attempt < maxRetries
        ) {
          const reason = isTimeout
            ? 'Timeout'
            : isServerError
              ? 'Server error'
              : 'Rate limit';
          const msg = `${reason}, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`;
          this.logger.warn(msg);
          await this.log(logPath, `WARN ${msg}${label ? ` [${label}]` : ''}`);
          await new Promise((res) => setTimeout(res, delay));
          delay = Math.min(delay * 2, 120_000);
        } else {
          throw err;
        }
      }
    }
    return { text: '', inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  }

  private buildRetryAppendix(input: {
    componentName: string;
    code: string;
    lastError?: string;
    validationContext: CodeValidationContext;
    componentPlan?: ComponentPromptContext;
  }): string {
    const compactError = this.compactRetryError(input.lastError);
    const failingSnippet = this.extractFailingSnippet(
      input.code,
      input.lastError,
      input.componentName,
    );
    const fixInstructions = this.buildTargetedFixInstructions(
      input.lastError,
      input.componentPlan,
      input.validationContext,
    );

    const lines = [
      '## RETRY MODE — DELTA ONLY',
      'Fix ONLY the failing area described below. Preserve unrelated layout and code.',
      '',
      '### Error',
      compactError,
    ];

    if (failingSnippet) {
      lines.push('');
      lines.push('### Failing snippet');
      lines.push('```tsx');
      lines.push(failingSnippet);
      lines.push('```');
    }

    if (fixInstructions.length > 0) {
      lines.push('');
      lines.push('### Fix instructions');
      for (const instruction of fixInstructions) {
        lines.push(`- ${instruction}`);
      }
    }

    const visualPlanChecklist = this.buildVisualPlanRetryChecklist(
      input.componentPlan,
      input.lastError,
      input.componentName,
    );
    if (visualPlanChecklist) {
      lines.push('');
      lines.push(visualPlanChecklist);
    }

    lines.push('');
    lines.push(
      'Return the complete corrected component file, but only change code necessary to fix the failure above.',
    );

    return lines.join('\n');
  }

  private compactRetryError(error?: string): string {
    if (!error) return 'Unknown validation error.';
    const compact = error.replace(/\s+/g, ' ').trim();
    return compact.length > 700 ? `${compact.slice(0, 700)}...` : compact;
  }

  private extractFailingSnippet(
    code: string,
    error: string | undefined,
    componentName: string,
  ): string {
    if (!code.trim()) return '';

    const tsErrors = this.validator.extractTypeScriptErrors(
      code,
      componentName,
    );
    const lineNumbers = new Set<number>();

    for (const source of [error ?? '', ...tsErrors]) {
      for (const match of source.matchAll(/:(\d+):\d+/g)) {
        const line = Number(match[1]);
        if (Number.isFinite(line) && line > 0) lineNumbers.add(line);
      }
    }

    const lines = code.split('\n');

    if (lineNumbers.size > 0) {
      const ordered = [...lineNumbers].sort((a, b) => a - b).slice(0, 2);
      return ordered
        .map((line) => this.sliceCodeWindow(lines, line, 10))
        .join('\n...\n');
    }

    const patterns = [
      /page\.(author|categories|tags|date|excerpt|comments)\b/,
      /pageDetail\.(author|categories|tags|date|excerpt|comments)\b/,
      /href="#"/,
      /to="#"/,
      /\/author\//,
      /menus\.map\(/,
    ];

    for (const pattern of patterns) {
      const idx = lines.findIndex((line) => pattern.test(line));
      if (idx !== -1) return this.sliceCodeWindow(lines, idx + 1, 8);
    }

    return this.sliceCodeWindow(lines, 1, 20);
  }

  private sliceCodeWindow(
    lines: string[],
    centerLine: number,
    radius: number,
  ): string {
    const start = Math.max(1, centerLine - radius);
    const end = Math.min(lines.length, centerLine + radius);
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(4)}: ${line}`)
      .join('\n');
  }

  private buildTargetedFixInstructions(
    error: string | undefined,
    componentPlan: ComponentPromptContext | undefined,
    validationContext: CodeValidationContext,
  ): string[] {
    const compact = (error ?? '').toLowerCase();
    const instructions = [
      'Do not redesign or rewrite unrelated sections.',
      'Keep the existing approved route/data contract intact.',
    ];

    if (
      /expected corresponding|jsx|parse|closing tag|unterminated/.test(compact)
    ) {
      instructions.push(
        'Fix JSX/tag balancing only in the failing area. Every opened JSX tag must close in the correct order.',
      );
    }

    if (/page detail contract|page\./.test(compact)) {
      instructions.push(
        'Use only canonical Page fields: id, title, content, slug, parentId, menuOrder, template, featuredImage.',
      );
      instructions.push(
        'Remove any page usage of author, categories, tags, date, excerpt, or comments.',
      );
    }

    if (/shared chrome contract|menus/.test(compact)) {
      instructions.push(
        'Do not hardcode nav/footer links. If this component declares menus, render them from `/api/menus` only.',
      );
    }

    if (
      /card-grid|card grid|expected card headings|approved cards|missing:/.test(
        compact,
      )
    ) {
      instructions.push(
        'Preserve every approved card item in the affected card-grid; do not collapse multi-row grids down to a single row.',
      );
      instructions.push(
        'Keep all approved card headings and bodies from the visual plan/template source, including lower rows and later items.',
      );
    }

    if (
      /tracked wrapper|data-vp-section-key|section boundaries can collapse|merge incorrectly/.test(
        compact,
      )
    ) {
      instructions.push(
        'Restore a dedicated top-level JSX wrapper for every approved tracked section and keep the exact `data-vp-source-node`, `data-vp-template`, `data-vp-source-file`, `data-vp-section-key`, `data-vp-component`, and `data-vp-section-component` attributes on that wrapper.',
      );
      instructions.push(
        'Do not merge two approved sections into one shared hero/grid wrapper. If text and image belong to different approved sections, render them in separate wrappers in the original order.',
      );
    }

    if (
      /visual plan fidelity violated|missing rendered sectionkey|missing sourcenodeid|lost hero heading|lost hero subheading|lost post-list title/.test(
        compact,
      )
    ) {
      instructions.push(
        'Restore every missing visual-plan section from the approved plan. If section 2 is missing, add it back as a separate top-level JSX wrapper instead of expanding section 1.',
      );
      instructions.push(
        'For each restored section, preserve the exact sectionKey/sourceNodeId pair from the approved visual plan on the outer wrapper attributes.',
      );
      instructions.push(
        'If the approved plan includes a hero heading/subheading or post-list title, render that approved content exactly or keep the approved dynamic binding intact; do not drop it.',
      );
    }

    if (
      /duplicated route prefix|extra `\/page` segment|\/page\/page\//.test(
        compact,
      )
    ) {
      instructions.push(
        'For menu items from `/api/menus`, use `item.url` directly for internal `<Link to={...}>` navigation.',
      );
      instructions.push(
        'Do not prepend `/page` or `/post` to a menu URL that already contains the canonical route path.',
      );
    }

    if (
      /hover:underline|underline on hover|wordPress-style interaction/.test(
        compact,
      )
    ) {
      instructions.push(
        'Visible text links for post titles, author/category archive links inside meta rows, menus, footer/sidebar lists, breadcrumbs, and social/footer text links must include hover underline styling such as `hover:underline underline-offset-4`.',
      );
      instructions.push(
        'Keep CTA buttons as buttons, but make ordinary text navigation/content links visibly underlined on hover.',
      );
    }

    if (
      /post meta author\/category labels|post meta category labels|canonical archive routes|post\.author|post\.categories\[0\]/.test(
        compact,
      )
    ) {
      instructions.push(
        'In post listings/meta rows, render author/category meta as archive links whenever `post.authorSlug` or `post.categorySlugs[0]` exists.',
      );
      instructions.push(
        'Use `post.authorSlug` with `/author/${post.authorSlug}` and `post.categorySlugs[0]` with `/category/${post.categorySlugs[0]}`. Keep plain-text author only when it is the actual heading/title content, such as an `h1` on author/archive/detail views.',
      );
      instructions.push(
        "Use a single ternary JSX expression for the fallback, for example `{post.categories?.[0] && (post.categorySlugs?.[0] ? <Link to={'/category/' + post.categorySlugs[0]} className='hover:underline underline-offset-4'>{post.categories[0]}</Link> : <span>{post.categories[0]}</span>)}`. Do not introduce extra brace layers around JSX branches.",
      );
    }

    if (/author/.test(compact) && /route|link/.test(compact)) {
      instructions.push(
        'Do not create author archive links unless the contract explicitly approves that route.',
      );
    }

    if (/no jsx return found/.test(compact)) {
      instructions.push(
        'Return a complete TSX component file with a valid JSX return block.',
      );
    }

    if (componentPlan?.type === 'page') {
      instructions.push(
        'Do not reintroduce shared header/footer/navigation chrome inside this page component.',
      );
    }

    if (validationContext.dataNeeds?.includes('pageDetail')) {
      instructions.push(
        'The main record for this component must stay on the page-detail contract, not a posts contract.',
      );
    }

    return [...new Set(instructions)];
  }

  private async generateComponentWithSectionAssembly(input: {
    componentName: string;
    modelName: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    repoManifest?: RepoThemeManifest;
    componentPlan?: ComponentPromptContext;
    editRequestContextNote?: string;
    logPath?: string;
    systemPrompt: string;
  }): Promise<{
    code: string;
    isValid: boolean;
    attemptsUsed: number;
    lastError?: string;
    lastRawOutput?: string;
    cotAttempts: import('../../ai-logger/ai-logger.service.js').AttemptLog[];
  }> {
    const {
      componentName,
      modelName,
      content,
      tokens,
      repoManifest,
      componentPlan,
      editRequestContextNote,
      logPath,
      systemPrompt,
    } = input;

    if (!componentPlan?.visualPlan) {
      return {
        code: '',
        isValid: false,
        attemptsUsed: 0,
        lastError: 'Missing visual plan for section-level assembly',
        cotAttempts: [],
      };
    }

    const sections = componentPlan.visualPlan.sections ?? [];
    const frame = this.codeGenerator.generateSectionAssemblyFrame(
      componentPlan.visualPlan,
    );
    const availableVariables = this.frameGenerator.describeVariables({
      type: componentPlan.type ?? 'page',
      dataNeeds: componentPlan.dataNeeds ?? [],
      isDetail: componentPlan.isDetail ?? false,
    });
    const validationContext = this.buildValidationContext(
      componentPlan,
      componentName,
      false,
      undefined,
      this.resolveRequiredCustomClassTargets(
        componentPlan.requiredCustomClassNames,
        tokens,
      ),
    );
    const assembledSections: string[] = [];
    let attemptsUsed = 0;
    let lastError: string | undefined;
    let lastRawOutput = '';
    const cotAttempts: import('../../ai-logger/ai-logger.service.js').AttemptLog[] =
      [];

    for (let index = 0; index < sections.length; index++) {
      const section = sections[index];
      const sectionResult = await this.generateInlineSectionForAssembly({
        componentName,
        section,
        sectionIndex: index,
        totalSections: sections.length,
        availableVariables,
        modelName,
        systemPrompt,
        content,
        tokens,
        repoManifest,
        componentPlan,
        editRequestContextNote,
        logPath,
      });
      attemptsUsed += sectionResult.attemptsUsed;
      lastRawOutput = sectionResult.lastRawOutput || lastRawOutput;
      cotAttempts.push(...sectionResult.cotAttempts);

      if (!sectionResult.isValid) {
        lastError = sectionResult.lastError;
        this.logger.warn(
          `[reviewer] "${componentName}" section-level: section ${index + 1}/${sections.length} (${section.type}) exhausted attempts — full-file fallback`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" section-level: section ${index + 1}/${sections.length} (${section.type}) exhausted attempts — full-file fallback`,
        );
        return {
          code: '',
          isValid: false,
          attemptsUsed,
          lastError: sectionResult.lastError,
          lastRawOutput,
          cotAttempts,
        };
      }

      assembledSections.push(sectionResult.code);
    }

    let code = this.codeGenerator.assembleSectionedComponent(
      frame,
      assembledSections,
    );
    code = this.stripSpuriousHardcodedSections(
      this.postProcessCode(code),
      componentName,
    );
    const check = this.validator.checkCodeStructure(code, validationContext);
    if (check.fixedCode) code = check.fixedCode;

    if (check.isValid) {
      this.logger.log(
        `[reviewer] "${componentName}" ✓ section-level one-file assembly succeeded (${sections.length} sections, ${attemptsUsed} AI attempt(s))`,
      );
      await this.log(
        logPath,
        `[reviewer] "${componentName}" ✓ section-level one-file assembly succeeded (${sections.length} sections, ${attemptsUsed} AI attempt(s))`,
      );
      return {
        code,
        isValid: true,
        attemptsUsed,
        lastRawOutput,
        cotAttempts,
      };
    }

    const targetedRetryIndexes = this.extractSectionIndexesFromVisualPlanError(
      check.error,
      sections.length,
    );
    if (targetedRetryIndexes.length > 0) {
      this.logger.warn(
        `[reviewer] "${componentName}" section-level final validation failed in section(s) ${targetedRetryIndexes
          .map((value) => value + 1)
          .join(', ')} — targeted section retry`,
      );
      await this.log(
        logPath,
        `WARN [reviewer] "${componentName}" section-level final validation failed in section(s) ${targetedRetryIndexes
          .map((value) => value + 1)
          .join(', ')} — targeted section retry`,
      );

      for (const index of targetedRetryIndexes) {
        const section = sections[index];
        const narrowedError = this.extractSectionSpecificError(
          check.error,
          index + 1,
        );
        const retryResult = await this.generateInlineSectionForAssembly({
          componentName,
          section,
          sectionIndex: index,
          totalSections: sections.length,
          availableVariables,
          modelName,
          systemPrompt,
          content,
          tokens,
          repoManifest,
          componentPlan,
          editRequestContextNote,
          logPath,
          initialRetryError: narrowedError,
          maxAttempts: 2,
          phaseLabel: 'targeted-retry',
        });
        attemptsUsed += retryResult.attemptsUsed;
        lastRawOutput = retryResult.lastRawOutput || lastRawOutput;
        cotAttempts.push(...retryResult.cotAttempts);
        if (retryResult.isValid) {
          assembledSections[index] = retryResult.code;
        }
      }

      code = this.codeGenerator.assembleSectionedComponent(
        frame,
        assembledSections,
      );
      code = this.stripSpuriousHardcodedSections(
        this.postProcessCode(code),
        componentName,
      );
      const retriedCheck = this.validator.checkCodeStructure(
        code,
        validationContext,
      );
      if (retriedCheck.fixedCode) code = retriedCheck.fixedCode;

      if (retriedCheck.isValid) {
        this.logger.log(
          `[reviewer] "${componentName}" ✓ section-level targeted retry resolved final validation`,
        );
        await this.log(
          logPath,
          `[reviewer] "${componentName}" ✓ section-level targeted retry resolved final validation`,
        );
        return {
          code,
          isValid: true,
          attemptsUsed,
          lastRawOutput,
          cotAttempts,
        };
      }

      lastError = retriedCheck.error;
      this.logger.warn(
        `[reviewer] "${componentName}" section-level targeted retry still invalid: ${retriedCheck.error}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer] "${componentName}" section-level targeted retry still invalid: ${retriedCheck.error}`,
      );
    }

    this.logger.warn(
      `[reviewer] "${componentName}" section-level one-file assembly produced invalid final file: ${check.error}`,
    );
    await this.log(
      logPath,
      `WARN [reviewer] "${componentName}" section-level one-file assembly produced invalid final file: ${check.error}`,
    );

    return {
      code,
      isValid: false,
      attemptsUsed,
      lastError: lastError ?? check.error,
      lastRawOutput,
      cotAttempts,
    };
  }

  private async generateInlineSectionForAssembly(input: {
    componentName: string;
    section: ComponentVisualPlan['sections'][number];
    sectionIndex: number;
    totalSections: number;
    availableVariables: string;
    modelName: string;
    systemPrompt: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    repoManifest?: RepoThemeManifest;
    componentPlan?: ComponentPromptContext;
    editRequestContextNote?: string;
    logPath?: string;
    initialRetryError?: string;
    maxAttempts?: number;
    phaseLabel?: string;
  }): Promise<{
    code: string;
    isValid: boolean;
    attemptsUsed: number;
    lastError?: string;
    lastRawOutput?: string;
    cotAttempts: AttemptLog[];
  }> {
    const {
      componentName,
      section,
      sectionIndex,
      totalSections,
      availableVariables,
      modelName,
      systemPrompt,
      content,
      tokens,
      repoManifest,
      componentPlan,
      editRequestContextNote,
      logPath,
      initialRetryError,
      maxAttempts = 2,
      phaseLabel = 'initial',
    } = input;

    let sectionCode = '';
    let sectionError = initialRetryError;
    let lastRawOutput = '';
    const cotAttempts: AttemptLog[] = [];

    this.logger.log(
      `[reviewer] "${componentName}" section-level (${phaseLabel}): generating section ${sectionIndex + 1}/${totalSections} (${section.type})`,
    );
    await this.log(
      logPath,
      `[reviewer] "${componentName}" section-level (${phaseLabel}): generating section ${sectionIndex + 1}/${totalSections} (${section.type})`,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const userPrompt = buildInlineSectionPrompt({
        componentName,
        section,
        sectionIndex,
        totalSections,
        availableVariables,
        content,
        tokens,
        repoManifest,
        componentPlan,
        editRequestContextNote,
        retryError: sectionError,
      });
      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens,
      } = await this.generateWithRetry(
        modelName,
        systemPrompt,
        userPrompt,
        4,
        logPath,
        `${componentName}:section-${sectionIndex + 1}:${phaseLabel}`,
        editRequestContextNote ? 'edit-request' : 'base',
      );
      lastRawOutput = raw;
      sectionCode = this.postProcessCode(raw).trim();
      const basicError = this.validateInlineSectionOutput(sectionCode);
      cotAttempts.push({
        attemptNumber: cotAttempts.length + 1,
        promptSent: {
          system: systemPrompt,
          user: userPrompt,
        },
        response: raw,
        tokensUsed: {
          input: inTok,
          output: outTok,
          total: inTok + outTok,
          ...(typeof cachedTokens === 'number' ? { cached: cachedTokens } : {}),
        },
        timestamp: new Date().toISOString(),
        success: !basicError,
        error: basicError,
        validationFeedback: basicError
          ? undefined
          : `section ${sectionIndex + 1} inline assembly candidate accepted`,
      });
      if (!basicError) {
        this.logger.log(
          `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) accepted on attempt ${attempt}/${maxAttempts}`,
        );
        await this.log(
          logPath,
          `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) accepted on attempt ${attempt}/${maxAttempts}`,
        );
        return {
          code: sectionCode,
          isValid: true,
          attemptsUsed: attempt,
          lastRawOutput,
          cotAttempts,
        };
      }
      sectionError = basicError;
      this.logger.warn(
        `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) attempt ${attempt}/${maxAttempts} failed: ${basicError}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer] "${componentName}" section-level (${phaseLabel}) section ${sectionIndex + 1}/${totalSections} attempt ${attempt}/${maxAttempts} failed: ${basicError}${this.formatRawOutput(raw)}`,
      );
    }

    return {
      code: sectionCode,
      isValid: false,
      attemptsUsed: maxAttempts,
      lastError: sectionError,
      lastRawOutput,
      cotAttempts,
    };
  }

  private extractSectionIndexesFromVisualPlanError(
    error: string | undefined,
    totalSections: number,
  ): number[] {
    if (!error || !/Visual plan fidelity violated/i.test(error)) return [];
    const matches = [...error.matchAll(/section\s+(\d+)/gi)];
    const indexes = matches
      .map((match) => Number(match[1]) - 1)
      .filter(
        (value) =>
          Number.isInteger(value) && value >= 0 && value < totalSections,
      );
    return [...new Set(indexes)];
  }

  private extractSectionSpecificError(
    error: string | undefined,
    sectionNumber: number,
  ): string | undefined {
    if (!error) return undefined;
    const lines = error
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const filtered = lines.filter((line) =>
      new RegExp(`section\\s+${sectionNumber}\\b`, 'i').test(line),
    );
    if (filtered.length === 0) return error;
    return ['Visual plan fidelity violated:', ...filtered].join('\n');
  }

  private validateInlineSectionOutput(code: string): string | undefined {
    const trimmed = code.trim();
    if (!trimmed) return 'Empty section JSX output';
    if (/^\s*import\s/m.test(trimmed)) {
      return 'Inline section output must not contain imports';
    }
    if (/export\s+default/.test(trimmed)) {
      return 'Inline section output must not contain export default';
    }
    if (/\buseEffect\s*\(|\buseState\s*\(|function\s+[A-Z]/.test(trimmed)) {
      return 'Inline section output must not declare hooks or component functions';
    }
    if (!/^<[\s\S]+>$/.test(trimmed)) {
      return 'Inline section output must be a single top-level JSX wrapper';
    }
    return undefined;
  }

  private buildVisualPlanRetryChecklist(
    componentPlan: ComponentPromptContext | undefined,
    error: string | undefined,
    componentName: string,
  ): string {
    if (
      !componentPlan?.visualPlan?.sections?.length ||
      !/visual plan fidelity violated|missing rendered sectionkey|missing sourcenodeid|lost hero heading|lost hero subheading|lost post-list title|lost card-grid subtitle|lost card heading|lost media-text heading|lost media-text list item/i.test(
        error ?? '',
      )
    ) {
      return '';
    }

    const lines = [
      '### Visual plan sections to preserve exactly',
      ...componentPlan.visualPlan.sections.map((section, index) => {
        const parts = [
          `- section ${index + 1}: type=${section.type}`,
          section.sectionKey ? `sectionKey=${section.sectionKey}` : null,
          section.sourceRef?.sourceNodeId
            ? `sourceNodeId=${section.sourceRef.sourceNodeId}`
            : null,
        ];

        if (section.type === 'hero') {
          parts.push(
            section.heading
              ? `heading=${JSON.stringify(section.heading)}`
              : null,
          );
          parts.push(
            section.subheading
              ? `subheading=${JSON.stringify(section.subheading)}`
              : null,
          );
        }

        if (section.type === 'post-list') {
          parts.push(
            section.title ? `title=${JSON.stringify(section.title)}` : null,
          );
        }

        if (section.type === 'card-grid') {
          parts.push(
            section.title ? `title=${JSON.stringify(section.title)}` : null,
          );
          parts.push(
            section.subtitle
              ? `subtitle=${JSON.stringify(section.subtitle)}`
              : null,
          );
          const cardHints = section.cards
            ?.slice(0, 4)
            .map((card, cardIndex) => {
              const hints = [
                card.heading
                  ? `card${cardIndex + 1}.heading=${JSON.stringify(card.heading)}`
                  : null,
                card.body
                  ? `card${cardIndex + 1}.body=${JSON.stringify(card.body)}`
                  : null,
              ].filter(Boolean);
              return hints.join(' | ');
            })
            .filter(Boolean);
          if (cardHints?.length) {
            parts.push(...cardHints);
          }
        }

        if (section.type === 'media-text') {
          parts.push(
            section.heading
              ? `heading=${JSON.stringify(section.heading)}`
              : null,
          );
          parts.push(
            section.body ? `body=${JSON.stringify(section.body)}` : null,
          );
          if (section.listItems?.length) {
            parts.push(
              `listItems=${JSON.stringify(section.listItems.slice(0, 6))}`,
            );
          }
        }

        return parts.filter(Boolean).join(' | ');
      }),
      `Use data-vp-component="${componentName}" on every tracked wrapper in this file.`,
    ];

    return lines.join('\n');
  }

  private buildAutoFixErrorContext(
    reason: string,
    lastError: string | undefined,
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
  ): string {
    const parts = [`${reason}: ${lastError ?? 'Unknown validation error.'}`];
    const checklist = this.buildVisualPlanRetryChecklist(
      componentPlan,
      lastError,
      componentName,
    );
    if (checklist) {
      parts.push(checklist);
    }
    return parts.join('\n\n');
  }

  // ── Code post-processors ──────────────────────────────────────────────────

  private postProcessCode(code: string): string {
    return this.promotePlainTextPostMetaLinks(
      this.ensureHoverUnderlineOnCanonicalTextLinks(
        this.normalizePlainTextPostMetaArchiveLinks(
          this.normalizeTailwindFunctionSpacing(
            this.fixDoublebraces(
              this.mergeClassNames(this.stripMarkdownFences(code)),
            ),
          ),
        ),
      ),
    );
  }

  private formatRawOutput(raw: string): string {
    return `${this.rawOutputDivider}${raw || '(empty)'}\n----- RAW OUTPUT END -----`;
  }

  private stripMarkdownFences(code: string): string {
    let result = code
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();

    const codeStart = result.search(
      /^(import |export |const |function |\/\/|\/\*)/m,
    );
    if (codeStart > 0) result = result.slice(codeStart).trim();
    return result;
  }

  private mergeClassNames(code: string): string {
    return code.replace(
      /(<[a-zA-Z0-9]+[^>]*?)\s+className=["']([^"']*)[\"']([^>]*?)\s+className=["']([^"']*)[\"']([^>]*>)/g,
      (_match, tagStart, class1, mid, class2, tagEnd) =>
        `${tagStart} className="${class1} ${class2}"${mid}${tagEnd}`,
    );
  }

  /**
   * Fix AI double-brace syntax: {{expr}} → {expr} in JSX text content.
   * AI sometimes writes Vue/Handlebars-style {{item.title}} which is a parse error in JSX.
   * We only fix occurrences that follow `>` (end of opening tag) or appear on an
   * indented line before `<` (closing tag) — leaves style={{ }} and similar alone.
   */
  private fixDoublebraces(code: string): string {
    // Pattern 1: >{{expr}}  →  >{expr}
    let result = code.replace(/>\{\{([^{}]+)\}\}/g, '>{$1}');
    // Pattern 2: line with only whitespace + {{expr}} + optional whitespace before <
    result = result.replace(/^(\s*)\{\{([^{}]+)\}\}(\s*<)/gm, '$1{$2}$3');
    return result;
  }

  private normalizeTailwindFunctionSpacing(code: string): string {
    return code.replace(
      /\[(min|max|clamp)\(([^)\]]+)\)\]/g,
      (_match, fnName: string, inner: string) =>
        `[${fnName}(${inner.replace(/,\s+/g, ',')})]`,
    );
  }

  private ensureHoverUnderlineOnCanonicalTextLinks(code: string): string {
    return code.replace(/<(Link|a)\b[\s\S]{0,400}?>/g, (rawTag) => {
      if (!/\bclassName="[^"]*"/.test(rawTag)) return rawTag;
      if (/hover:underline/.test(rawTag) || /\bno-underline\b/.test(rawTag)) {
        return rawTag;
      }

      const looksLikeButton =
        /\bbg-\[/.test(rawTag) ||
        (/\bpx-/.test(rawTag) && /\bpy-/.test(rawTag)) ||
        /\bjustify-center\b/.test(rawTag);
      if (looksLikeButton) return rawTag;

      const isCanonicalTextLink =
        /\/(?:post|page|author|category|tag)\//.test(rawTag) ||
        /\bitem\.url\b/.test(rawTag) ||
        /\btoAppPath\(item\.url\)\b/.test(rawTag) ||
        /\bhref=["']https?:\/\//.test(rawTag);
      if (!isCanonicalTextLink) return rawTag;

      return rawTag.replace(
        /\bclassName="([^"]*)"/,
        (_match, classes: string) =>
          `className="${this.appendUniqueClasses(
            classes,
            'hover:underline underline-offset-4',
          )}"`,
      );
    });
  }

  private normalizePlainTextPostMetaArchiveLinks(code: string): string {
    let next = code;

    next = next.replace(
      /\{\s*(post|item|postDetail)\.author\s*&&\s*<(span|p)\b([^>]*)>\s*\{\1\.author\}\s*<\/\2>\s*\}/g,
      (_match, record: string, tag: string, attrs: string) =>
        `{${record}.author && (${record}.authorSlug ? <Link to={'/author/' + ${record}.authorSlug}${attrs}>{${record}.author}</Link> : <${tag}${attrs}>{${record}.author}</${tag}>)}`,
    );

    next = next.replace(
      /<(span|p)\b([^>]*)>\s*\{(post|item|postDetail)\.author\}\s*<\/\1>/g,
      (match, tag: string, attrs: string, record: string, offset: number) => {
        if (this.isWithinHeadingTitleContext(next, offset)) return match;
        if (this.isWithinSlugTernaryFallback(next, offset)) return match;
        return `{${record}.authorSlug ? <Link to={'/author/' + ${record}.authorSlug}${attrs}>{${record}.author}</Link> : <${tag}${attrs}>{${record}.author}</${tag}>}`;
      },
    );

    next = next.replace(
      /\{\s*(post|item|postDetail)\.categories(?:\?\.)?\[0\]\s*&&\s*<span\b([^>]*)>\s*\{\1\.categories(?:\?\.)?\[0\](?:\s*\?\?\s*'')?\}\s*<\/span>\s*\}/g,
      (_match, record: string, attrs: string) =>
        `{${record}.categories?.[0] && (${record}.categorySlugs?.[0] ? <Link to={'/category/' + ${record}.categorySlugs[0]}${attrs}>{${record}.categories[0]}</Link> : <span${attrs}>{${record}.categories[0]}</span>)}`,
    );

    next = next.replace(
      /<span\b([^>]*)>\s*\{(post|item|postDetail)\.categories(?:\?\.)?\[0\](?:\s*\?\?\s*'')?\}\s*<\/span>/g,
      (match, attrs: string, record: string, offset: number) => {
        if (this.isWithinSlugTernaryFallback(next, offset)) return match;
        return `{${record}.categorySlugs?.[0] ? <Link to={'/category/' + ${record}.categorySlugs[0]}${attrs}>{${record}.categories[0]}</Link> : <span${attrs}>{${record}.categories[0]}</span>}`;
      },
    );

    next = next.replace(
      /\{(post|item|postDetail)\.categories\?\.map\(\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\(\s*<span\b([^>]*)>\s*\{\2\}\s*<\/span>\s*\)\)\}/g,
      (
        _match,
        record: string,
        categoryVar: string,
        indexVar: string,
        attrs: string,
      ) =>
        `{${record}.categories?.map((${categoryVar}, ${indexVar}) => (${record}.categorySlugs?.[${indexVar}] ? <Link to={'/category/' + ${record}.categorySlugs[${indexVar}]}${attrs}>{${categoryVar}}</Link> : <span${attrs}>{${categoryVar}}</span>}))}`,
    );

    return next;
  }

  private promotePlainTextPostMetaLinks(code: string): string {
    const isCanonicalMetaLink = (raw: string): boolean =>
      /(?:to=|href=)[^>]*\/author\//.test(raw) ||
      /(?:to=|href=)[^>]*\/category\//.test(raw);

    const decorateQuoted = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${before}className=${quote}${this.appendUniqueClasses(
            className,
            'hover:underline underline-offset-4',
          )}${quote}`;
        },
      );

    const decorateTemplateLiteral = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${before}className={\`${this.appendUniqueClasses(
            className,
            'hover:underline underline-offset-4',
          )}\`}`;
        },
      );

    const decorateWithoutClass = (source: string) =>
      source.replace(
        /<(Link|a)\b((?:(?!className=)[^>])*)(?=>)/g,
        (match, tag: string, attrs: string) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${attrs} className="hover:underline underline-offset-4"`;
        },
      );

    return decorateWithoutClass(decorateTemplateLiteral(decorateQuoted(code)));
  }

  private appendUniqueClasses(existing: string, addition: string): string {
    return [...new Set(`${existing} ${addition}`.split(/\s+/).filter(Boolean))]
      .join(' ')
      .trim();
  }

  private isWithinHeadingTitleContext(code: string, offset: number): boolean {
    const start = Math.max(0, offset - 220);
    const end = Math.min(code.length, offset + 220);
    const window = code.slice(start, end);
    const before = code.slice(start, offset);
    const openHeading = before.match(/<h[1-6]\b[^>]*>/gi);
    const closeHeading = before.match(/<\/h[1-6]>/gi);
    if ((openHeading?.length ?? 0) > (closeHeading?.length ?? 0)) {
      return true;
    }

    return /\b(?:title|heading)\b/i.test(window);
  }

  private isWithinSlugTernaryFallback(code: string, offset: number): boolean {
    const before = code.slice(Math.max(0, offset - 600), offset);
    return (
      /\bauthorSlug\s*\?/.test(before) ||
      /\bcategorySlugs(?:\?\.)?[^a-z]\[0\]\s*\?/.test(before) ||
      /\b(?:post|item|postDetail)\.author\s*&&/.test(before) ||
      /\b(?:post|item|postDetail)\.categories(?:\?\.)?(?:\[0\])?\s*&&/.test(
        before,
      )
    );
  }

  /**
   * Remove JSX `<section>` blocks that contain only hardcoded static text with
   * no references to dynamic data (item/page/post/data state variables).
   * Only applied to detail-type components (Page, Single and their variants)
   * where the only valid content source is `item.content` via dangerouslySetInnerHTML.
   */
  private stripSpuriousHardcodedSections(
    code: string,
    componentName: string,
  ): string {
    const isDetailComponent =
      /^(Page|Single|PageNoTitle|PageWide|PageWithSidebar|SingleWithSidebar)$/.test(
        componentName,
      );
    const isListLikePageComponent =
      /^(Archive|Index|Search|NotFound|Page404)$/.test(componentName);
    if (!isDetailComponent && !isListLikePageComponent) return code;

    // Dynamic-data reference pattern — any section containing these is kept.
    const dynamicRef =
      /\{(?:item|page|post|data|loading|error)\b|\{[a-zA-Z]+\s*&&|\{[a-zA-Z]+\s*\?/;

    // Walk through the code finding top-level <section> tags and remove those
    // that have no dynamic references and no dangerouslySetInnerHTML.
    let result = '';
    let i = 0;
    while (i < code.length) {
      // Find next <section opening tag
      const sectionStart = code.indexOf('<section', i);
      if (sectionStart === -1) {
        result += code.slice(i);
        break;
      }
      // Copy everything before this section
      result += code.slice(i, sectionStart);

      // Find the matching </section> by tracking depth
      let depth = 0;
      let j = sectionStart;
      while (j < code.length) {
        const openIdx = code.indexOf('<section', j);
        const closeIdx = code.indexOf('</section>', j);
        if (closeIdx === -1) {
          // No closing tag found — keep as-is
          j = code.length;
          break;
        }
        if (openIdx !== -1 && openIdx < closeIdx) {
          depth++;
          j = openIdx + 8; // skip past '<section'
        } else {
          depth--;
          j = closeIdx + 10; // skip past '</section>'
          if (depth === 0) break;
        }
      }

      const sectionContent = code.slice(sectionStart, j);
      const isHeadingOnlyInventedAuxiliary =
        isListLikePageComponent &&
        this.isHeadingOnlyInventedAuxiliarySection(sectionContent);

      // Keep the section if it has dynamic refs or dangerouslySetInnerHTML
      if (
        dynamicRef.test(sectionContent) ||
        /dangerouslySetInnerHTML/.test(sectionContent) ||
        (!isDetailComponent && !isHeadingOnlyInventedAuxiliary)
      ) {
        result += sectionContent;
      }
      // else: silently drop the spurious hardcoded section

      i = j;
    }
    return result;
  }

  private isHeadingOnlyInventedAuxiliarySection(
    sectionContent: string,
  ): boolean {
    const visibleTexts = [
      ...sectionContent.matchAll(
        /<(h[1-6]|p|span|strong|em|li)\b[^>]*>([\s\S]*?)<\/\1>/gi,
      ),
    ]
      .map((match) => this.normalizeAuxiliaryHeadingText(match[2] ?? ''))
      .filter(Boolean);
    if (visibleTexts.length !== 1) return false;
    return new Set<string>(INVENTED_AUXILIARY_SECTION_LABELS).has(
      visibleTexts[0]!,
    );
  }

  private normalizeAuxiliaryHeadingText(value: string): string {
    return value
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ── Logger ────────────────────────────────────────────────────────────────

  private async log(
    logPath: string | undefined,
    message: string,
  ): Promise<void> {
    if (!logPath || logPath.endsWith('.json')) return;
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // never crash pipeline because of a log failure
    }
  }
}
