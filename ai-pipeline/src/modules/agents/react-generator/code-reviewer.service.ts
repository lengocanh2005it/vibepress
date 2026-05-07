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
import { getComponentStrategy } from '../component-strategy.registry.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';
import {
  buildComponentPrompt,
  buildComponentRepoChainNote,
  buildInlineSectionPrompt,
  buildSectionPrompt,
  buildSurfacePlanRepairContextNote,
  buildSpectraContractPromptNote,
  type ComponentPromptContext,
} from './prompts/component.prompt.js';
import { INVENTED_AUXILIARY_SECTION_LABELS } from './auxiliary-section.guard.js';
import { FLAT_REST_SAFETY_RULE } from './api-contract.js';
import {
  normalizeCanonicalPostMetaAndTextLinks,
  normalizeCommonTypographyTypos,
  normalizeThemeAssetReferences,
} from '../shared/code-postprocess.util.js';
import {
  synchronizeVisualPlanContract,
  toVisualDataNeeds,
} from '../shared/visual-data-needs.util.js';
import { isHybridDetailPlanWithoutCanonicalBody } from './prompt-policy.util.js';
import {
  isDeterministicFallbackEligibleForRenderContract,
  shouldPreferDeterministicGenerationForRenderContract,
} from '../planner/render-contract.schema.js';
import {
  buildVisualPlanPrompt,
  parseVisualPlanDetailed,
} from './prompts/visual-plan.prompt.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import { inferTargetFromBlockName } from '../../../common/utils/wp-block-to-json.js';
import { extractStaticImageSources } from '../../../common/utils/theme-asset.util.js';
import type {
  ThemeInteractionTarget,
  ThemeTokens,
} from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import {
  collectSurfacePlanRequiredLiterals,
  resolvePlannerSectionBlueprint,
} from '../planner/planner-surface-plan.util.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type {
  BlockNode,
  ComponentVisualPlan,
  SectionPlan,
} from './visual-plan.schema.js';
import {
  shouldBypassAiGenerationForVisualPlan,
  shouldProtectDeterministicStructureFromAi,
} from './visual-plan.schema.js';
import {
  shouldForceStrictThemeSourceFaithfulDeterministicPage,
  shouldPreferSectionAssemblyForFrontPage,
  shouldPreferThemeSourceFaithfulDeterministicPage,
} from './source-faithful-deterministic.util.js';
import { isProfolioFseAiLockedVisualPlanSurface } from '../../theme/profiles/profolio-fse-generation-policy.js';

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

type FullFileGenerationPolicy = 'plan-guided-full-file' | 'direct-ai-full-file';

const RICH_VISUAL_SECTION_TYPES = new Set([
  'prose-block',
  'hero',
  'cta-strip',
  'cover',
  'media-text',
  'card-grid',
  'testimonial',
  'accordion',
  'tabs',
  'carousel',
  'modal',
  'newsletter',
  'post-featured-image',
]);

const INTERACTIVE_VISUAL_SECTION_TYPES = new Set([
  'accordion',
  'tabs',
  'carousel',
  'modal',
]);

const LOW_COMPLEXITY_VISUAL_SECTION_TYPES = new Set([
  'page-content',
  'post-content',
  'post-title',
  'post-featured-image',
  'post-terms',
  'post-navigation',
  'comments',
  'search',
  'breadcrumb',
  'sidebar',
  'post-list',
  'navbar',
  'footer',
  'post-terms',
  'post-navigation',
]);

const MEDIA_HEAVY_VISUAL_SECTION_TYPES = new Set([
  'cover',
  'media-text',
  'carousel',
  'testimonial',
]);

const CONTENT_WRAPPER_COMPAT_VISUAL_SECTION_TYPES = new Set([
  'page-content',
  'prose-block',
  'hero',
  'cta-strip',
  'breadcrumb',
  'sidebar',
]);

const LIST_DRIVEN_VISUAL_SECTION_TYPES = new Set([
  'hero',
  'cta-strip',
  'cover',
  'search',
  'post-list',
  'breadcrumb',
  'sidebar',
  'post-navigation',
  'post-title',
  'post-featured-image',
]);

