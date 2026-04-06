import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import {
  ValidatorService,
  type CodeValidationContext,
} from '../validator/validator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';
import { getComponentStrategy } from '../component-strategy.registry.js';
import {
  buildComponentPrompt,
  buildSectionPrompt,
  type ComponentPromptContext,
} from './prompts/component.prompt.js';
import {
  buildFragmentPrompt,
  FRAGMENT_SYSTEM_PROMPT,
} from './prompts/fragment.prompt.js';
import {
  buildVisualPlanPrompt,
  extractStaticImageSources,
  parseVisualPlanDetailed,
} from './prompts/visual-plan.prompt.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';
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
  componentPlan?: PlanResult[number];
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
  componentPlan?: PlanResult[number];
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
    private readonly llmFactory: LlmFactoryService,
    private readonly validator: ValidatorService,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly frameGenerator: FrameGeneratorService,
    private readonly aiLogger?: AiLoggerService,
  ) {}

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
      systemPrompt: _systemPrompt,
      content,
      tokens,
      componentPlan,
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
    const cotAttempts: any[] = [];
    // Set when both AI codegen AND deterministic fallback from the pre-computed
    // plan have failed. Signals D2 to generate a fresh AI visual plan instead
    // of running direct-AI with the same broken plan context.
    let precomputedPlanAllFailed = false;
    let promptContext = this.buildPromptContext(componentPlan, undefined, {
      includeVisualPlan: !forceDirectAi,
    });
    let validationContext = this.buildValidationContext(
      promptContext,
      componentName,
    );

    if (preferDirectAi && componentPlan?.visualPlan) {
      await this.log(
        logPath,
        `[reviewer] "${componentName}": preferDirectAi enabled; bypassing visual-plan-first path to preserve WordPress block fidelity`,
      );
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
        validationContext = this.buildValidationContext(
          promptContext,
          componentName,
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
          componentPlan: promptContext,
          logPath,
          logLabel: 'precomputed-plan',
        });
        attempts += planned.attemptsUsed;
        code = planned.code;
        if (planned.isValid) {
          this.logger.log(
            `[reviewer] "${componentName}" ✓ AI codegen succeeded using reviewed visual plan`,
          );

          // Log COT process before returning
          if (this.aiLogger && jobId) {
            cotAttempts.push({
              attemptNumber: cotAttempts.length + 1,
              response: planned.lastRawOutput?.substring(0, 500) || '',
              tokensUsed: {
                input: 0,
                output: 0,
                total: 0,
              },
              timestamp: new Date().toISOString(),
              success: true,
              validationFeedback: 'Pre-computed visual plan codegen succeeded',
            });

            await this.aiLogger.logCotProcess({
              jobId,
              step: 'code-generation',
              componentName,
              model: modelName,
              startTime,
              endTime: new Date().toISOString(),
              totalAttempts: cotAttempts.length,
              attempts: cotAttempts,
              finalSuccess: true,
              totalTokenCost: 0,
              totalTokens: { input: 0, output: 0 },
            });
          }

          return {
            component: {
              name: componentName,
              filePath: '',
              code,
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
          // Log COT process before returning
          if (this.aiLogger && jobId) {
            cotAttempts.push({
              attemptNumber: cotAttempts.length + 1,
              response: 'Deterministic fallback (rule-based generation)',
              tokensUsed: { input: 0, output: 0, total: 0 },
              timestamp: new Date().toISOString(),
              success: true,
              validationFeedback:
                'Deterministic pre-computed plan codegen succeeded',
            });

            await this.aiLogger.logCotProcess({
              jobId,
              step: 'code-generation',
              componentName,
              model: modelName,
              startTime,
              endTime: new Date().toISOString(),
              totalAttempts: cotAttempts.length,
              attempts: cotAttempts,
              finalSuccess: true,
              totalTokenCost: 0,
              totalTokens: { input: 0, output: 0 },
            });
          }

          return {
            component: {
              name: componentName,
              filePath: '',
              code: deterministic.code,
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
      if (!forceDirectAi && (isRetry || !componentPlan?.visualPlan || precomputedPlanAllFailed)) {
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
            }
          : undefined;

        const { systemPrompt: s1System, userPrompt: s1User } =
          buildVisualPlanPrompt({
            componentName,
            templateSource,
            content,
            tokens,
            componentType: componentPlan?.type,
            route: componentPlan?.route,
            isDetail: componentPlan?.isDetail,
            dataNeeds: visualDataNeeds,
          });

        try {
          const { text: s1Raw } = await this.generateWithRetry(
            modelName,
            s1System,
            s1User,
            3,
            logPath,
            `${componentName}:plan`,
          );
          const parsedPlan = parseVisualPlanDetailed(s1Raw, componentName, {
            allowedImageSrcs: extractStaticImageSources(templateSource),
            contract: visualContract,
          });
          const visualPlan = parsedPlan.plan;

          if (visualPlan) {
            promptContext = this.buildPromptContext(componentPlan, visualPlan);
            validationContext = this.buildValidationContext(
              promptContext,
              componentName,
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
              componentPlan: promptContext,
              logPath,
              logLabel: 'visual-plan',
            });
            attempts += planned.attemptsUsed;
            code = planned.code;
            if (planned.isValid) {
              this.logger.log(
                `[reviewer] "${componentName}" ✓ AI codegen succeeded using AI-generated visual plan`,
              );

              // Log COT process before returning
              if (this.aiLogger && jobId) {
                cotAttempts.push({
                  attemptNumber: cotAttempts.length + 1,
                  response: (planned.lastRawOutput || '').substring(0, 500),
                  tokensUsed: {
                    input: 0,
                    output: 0,
                    total: 0,
                  },
                  timestamp: new Date().toISOString(),
                  success: true,
                  validationFeedback:
                    'AI visual plan + codegen succeeded on attempt ' +
                    (cotAttempts.length + 1),
                });

                await this.aiLogger.logCotProcess({
                  jobId,
                  step: 'code-generation',
                  componentName,
                  model: modelName,
                  startTime,
                  endTime: new Date().toISOString(),
                  totalAttempts: cotAttempts.length,
                  attempts: cotAttempts,
                  finalSuccess: true,
                  totalTokenCost: 0,
                  totalTokens: { input: 0, output: 0 },
                });
              }

              return {
                component: { name: componentName, filePath: '', code },
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
        componentPlan: promptContext,
        logPath,
        logLabel: 'direct-ai',
      });
      attempts += direct.attemptsUsed;
      code = direct.code;
      lastError = direct.lastError ?? lastError;

      if (direct.isValid) {
        this.logger.log(
          `[reviewer] "${componentName}" ✓ AI codegen succeeded using direct template prompt`,
        );

        // Log COT process before returning
        if (this.aiLogger && jobId) {
          cotAttempts.push({
            attemptNumber: cotAttempts.length + 1,
            response: (direct.lastRawOutput || '').substring(0, 500),
            tokensUsed: {
              input: 0,
              output: 0,
              total: 0,
            },
            timestamp: new Date().toISOString(),
            success: true,
            validationFeedback: 'Direct AI TSX generation succeeded',
          });

          await this.aiLogger.logCotProcess({
            jobId,
            step: 'code-generation',
            componentName,
            model: modelName,
            startTime,
            endTime: new Date().toISOString(),
            totalAttempts: cotAttempts.length,
            attempts: cotAttempts,
            finalSuccess: true,
            totalTokenCost: 0,
            totalTokens: { input: 0, output: 0 },
          });
        }

        return {
          component: { name: componentName, filePath: '', code },
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
        code = await this.selfFix(
          fixAgentModel,
          code,
          lastError!,
          logPath,
          componentName,
        );
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

          // Log COT process before returning
          if (this.aiLogger && jobId) {
            cotAttempts.push({
              attemptNumber: cotAttempts.length + 1,
              response: 'Fix Agent repair successful',
              tokensUsed: {
                input: 0,
                output: 0,
                total: 0,
              },
              timestamp: new Date().toISOString(),
              success: true,
              validationFeedback: 'Fix Agent repair resolved validation errors',
            });

            await this.aiLogger.logCotProcess({
              jobId,
              step: 'code-generation',
              componentName,
              model: fixAgentModel,
              startTime,
              endTime: new Date().toISOString(),
              totalAttempts: cotAttempts.length,
              attempts: cotAttempts,
              finalSuccess: true,
              totalTokenCost: 0,
              totalTokens: { input: 0, output: 0 },
            });
          }

          return {
            component: { name: componentName, filePath: '', code },
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
    if (this.aiLogger && jobId) {
      cotAttempts.push({
        attemptNumber: cotAttempts.length + 1,
        response: `All retry paths exhausted after ${MAX_ROUNDS} rounds`,
        tokensUsed: { input: 0, output: 0, total: 0 },
        timestamp: new Date().toISOString(),
        success: false,
        error: lastError,
      });

      await this.aiLogger.logCotProcess({
        jobId,
        step: 'code-generation',
        componentName,
        model: modelName,
        startTime,
        endTime: new Date().toISOString(),
        totalAttempts: cotAttempts.length,
        attempts: cotAttempts,
        finalSuccess: false,
        totalTokenCost: 0,
        totalTokens: { input: 0, output: 0 },
        finalError: lastError,
      });
    }

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
      componentPlan,
      logPath,
      jobId,
    } = input;

    const startTime = new Date().toISOString();
    const cotAttempts: any[] = [];
    const promptContext = this.buildPromptContext(componentPlan, undefined, {
      includeVisualPlan: !preferDirectAi,
    });

    const userPrompt = buildSectionPrompt({
      sectionName,
      parentName,
      sectionIndex,
      totalSections,
      nodesJson,
      siteInfo: content.siteInfo,
      menus: content.menus,
      tokens,
      content,
      componentPlan: promptContext,
    });

    let code = '';
    let lastError: string | undefined;
    let isValid = false;
    const validationContext = this.buildValidationContext(
      promptContext,
      sectionName,
      true,
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
      } = await this.generateWithRetry(
        modelName,
        systemPrompt,
        userPrompt,
        5,
        logPath,
        sectionName,
      );
      code = this.stripMarkdownFences(raw);
      code = this.mergeClassNames(code);
      code = this.fixDoublebraces(code);
      code = this.normalizeTailwindFunctionSpacing(code);

      const check = this.validator.checkCodeStructure(code, validationContext);
      if (check.fixedCode) code = check.fixedCode;
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
        code = await this.selfFix(
          fixAgentModel,
          code,
          lastError,
          logPath,
          sectionName,
        );
        const check = this.validator.checkCodeStructure(
          code,
          validationContext,
        );
        if (check.fixedCode) code = check.fixedCode;
        if (check.isValid) {
          isValid = true;
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
      // Log section generation failure
      if (this.aiLogger && jobId) {
        cotAttempts.push({
          attemptNumber: cotAttempts.length + 1,
          response: `Section generation failed after all attempts`,
          tokensUsed: { input: 0, output: 0, total: 0 },
          timestamp: new Date().toISOString(),
          success: false,
          error: lastError,
        });

        await this.aiLogger.logCotProcess({
          jobId,
          step: 'section-generation',
          componentName: sectionName,
          model: modelName,
          startTime,
          endTime: new Date().toISOString(),
          totalAttempts: cotAttempts.length,
          attempts: cotAttempts,
          finalSuccess: false,
          totalTokenCost: 0,
          totalTokens: { input: 0, output: 0 },
          finalError: lastError,
        });
      }

      throw new Error(
        `[reviewer] Section "${sectionName}" failed after 3 attempts: ${lastError}`,
      );
    }

    // Log successful section generation
    if (this.aiLogger && jobId) {
      cotAttempts.push({
        attemptNumber: cotAttempts.length + 1,
        response: 'Section generation succeeded',
        tokensUsed: { input: 0, output: 0, total: 0 },
        timestamp: new Date().toISOString(),
        success: true,
        validationFeedback: 'Section code passed validation',
      });

      await this.aiLogger.logCotProcess({
        jobId,
        step: 'section-generation',
        componentName: sectionName,
        model: modelName,
        startTime,
        endTime: new Date().toISOString(),
        totalAttempts: cotAttempts.length,
        attempts: cotAttempts,
        finalSuccess: true,
        totalTokenCost: 0,
        totalTokens: { input: 0, output: 0 },
      });
    }

    return { name: sectionName, filePath: '', code, isSubComponent: true };
  }

  // ── Self-fix (Fix Agent) ───────────────────────────────────────────────────

  private buildPromptContext(
    componentPlan?: PlanResult[number] | ComponentPromptContext,
    visualPlan?: ComponentVisualPlan,
    options?: { includeVisualPlan?: boolean },
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

    return {
      description: componentPlan?.description,
      route: componentPlan?.route,
      isDetail: componentPlan?.isDetail,
      type: componentPlan?.type,
      dataNeeds,
      visualPlan: resolvedVisualPlan,
    };
  }

  private buildValidationContext(
    componentPlan?: ComponentPromptContext,
    componentName?: string,
    isSubComponent = false,
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
      allowedRelativeImports: componentPlan?.visualPlan?.layout.includes ?? [],
      requireCommentForm:
        commentSection?.type === 'comments' ? commentSection.showForm : false,
    };
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
    logPath?: string;
  }): Promise<{
    code: string;
    isValid: boolean;
    attemptsUsed: number;
    lastError?: string;
  }> {
    const { componentName, templateSource, modelName, componentPlan, logPath } =
      input;

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
    );

    let lastFragment = '';
    let lastError = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const userPrompt = buildFragmentPrompt({
        componentName,
        availableVariables,
        templateSource,
        visualPlan: componentPlan.visualPlan,
        componentType: componentPlan.type,
        retryError: attempt > 1 ? lastError : undefined,
        previousFragment: attempt > 1 ? lastFragment : undefined,
      });

      const { text: raw } = await this.generateWithRetry(
        modelName,
        FRAGMENT_SYSTEM_PROMPT,
        userPrompt,
        3,
        logPath,
        `${componentName}:fragment:${attempt}`,
      );

      lastFragment = raw
        .replace(/^```(?:tsx|jsx|ts|js)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      const assembled = this.frameGenerator.assembleComponent(
        frame,
        lastFragment,
      );
      const sanitized = this.validator.sanitizeGeneratedCode(assembled);
      const check = this.validator.checkCodeStructure(
        sanitized,
        validationContext,
      );
      const code = check.fixedCode ?? sanitized;

      if (check.isValid) {
        await this.log(
          logPath,
          `[reviewer:frame] "${componentName}" fragment attempt ${attempt}/2 ✓`,
        );
        return { code, isValid: true, attemptsUsed: attempt };
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

    return { code: '', isValid: false, attemptsUsed: 2, lastError };
  }

  private async generateComponentWithPlan(input: {
    componentName: string;
    templateSource: string;
    modelName: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    componentPlan?: ComponentPromptContext;
    logPath?: string;
    logLabel: string;
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
      componentPlan,
      logPath,
      logLabel,
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
    );

    // ── D0: Frame + Fragment — try before full-file generation ──────────────
    // Skipped when the plan lacks enough context to build a frame (no dataNeeds
    // or no type), or when direct-AI / section-chunk paths explicitly request
    // full-file output (logLabel === 'direct-ai' has already exhausted D2).
    if (componentPlan && this.shouldUseFramePath(componentPlan, componentName)) {
      const frameResult = await this.generateComponentWithFrame({
        componentName,
        templateSource,
        modelName,
        componentPlan,
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
          cotAttempts: [],
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
        componentPlan,
        attempt > 1
          ? `Previous attempt failed: ${lastError}\n\nYour previous output:\n\`\`\`tsx\n${code}\n\`\`\`\nFix ONLY the error above.`
          : undefined,
      );
      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
      } = await this.generateWithRetry(
        modelName,
        this.componentSystemPrompt,
        userPromptForAttempt,
        5,
        logPath,
        `${componentName}:${logLabel}`,
      );

      lastRawOutput = raw;
      code = this.postProcessCode(raw);

      const check = this.validator.checkCodeStructure(code, validationContext);
      if (check.fixedCode) code = check.fixedCode;

      cotAttempts.push({
        attemptNumber: attempt,
        promptSent: {
          system: this.componentSystemPrompt,
          user: userPromptForAttempt,
        },
        response: raw,
        tokensUsed: { input: inTok, output: outTok, total: inTok + outTok },
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

        if (isNoJsx || isPageContract) {
          const reason = isNoJsx
            ? 'No JSX return found'
            : 'Page detail contract violated';
          this.logger.warn(
            `[reviewer:autofix] "${componentName}" ${reason}; invoking self-fix agent`,
          );
          await this.log(
            logPath,
            `[reviewer:autofix] "${componentName}" ${reason}; invoking self-fix agent`,
          );

          try {
            const fixed = await this.selfFix(
              modelName,
              code,
              `${reason}: ${lastError}`,
              logPath,
              `${componentName}:${logLabel}:autofix`,
            );
            code = fixed;

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
                  system: this.componentSystemPrompt,
                  user: userPromptForAttempt,
                },
                response: raw,
                tokensUsed: { input: 0, output: 0, total: 0 },
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
  ): Promise<string> {
    const { text: raw } = await this.generateWithRetry(
      model,
      'You are a React/TypeScript expert. Fix the exact error in the component. Return ONLY the corrected TSX code, no explanation.',
      `This component has a validation error: ${error}\n\nFix it and return the complete corrected code:\n\`\`\`tsx\n${brokenCode}\n\`\`\``,
      3,
      logPath,
      label ? `${label}:fix` : undefined,
    );
    return this.postProcessCode(raw);
  }

  // ── LLM call with exponential back-off ───────────────────────────────────

  private async generateWithRetry(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxRetries = 5,
    logPath?: string,
    label?: string,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    let delay = 30_000;
    let maxTokens = this.llmFactory.getMaxTokens();
    let lastTruncatedResult: {
      text: string;
      inputTokens: number;
      outputTokens: number;
    } | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.llmFactory.chat({
          model,
          systemPrompt,
          userPrompt,
          maxTokens,
        });
        const tokenLogPath = logPath?.replace(/\.log$/, '.tokens.log');
        if (tokenLogPath) {
          await this.tokenTracker.init(tokenLogPath);
          await this.tokenTracker.track(
            model,
            result.inputTokens,
            result.outputTokens,
            label ?? model,
          );
        }
        if (result.truncated) {
          lastTruncatedResult = {
            text: result.text,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
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
    return { text: '', inputTokens: 0, outputTokens: 0 };
  }

  // ── Code post-processors ──────────────────────────────────────────────────

  private postProcessCode(code: string): string {
    return this.normalizeTailwindFunctionSpacing(
      this.fixDoublebraces(
        this.mergeClassNames(this.stripMarkdownFences(code)),
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

  // ── Logger ────────────────────────────────────────────────────────────────

  private async log(
    logPath: string | undefined,
    message: string,
  ): Promise<void> {
    if (!logPath) return;
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // never crash pipeline because of a log failure
    }
  }
}