// Keep deterministic inline assembly limited to low-risk, content-structural
// sections and compact source-backed sections where dropping a literal field is
// worse than losing some design freedom. Rich interactive sections still need AI.
const DETERMINISTIC_SECTION_ASSEMBLY_TYPES = new Set<SectionPlan['type']>([
  'cover',
  'post-list',
  'post-content',
  'post-title',
  'post-featured-image',
  'post-meta',
  'post-terms',
  'post-navigation',
  'page-content',
  'comments',
  'sidebar',
  'prose-block',
  'testimonial',
]);

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
    'You are a senior React + TypeScript engineer focused on source-faithful WordPress migration. Generate a complete component from the provided migration context, preserve source-backed class/style semantics and DOM hierarchy, and return ONLY raw TSX code.';
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

  private readonly rewriteFileSystemPrompt =
    'You are a React/TypeScript expert. Apply ONLY the requested change to the complete TSX file. ' +
    'Return the ENTIRE modified file — all imports, exports, types, hooks, and unchanged code must be preserved exactly as-is. ' +
    'Do NOT reformat, rename variables, or alter anything not mentioned in the instruction. ' +
    'Do NOT wrap the output in markdown fences or add any explanation. The output must be valid, compilable TSX.';

  private readonly rewriteFragmentSystemPrompt =
    'You are a React/TypeScript expert. Apply ONLY the requested change to the provided code fragment. ' +
    'Return the ENTIRE fragment back — preserve every unchanged line exactly as-is. ' +
    'Do NOT add or remove import statements. Do NOT output anything outside this fragment. ' +
    'Do NOT wrap in markdown fences or add any explanation. Output must be valid TSX.';

  private readonly patchSnippetSystemPrompt =
    'You are a React/TypeScript expert. Apply the requested change to the given TSX snippet. ' +
    'Return ONLY the modified snippet — no imports, no exports, no full component file, no markdown fences, no explanation. ' +
    'The snippet may start or end mid-JSX. Preserve original indentation exactly.';

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Apply a targeted edit instruction to a small TSX snippet (not the whole file).
   * Returns the modified snippet only — caller is responsible for splicing it back.
   */
  public async patchSnippet(
    model: string,
    snippet: string,
    instruction: string,
    logPath?: string,
    label?: string,
  ): Promise<string> {
    const userPrompt =
      `Edit instruction: ${instruction}\n\n` +
      `Snippet to modify:\n\`\`\`tsx\n${snippet}\n\`\`\`\n\n` +
      'Return only the modified lines, preserving original indentation. No fences, no explanation.';

    await this.log(
      logPath,
      `[patch-snippet] ${label ?? 'snippet'}: ${instruction.slice(0, 120)}`,
    );

    const result = await this.llmFactory.chat({
      model,
      systemPrompt: this.patchSnippetSystemPrompt,
      userPrompt,
      maxTokens: 2048,
    });

    const raw = result.text ?? '';
    return raw
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();
  }

  /**
   * Send the entire TSX file to AI with an edit instruction and get back the fully rewritten file.
   * Caller is responsible for backup + writeFile.
   */
  public async rewriteFile(
    model: string,
    fileContent: string,
    instruction: string,
    logPath?: string,
    label?: string,
  ): Promise<string> {
    const userPrompt =
      `Edit instruction:\n${instruction}\n\n` +
      `Complete TSX file to modify:\n\`\`\`tsx\n${fileContent}\n\`\`\`\n\n` +
      'Return the complete modified file only. No markdown fences, no explanation.';

    await this.log(
      logPath,
      `[rewrite-file] ${label ?? 'file'}: ${instruction.slice(0, 120)}`,
    );

    const inputChars = userPrompt.length;
    this.logger.log(
      `[timing] llm.chat start — model=${model} inputChars=${inputChars}`,
    );
    const tChat = Date.now();
    const result = await this.llmFactory.chat({
      model,
      systemPrompt: this.rewriteFileSystemPrompt,
      userPrompt,
      maxTokens: 8192,
    });
    this.logger.log(
      `[timing] llm.chat done — ${Date.now() - tChat}ms | inputTokens=${result.inputTokens} outputTokens=${result.outputTokens}`,
    );

    const raw = result.text ?? '';
    return raw
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();
  }

  /**
   * Send a fragment of a TSX file (lines windowStart–windowEnd) to AI.
   * Returns only the modified fragment — caller is responsible for splicing back.
   */
  public async rewriteFragment(
    model: string,
    fragment: string,
    instruction: string,
    windowStart: number,
    windowEnd: number,
    logPath?: string,
    label?: string,
  ): Promise<string> {
    const userPrompt =
      `Edit instruction:\n${instruction}\n\n` +
      `Code fragment (lines ${windowStart}–${windowEnd} of the file):\n\`\`\`tsx\n${fragment}\n\`\`\`\n\n` +
      'Return the complete modified fragment only. No markdown fences, no explanation.';

    await this.log(
      logPath,
      `[rewrite-fragment] ${label ?? 'fragment'} lines ${windowStart}-${windowEnd}: ${instruction.slice(0, 80)}`,
    );

    const inputChars = userPrompt.length;
    this.logger.log(
      `[timing] llm.chat start (fragment) — model=${model} inputChars=${inputChars} lines=${windowEnd - windowStart + 1}`,
    );
    const tChat = Date.now();
    const result = await this.llmFactory.chat({
      model,
      systemPrompt: this.rewriteFragmentSystemPrompt,
      userPrompt,
      maxTokens: 4096,
    });
    this.logger.log(
      `[timing] llm.chat done (fragment) — ${Date.now() - tChat}ms | inputTokens=${result.inputTokens} outputTokens=${result.outputTokens}`,
    );

    const raw = result.text ?? '';
    return raw
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();
  }

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
    const strategy = getComponentStrategy(componentName);
    const strictDeterministicAuthority =
      this.isStrictDeterministicAuthority(componentPlan);
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
    const nodeCustomClassTargets =
      this.collectCustomClassTargetsFromNodesJson(templateSource);
    if (
      nodeCustomClassNames.length > 0 ||
      Object.keys(nodeCustomClassTargets).length > 0
    ) {
      const merged = [
        ...new Set([
          ...(promptContext?.requiredCustomClassNames ?? []),
          ...nodeCustomClassNames,
        ]),
      ];
      const mergedTargets = {
        ...(promptContext?.requiredCustomClassTargets ?? {}),
        ...nodeCustomClassTargets,
      };
      promptContext = promptContext
        ? {
            ...promptContext,
            requiredCustomClassNames: merged,
            requiredCustomClassTargets: mergedTargets,
          }
        : {
            requiredCustomClassNames: merged,
            requiredCustomClassTargets: mergedTargets,
          };
    }
    let validationContext = this.buildValidationContext(
      promptContext,
      componentName,
      false,
      undefined,
      this.resolveRequiredCustomClassTargets(
        promptContext?.requiredCustomClassNames,
        tokens,
        nodeCustomClassTargets,
      ),
    );

    if (preferDirectAi && componentPlan?.visualPlan) {
      await this.log(
        logPath,
        `[reviewer] "${componentName}": preferDirectAi enabled; bypassing visual-plan-first path to preserve WordPress block fidelity`,
      );
    }

    const sectionAssemblyDecision = this.getSectionLevelAssemblyDecision(
      componentPlan,
      componentName,
      repoManifest,
    );
    if (
      !strictDeterministicAuthority &&
      !forceDirectAi &&
      sectionAssemblyDecision.enabled
    ) {
      this.logger.log(
        `[reviewer] "${componentName}": using section-level one-file assembly (${componentPlan?.visualPlan?.sections.length ?? 0} sections; ${sectionAssemblyDecision.reason})`,
      );
      await this.log(
        logPath,
        `[reviewer] "${componentName}": using section-level one-file assembly (${componentPlan?.visualPlan?.sections.length ?? 0} sections; ${sectionAssemblyDecision.reason})`,
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

    if (strictDeterministicAuthority && componentPlan?.visualPlan) {
      await this.log(
        logPath,
        `[reviewer] "${componentName}": deterministic-authority plan locked; skipping AI visual plan/codegen and using deterministic generation only`,
      );
      const deterministicOnly = await this.tryDeterministicPlan(
        componentName,
        componentPlan.visualPlan,
        componentPlan.renderContract?.fallback?.sections,
        validationContext,
        logPath,
        'locked deterministic-authority plan',
      );
      return {
        component: {
          name: componentName,
          filePath: '',
          code: deterministicOnly.code,
          requiredCustomClassNames: promptContext?.requiredCustomClassNames,
          visualPlan: promptContext?.visualPlan,
        },
        fromVisualPlan: true,
        generationMode: 'deterministic',
        attempts: 0,
        rawResponse: '',
      };
    }

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const isRetry = round > 1;

      // ── D1: Reviewed pre-computed visual plan → AI-first codegen ─────────────
      if (!forceDirectAi && !isRetry && componentPlan?.visualPlan) {
        promptContext = this.buildPromptContext(
          componentPlan,
          componentPlan.visualPlan,
        );
        if (
          nodeCustomClassNames.length > 0 ||
          Object.keys(nodeCustomClassTargets).length > 0
        ) {
          const merged = [
            ...new Set([
              ...(promptContext?.requiredCustomClassNames ?? []),
              ...nodeCustomClassNames,
            ]),
          ];
          const mergedTargets = {
            ...(promptContext?.requiredCustomClassTargets ?? {}),
            ...nodeCustomClassTargets,
          };
          promptContext = promptContext
            ? {
                ...promptContext,
                requiredCustomClassNames: merged,
                requiredCustomClassTargets: mergedTargets,
              }
            : {
                requiredCustomClassNames: merged,
                requiredCustomClassTargets: mergedTargets,
              };
        }
        validationContext = this.buildValidationContext(
          promptContext,
          componentName,
          false,
          undefined,
          this.resolveRequiredCustomClassTargets(
            promptContext?.requiredCustomClassNames,
            tokens,
            nodeCustomClassTargets,
          ),
        );
        await this.log(
          logPath,
          `[reviewer] "${componentName}": using reviewed pre-computed visual plan for AI codegen (${componentPlan.visualPlan.sections.length} sections)`,
        );

        const prefersDeterministicPlan =
          strategy.deterministicFirst ||
          this.shouldPreferDeterministicPlan(
            componentPlan,
            componentName,
            repoManifest,
          );
        if (prefersDeterministicPlan) {
          const deterministicFirst = await this.tryDeterministicPlan(
            componentName,
            componentPlan.visualPlan,
            componentPlan.renderContract?.fallback?.sections,
            validationContext,
            logPath,
            'reviewed plan (deterministic-first)',
          );
          if (deterministicFirst.isValid) {
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
                code: deterministicFirst.code,
                requiredCustomClassNames:
                  promptContext?.requiredCustomClassNames,
                visualPlan: promptContext?.visualPlan,
              },
              fromVisualPlan: true,
              generationMode: 'deterministic',
              attempts,
              rawResponse: '',
            };
          }
          lastError = deterministicFirst.error ?? lastError;
        }

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
          fullFilePolicy: 'plan-guided-full-file',
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
              visualPlan: promptContext?.visualPlan,
            },
            fromVisualPlan: true,
            generationMode: 'ai',
            attempts,
            rawResponse: planned.lastRawOutput || '',
          };
        }
        lastError = planned.lastError ?? lastError;
        this.logger.warn(
          `[reviewer] "${componentName}" AI reviewed-plan codegen failed: ${planned.lastError} — deterministic fallback`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" AI reviewed-plan codegen failed: ${planned.lastError} — deterministic fallback`,
        );

        if (this.canUseDeterministicGeneration(componentPlan)) {
          const deterministic = await this.tryDeterministicPlan(
            componentName,
            componentPlan.visualPlan,
            componentPlan.renderContract?.fallback?.sections,
            validationContext,
            logPath,
            'reviewed plan',
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
                'Deterministic reviewed-plan fallback succeeded',
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
                requiredCustomClassNames:
                  promptContext?.requiredCustomClassNames,
                visualPlan: promptContext?.visualPlan,
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
            `[reviewer] "${componentName}" deterministic reviewed-plan fallback failed: ${deterministic.error} — requesting fresh AI visual plan`,
          );
          await this.log(
            logPath,
            `WARN [reviewer] "${componentName}" deterministic reviewed-plan fallback failed: ${deterministic.error} — requesting fresh AI visual plan`,
          );
        } else {
          precomputedPlanAllFailed = true;
        }
      }

      // ── D2: AI visual plan → AI codegen ─────────────────────────────────────
      // Used when: no reviewed plan on round 1, after R3→D1 retry, or when
      // the reviewed-plan path has failed end-to-end (both AI and deterministic).
      if (
        !forceDirectAi &&
        (isRetry || !componentPlan?.visualPlan || precomputedPlanAllFailed)
      ) {
        await this.log(
          logPath,
          isRetry
            ? `[reviewer] "${componentName}" R3→D1: restarting with fresh AI visual plan (round ${round}/${MAX_ROUNDS})`
            : precomputedPlanAllFailed
              ? `[reviewer] "${componentName}" reviewed-plan path failed end-to-end — generating fresh AI visual plan`
              : `[reviewer] Stage 1: requesting AI visual plan for "${componentName}"`,
        );
        const visualDataNeeds = componentPlan
          ? toVisualDataNeeds(componentPlan.dataNeeds)
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
          const visualPlan = parsedPlan.plan
            ? {
                ...parsedPlan.plan,
                ...(componentPlan?.fixedSlug
                  ? {
                      pageBinding: {
                        id: componentPlan.fixedPageId,
                        slug: componentPlan.fixedSlug,
                        title: componentPlan.fixedTitle,
                        route: componentPlan.route ?? undefined,
                      },
                    }
                  : {}),
              }
            : undefined;

          if (visualPlan) {
            promptContext = this.buildPromptContext(componentPlan, visualPlan);
            if (
              nodeCustomClassNames.length > 0 ||
              Object.keys(nodeCustomClassTargets).length > 0
            ) {
              const merged = [
                ...new Set([
                  ...(promptContext?.requiredCustomClassNames ?? []),
                  ...nodeCustomClassNames,
                ]),
              ];
              const mergedTargets = {
                ...(promptContext?.requiredCustomClassTargets ?? {}),
                ...nodeCustomClassTargets,
              };
              promptContext = promptContext
                ? {
                    ...promptContext,
                    requiredCustomClassNames: merged,
                    requiredCustomClassTargets: mergedTargets,
                  }
                : {
                    requiredCustomClassNames: merged,
                    requiredCustomClassTargets: mergedTargets,
                  };
            }
            validationContext = this.buildValidationContext(
              promptContext,
              componentName,
              false,
              undefined,
              this.resolveRequiredCustomClassTargets(
                promptContext?.requiredCustomClassNames,
                tokens,
                nodeCustomClassTargets,
              ),
            );
            await this.log(
              logPath,
              `[reviewer] Stage 2: generating TSX with AI from visual plan (${visualPlan.sections.length} sections)`,
            );
            const prefersDeterministicPlan =
              strategy.deterministicFirst ||
              this.shouldPreferDeterministicPlan(componentPlan, componentName);
            if (prefersDeterministicPlan) {
              const deterministicFirst = await this.tryDeterministicPlan(
                componentName,
                visualPlan,
                componentPlan?.renderContract?.fallback?.sections,
                validationContext,
                logPath,
                'AI visual plan (deterministic-first)',
              );
              if (deterministicFirst.isValid) {
                return {
                  component: {
                    name: componentName,
                    filePath: '',
                    code: deterministicFirst.code,
                    requiredCustomClassNames:
                      promptContext?.requiredCustomClassNames,
                    visualPlan: promptContext?.visualPlan,
                  },
                  fromVisualPlan: true,
                  generationMode: 'deterministic',
                  attempts,
                  rawResponse: '',
                };
              }
              lastError = deterministicFirst.error ?? lastError;
            }
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
              fullFilePolicy: 'plan-guided-full-file',
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
                  visualPlan: promptContext?.visualPlan,
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

            if (this.canUseDeterministicGeneration(componentPlan)) {
              const deterministic = await this.tryDeterministicPlan(
                componentName,
                visualPlan,
                componentPlan?.renderContract?.fallback?.sections,
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
                    visualPlan: promptContext?.visualPlan,
                  },
                  fromVisualPlan: true,
                  generationMode: 'deterministic',
                  attempts,
                  rawResponse: '',
                };
              }
              lastError = deterministic.error ?? lastError;
            }
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
        fullFilePolicy: 'direct-ai-full-file',
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
            visualPlan: promptContext?.visualPlan,
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
          this.buildAutoFixErrorContext(
            'Validation failure',
            lastError,
            componentPlan,
            componentName,
            repoManifest,
          ),
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
              visualPlan: promptContext?.visualPlan,
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
          this.buildAutoFixErrorContext(
            'Section validation failure',
            lastError,
            promptContext,
            sectionName,
            repoManifest,
          ),
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
        : synchronizeVisualPlanContract(
            visualPlan ?? componentPlan?.visualPlan,
            componentPlan,
          );
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
      templateName:
        'templateName' in (componentPlan ?? {})
          ? (componentPlan as PlanResult[number] | ComponentPromptContext)
              ?.templateName
          : undefined,
      description: componentPlan?.description,
      route: componentPlan?.route,
      isDetail: componentPlan?.isDetail,
      type: componentPlan?.type,
      fixedSlug: componentPlan?.fixedSlug,
      fixedTitle: componentPlan?.fixedTitle,
      fixedPageId: componentPlan?.fixedPageId,
      runtimeRenderer:
        'runtimeRenderer' in (componentPlan ?? {})
          ? (componentPlan as PlanResult[number] | ComponentPromptContext)
              ?.runtimeRenderer
          : undefined,
      dataNeeds,
      requiredCustomClassNames,
      sourceBackedAuxiliaryLabels: componentPlan?.sourceBackedAuxiliaryLabels,
      visualPlan: resolvedVisualPlan,
      surfacePlan:
        'surfacePlan' in (componentPlan ?? {})
          ? (componentPlan as PlanResult[number] | ComponentPromptContext)
              ?.surfacePlan
          : undefined,
      renderContract:
        'renderContract' in (componentPlan ?? {})
          ? (componentPlan as PlanResult[number] | ComponentPromptContext)
              ?.renderContract
          : undefined,
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
      fixedSlug: componentPlan?.fixedSlug,
      runtimeRenderer: componentPlan?.runtimeRenderer,
      dataNeeds: componentPlan?.dataNeeds,
      type: componentPlan?.type,
      isSubComponent,
      visualPlan: componentPlan?.visualPlan,
      surfacePlan: componentPlan?.surfacePlan,
      renderContract: componentPlan?.renderContract,
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
    nodeInferredTargets?: Record<string, ThemeInteractionTarget>,
  ): Record<string, ThemeInteractionTarget> | undefined {
    const targetMap: Record<string, ThemeInteractionTarget> = {
      ...(nodeInferredTargets ?? {}),
    };

    const precise = tokens?.interactions?.precise ?? [];
    for (const className of requiredCustomClassNames ?? []) {
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
    const resolvedPlan = visualPlan ?? componentPlan?.visualPlan;
    const classNames = [
      ...(componentPlan && 'customClassNames' in componentPlan
        ? (componentPlan.customClassNames ?? [])
        : []),
      ...(resolvedPlan?.sections.flatMap((section) =>
        this.extractCustomClassNamesFromSection(section),
      ) ?? []),
      ...this.extractCustomClassNamesFromBlockTree(resolvedPlan?.blockTree),
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

  private collectCustomClassTargetsFromNodesJson(
    nodesJson: string,
  ): Record<string, ThemeInteractionTarget> {
    try {
      const parsed = JSON.parse(nodesJson) as unknown[];
      const targets: Record<string, ThemeInteractionTarget> = {};
      const visit = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const node = value as {
          block?: string;
          customClassNames?: string[];
          children?: unknown[];
        };
        const target = inferTargetFromBlockName(node.block ?? '');
        if (target) {
          for (const className of node.customClassNames ?? []) {
            const normalized = className.trim();
            if (normalized && !targets[normalized]) {
              targets[normalized] = target;
            }
          }
        }
        for (const child of node.children ?? []) visit(child);
      };
      if (Array.isArray(parsed)) {
        for (const node of parsed) visit(node);
      }
      return targets;
    } catch {
      return {};
    }
  }

  private getSectionLevelAssemblyDecision(
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
    repoManifest?: RepoThemeManifest,
  ): { enabled: boolean; reason: string } {
    if (componentPlan?.type !== 'page' || !componentPlan.visualPlan) {
      return { enabled: false, reason: 'not eligible' };
    }

    if (repoManifest?.themeTypeHints?.themeSlug === 'profolio-fse') {
      return {
        enabled: false,
        reason:
          'profolio-fse pages use source-cluster child component composition',
      };
    }

    if (
      shouldPreferThemeSourceFaithfulDeterministicPage({
        componentPlan,
        componentName,
        repoManifest,
      })
    ) {
      return {
        enabled: false,
        reason:
          'theme source-faithful page prefers deterministic block-tree/full-file generation',
      };
    }

    const pinnedSectionAssemblyComponent = Boolean(
      /^(FrontPage|Home|TemplateAbout|TemplateContact|TemplateServices)$/i.test(
        componentName,
      ) && componentPlan.visualPlan.sections.length >= 1,
    );
    if (pinnedSectionAssemblyComponent) {
      return {
        enabled: true,
        reason: 'component is pinned to section assembly',
      };
    }

    // PR4: honor planner-annotated generationMode (set by PR3 for home-like components).
    // When ≥2 sections carry 'section-assembly', bypass heuristic scoring entirely.
    const plannerAnnotated = componentPlan.visualPlan.sections.filter(
      (s) => s.generationMode === 'section-assembly',
    );
    if (plannerAnnotated.length >= 2) {
      return {
        enabled: true,
        reason: `planner-annotated section-assembly (${plannerAnnotated.length}/${componentPlan.visualPlan.sections.length} sections)`,
      };
    }

    const normalizedNeeds = new Set(toVisualDataNeeds(componentPlan.dataNeeds));
    const signals = this.getVisualPlanSectionSignals(componentPlan);
    const complexAiFirstPageCandidate = this.isComplexAiFirstPageCandidate(
      componentPlan,
      componentName,
      signals,
      normalizedNeeds,
    );
    const defaultRichPageAssemblyCandidate = Boolean(
      !componentPlan.isDetail &&
      signals.sections.length >= 2 &&
      !signals.lowComplexityOnly &&
      (signals.richSectionCount >= 1 ||
        signals.sourceBackedSectionCount >= 2 ||
        signals.distinctTypes.size >= 2 ||
        normalizedNeeds.has('posts')),
    );

    if (
      componentPlan.visualPlan.blockTree?.length &&
      componentPlan.visualPlan.renderMode !== 'section-centric'
    ) {
      const allowHybridSectionAssembly =
        componentPlan.visualPlan.renderMode === 'hybrid' &&
        !componentPlan.isDetail &&
        !signals.hasPageContent &&
        !signals.hasPostContent &&
        !signals.lowComplexityOnly &&
        (signals.sections.length >= 3 || defaultRichPageAssemblyCandidate) &&
        (signals.richSectionCount >= 1 ||
          signals.mediaHeavySectionCount >= 1 ||
          signals.sourceBackedSectionCount >= 2 ||
          normalizedNeeds.has('posts'));
      const allowComplexBlockTreeSectionAssembly = Boolean(
        componentPlan.visualPlan.renderMode === 'hybrid' &&
        complexAiFirstPageCandidate &&
        componentPlan.visualPlan.layout.sidebarScope !== 'all-content' &&
        signals.sections.length >= 3 &&
        (signals.richSectionCount >= 1 ||
          signals.mediaHeavySectionCount >= 1 ||
          signals.sourceBackedSectionCount >= 2 ||
          signals.hasPageContent),
      );
      if (allowHybridSectionAssembly) {
        return {
          enabled: true,
          reason:
            'hybrid block-tree page prefers section assembly for content retention',
        };
      }
      if (allowComplexBlockTreeSectionAssembly) {
        return {
          enabled: true,
          reason:
            'complex homepage/page template prefers section assembly before deterministic fallback',
        };
      }
      return {
        enabled: false,
        reason:
          'block-tree plans preserve hierarchy via hybrid/full-file render',
      };
    }
    if (signals.sections.length < 2) {
      return { enabled: false, reason: 'too few sections' };
    }

    const isPageDetail =
      componentPlan.isDetail && normalizedNeeds.has('pageDetail');
    const isPostDetail =
      componentPlan.isDetail &&
      (normalizedNeeds.has('postDetail') || signals.hasPostContent);
    const isCanonicalSinglePostDetail =
      /^Single$/i.test(componentName) &&
      isPostDetail &&
      signals.sections.length >= 2 &&
      signals.sections.every((section) =>
        DETERMINISTIC_SECTION_ASSEMBLY_TYPES.has(section.type),
      );
    const isSingleWithSidebar =
      /^SingleWithSidebar$/i.test(componentName) &&
      isPostDetail &&
      componentPlan.visualPlan.layout.contentLayout !== 'single-column' &&
      signals.sections.some((section) => section.type === 'sidebar') &&
      signals.sections.some((section) => section.type === 'comments');
    if (componentPlan.visualPlan.layout.sidebarScope === 'all-content') {
      return {
        enabled: false,
        reason:
          'all-content sidebar layout prefers full-file deterministic shell',
      };
    }
    const richPageDetailCandidate = Boolean(
      isPageDetail &&
      !isPostDetail &&
      signals.sections.length >= 4 &&
      (signals.richSectionCount >= 2 ||
        signals.interactiveSectionCount >= 1 ||
        signals.mediaHeavySectionCount >= 2),
    );

    if (
      componentPlan.isDetail &&
      !isSingleWithSidebar &&
      !isCanonicalSinglePostDetail &&
      !richPageDetailCandidate
    ) {
      return {
        enabled: false,
        reason: isPostDetail
          ? 'post-detail view blocked'
          : isPageDetail
            ? 'page-detail prefers full-file AI'
            : 'detail view blocked',
      };
    }

    const hasOnlyContentWrapper =
      signals.hasPageContent &&
      signals.sections.every((section) =>
        CONTENT_WRAPPER_COMPAT_VISUAL_SECTION_TYPES.has(section.type),
      );
    const listDrivenOnly =
      normalizedNeeds.has('posts') &&
      signals.sections.every((section) =>
        LIST_DRIVEN_VISUAL_SECTION_TYPES.has(section.type),
      );

    if (signals.lowComplexityOnly) {
      if (isSingleWithSidebar || isCanonicalSinglePostDetail) {
        return {
          enabled: true,
          reason: isSingleWithSidebar
            ? 'single-with-sidebar deterministic section assembly'
            : 'single deterministic section assembly',
        };
      }
      return { enabled: false, reason: 'low-complexity data/content template' };
    }

    if (hasOnlyContentWrapper) {
      if (complexAiFirstPageCandidate && signals.sections.length >= 3) {
        return {
          enabled: true,
          reason:
            'complex homepage/page template keeps page-content inside section assembly',
        };
      }
      return {
        enabled: false,
        reason: 'page-content wrapper is simpler as full-file',
      };
    }

    if (defaultRichPageAssemblyCandidate) {
      return {
        enabled: true,
        reason:
          'page visual plan defaults to section assembly to isolate source-backed regions',
      };
    }

    if (listDrivenOnly) {
      return {
        enabled: false,
        reason: 'list-driven template is simpler as full-file',
      };
    }

    let score = 0;
    if (signals.sections.length >= 5) score += 3;
    else if (signals.sections.length >= 4) score += 2;
    else if (signals.sections.length >= 3) score += 1;

    if (signals.richSectionCount >= 3) score += 3;
    else if (signals.richSectionCount >= 2) score += 2;
    else if (signals.richSectionCount >= 1) score += 1;

    if (signals.interactiveSectionCount >= 1) score += 2;
    if (signals.mediaHeavySectionCount >= 2) score += 2;
    if (signals.distinctTypes.size >= 4) score += 2;
    else if (signals.distinctTypes.size >= 3) score += 1;
    if (signals.sourceBackedSectionCount >= 3) score += 1;
    if (componentPlan.route === '/') score += 1;
    if (componentPlan.fixedSlug) score += 1;
    if (normalizedNeeds.has('pageDetail') && !signals.hasPageContent)
      score += 1;
    const enabled = Boolean(
      score >= 5 ||
      (signals.sections.length >= 4 && signals.richSectionCount >= 2) ||
      isSingleWithSidebar ||
      isCanonicalSinglePostDetail,
    );
    const reason = [
      `score=${score}`,
      `rich=${signals.richSectionCount}`,
      `interactive=${signals.interactiveSectionCount}`,
      `media=${signals.mediaHeavySectionCount}`,
      `types=${signals.distinctTypes.size}`,
      `sourceBacked=${signals.sourceBackedSectionCount}`,
      `pageDetailRich=${richPageDetailCandidate ? 1 : 0}`,
      `single=${isCanonicalSinglePostDetail ? 1 : 0}`,
      `singleWithSidebar=${isSingleWithSidebar ? 1 : 0}`,
    ].join(', ');

    return { enabled, reason };
  }

  private shouldPreferDeterministicPlan(
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
    repoManifest?: RepoThemeManifest,
  ): boolean {
    if (!this.canUseDeterministicGeneration(componentPlan)) return false;
    if (
      componentPlan?.type === 'page' &&
      componentPlan.visualPlan?.renderAuthority === 'ai' &&
      componentPlan.visualPlan.renderMode === 'section-centric'
    ) {
      return false;
    }
    if (
      isProfolioFseAiLockedVisualPlanSurface({
        templateName: componentPlan?.templateName,
        componentName,
      })
    ) {
      return false;
    }
    if (
      shouldPreferSectionAssemblyForFrontPage({ componentPlan, componentName })
    ) {
      return false;
    }
    if (
      shouldPreferThemeSourceFaithfulDeterministicPage({
        componentPlan,
        componentName,
        repoManifest,
      })
    ) {
      return true;
    }
    if (
      componentPlan?.visualPlan?.sections.some(
        (section): section is Extract<SectionPlan, { type: 'accordion' }> =>
          section.type === 'accordion',
      )
    ) {
      return true;
    }
    if (
      componentPlan?.visualPlan?.sections.some(
        (section) =>
          section.type === 'post-list' && section.resource === 'products',
      )
    ) {
      return true;
    }
    const normalizedNeeds = new Set(
      toVisualDataNeeds(componentPlan?.dataNeeds),
    );
    const signals = this.getVisualPlanSectionSignals(componentPlan);
    if (
      this.isComplexAiFirstPageCandidate(
        componentPlan,
        componentName,
        signals,
        normalizedNeeds,
      )
    ) {
      return false;
    }
    if (
      shouldPreferDeterministicGenerationForRenderContract(
        componentPlan?.renderContract,
      )
    ) {
      return true;
    }
    if (!componentPlan?.visualPlan) return false;
    if (shouldProtectDeterministicStructureFromAi(componentPlan.visualPlan)) {
      return true;
    }
    return isHybridDetailPlanWithoutCanonicalBody({
      visualPlan: componentPlan.visualPlan,
      dataNeeds: componentPlan.dataNeeds,
      isDetail: componentPlan.isDetail,
    });
  }

  private isStrictDeterministicAuthority(
    componentPlan: ReviewInput['componentPlan'] | undefined,
  ): boolean {
    if (!this.canUseDeterministicGeneration(componentPlan)) return false;
    if (
      shouldPreferSectionAssemblyForFrontPage({
        componentPlan,
        componentName: componentPlan?.componentName ?? '',
      })
    ) {
      return false;
    }
    if (
      isProfolioFseAiLockedVisualPlanSurface({
        templateName: componentPlan?.templateName,
        componentName: componentPlan?.componentName,
      })
    ) {
      return false;
    }
    if (
      shouldForceStrictThemeSourceFaithfulDeterministicPage({
        componentPlan,
        componentName: componentPlan?.componentName ?? '',
      })
    ) {
      return true;
    }
    if (!componentPlan?.visualPlan) return false;
    return shouldBypassAiGenerationForVisualPlan(
      synchronizeVisualPlanContract(componentPlan.visualPlan, componentPlan),
    );
  }

  private canUseDeterministicGeneration(
    componentPlan:
      | ComponentPromptContext
      | ReviewInput['componentPlan']
      | undefined,
  ): boolean {
    return (
      componentPlan?.type === 'partial' ||
      isDeterministicFallbackEligibleForRenderContract(
        componentPlan?.renderContract,
      )
    );
  }

  private isComplexAiFirstPageCandidate(
    componentPlan:
      | ComponentPromptContext
      | ReviewInput['componentPlan']
      | undefined,
    componentName: string,
    signals?: ReturnType<CodeReviewerService['getVisualPlanSectionSignals']>,
    normalizedNeeds?: Set<string>,
  ): boolean {
    if (componentPlan?.type !== 'page' || !componentPlan.visualPlan)
      return false;
    if (componentPlan.visualPlan.renderMode === 'block-centric') return false;

    const planSignals =
      signals ?? this.getVisualPlanSectionSignals(componentPlan);
    const needs =
      normalizedNeeds ?? new Set(toVisualDataNeeds(componentPlan.dataNeeds));
    const templateName = componentPlan.templateName?.toLowerCase() ?? '';
    const blockTreeSignals = this.collectBlockTreeComplexitySignals(
      componentPlan.visualPlan.blockTree ?? [],
    );
    const homeLike =
      componentPlan.route === '/' ||
      ['front-page', 'frontend-page', 'home', 'index'].includes(templateName) ||
      /^(FrontPage|Home)$/i.test(componentName);
    const fixedPageLike =
      /^PagePage/i.test(componentName) ||
      templateName.startsWith('page-') ||
      (componentPlan.isDetail === true && needs.has('pageDetail'));
    const templateDrivenLanding =
      /^template-/.test(templateName) ||
      [
        'templateabout',
        'templatecontact',
        'templateservices',
        'templateportfolio',
        'templatelanding',
      ].includes(templateName.replace(/[^a-z]/g, '')) ||
      /^PagePage/i.test(componentName);
    const structurallyRich =
      planSignals.sections.length >= 4 ||
      planSignals.richSectionCount >= 2 ||
      planSignals.mediaHeavySectionCount >= 2 ||
      planSignals.distinctTypes.size >= 3 ||
      planSignals.sourceBackedSectionCount >= 3;
    const blockTreeRich =
      blockTreeSignals.nodeCount >= 14 ||
      blockTreeSignals.maxDepth >= 4 ||
      blockTreeSignals.wrapperNodeCount >= 6 ||
      blockTreeSignals.mediaNodeCount >= 4 ||
      blockTreeSignals.interactiveOrPluginNodeCount >= 1 ||
      blockTreeSignals.markerClassCount >= 2;
    const visuallySensitiveThemeStructure =
      blockTreeSignals.interactiveOrPluginNodeCount >= 1 ||
      blockTreeSignals.markerClassCount >= 2 ||
      blockTreeSignals.iconOrLogoAssetCount >= 3 ||
      (blockTreeSignals.mediaNodeCount >= 3 &&
        blockTreeSignals.wrapperNodeCount >= 4);
    const sourceCompressionRisk = Boolean(
      blockTreeSignals.sourceBackedNodeCount >= 10 &&
      planSignals.sections.length > 0 &&
      blockTreeSignals.sourceBackedNodeCount >= planSignals.sections.length * 3,
    );
    const complexityConfirmed =
      structurallyRich ||
      blockTreeRich ||
      visuallySensitiveThemeStructure ||
      sourceCompressionRisk;

    return (
      complexityConfirmed &&
      (homeLike || fixedPageLike || templateDrivenLanding) &&
      componentPlan.visualPlan.layout.sidebarScope !== 'all-content'
    );
  }

  private collectBlockTreeComplexitySignals(nodes: BlockNode[]): {
    nodeCount: number;
    maxDepth: number;
    sourceBackedNodeCount: number;
    wrapperNodeCount: number;
    mediaNodeCount: number;
    interactiveOrPluginNodeCount: number;
    markerClassCount: number;
    iconOrLogoAssetCount: number;
  } {
    const markerClasses = new Set<string>();
    let nodeCount = 0;
    let maxDepth = 0;
    let sourceBackedNodeCount = 0;
    let wrapperNodeCount = 0;
    let mediaNodeCount = 0;
    let interactiveOrPluginNodeCount = 0;
    let iconOrLogoAssetCount = 0;

    const visit = (entries: BlockNode[], depth: number) => {
      if (entries.length === 0) return;
      if (depth > maxDepth) maxDepth = depth;
      for (const node of entries) {
        nodeCount += 1;
        if (node.sourceRef?.sourceNodeId) sourceBackedNodeCount += 1;
        if (
          [
            'group',
            'columns',
            'column',
            'cover',
            'spacer',
            'separator',
          ].includes(node.kind)
        ) {
          wrapperNodeCount += 1;
        }
        if (
          [
            'image',
            'gallery',
            'media-text',
            'post-featured-image',
            'cover',
          ].includes(node.kind) ||
          typeof node.src === 'string'
        ) {
          mediaNodeCount += 1;
        }
        if (
          /^uagb\//i.test(node.blockName) ||
          ['accordion', 'carousel', 'modal', 'tabs', 'slider'].includes(
            node.kind,
          )
        ) {
          interactiveOrPluginNodeCount += 1;
        }
        if (
          typeof node.src === 'string' &&
          /(icon|logo|figma|wordpress|photoshop|illustrator|after-effects)/i.test(
            node.src,
          )
        ) {
          iconOrLogoAssetCount += 1;
        }
        for (const className of node.customClassNames ?? []) {
          if (
            /(uagb-|wow\b|animate__|is-style-|sticky-sidebar|r-pad|wp-block-cover__inner-container)/i.test(
              className,
            )
          ) {
            markerClasses.add(className);
          }
        }
        visit(node.children ?? [], depth + 1);
      }
    };

    visit(nodes, 1);
    return {
      nodeCount,
      maxDepth,
      sourceBackedNodeCount,
      wrapperNodeCount,
      mediaNodeCount,
      interactiveOrPluginNodeCount,
      markerClassCount: markerClasses.size,
      iconOrLogoAssetCount,
    };
  }

  private getVisualPlanSectionSignals(
    componentPlan: ComponentPromptContext | undefined,
  ): {
    sections: SectionPlan[];
    richSectionCount: number;
    interactiveSectionCount: number;
    mediaHeavySectionCount: number;
    sourceBackedSectionCount: number;
    distinctTypes: Set<string>;
    lowComplexityOnly: boolean;
    hasPageContent: boolean;
    hasPostContent: boolean;
  } {
    const sections = componentPlan?.visualPlan?.sections ?? [];
    return {
      sections,
      richSectionCount: sections.filter((section) =>
        RICH_VISUAL_SECTION_TYPES.has(section.type),
      ).length,
      interactiveSectionCount: sections.filter((section) =>
        INTERACTIVE_VISUAL_SECTION_TYPES.has(section.type),
      ).length,
      mediaHeavySectionCount: sections.filter((section) =>
        MEDIA_HEAVY_VISUAL_SECTION_TYPES.has(section.type),
      ).length,
      sourceBackedSectionCount: sections.filter(
        (section) => !!section.sourceRef?.sourceNodeId,
      ).length,
      distinctTypes: new Set(sections.map((section) => section.type)),
      lowComplexityOnly:
        sections.length > 0 &&
        sections.every((section) =>
          LOW_COMPLEXITY_VISUAL_SECTION_TYPES.has(section.type),
        ),
      hasPageContent: sections.some(
        (section) =>
          section.type === 'page-content' || section.type === 'prose-block',
      ),
      hasPostContent: sections.some(
        (section) => section.type === 'post-content',
      ),
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
    fullFilePolicy: FullFileGenerationPolicy;
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
      fullFilePolicy,
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
              repoManifest,
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
      code = this.postProcessFullFileCandidate(
        raw,
        componentName,
        fullFilePolicy,
        componentPlan,
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
          'Visual plan obligations violated',
        );
        const isLayoutContract = lastError?.includes(
          'Layout contract violated',
        );

        if (
          isNoJsx ||
          isPageContract ||
          isVisualPlanFidelity ||
          isLayoutContract
        ) {
          const reason = isNoJsx
            ? 'No JSX return found'
            : isPageContract
              ? 'Page detail contract violated'
              : isLayoutContract
                ? 'Layout contract violated'
                : 'Visual plan obligations violated';
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
                repoManifest,
              ),
              logPath,
              `${componentName}:${logLabel}:autofix`,
            );
            code = this.postProcessFullFileCandidate(
              fixedResult.code,
              componentName,
              fullFilePolicy,
              componentPlan,
            );

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
    fallbackSections: SectionPlan[] | undefined,
    validationContext: CodeValidationContext,
    logPath?: string,
    label = 'visual plan',
  ): Promise<{ code: string; isValid: boolean; error?: string }> {
    const resolvedVisualPlan = this.mergeDeterministicFallbackSections(
      visualPlan,
      fallbackSections,
    );
    const effectiveVisualPlan =
      synchronizeVisualPlanContract(resolvedVisualPlan, {
        dataNeeds: validationContext.dataNeeds,
        fixedSlug: validationContext.fixedSlug,
        route: validationContext.route,
        runtimeRenderer: validationContext.runtimeRenderer,
      }) ?? resolvedVisualPlan;
    let code = this.codeGenerator.generate(effectiveVisualPlan);
    const check = this.validator.checkCodeStructure(code, {
      ...validationContext,
      dataNeeds: validationContext.dataNeeds ?? effectiveVisualPlan.dataNeeds,
      allowedRelativeImports:
        validationContext.allowedRelativeImports ??
        effectiveVisualPlan.layout.includes,
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

  private mergeDeterministicFallbackSections(
    visualPlan: ComponentVisualPlan,
    fallbackSections: SectionPlan[] | undefined,
  ): ComponentVisualPlan {
    const safeFallbackSections = Array.isArray(fallbackSections)
      ? fallbackSections.filter(Boolean)
      : [];
    if (safeFallbackSections.length === 0) return visualPlan;

    const currentSections = Array.isArray(visualPlan.sections)
      ? visualPlan.sections.filter(Boolean)
      : [];
    if (currentSections.length === 0) {
      return {
        ...visualPlan,
        sections: safeFallbackSections,
      };
    }

    const sectionKeyFor = (section: SectionPlan): string =>
      [
        section.type,
        section.sectionKey ?? '',
        section.debugKey ?? '',
        section.sourceRef?.sourceNodeId ?? '',
      ].join('::');

    const existing = new Set(
      currentSections.map((section) => sectionKeyFor(section)),
    );
    const mergedSections = [...currentSections];
    for (const section of safeFallbackSections) {
      const key = sectionKeyFor(section);
      if (existing.has(key)) continue;
      mergedSections.push(section);
      existing.add(key);
    }

    if (mergedSections.length === currentSections.length) {
      return visualPlan;
    }

    return {
      ...visualPlan,
      sections: mergedSections,
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

    const userPrompt = `This component has a validation error or targeted edit request:\n${error}\n\n${FLAT_REST_SAFETY_RULE}\n\nFix it and return the complete corrected code. When exact target regions or capture instructions are included, modify those regions first while preserving unrelated code.\n\`\`\`tsx\n${brokenCode}\n\`\`\``;

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
    repoManifest?: RepoThemeManifest;
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

    const repoChainNote = buildComponentRepoChainNote(
      input.repoManifest,
      input.componentPlan,
    );
    if (repoChainNote) {
      lines.push('');
      lines.push(repoChainNote);
    }

    const spectraContractNote = buildSpectraContractPromptNote(
      input.repoManifest,
      input.componentPlan?.visualPlan,
    );
    if (spectraContractNote) {
      lines.push('');
      lines.push(spectraContractNote);
    }

    const approvedPlanChecklist = this.buildApprovedPlanRetryChecklist(
      input.componentPlan,
      input.lastError,
      input.componentName,
    );
    if (approvedPlanChecklist) {
      lines.push('');
      lines.push(approvedPlanChecklist);
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
    // Use a larger limit for fidelity errors so all lost fields are visible to the AI
    const limit =
      /visual plan obligations violated|surface-plan source evidence violated|lost media-text|lost card/i.test(
        compact,
      )
        ? 2000
        : 700;
    return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
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
    const fixedSlug = validationContext.fixedSlug?.trim();
    const normalizedDataNeeds = new Set(
      (validationContext.dataNeeds ?? []).map((need) =>
        need === 'page-detail'
          ? 'pageDetail'
          : need === 'post-detail'
            ? 'postDetail'
            : need === 'product-detail'
              ? 'productDetail'
              : need,
      ),
    );
    const instructions = [
      'Do not redesign or rewrite unrelated sections.',
      'Keep the existing approved route/data contract intact.',
    ];

    if (fixedSlug) {
      instructions.push(
        `This component is bound to the fixed slug \`${fixedSlug}\`; do not convert it back to a dynamic slug route.`,
      );
      instructions.push('Do not import or call `useParams()` in this file.');
      if (normalizedDataNeeds.has('pageDetail')) {
        instructions.push(
          `Fetch the main record only from \`/api/pages/${fixedSlug}\`, not \`/api/pages/\${slug}\` and not \`/api/pages\` + lookup.`,
        );
      }
      if (normalizedDataNeeds.has('postDetail')) {
        instructions.push(
          `Fetch the main record only from \`/api/posts/${fixedSlug}\`, not \`/api/posts/\${slug}\` and not \`/api/posts\` + lookup.`,
        );
      }
      if (normalizedDataNeeds.has('productDetail')) {
        instructions.push(
          `Fetch the main record only from \`/api/post-types/product/${fixedSlug}\`, not \`/api/post-types/product/\${slug}\` and not \`/api/post-types/product/posts\` + lookup.`,
        );
      }
    }

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
    if (/footerlinks|footer-links|\/api\/footer-links/.test(compact)) {
      instructions.push(
        'If this is a Footer component, fetch `/api/footer-links` and render those columns directly; do not fall back to `/api/menus`.',
      );
      instructions.push(
        'Do not create fallback per-column arrays or helper functions that synthesize About/Privacy/Social links. Iterate the fetched footer-links data directly.',
      );
      instructions.push(
        'For footer brand copy, prefer `siteInfo.blogDescription` when the footer is showing the site tagline. Do not invent alternate About/Privacy/Social-style copy.',
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
      /section boundaries can collapse|merge incorrectly|obligation ".*" is missing required capability/.test(
        compact,
      )
    ) {
      instructions.push(
        'Restore a dedicated semantic region for every approved section so distinct source-backed content does not collapse into one shared wrapper.',
      );
      instructions.push(
        'Do not merge two approved sections into one shared hero/grid wrapper. If text and image belong to different approved sections, render them in separate wrappers in the original order.',
      );
    }

    if (
      /visual plan obligations violated|required capability|lost hero heading|lost hero subheading|lost post-list title/.test(
        compact,
      )
    ) {
      instructions.push(
        'Restore every missing visual-plan section from the approved plan. If section 2 is missing, add it back as a separate top-level JSX wrapper instead of expanding section 1.',
      );
      instructions.push(
        'If the approved plan includes a hero heading/subheading or post-list title, render that approved content exactly or keep the approved dynamic binding intact; do not drop it.',
      );

      // Extract pinpoint lost values from the error message and add them as explicit fix hints
      const lostFieldLines = (error ?? '')
        .split('\n')
        .filter((line) => /lost (media-text|card|card-grid|hero)/i.test(line));
      if (lostFieldLines.length > 0) {
        instructions.push(
          'The following specific content fields were detected as missing — you MUST render each one as a literal string in the JSX:',
        );
        for (const line of lostFieldLines.slice(0, 20)) {
          instructions.push(`  • ${line.trim()}`);
        }
        instructions.push(
          'Do NOT omit, truncate, or replace these with placeholders. Hardcode the exact value from the approved visual plan.',
        );
      }
    }

    if (
      /search wrapper|source search block|role=["']search["']|search-input/.test(
        compact,
      )
    ) {
      instructions.push(
        'Restore a real semantic search shell in the failing section: render `<form role="search">` instead of a generic wrapper.',
      );
      instructions.push(
        'Inside that form, keep a real `<input type="search" ... />` and a submit button. Do not replace the search block with comments, author bio, promo copy, or unrelated filters.',
      );
      instructions.push(
        'If the approved section only requires `search-input`, keep it as a search widget only; render search results elsewhere only when a separate approved post-list/results section exists.',
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
        'Visible text links for post titles, author/category archive links inside meta rows, footer/sidebar lists, breadcrumbs, and social/footer text links must include hover underline styling such as `hover:underline underline-offset-4`. Header `.wp-block-navigation` links are exempt when source CSS provides the hover underline.',
      );
      instructions.push(
        'Keep CTA buttons as buttons. Keep header navigation links opacity 100 without `hover:opacity-*`; source theme CSS should provide the white underline hover state.',
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
    const frame = this.codeGenerator.generateSectionAssemblyFrame({
      ...componentPlan.visualPlan,
      runtimeRenderer: componentPlan.runtimeRenderer,
    });
    const availableVariables = this.buildSectionAssemblyAvailableVariables(
      this.frameGenerator.describeVariables({
        type: componentPlan.type ?? 'page',
        dataNeeds: componentPlan.dataNeeds ?? [],
        isDetail: componentPlan.isDetail ?? false,
        fixedSlug: componentPlan.fixedSlug,
      }),
      sections,
    );
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

    let code = this.postProcessCode(
      this.codeGenerator.assembleSectionedComponent(frame, assembledSections),
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
        const narrowedError = this.buildTargetedSectionRetryError({
          error: check.error,
          section,
          sectionNumber: index + 1,
        });
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

      code = this.postProcessCode(
        this.codeGenerator.assembleSectionedComponent(frame, assembledSections),
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

    // ── R3-assembly: Self-fix pass for assembled file violations ─────────────
    const assemblyError = lastError ?? check.error;
    await this.log(
      logPath,
      `[reviewer:assembly-fix] "${componentName}" attempting self-repair: ${assemblyError}`,
    );
    try {
      const fixResult = await this.selfFixDetailed(
        modelName,
        code,
        this.buildAutoFixErrorContext(
          'Section assembly validation failure',
          assemblyError,
          componentPlan,
          componentName,
          repoManifest,
        ),
        logPath,
        componentName,
      );
      const fixedCode = fixResult.code;
      const fixCheck = this.validator.checkCodeStructure(
        fixedCode,
        validationContext,
      );
      const resolvedCode = fixCheck.fixedCode ?? fixedCode;
      if (fixCheck.isValid) {
        this.logger.log(
          `[reviewer:assembly-fix] "${componentName}" ✓ self-repair resolved assembly violation`,
        );
        await this.log(
          logPath,
          `[reviewer:assembly-fix] "${componentName}" ✓ self-repair resolved assembly violation`,
        );
        return {
          code: resolvedCode,
          isValid: true,
          attemptsUsed,
          lastRawOutput,
          cotAttempts,
        };
      }
      this.logger.warn(
        `[reviewer:assembly-fix] "${componentName}" self-repair still invalid: ${fixCheck.error}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer:assembly-fix] "${componentName}" self-repair still invalid: ${fixCheck.error}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `[reviewer:assembly-fix] "${componentName}" self-repair call failed: ${err?.message}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer:assembly-fix] "${componentName}" self-repair call failed: ${err?.message}`,
      );
    }

    this.logger.warn(
      `[reviewer] "${componentName}" section-level one-file assembly produced invalid final file: ${assemblyError}`,
    );
    await this.log(
      logPath,
      `WARN [reviewer] "${componentName}" section-level one-file assembly produced invalid final file: ${assemblyError}`,
    );

    return {
      code,
      isValid: false,
      attemptsUsed,
      lastError: assemblyError,
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

    if (
      componentPlan?.visualPlan &&
      DETERMINISTIC_SECTION_ASSEMBLY_TYPES.has(section.type)
    ) {
      this.logger.log(
        `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) using deterministic collection renderer`,
      );
      await this.log(
        logPath,
        `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) using deterministic collection renderer`,
      );
      try {
        const deterministicCode = this.normalizeInlineSectionOutput(
          this.postProcessCode(
            this.codeGenerator.generateDeterministicInlineSection(
              {
                ...componentPlan.visualPlan,
                runtimeRenderer: componentPlan.runtimeRenderer,
              },
              sectionIndex,
            ),
          ),
        );
        const stableDeterministicCode = this.ensureInlineSectionSingleWrapper(
          deterministicCode,
          section,
        );
        const basicError = this.validateInlineSectionOutput(
          stableDeterministicCode,
        );
        const syntaxError = basicError
          ? undefined
          : this.validator.checkInlineSectionSyntax(stableDeterministicCode);
        const fidelityError =
          basicError || syntaxError
            ? undefined
            : this.validator.checkInlineSectionFidelity(
                stableDeterministicCode,
                section,
                componentName,
                sectionIndex + 1,
              );
        const deterministicError =
          basicError ?? syntaxError ?? fidelityError ?? undefined;
        if (!deterministicError) {
          this.logger.log(
            `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) accepted via deterministic collection renderer`,
          );
          await this.log(
            logPath,
            `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) accepted via deterministic collection renderer`,
          );
          return {
            code: stableDeterministicCode,
            isValid: true,
            attemptsUsed: 0,
            lastRawOutput: stableDeterministicCode,
            cotAttempts: [],
          };
        }
        this.logger.warn(
          `[reviewer] "${componentName}" section-level (${phaseLabel}): deterministic collection renderer failed for section ${sectionIndex + 1}/${totalSections} (${section.type}): ${deterministicError}`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" section-level (${phaseLabel}) deterministic collection renderer failed for section ${sectionIndex + 1}/${totalSections} (${section.type}): ${deterministicError} — retrying with AI section generation`,
        );
        sectionError = [sectionError, deterministicError]
          .filter(Boolean)
          .join('\n\n');
      } catch (err: any) {
        const deterministicError =
          err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[reviewer] "${componentName}" section-level (${phaseLabel}): deterministic collection renderer crashed for section ${sectionIndex + 1}/${totalSections} (${section.type}): ${deterministicError}`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" section-level (${phaseLabel}) deterministic collection renderer crashed for section ${sectionIndex + 1}/${totalSections} (${section.type}): ${deterministicError} — retrying with AI section generation`,
        );
        sectionError = [sectionError, deterministicError]
          .filter(Boolean)
          .join('\n\n');
      }
    }

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
      sectionCode = this.normalizeInlineSectionOutput(
        this.postProcessCode(raw),
      );
      const basicError = this.validateInlineSectionOutput(sectionCode);
      const syntaxError = basicError
        ? undefined
        : this.validator.checkInlineSectionSyntax(sectionCode);
      const fidelityError =
        basicError || syntaxError
          ? undefined
          : this.validator.checkInlineSectionFidelity(
              sectionCode,
              section,
              componentName,
              sectionIndex + 1,
            );
      const attemptError =
        basicError ?? syntaxError ?? fidelityError ?? undefined;
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
        success: !attemptError,
        error: attemptError,
        validationFeedback: attemptError
          ? undefined
          : `section ${sectionIndex + 1} inline assembly candidate accepted`,
      });
      if (!attemptError) {
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
      sectionError = attemptError;
      this.logger.warn(
        `[reviewer] "${componentName}" section-level (${phaseLabel}): section ${sectionIndex + 1}/${totalSections} (${section.type}) attempt ${attempt}/${maxAttempts} failed: ${attemptError}`,
      );
      await this.log(
        logPath,
        `WARN [reviewer] "${componentName}" section-level (${phaseLabel}) section ${sectionIndex + 1}/${totalSections} attempt ${attempt}/${maxAttempts} failed: ${attemptError}${this.formatRawOutput(raw)}`,
      );
    }

    // ── Self-fix pass: AI repair for section that exhausted normal attempts ──
    if (sectionError && sectionCode) {
      await this.log(
        logPath,
        `[reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} (${section.type}) attempting self-repair: ${sectionError}`,
      );
      try {
        const fixResult = await this.selfFixDetailed(
          modelName,
          sectionCode,
          this.buildAutoFixErrorContext(
            `Section ${sectionIndex + 1}/${totalSections} validation failure`,
            sectionError,
            componentPlan,
            componentName,
            repoManifest,
          ),
          logPath,
          `${componentName}:section-${sectionIndex + 1}`,
        );
        const fixedCode = this.normalizeInlineSectionOutput(
          this.postProcessCode(fixResult.code),
        );
        const fixBasicError = this.validateInlineSectionOutput(fixedCode);
        const fixSyntaxError = fixBasicError
          ? undefined
          : this.validator.checkInlineSectionSyntax(fixedCode);
        const fixFidelityError =
          fixBasicError || fixSyntaxError
            ? undefined
            : this.validator.checkInlineSectionFidelity(
                fixedCode,
                section,
                componentName,
                sectionIndex + 1,
              );
        const fixError =
          fixBasicError ?? fixSyntaxError ?? fixFidelityError ?? undefined;
        if (!fixError) {
          this.logger.log(
            `[reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} ✓ self-repair resolved`,
          );
          await this.log(
            logPath,
            `[reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} ✓ self-repair resolved`,
          );
          return {
            code: fixedCode,
            isValid: true,
            attemptsUsed: maxAttempts + 1,
            lastRawOutput: fixResult.rawResponse,
            cotAttempts,
          };
        }
        this.logger.warn(
          `[reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} self-repair still invalid: ${fixError}`,
        );
        await this.log(
          logPath,
          `WARN [reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} self-repair still invalid: ${fixError}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `[reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} self-repair call failed: ${err?.message}`,
        );
        await this.log(
          logPath,
          `WARN [reviewer:section-fix] "${componentName}" section ${sectionIndex + 1}/${totalSections} self-repair call failed: ${err?.message}`,
        );
      }
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
    if (
      !error ||
      !/Visual plan obligations violated|Visual section contracts violated/i.test(
        error,
      )
    ) {
      return [];
    }
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
    return ['Visual plan obligations violated:', ...filtered].join('\n');
  }

  private buildSectionAssemblyAvailableVariables(
    baseVariables: string,
    sections: ComponentVisualPlan['sections'],
  ): string {
    const extras: string[] = [];

    if (sections.some((section) => section.type === 'carousel')) {
      extras.push('`activeCarousels: Record<string, number>`');
      extras.push(
        '`setActiveCarousels: React.Dispatch<React.SetStateAction<Record<string, number>>>`',
      );
    }

    if (sections.some((section) => section.type === 'tabs')) {
      extras.push('`activeTabs: Record<string, number>`');
      extras.push(
        '`setActiveTabs: React.Dispatch<React.SetStateAction<Record<string, number>>>`',
      );
    }

    if (sections.some((section) => section.type === 'accordion')) {
      extras.push('`openAccordions: Record<string, number[]>`');
      extras.push(
        '`setOpenAccordions: React.Dispatch<React.SetStateAction<Record<string, number[]>>>`',
      );
    }

    if (sections.some((section) => section.type === 'modal')) {
      extras.push('`openModals: Record<string, boolean>`');
      extras.push(
        '`setOpenModals: React.Dispatch<React.SetStateAction<Record<string, boolean>>>`',
      );
    }

    if (extras.length === 0) {
      return baseVariables;
    }

    if (!baseVariables || baseVariables === '(no data variables)') {
      return extras.join(', ');
    }

    return `${baseVariables}, ${extras.join(', ')}`;
  }

  private buildTargetedSectionRetryError(input: {
    error: string | undefined;
    section: ComponentVisualPlan['sections'][number];
    sectionNumber: number;
  }): string | undefined {
    const baseError = this.extractSectionSpecificError(
      input.error,
      input.sectionNumber,
    );
    const requiredContent = this.buildSectionRequiredContentChecklist(
      input.section,
    );
    const lines = [
      baseError?.trim(),
      '## TARGETED SECTION RETRY',
      `You are regenerating only section ${input.sectionNumber} (${input.section.type}).`,
      'Preserve every approved content field for this section exactly; do not summarize, collapse, or omit any repeated item.',
      requiredContent,
    ].filter(Boolean);
    return lines.join('\n\n');
  }

  private buildSectionRequiredContentChecklist(
    section: ComponentVisualPlan['sections'][number],
  ): string {
    const lines: string[] = ['## REQUIRED CONTENT CHECKLIST'];
    const stateKey = this.resolveInteractiveSectionStateKey(section);

    switch (section.type) {
      case 'prose-block':
        lines.push(
          `- Render exactly ${section.sourceSegments.length} source segment(s) in order. Do not merge, summarize, or drop segments.`,
        );
        section.sourceSegments.forEach((segment, segmentIndex) => {
          const prefix = `- Segment ${segmentIndex + 1}`;
          switch (segment.type) {
            case 'heading':
              lines.push(`${prefix} heading: ${JSON.stringify(segment.text)}`);
              break;
            case 'paragraph':
              lines.push(
                `${prefix} paragraph: ${JSON.stringify(segment.text ?? segment.html)}`,
              );
              break;
            case 'image':
              lines.push(`${prefix} image src: ${JSON.stringify(segment.src)}`);
              break;
            case 'list':
              lines.push(
                `${prefix} list items: ${segment.items.map((item) => JSON.stringify(item)).join(', ')}`,
              );
              break;
            case 'html':
              lines.push(`${prefix} html: ${JSON.stringify(segment.html)}`);
              break;
          }
        });
        break;
      case 'card-grid':
        if (section.title) {
          lines.push(`- Keep title exactly: ${JSON.stringify(section.title)}`);
        }
        if (section.subtitle) {
          lines.push(
            `- Keep subtitle exactly: ${JSON.stringify(section.subtitle)}`,
          );
        }
        lines.push(
          `- Render exactly ${section.cards.length} card(s). Do not merge or drop cards.`,
        );
        section.cards.forEach((card, cardIndex) => {
          lines.push(
            `- Card ${cardIndex + 1} heading: ${JSON.stringify(card.heading)}`,
          );
          lines.push(
            `- Card ${cardIndex + 1} body: ${JSON.stringify(card.body)}`,
          );
          if (card.imageSrc) {
            lines.push(
              `- Card ${cardIndex + 1} image src (use exactly, do not omit): ${JSON.stringify(card.imageSrc)}`,
            );
          }
        });
        break;
      case 'accordion':
        if (section.title) {
          lines.push(`- Keep title exactly: ${JSON.stringify(section.title)}`);
        }
        if (typeof section.allowMultiple === 'boolean') {
          lines.push(
            `- Preserve allowMultiple exactly: ${section.allowMultiple}.`,
          );
        }
        if (typeof section.enableToggle === 'boolean') {
          lines.push(
            `- Preserve enableToggle exactly: ${section.enableToggle}.`,
          );
        }
        if (section.defaultOpenItems?.length) {
          lines.push(
            `- Preserve defaultOpenItems exactly: ${JSON.stringify(section.defaultOpenItems)}.`,
          );
        }
        if (section.variant) {
          lines.push(
            `- Preserve accordion variant/layout exactly: ${JSON.stringify(section.variant)}.`,
          );
        }
        lines.push(
          `- Render exactly ${section.items.length} accordion item(s).`,
        );
        section.items.forEach((item, itemIndex) => {
          lines.push(
            `- Item ${itemIndex + 1} heading: ${JSON.stringify(item.heading)}`,
          );
          lines.push(
            `- Item ${itemIndex + 1} body: ${JSON.stringify(item.body)}`,
          );
        });
        break;
      case 'tabs':
        if (section.title) {
          lines.push(`- Keep title exactly: ${JSON.stringify(section.title)}`);
        }
        if (typeof section.activeTab === 'number') {
          lines.push(`- Preserve activeTab exactly: ${section.activeTab}.`);
        }
        if (section.variant) {
          lines.push(
            `- Preserve tabs variant exactly: ${JSON.stringify(section.variant)}. Do not redesign it into a different tabs family.`,
          );
        }
        if (section.tabAlign) {
          lines.push(
            `- Preserve tab alignment exactly: ${JSON.stringify(section.tabAlign)}.`,
          );
        }
        lines.push(`- Render exactly ${section.tabs.length} tab(s).`);
        section.tabs.forEach((tab, tabIndex) => {
          lines.push(
            `- Tab ${tabIndex + 1} label: ${JSON.stringify(tab.label)}`,
          );
          if (tab.heading) {
            lines.push(
              `- Tab ${tabIndex + 1} heading: ${JSON.stringify(tab.heading)}`,
            );
          }
          if (tab.body) {
            lines.push(
              `- Tab ${tabIndex + 1} body: ${JSON.stringify(tab.body)}`,
            );
          }
          if (tab.imageSrc) {
            lines.push(
              `- Tab ${tabIndex + 1} image src: ${JSON.stringify(tab.imageSrc)}`,
            );
          }
          if (tab.cta?.text) {
            lines.push(
              `- Tab ${tabIndex + 1} CTA text: ${JSON.stringify(tab.cta.text)}`,
            );
          }
        });
        lines.push(
          '- Keep the Spectra tabs structure markers such as `uagb-tabs__wrap`, `uagb-tabs__panel`, `uagb-tab`, and `uagb-tabs__body-wrap` when they are already part of the approved implementation path.',
        );
        break;
      case 'carousel':
        if (stateKey) {
          lines.push(
            `- Use the exact approved carousel state key ${JSON.stringify(stateKey)} everywhere in this section. Do not mix it with any other key.`,
          );
        }
        lines.push(`- Render exactly ${section.slides.length} slide(s).`);
        if (typeof section.autoplay === 'boolean') {
          lines.push(`- Preserve autoplay exactly: ${section.autoplay}.`);
        }
        if (typeof section.autoplaySpeed === 'number') {
          lines.push(
            `- Preserve autoplaySpeed exactly: ${section.autoplaySpeed}.`,
          );
        }
        if (typeof section.loop === 'boolean') {
          lines.push(`- Preserve loop exactly: ${section.loop}.`);
        }
        if (section.effect) {
          lines.push(
            `- Preserve effect exactly: ${JSON.stringify(section.effect)}.`,
          );
        }
        if (typeof section.showDots === 'boolean') {
          lines.push(`- Preserve showDots exactly: ${section.showDots}.`);
        }
        if (typeof section.showArrows === 'boolean') {
          lines.push(`- Preserve showArrows exactly: ${section.showArrows}.`);
        }
        if (typeof section.vertical === 'boolean') {
          lines.push(`- Preserve vertical exactly: ${section.vertical}.`);
        }
        if (typeof section.transitionSpeed === 'number') {
          lines.push(
            `- Preserve transitionSpeed exactly: ${section.transitionSpeed}.`,
          );
        }
        if (section.pauseOn) {
          lines.push(
            `- Preserve pauseOn exactly: ${JSON.stringify(section.pauseOn)}.`,
          );
        }
        section.slides.forEach((slide, slideIndex) => {
          if (slide.heading) {
            lines.push(
              `- Slide ${slideIndex + 1} heading: ${JSON.stringify(slide.heading)}`,
            );
          }
          if (slide.subheading) {
            lines.push(
              `- Slide ${slideIndex + 1} subheading: ${JSON.stringify(slide.subheading)}`,
            );
          }
          if (slide.imageSrc) {
            lines.push(
              `- Slide ${slideIndex + 1} image src: ${JSON.stringify(slide.imageSrc)}`,
            );
          }
          if (slide.cta?.text) {
            lines.push(
              `- Slide ${slideIndex + 1} CTA text: ${JSON.stringify(slide.cta.text)}`,
            );
          }
        });
        lines.push(
          '- If the section renders `.swiper-wrapper`, bind its inline transform to `activeCarousels[...]` so only the active slide is shown.',
        );
        lines.push(
          '- Keep the Spectra slider hierarchy `uagb-slider-container > uagb-swiper > swiper-wrapper > swiper-slide`; do not collapse it into a generic carousel shell.',
        );
        lines.push(
          '- Prev/next controls must use `swiper-button-prev` and `swiper-button-next` and each button must contain a visible SVG or text child.',
        );
        lines.push(
          '- If dots are rendered, keep the `swiper-pagination` wrapper with clickable bullets that update `setActiveCarousels(...)`.',
        );
        lines.push(
          '- Dots and arrow buttons must update `setActiveCarousels(...)`; do not leave carousel controls decorative only.',
        );
        break;
      case 'modal':
        if (stateKey) {
          lines.push(
            `- Use the exact approved modal state key ${JSON.stringify(stateKey)} everywhere in this section. Do not reuse any carousel or other section key.`,
          );
        }
        if (section.triggerText) {
          lines.push(
            `- Keep trigger text exactly: ${JSON.stringify(section.triggerText)}`,
          );
        }
        if (section.heading) {
          lines.push(
            `- Keep heading exactly: ${JSON.stringify(section.heading)}`,
          );
        }
        if (section.body) {
          lines.push(`- Keep body exactly: ${JSON.stringify(section.body)}`);
        }
        if (section.imageSrc) {
          lines.push(
            `- Keep image src exactly: ${JSON.stringify(section.imageSrc)}`,
          );
        }
        if (section.cta?.text) {
          lines.push(
            `- Keep CTA text exactly: ${JSON.stringify(section.cta.text)}`,
          );
        }
        if (section.ctas?.length) {
          section.ctas.slice(1).forEach((cta, ctaIndex) => {
            if (cta.text) {
              lines.push(
                `- Keep CTA ${ctaIndex + 2} text exactly: ${JSON.stringify(cta.text)}`,
              );
            }
          });
        }
        if (section.width) {
          lines.push(`- Preserve modal width exactly: ${section.width}.`);
        }
        if (section.height) {
          lines.push(`- Preserve modal height exactly: ${section.height}.`);
        }
        if (section.overlayColor) {
          lines.push(
            `- Preserve overlayColor exactly: ${JSON.stringify(section.overlayColor)}.`,
          );
        }
        lines.push(
          '- Wrap the trigger button in `uagb-spectra-button-wrapper` and keep the trigger button class `uagb-modal-trigger uagb-modal-button-link`.',
        );
        lines.push(
          '- The trigger must remain visibly rendered in normal document flow before the popup opens. Do not hide it with `hidden`, `sr-only`, `invisible`, `opacity-0`, `display:none`, zero-sized wrappers, or by moving the label text off-screen.',
        );
        lines.push(
          '- Keep the open popup hierarchy `uagb-modal-popup active > uagb-modal-popup-wrap > uagb-modal-popup-content` and include `uagb-modal-popup-close` for the close button.',
        );
        lines.push(
          '- Render a trigger button with class `uagb-modal-trigger` and `uagb-modal-button-link`.',
        );
        lines.push(
          '- Render the popup conditionally with `openModals[...] ? (...) : null`; do not inline the popup content.',
        );
        lines.push(
          '- The rendered open popup overlay must include the `active` class together with `uagb-modal-popup`; Spectra compat CSS keeps `.uagb-modal-popup` hidden until `.active` is present.',
        );
        lines.push(
          '- Use `setOpenModals` to open and close the popup; do not introduce local hooks inside the section JSX.',
        );
        if (!section.overlayColor) {
          lines.push(
            '- No source-backed overlayColor was approved for this modal. Use a soft translucent backdrop, not an opaque or near-black fullscreen overlay.',
          );
        }
        break;
      case 'media-text':
        if (section.background) {
          lines.push(
            `- Preserve section background exactly: ${JSON.stringify(section.background)}.`,
          );
        }
        if (section.textColor) {
          lines.push(
            `- Preserve section textColor exactly: ${JSON.stringify(section.textColor)}.`,
          );
        }
        if (section.imageSrc) {
          lines.push(
            `- Keep image src exactly: ${JSON.stringify(section.imageSrc)}`,
          );
        }
        if (section.subtitle) {
          lines.push(
            `- Keep subtitle exactly: ${JSON.stringify(section.subtitle)}`,
          );
        }
        if (section.heading) {
          lines.push(
            `- Keep heading exactly: ${JSON.stringify(section.heading)}`,
          );
        }
        if (section.body) {
          lines.push(`- Keep body exactly: ${JSON.stringify(section.body)}`);
        }
        if (section.listItems?.length) {
          lines.push(
            `- Keep ${section.listItems.length} list item(s): ${section.listItems
              .map((item) => JSON.stringify(item))
              .join(', ')}`,
          );
          if (section.listItems.some((item) => /<[^>]+>/.test(item))) {
            lines.push(
              '- Some list items contain inline HTML markup such as `<strong>`. Preserve that markup in the rendered `<li>` instead of stripping or flattening it.',
            );
          }
        }
        if (section.cta?.text) {
          lines.push(
            `- Keep CTA text exactly: ${JSON.stringify(section.cta.text)}`,
          );
        }
        if (section.ctas?.length) {
          section.ctas.slice(1).forEach((cta, ctaIndex) => {
            if (!cta.text) return;
            lines.push(
              `- Keep CTA ${ctaIndex + 2} text exactly: ${JSON.stringify(cta.text)}`,
            );
          });
        }
        break;
      case 'hero':
        if (
          'image' in section &&
          (section as { image?: { src?: string } }).image?.src
        ) {
          lines.push(
            `- Keep image src exactly (do not omit): ${JSON.stringify((section as { image: { src: string } }).image.src)}`,
          );
        }
        if ('heading' in section && section.heading) {
          lines.push(
            `- Keep heading exactly: ${JSON.stringify(section.heading)}`,
          );
        }
        if ('subheading' in section && section.subheading) {
          lines.push(
            `- Keep subheading exactly: ${JSON.stringify(section.subheading)}`,
          );
        }
        if ('cta' in section && section.cta?.text) {
          lines.push(
            `- Keep CTA text exactly: ${JSON.stringify(section.cta.text)}`,
          );
        }
        if ('ctas' in section && Array.isArray(section.ctas)) {
          section.ctas.slice(1).forEach((cta, ctaIndex) => {
            if (!cta.text) return;
            lines.push(
              `- Keep CTA ${ctaIndex + 2} text exactly: ${JSON.stringify(cta.text)}`,
            );
          });
        }
        break;
      case 'cover':
        if ('imageSrc' in section && section.imageSrc) {
          lines.push(
            `- Keep image src exactly (do not omit): ${JSON.stringify(section.imageSrc)}`,
          );
        }
        if ('heading' in section && section.heading) {
          lines.push(
            `- Keep heading exactly: ${JSON.stringify(section.heading)}`,
          );
        }
        if ('subheading' in section && section.subheading) {
          lines.push(
            `- Keep subheading exactly: ${JSON.stringify(section.subheading)}`,
          );
        }
        if ('cta' in section && section.cta?.text) {
          lines.push(
            `- Keep CTA text exactly: ${JSON.stringify(section.cta.text)}`,
          );
        }
        if ('ctas' in section && Array.isArray(section.ctas)) {
          section.ctas.slice(1).forEach((cta, ctaIndex) => {
            if (!cta.text) return;
            lines.push(
              `- Keep CTA ${ctaIndex + 2} text exactly: ${JSON.stringify(cta.text)}`,
            );
          });
        }
        break;
      case 'cta-strip':
        if (section.align) {
          lines.push(
            `- Keep alignment exactly: ${JSON.stringify(section.align)}`,
          );
        }
        if (section.cta?.text) {
          lines.push(
            `- Keep CTA text exactly: ${JSON.stringify(section.cta.text)}`,
          );
        }
        if (section.ctas?.length) {
          section.ctas.slice(1).forEach((cta, ctaIndex) => {
            if (!cta.text) return;
            lines.push(
              `- Keep CTA ${ctaIndex + 2} text exactly: ${JSON.stringify(cta.text)}`,
            );
          });
        }
        break;
      case 'testimonial':
        lines.push(`- Keep quote exactly: ${JSON.stringify(section.quote)}`);
        lines.push(
          `- Keep author name exactly: ${JSON.stringify(section.authorName)}`,
        );
        if (section.authorTitle) {
          lines.push(
            `- Keep author title exactly: ${JSON.stringify(section.authorTitle)}`,
          );
        }
        if (section.authorAvatar) {
          lines.push(
            `- Keep author avatar src exactly (do not omit): ${JSON.stringify(section.authorAvatar)}`,
          );
        }
        break;
      case 'newsletter':
        lines.push(
          `- Keep heading exactly: ${JSON.stringify(section.heading)}`,
        );
        if (section.subheading) {
          lines.push(
            `- Keep subheading exactly: ${JSON.stringify(section.subheading)}`,
          );
        }
        lines.push(
          `- Keep button text exactly: ${JSON.stringify(section.buttonText)}`,
        );
        break;
      case 'post-list':
        if (section.title) {
          lines.push(`- Keep title exactly: ${JSON.stringify(section.title)}`);
        }
        break;
      default:
        lines.push(
          '- Preserve every approved heading, body, CTA, image, and repeated child item from the approved section JSON.',
        );
        break;
    }

    lines.push(
      '- If any checklist item is missing in your JSX, the retry will fail again.',
    );
    return lines.join('\n');
  }

  private validateInlineSectionOutput(code: string): string | undefined {
    const trimmed = this.normalizeInlineSectionOutput(code);
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
    if (!this.hasSingleTopLevelJsxWrapper(trimmed)) {
      return 'Inline section output must be a single top-level JSX wrapper';
    }
    return undefined;
  }

  private hasSingleTopLevelJsxWrapper(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed.startsWith('<')) return false;
    const firstNodeEnd = this.findFirstTopLevelJsxNodeEnd(trimmed);
    if (firstNodeEnd == null) return false;
    return trimmed.slice(firstNodeEnd).trim().length === 0;
  }

  private normalizeInlineSectionOutput(code: string): string {
    let result = code
      .trim()
      .replace(/^(?:\s*\{\/\*[\s\S]*?\*\/\}\s*)+/, '')
      .trim();

    const unwrap = (value: string): string => {
      const trimmed = value.trim().replace(/;+\s*$/, '');

      const returnWrappedMatch = trimmed.match(
        /^return\s*\(\s*([\s\S]*?)\s*\)\s*;?$/i,
      );
      if (returnWrappedMatch) {
        return returnWrappedMatch[1]?.trim() ?? trimmed;
      }

      const returnDirectMatch = trimmed.match(/^return\s+([\s\S]*?)\s*;?$/i);
      if (returnDirectMatch && /^<[\s\S]+>$/.test(returnDirectMatch[1] ?? '')) {
        return returnDirectMatch[1]?.trim() ?? trimmed;
      }

      const wrappedJsxMatch = trimmed.match(/^\(\s*(<[\s\S]+>)\s*\)\s*;?$/);
      if (wrappedJsxMatch) {
        return wrappedJsxMatch[1]?.trim() ?? trimmed;
      }

      return trimmed;
    };

    let previous = '';
    while (result !== previous) {
      previous = result;
      result = unwrap(result);
    }

    const firstJsxIndex = this.findFirstLikelyJsxStart(result);
    if (firstJsxIndex > 0) {
      const prelude = result.slice(0, firstJsxIndex).trim();
      if (
        prelude &&
        /^(?:const|let|var|function|type|interface)\b/m.test(prelude)
      ) {
        result = result.slice(firstJsxIndex).trim();
      }
    }

    const trimmed = result.trim();
    if (
      trimmed &&
      (this.shouldWrapInlineSectionInFragment(trimmed) ||
        !/^<[\s\S]+>$/.test(trimmed)) &&
      !/^\s*(?:import\b|export\b)/m.test(trimmed) &&
      !/\buseEffect\s*\(|\buseState\s*\(|function\s+[A-Z]/.test(trimmed) &&
      /^(?:\{[\s\S]+\}|<[\s\S]+>)/.test(trimmed)
    ) {
      return `<>${trimmed}</>`;
    }

    return result.trim();
  }

  private ensureInlineSectionSingleWrapper(
    code: string,
    section: SectionPlan,
  ): string {
    const trimmed = code.trim();
    if (!trimmed) return trimmed;
    if (section.type === 'sidebar' && trimmed.startsWith('<>')) {
      const inner = trimmed.replace(/^<>\s*/, '').replace(/\s*<\/>$/, '');
      return `<section className="vp-inline-section vp-inline-section-sidebar" data-inline-section="sidebar">\n${inner}\n</section>`;
    }
    if (this.hasSingleTopLevelJsxWrapper(trimmed)) return trimmed;
    if (/^\s*(?:import\b|export\b)/m.test(trimmed)) return trimmed;
    if (/\buseEffect\s*\(|\buseState\s*\(|function\s+[A-Z]/.test(trimmed)) {
      return trimmed;
    }

    const className =
      section.type === 'sidebar'
        ? 'vp-inline-section vp-inline-section-sidebar'
        : 'vp-inline-section';
    return `<section className="${className}" data-inline-section="${section.type}">\n${trimmed}\n</section>`;
  }

  private findFirstLikelyJsxStart(code: string): number {
    const pattern = /<(?:>|\/?[A-Za-z])/g;
    for (const match of code.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      const lineStart = code.lastIndexOf('\n', index - 1) + 1;
      const prefix = code.slice(lineStart, index);
      if (/^\s*$/.test(prefix)) {
        return index;
      }
    }
    return -1;
  }

  private shouldWrapInlineSectionInFragment(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('{')) return true;
    if (!trimmed.startsWith('<')) return false;

    const firstNodeEnd = this.findFirstTopLevelJsxNodeEnd(trimmed);
    if (firstNodeEnd == null) return false;
    return trimmed.slice(firstNodeEnd).trim().length > 0;
  }

  private findFirstTopLevelJsxNodeEnd(code: string): number | null {
    let depth = 0;
    let index = 0;
    let childExpressionDepth = 0;
    let childExpressionQuote: '"' | "'" | '`' | null = null;

    while (index < code.length) {
      const char = code[index];
      const prev = code[index - 1];

      if (childExpressionDepth > 0) {
        if (childExpressionQuote) {
          if (char === childExpressionQuote && prev !== '\\') {
            childExpressionQuote = null;
          }
          index += 1;
          continue;
        }
        if (char === '"' || char === "'" || char === '`') {
          childExpressionQuote = char;
          index += 1;
          continue;
        }
        if (char === '{') {
          childExpressionDepth += 1;
          index += 1;
          continue;
        }
        if (char === '}') {
          childExpressionDepth = Math.max(0, childExpressionDepth - 1);
          index += 1;
          continue;
        }
        index += 1;
        continue;
      }

      if (char === '{') {
        childExpressionDepth = 1;
        index += 1;
        continue;
      }

      if (code[index] !== '<') {
        index += 1;
        continue;
      }

      const tagEnd = this.findJsxTagEnd(code, index);
      if (tagEnd == null) return null;

      const token = code.slice(index, tagEnd + 1).trim();
      const isFragmentOpen = token === '<>';
      const isFragmentClose = token === '</>';
      const isClosingTag = /^<\//.test(token) && !isFragmentClose;
      const isDeclaration =
        /^<!/.test(token) || /^<\?/.test(token) || /^<!--/.test(token);
      const isSelfClosing =
        !isClosingTag && !isFragmentOpen && /\/>\s*$/.test(token);

      if (!isDeclaration) {
        if (isClosingTag || isFragmentClose) {
          depth = Math.max(0, depth - 1);
        } else {
          depth += 1;
          if (isSelfClosing) depth = Math.max(0, depth - 1);
        }
      }

      index = tagEnd + 1;
      if (depth === 0) return index;
    }

    return null;
  }

  private findJsxTagEnd(code: string, start: number): number | null {
    let quote: '"' | "'" | '`' | null = null;
    let braceDepth = 0;

    for (let index = start + 1; index < code.length; index++) {
      const char = code[index];
      const prev = code[index - 1];

      if (quote) {
        if (char === quote && prev !== '\\') {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }

      if (char === '{') {
        braceDepth += 1;
        continue;
      }
      if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }

      if (char === '>' && braceDepth === 0) {
        return index;
      }
    }

    return null;
  }

  private buildApprovedPlanRetryChecklist(
    componentPlan: ComponentPromptContext | undefined,
    error: string | undefined,
    componentName: string,
  ): string {
    const sections = resolvePlannerSectionBlueprint({
      visualPlan: componentPlan?.visualPlan,
      surfacePlan: componentPlan?.surfacePlan,
    });
    const surfacePlan = componentPlan?.surfacePlan;
    const hasPlannerBlockTree = Boolean(
      componentPlan?.visualPlan?.blockTree?.length ||
      surfacePlan?.sourceEvidence.blockTree?.length,
    );
    if (
      (sections.length === 0 && !surfacePlan) ||
      !/visual plan obligations violated|required capability|surface-plan source evidence violated|obligation "/i.test(
        error ?? '',
      )
    ) {
      return '';
    }

    const lines = [
      `### Approved planner contract for ${componentName}`,
      ...(surfacePlan ? [buildSurfacePlanRepairContextNote(surfacePlan)] : []),
      '### Approved plan sections to preserve exactly',
      'If a section below includes blueprint style or layout fields such as presentation, ctaStyle, secondaryCtaStyle, cardStyle, quoteStyle, authorStyle, imageRadius, imageAspectRatio, imageFrameBackgroundSrc, imageFrameBackground, imageFrameMinHeight, imageHeightStyle, triggerStyle, slideHeight, dotsColor, arrowColor, arrowBackground, width, height, activeTab, variant, tabAlign, allowMultiple, enableToggle, defaultOpenItems, itemLayout, metaLayout, metaAlign, metaSeparator, itemGap, or metaGap, preserve and re-apply those exact values.',
      'Do not replace approved blueprint styles with prettier defaults, palette fallbacks, or generic token-based classes when the plan already provides exact visual values.',
      'If the approved plan includes source `customClassNames` on the section itself, CTA/link elements, images, card wrappers, avatar elements, or nested text nodes such as headings, quotes, subtitles, tab panels, accordion bodies, and modal copy, preserve those exact class tokens on the corresponding rendered JSX elements. Do not collapse them onto the wrong wrapper or delete them during fixes.',
      ...(hasPlannerBlockTree
        ? [
            'The approved plan also includes a preserved WordPress `blockTree`. Treat it as the structural source of truth for wrapper order, columns/column ownership, template-part boundaries, and sidebar shell placement.',
            'Do NOT flatten block wrappers into a simpler section stack during repair. Keep group nesting, main/aside ownership, and source-backed shell spacing intact while repairing the JSX.',
          ]
        : []),
      ...(sections.some((section) => section.type === 'cover')
        ? [
            'For important screenshot/composite cover imagery, preserve the full asset by default. Prefer object-contain or another non-cropping treatment unless the approved source is clearly intentionally cropped.',
          ]
        : []),
      ...(sections.some((section) => section.type === 'carousel')
        ? [
            'If a carousel uses drag/swipe helpers or guard utilities, they must be attached to the rendered slider shell. Do not leave carousel interaction helpers declared but unused.',
          ]
        : []),
      ...sections.map((section, index) => {
        const parts = [
          `- section ${index + 1}: type=${section.type}`,
          (section.debugKey ?? section.sectionKey)
            ? `debugKey=${section.debugKey ?? section.sectionKey}`
            : null,
          section.sourceRef?.sourceNodeId
            ? `sourceNodeId=${section.sourceRef.sourceNodeId}`
            : null,
          this.extractCustomClassNamesFromSection(section).length > 0
            ? `customClassNames=${JSON.stringify(
                this.extractCustomClassNamesFromSection(section),
              )}`
            : null,
          section.presentation
            ? `presentation=${JSON.stringify(section.presentation)}`
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
          parts.push(
            section.ctaStyle
              ? `ctaStyle=${JSON.stringify(section.ctaStyle)}`
              : null,
          );
          parts.push(
            section.secondaryCtaStyle
              ? `secondaryCtaStyle=${JSON.stringify(section.secondaryCtaStyle)}`
              : null,
          );
        }
        if (section.type === 'tabs') {
          parts.push(
            typeof section.activeTab === 'number'
              ? `activeTab=${section.activeTab}`
              : null,
          );
          parts.push(
            section.variant
              ? `variant=${JSON.stringify(section.variant)}`
              : null,
          );
          parts.push(
            section.tabAlign
              ? `tabAlign=${JSON.stringify(section.tabAlign)}`
              : null,
          );
        }
        if (section.type === 'accordion') {
          parts.push(
            typeof section.allowMultiple === 'boolean'
              ? `allowMultiple=${section.allowMultiple}`
              : null,
          );
          parts.push(
            typeof section.enableToggle === 'boolean'
              ? `enableToggle=${section.enableToggle}`
              : null,
          );
          parts.push(
            section.defaultOpenItems?.length
              ? `defaultOpenItems=${JSON.stringify(section.defaultOpenItems)}`
              : null,
          );
          parts.push(
            section.variant
              ? `variant=${JSON.stringify(section.variant)}`
              : null,
          );
        }
        if (section.type === 'carousel') {
          parts.push(
            typeof section.autoplay === 'boolean'
              ? `autoplay=${section.autoplay}`
              : null,
          );
          parts.push(
            typeof section.autoplaySpeed === 'number'
              ? `autoplaySpeed=${section.autoplaySpeed}`
              : null,
          );
          parts.push(
            typeof section.loop === 'boolean' ? `loop=${section.loop}` : null,
          );
          parts.push(
            section.effect ? `effect=${JSON.stringify(section.effect)}` : null,
          );
          parts.push(
            typeof section.showDots === 'boolean'
              ? `showDots=${section.showDots}`
              : null,
          );
          parts.push(
            typeof section.showArrows === 'boolean'
              ? `showArrows=${section.showArrows}`
              : null,
          );
          parts.push(
            typeof section.vertical === 'boolean'
              ? `vertical=${section.vertical}`
              : null,
          );
          parts.push(
            typeof section.transitionSpeed === 'number'
              ? `transitionSpeed=${section.transitionSpeed}`
              : null,
          );
          parts.push(
            section.pauseOn
              ? `pauseOn=${JSON.stringify(section.pauseOn)}`
              : null,
          );
        }

        if (section.type === 'cta-strip') {
          parts.push(
            section.align ? `align=${JSON.stringify(section.align)}` : null,
          );
          parts.push(
            section.cta?.text
              ? `ctaText=${JSON.stringify(section.cta.text)}`
              : null,
          );
          if (Array.isArray(section.ctas) && section.ctas.length > 1) {
            parts.push(
              ...section.ctas
                .slice(1)
                .map((cta, ctaIndex) =>
                  cta.text
                    ? `cta${ctaIndex + 2}Text=${JSON.stringify(cta.text)}`
                    : null,
                ),
            );
          }
          parts.push(
            section.ctaStyle
              ? `ctaStyle=${JSON.stringify(section.ctaStyle)}`
              : null,
          );
          parts.push(
            section.secondaryCtaStyle
              ? `secondaryCtaStyle=${JSON.stringify(section.secondaryCtaStyle)}`
              : null,
          );
        }

        if (section.type === 'post-list') {
          parts.push(
            section.title ? `title=${JSON.stringify(section.title)}` : null,
          );
          parts.push(`layout=${JSON.stringify(section.layout)}`);
          parts.push(
            section.itemLayout
              ? `itemLayout=${JSON.stringify(section.itemLayout)}`
              : null,
          );
          parts.push(
            section.metaLayout
              ? `metaLayout=${JSON.stringify(section.metaLayout)}`
              : null,
          );
          parts.push(
            section.metaAlign
              ? `metaAlign=${JSON.stringify(section.metaAlign)}`
              : null,
          );
          parts.push(
            section.metaSeparator
              ? `metaSeparator=${JSON.stringify(section.metaSeparator)}`
              : null,
          );
          parts.push(
            section.itemGap
              ? `itemGap=${JSON.stringify(section.itemGap)}`
              : null,
          );
          parts.push(
            section.metaGap
              ? `metaGap=${JSON.stringify(section.metaGap)}`
              : null,
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
            ?.map((card, cardIndex) => {
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
          parts.push(
            section.titleStyle
              ? `titleStyle=${JSON.stringify(section.titleStyle)}`
              : null,
          );
          parts.push(
            section.cardStyle
              ? `cardStyle=${JSON.stringify(section.cardStyle)}`
              : null,
          );
        }

        if (section.type === 'cover') {
          parts.push(
            section.imageSrc
              ? `imageSrc=${JSON.stringify(section.imageSrc)}`
              : null,
          );
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

        if (section.type === 'media-text') {
          parts.push(
            section.imageSrc
              ? `imageSrc=${JSON.stringify(section.imageSrc)}`
              : null,
          );
          parts.push(
            section.subtitle
              ? `subtitle=${JSON.stringify(section.subtitle)}`
              : null,
          );
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
          parts.push(
            section.cta?.text
              ? `ctaText=${JSON.stringify(section.cta.text)}`
              : null,
          );
          if (Array.isArray(section.ctas) && section.ctas.length > 1) {
            parts.push(
              ...section.ctas
                .slice(1)
                .map((cta, ctaIndex) =>
                  cta.text
                    ? `cta${ctaIndex + 2}Text=${JSON.stringify(cta.text)}`
                    : null,
                ),
            );
          }
          parts.push(
            section.imageRadius
              ? `imageRadius=${JSON.stringify(section.imageRadius)}`
              : null,
          );
          parts.push(
            section.imageAspectRatio
              ? `imageAspectRatio=${JSON.stringify(section.imageAspectRatio)}`
              : null,
          );
          parts.push(
            section.ctaStyle
              ? `ctaStyle=${JSON.stringify(section.ctaStyle)}`
              : null,
          );
          parts.push(
            section.secondaryCtaStyle
              ? `secondaryCtaStyle=${JSON.stringify(section.secondaryCtaStyle)}`
              : null,
          );
        }

        if (section.type === 'modal') {
          const stateKey = this.resolveInteractiveSectionStateKey(section);
          parts.push(
            section.triggerText
              ? `triggerText=${JSON.stringify(section.triggerText)}`
              : null,
          );
          parts.push(
            section.heading
              ? `heading=${JSON.stringify(section.heading)}`
              : null,
          );
          parts.push(
            section.body ? `body=${JSON.stringify(section.body)}` : null,
          );
          parts.push(
            section.imageSrc
              ? `imageSrc=${JSON.stringify(section.imageSrc)}`
              : null,
          );
          parts.push(
            section.cta?.text
              ? `ctaText=${JSON.stringify(section.cta.text)}`
              : null,
          );
          if (Array.isArray(section.ctas) && section.ctas.length > 1) {
            parts.push(
              ...section.ctas
                .slice(1)
                .map((cta, ctaIndex) =>
                  cta.text
                    ? `cta${ctaIndex + 2}Text=${JSON.stringify(cta.text)}`
                    : null,
                ),
            );
          }
          parts.push(
            section.width ? `width=${JSON.stringify(section.width)}` : null,
          );
          parts.push(
            section.height ? `height=${JSON.stringify(section.height)}` : null,
          );
          parts.push(
            section.triggerStyle
              ? `triggerStyle=${JSON.stringify(section.triggerStyle)}`
              : null,
          );
          parts.push(
            section.headingStyle
              ? `headingStyle=${JSON.stringify(section.headingStyle)}`
              : null,
          );
          parts.push(
            section.bodyStyle
              ? `bodyStyle=${JSON.stringify(section.bodyStyle)}`
              : null,
          );
          parts.push(
            section.ctaStyle
              ? `ctaStyle=${JSON.stringify(section.ctaStyle)}`
              : null,
          );
          parts.push(
            section.secondaryCtaStyle
              ? `secondaryCtaStyle=${JSON.stringify(section.secondaryCtaStyle)}`
              : null,
          );
          parts.push(
            'behavior=render modal trigger button plus conditional popup overlay with uagb-modal-trigger and uagb-modal-popup',
          );
          parts.push(stateKey ? `stateKey=${JSON.stringify(stateKey)}` : null);
        }

        if (section.type === 'carousel') {
          const stateKey = this.resolveInteractiveSectionStateKey(section);
          parts.push(`slideCount=${section.slides?.length ?? 0}`);
          parts.push(stateKey ? `stateKey=${JSON.stringify(stateKey)}` : null);
          parts.push(
            section.slideHeight
              ? `slideHeight=${JSON.stringify(section.slideHeight)}`
              : null,
          );
          parts.push(
            section.dotsColor
              ? `dotsColor=${JSON.stringify(section.dotsColor)}`
              : null,
          );
          parts.push(
            section.arrowColor
              ? `arrowColor=${JSON.stringify(section.arrowColor)}`
              : null,
          );
          parts.push(
            section.arrowBackground
              ? `arrowBackground=${JSON.stringify(section.arrowBackground)}`
              : null,
          );
          parts.push(
            section.headingStyle
              ? `headingStyle=${JSON.stringify(section.headingStyle)}`
              : null,
          );
          parts.push(
            section.subheadingStyle
              ? `subheadingStyle=${JSON.stringify(section.subheadingStyle)}`
              : null,
          );
          parts.push(
            section.ctaStyle
              ? `ctaStyle=${JSON.stringify(section.ctaStyle)}`
              : null,
          );
          parts.push(
            section.secondaryCtaStyle
              ? `secondaryCtaStyle=${JSON.stringify(section.secondaryCtaStyle)}`
              : null,
          );
          const slideHints = section.slides
            ?.slice(0, 6)
            .map((slide, slideIndex) => {
              const hints = [
                slide.heading
                  ? `slide${slideIndex + 1}.heading=${JSON.stringify(slide.heading)}`
                  : null,
                slide.subheading
                  ? `slide${slideIndex + 1}.subheading=${JSON.stringify(slide.subheading)}`
                  : null,
                slide.imageSrc
                  ? `slide${slideIndex + 1}.imageSrc=${JSON.stringify(slide.imageSrc)}`
                  : null,
                slide.cta?.text
                  ? `slide${slideIndex + 1}.ctaText=${JSON.stringify(slide.cta.text)}`
                  : null,
              ].filter(Boolean);
              return hints.join(' | ');
            })
            .filter(Boolean);
          if (slideHints?.length) {
            parts.push(...slideHints);
          }
          parts.push(
            'behavior=bind swiper-wrapper translateX to activeCarousels[...] and render non-empty swiper-button-prev/swiper-button-next controls',
          );
        }

        if (section.type === 'testimonial') {
          parts.push(
            section.quoteStyle
              ? `quoteStyle=${JSON.stringify(section.quoteStyle)}`
              : null,
          );
          parts.push(
            section.authorStyle
              ? `authorStyle=${JSON.stringify(section.authorStyle)}`
              : null,
          );
          parts.push(
            section.cardStyle
              ? `cardStyle=${JSON.stringify(section.cardStyle)}`
              : null,
          );
        }

        if (section.type === 'newsletter') {
          parts.push(
            section.headingStyle
              ? `headingStyle=${JSON.stringify(section.headingStyle)}`
              : null,
          );
          parts.push(
            section.inputStyle
              ? `inputStyle=${JSON.stringify(section.inputStyle)}`
              : null,
          );
          parts.push(
            section.cardStyle
              ? `cardStyle=${JSON.stringify(section.cardStyle)}`
              : null,
          );
        }

        if (section.type === 'tabs') {
          parts.push(
            section.title ? `title=${JSON.stringify(section.title)}` : null,
          );
          if (section.tabs?.length) {
            parts.push(
              `tabs=${JSON.stringify(
                section.tabs.slice(0, 6).map((tab) => ({
                  label: tab.label,
                  heading: tab.heading,
                  body: tab.body,
                  imageSrc: tab.imageSrc,
                  ctaText: tab.cta?.text,
                })),
              )}`,
            );
          }
        }

        if (section.type === 'accordion') {
          parts.push(
            section.title ? `title=${JSON.stringify(section.title)}` : null,
          );
          if (section.items?.length) {
            parts.push(
              `items=${JSON.stringify(
                section.items.slice(0, 6).map((item) => ({
                  heading: item.heading,
                  body: item.body,
                })),
              )}`,
            );
          }
        }

        return parts.filter(Boolean).join(' | ');
      }),
      `Keep semantic section ownership stable in "${componentName}" so each approved source-backed region remains independently editable and reviewable.`,
    ];

    return lines.join('\n');
  }

  private extractCustomClassNamesFromBlockTree(
    nodes?: readonly BlockNode[],
  ): string[] {
    if (!nodes?.length) return [];
    const result = new Set<string>();
    const visit = (node: BlockNode) => {
      for (const className of node.customClassNames ?? []) {
        const normalized = className.trim();
        if (normalized) result.add(normalized);
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    return [...result];
  }

  private extractCustomClassNamesFromSection(section: SectionPlan): string[] {
    const result = new Set<string>();
    const add = (values?: string[]) => {
      for (const className of values ?? []) {
        const normalized = className.trim();
        if (normalized) result.add(normalized);
      }
    };
    const addCta = (cta?: { customClassNames?: string[] }) => {
      add(cta?.customClassNames);
    };

    add(section.customClassNames);

    if ('cta' in section) addCta(section.cta);
    if ('ctas' in section) {
      for (const cta of section.ctas ?? []) addCta(cta);
    }

    switch (section.type) {
      case 'prose-block':
        for (const segment of section.sourceSegments) {
          add(segment.customClassNames);
          if (segment.type === 'list') {
            add(segment.itemCustomClassNames);
          }
        }
        break;
      case 'hero':
        add(section.headingCustomClassNames);
        add(section.subheadingCustomClassNames);
        add(section.image?.customClassNames);
        break;
      case 'cover':
        add(section.headingCustomClassNames);
        add(section.subheadingCustomClassNames);
        break;
      case 'post-list':
        add(section.titleCustomClassNames);
        break;
      case 'card-grid':
        add(section.titleCustomClassNames);
        add(section.subtitleCustomClassNames);
        for (const card of section.cards) {
          add(card.customClassNames);
          add(card.headingCustomClassNames);
          add(card.bodyCustomClassNames);
          add(card.imageCustomClassNames);
        }
        break;
      case 'media-text':
        add(section.subtitleCustomClassNames);
        add(section.headingCustomClassNames);
        add(section.bodyCustomClassNames);
        add(section.imageCustomClassNames);
        break;
      case 'testimonial':
        add(section.quoteCustomClassNames);
        add(section.authorCustomClassNames);
        add(section.authorAvatarCustomClassNames);
        break;
      case 'newsletter':
        add(section.headingCustomClassNames);
        add(section.subheadingCustomClassNames);
        break;
      case 'modal':
        add(section.triggerCustomClassNames);
        add(section.headingCustomClassNames);
        add(section.bodyCustomClassNames);
        add(section.imageCustomClassNames);
        break;
      case 'tabs':
        add(section.titleCustomClassNames);
        for (const tab of section.tabs) {
          add(tab.headingCustomClassNames);
          add(tab.bodyCustomClassNames);
          add(tab.imageCustomClassNames);
          addCta(tab.cta);
        }
        break;
      case 'accordion':
        add(section.titleCustomClassNames);
        for (const item of section.items) {
          add(item.headingCustomClassNames);
          add(item.bodyCustomClassNames);
        }
        break;
      case 'carousel':
        for (const slide of section.slides) {
          add(slide.headingCustomClassNames);
          add(slide.subheadingCustomClassNames);
          add(slide.imageCustomClassNames);
          addCta(slide.cta);
        }
        break;
      default:
        break;
    }

    return [...result];
  }

  private resolveInteractiveSectionStateKey(
    section: ComponentVisualPlan['sections'][number],
  ): string | null {
    const raw =
      section.debugKey ?? section.sectionKey ?? section.sourceRef?.sourceNodeId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  private buildAutoFixErrorContext(
    reason: string,
    lastError: string | undefined,
    componentPlan: ComponentPromptContext | undefined,
    componentName: string,
    repoManifest?: RepoThemeManifest,
  ): string {
    const parts = [`${reason}: ${lastError ?? 'Unknown validation error.'}`];
    const requiredLiterals = componentPlan?.surfacePlan
      ? collectSurfacePlanRequiredLiterals(componentPlan.surfacePlan)
      : [];
    const fixedSlug = componentPlan?.fixedSlug?.trim();
    if (fixedSlug) {
      const boundEndpoint = componentPlan?.dataNeeds?.includes('postDetail')
        ? `/api/posts/${fixedSlug}`
        : componentPlan?.dataNeeds?.includes('productDetail')
          ? `/api/post-types/product/${fixedSlug}`
          : componentPlan?.dataNeeds?.includes('pageDetail')
            ? `/api/pages/${fixedSlug}`
            : undefined;
      const bindingLines = [
        `Fixed slug binding: \`${fixedSlug}\`.`,
        'Do not import or call `useParams()`.',
      ];
      if (boundEndpoint) {
        bindingLines.push(
          `Fetch the main record only from \`${boundEndpoint}\`. Do not fall back to a dynamic \`/api/.../\${slug}\` endpoint or a list endpoint plus lookup.`,
        );
      }
      parts.push(bindingLines.join('\n'));
    }
    if (requiredLiterals.length > 0) {
      parts.push(
        `Source literal reminders: ${requiredLiterals
          .slice(0, 8)
          .map((literal) => JSON.stringify(literal))
          .join(' | ')}`,
      );
    }
    const checklist = this.buildApprovedPlanRetryChecklist(
      componentPlan,
      lastError,
      componentName,
    );
    if (checklist) {
      parts.push(checklist);
    }
    const repoChainNote = buildComponentRepoChainNote(
      repoManifest,
      componentPlan,
    );
    if (repoChainNote) {
      parts.push(repoChainNote);
    }
    const spectraContractNote = buildSpectraContractPromptNote(
      repoManifest,
      componentPlan?.visualPlan,
    );
    if (spectraContractNote) {
      parts.push(spectraContractNote);
    }
    return parts.join('\n\n');
  }

  // ── Code post-processors ──────────────────────────────────────────────────

  private postProcessCode(code: string): string {
    return normalizeCommonTypographyTypos(
      normalizeThemeAssetReferences(
        normalizeCanonicalPostMetaAndTextLinks(
          this.normalizeTailwindFunctionSpacing(
            this.fixDoublebraces(
              this.mergeClassNames(this.stripMarkdownFences(code)),
            ),
          ),
        ),
      ),
    );
  }

  private postProcessFullFileCandidate(
    code: string,
    componentName: string,
    policy: FullFileGenerationPolicy,
    componentPlan?: ComponentPromptContext,
  ): string {
    let processed = this.postProcessCode(code);
    processed = this.stripSharedChromeLeakSections(
      processed,
      componentName,
      componentPlan,
    );
    if (policy !== 'direct-ai-full-file') {
      return processed;
    }
    return this.stripSpuriousHardcodedSections(processed, componentName);
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

  /**
   * Direct-AI full-file cleanup only:
   * Remove JSX `<section>` blocks that contain only hardcoded static text with
   * no references to dynamic data (item/page/post/data state variables).
   * Do NOT use this on section-assembly or plan-guided generation paths because
   * source-backed sections may legitimately be static JSX after deterministic or
   * visual-plan-driven reconstruction.
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

  private stripSharedChromeLeakSections(
    code: string,
    componentName: string,
    componentPlan?: ComponentPromptContext,
  ): string {
    if (componentPlan?.type !== 'page') return code;

    const sharedFooterMarker =
      /pg-footer-center-row|profolio-fse-scroll-top|let'?s work together|looking for a one time project|looking for a dedicated designer/i;
    const containsSharedFooterMarker = (value: string) =>
      sharedFooterMarker.test(value);

    const cleaned = this.stripTopLevelSectionBlocks(code, (sectionContent) =>
      containsSharedFooterMarker(sectionContent),
    );
    if (cleaned !== code) return cleaned;

    const topLevelFooterPattern = /\n?\s*<footer\b[\s\S]*?<\/footer>\s*/gi;
    return code.replace(topLevelFooterPattern, (match) =>
      containsSharedFooterMarker(match) ? '' : match,
    );
  }

  private stripTopLevelSectionBlocks(
    code: string,
    shouldDrop: (sectionContent: string) => boolean,
  ): string {
    let result = '';
    let i = 0;
    while (i < code.length) {
      const sectionStart = code.indexOf('<section', i);
      if (sectionStart === -1) {
        result += code.slice(i);
        break;
      }
      result += code.slice(i, sectionStart);

      let depth = 0;
      let j = sectionStart;
      while (j < code.length) {
        const openIdx = code.indexOf('<section', j);
        const closeIdx = code.indexOf('</section>', j);
        if (closeIdx === -1) {
          j = code.length;
          break;
        }
        if (openIdx !== -1 && openIdx < closeIdx) {
          depth++;
          j = openIdx + 8;
        } else {
          depth--;
          j = closeIdx + 10;
          if (depth === 0) break;
        }
      }

      const sectionContent = code.slice(sectionStart, j);
      if (!shouldDrop(sectionContent)) {
        result += sectionContent;
      }
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
