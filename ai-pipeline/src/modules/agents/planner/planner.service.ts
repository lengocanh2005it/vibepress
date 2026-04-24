import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname } from 'path';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import {
  wpBlocksToJson,
  wpBlocksToJsonWithSourceRefs,
  ensureWpNodesHaveSourceRefs,
  wpJsonToString,
  type WpNode,
} from '../../../common/utils/wp-block-to-json.js';
import { mapWpNodesToDraftSections } from '../../../common/utils/wp-node-to-sections-mapper.js';
import { StyleResolverService } from '../../../common/style-resolver/style-resolver.service.js';
import { buildEditRequestContextNote } from '../../edit-request/edit-request-prompt.util.js';
import { CapturePlanningService } from '../../edit-request/capture-planning.service.js';
import type { PipelineEditRequestDto } from '../../orchestrator/orchestrator.dto.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import {
  getComponentStrategy,
  isSharedChromePartialComponent,
} from '../component-strategy.registry.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import type {
  BlockParseResult,
  ThemeTokens,
  ThemeDefaults,
} from '../block-parser/block-parser.service.js';
import {
  buildVisualPlanPrompt,
  extractStaticImageSources,
  parseVisualPlanDetailed,
  sanitizeSectionsForContract,
  type VisualPlanContract,
} from '../react-generator/prompts/visual-plan.prompt.js';
import {
  extractAuxiliaryLabelsFromSections,
  extractSourceBackedAuxiliaryLabels,
  mergeAuxiliaryLabels,
} from '../react-generator/auxiliary-section.guard.js';
import { buildRepoManifestContextNote } from '../repo-analyzer/repo-manifest-context.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import type {
  ComponentVisualPlan,
  ColorPalette,
  DataNeed,
  TypographyTokens,
  LayoutTokens,
  SectionPlan,
} from '../react-generator/visual-plan.schema.js';
import {
  PlannerVisualRepairService,
  type PlanningSourceCandidate,
  type PlanningSourceContext,
  type PlanningSourceSupplement,
  type PlannerVisualPlanRepairState,
  type PlannerVisualRepairDelegate,
} from './planner-visual-repair.service.js';

export interface ComponentPlan {
  templateName: string;
  componentName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  isDetail: boolean;
  description: string;
  customClassNames?: string[];
  sourceBackedAuxiliaryLabels?: string[];
  draftSections?: SectionPlan[];
  planningSourceLabel?: string;
  planningSourceReason?: string;
  planningSourceFile?: string;
  planningSourceSummary?: string;
  fixedSlug?: string;
  fixedPageId?: number | string;
  fixedTitle?: string;
  /** Pre-computed visual plan from Phase B — generator skips Stage 1 if present */
  visualPlan?: ComponentVisualPlan;
}

export type PlanResult = ComponentPlan[];

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly rawOutputDivider = '\n----- RAW OUTPUT BEGIN -----\n';
  private readonly tokenTracker = new TokenTracker();

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    private readonly aiLogger: AiLoggerService,
    private readonly styleResolver: StyleResolverService,
    private readonly capturePlanning: CapturePlanningService,
    private readonly visualRepair: PlannerVisualRepairService,
  ) {}

  async plan(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    modelName?: string,
    jobId?: string,
    options?: {
      includeVisualPlans?: boolean;
      logPath?: string;
      repoManifest?: RepoThemeManifest;
      editRequest?: PipelineEditRequestDto;
      /** Errors from the previous plan-review pass — injected into the Phase A prompt so the LLM knows what to fix. */
      planReviewErrors?: string[];
    },
  ): Promise<PlanResult> {
    // Build source map for layer 2 enrichment and Phase B
    const sourceMap = new Map<string, string>();
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    for (const t of allTemplates) {
      sourceMap.set(t.name, 'markup' in t ? t.markup : t.html);
    }

    const resolvedModel = modelName ?? this.llmFactory.getModel();
    const includeVisualPlans = options?.includeVisualPlans ?? true;
    const tokenLogPath = TokenTracker.getTokenLogPath(options?.logPath);
    if (tokenLogPath) {
      await this.tokenTracker.init(tokenLogPath);
    }

    const templateNames = this.getExpectedTemplateNames(theme, content);

    // ── Phase A: architecture plan ─────────────────────────────────────────
    this.logger.log(
      `[Phase A] Planning architecture for ${templateNames.length} components in "${content.siteInfo.siteName}"`,
    );

    const systemPrompt = this.buildSystemPrompt();
    const editRequestContext = buildEditRequestContextNote(
      options?.editRequest,
      {
        audience: 'planner',
      },
    );
    const userPrompt = options?.planReviewErrors?.length
      ? this.buildValidationFeedbackPrompt(
          options.planReviewErrors,
          templateNames,
          editRequestContext,
        )
      : this.buildUserPrompt(
          theme,
          content,
          templateNames,
          sourceMap,
          options?.repoManifest,
          editRequestContext,
        );

    let plan: PlanResult | null = null;
    let lastError = 'unknown parse failure';
    let lastRaw = '';
    const attempts: any[] = [];
    const startTime = new Date().toISOString();

    for (let attempt = 1; attempt <= 3; attempt++) {
      const prompt =
        attempt === 1
          ? userPrompt
          : this.buildRetryPrompt(lastRaw, templateNames, editRequestContext);

      const {
        text: raw,
        inputTokens: inTok,
        outputTokens: outTok,
      } = await this.llmFactory.chat({
        model: resolvedModel,
        systemPrompt,
        userPrompt: prompt,
        maxTokens: 4096,
      });
      if (tokenLogPath) {
        await this.tokenTracker.track(
          resolvedModel,
          inTok,
          outTok,
          `planner:${attempt === 1 ? 'phase-a' : `phase-a-retry-${attempt}`}`,
          {
            scope: editRequestContext ? 'edit-request' : 'base',
          },
        );
      }

      lastRaw = raw;
      const parsed = this.tryParseResponseDetailed(raw, templateNames);
      plan = parsed.plan;
      if (!parsed.plan) lastError = parsed.reason;

      // Track attempt — store full prompt + response for CoT replay
      attempts.push({
        attemptNumber: attempt,
        promptSent: {
          system: systemPrompt,
          user: prompt,
        },
        response: raw,
        tokensUsed: {
          input: inTok,
          output: outTok,
          total: inTok + outTok,
        },
        timestamp: new Date().toISOString(),
        success: !!plan,
        error: plan ? undefined : lastError,
      });

      if (plan) {
        this.logger.log(
          `[Phase A] Received on attempt ${attempt}: ${plan.length} components`,
        );
        break;
      }

      this.logger.warn(
        `[Phase A] Attempt ${attempt}/3 failed: ${lastError}${this.formatRawOutput(raw)}`,
      );
    }

    if (!plan) {
      this.logger.warn(
        `[Phase A] All attempts failed, using fallback plan. Last error: ${lastError}${this.formatRawOutput(lastRaw)}`,
      );
      plan = this.buildFallbackPlan(templateNames);
    }

    // Log AI activity for planning
    if (this.aiLogger && jobId) {
      const endTime = new Date().toISOString();
      const totalTokens = attempts.reduce(
        (sum, att) => sum + att.tokensUsed.total,
        0,
      );
      const totalInput = attempts.reduce(
        (sum, att) => sum + att.tokensUsed.input,
        0,
      );
      const totalOutput = attempts.reduce(
        (sum, att) => sum + att.tokensUsed.output,
        0,
      );

      await this.aiLogger.logCotProcess({
        jobId,
        step: 'planning',
        model: resolvedModel,
        startTime,
        endTime,
        totalAttempts: attempts.length,
        attempts,
        finalSuccess: !!plan,
        totalTokenCost: totalTokens,
        totalTokens: {
          input: totalInput,
          output: totalOutput,
        },
        finalError: plan ? undefined : lastError,
      });
    }

    // Deterministically add any templates the AI omitted so a near-complete
    // answer does not trigger wasteful retries or lose the valid components.
    plan = this.injectMissingTemplates(plan, templateNames);

    // ── Phase B (C2): Component Graph Builder — deterministic, no AI ────────
    // Scans each template's source for navigation blocks, query blocks, etc.
    // to enrich component routes, data needs, and layout flags.
    this.logger.log(
      `[Phase B: Component Graph Builder] Enriching plan for ${plan.length} components`,
    );
    const enriched = this.materializeConcretePagePlans(
      this.enrichPlan(plan, sourceMap),
      content,
    );
    this.logger.log(
      `[Phase B: Component Graph Builder] Done — ${enriched.filter((c) => c.route).length} routable, ` +
        `${enriched.filter((c) => c.dataNeeds?.includes('menus')).length} with menus`,
    );
    // ── Phase C (C3): AI Visual Sections ────────────────────────────────
    // AI generates a visual section plan (navbar/hero/footer/etc.) per component.
    // palette, typography, layout are injected deterministically from theme tokens.
    const tokens = theme.type === 'fse' ? theme.tokens : undefined;
    const globalPalette = this.deriveGlobalPalette(tokens);
    const globalTypography = this.deriveGlobalTypography(tokens);

    const skipVisualPlan =
      !includeVisualPlans ||
      (this.configService.get<boolean>('planner.minimalVisualPlan') ?? false);

    if (skipVisualPlan) {
      this.logger.log(
        `[Phase C: AI Visual Sections] Skipped visual plan generation (${includeVisualPlans ? 'minimalVisualPlan=true' : 'deferred until after plan review'}), plan only includes data/contract`,
      );
      return enriched;
    }

    this.logger.log(
      `[Phase C: AI Visual Sections] Generating visual plans for ${enriched.length} components (palette + typography from theme tokens)`,
    );

    return this.buildVisualPlans(
      enriched,
      sourceMap,
      content,
      tokens,
      globalPalette,
      globalTypography,
      options?.repoManifest,
      options?.editRequest,
      resolvedModel,
      options?.logPath,
    );
  }

  async attachVisualPlans(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    plan: PlanResult,
    modelName?: string,
    repoManifest?: RepoThemeManifest,
    editRequest?: PipelineEditRequestDto,
  ): Promise<PlanResult> {
    const skipVisualPlan =
      this.configService.get<boolean>('planner.minimalVisualPlan') ?? false;
    if (skipVisualPlan) {
      this.logger.log(
        `[Phase C: AI Visual Sections] Skipped visual plan generation (minimalVisualPlan=true), plan only includes data/contract`,
      );
      return plan;
    }

    const sourceMap = new Map<string, string>();
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    for (const t of allTemplates) {
      sourceMap.set(t.name, 'markup' in t ? t.markup : t.html);
    }

    const tokens = theme.type === 'fse' ? theme.tokens : undefined;
    const globalPalette = this.deriveGlobalPalette(tokens);
    const globalTypography = this.deriveGlobalTypography(tokens);
    const resolvedModel = modelName ?? this.llmFactory.getModel();

    const concretizedPlan = this.materializeConcretePagePlans(plan, content);

    this.logger.log(
      `[Phase C: AI Visual Sections] Generating visual plans for ${concretizedPlan.length} reviewed components (palette + typography from theme tokens)`,
    );

    return this.buildVisualPlans(
      concretizedPlan,
      sourceMap,
      content,
      tokens,
      globalPalette,
      globalTypography,
      repoManifest,
      editRequest,
      resolvedModel,
      undefined,
    );
  }

  // ── Phase C: AI visual plan per component ───────────────────────────

  private async buildVisualPlans(
    plan: PlanResult,
    sourceMap: Map<string, string>,
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
    globalPalette: ColorPalette,
    globalTypography: TypographyTokens,
    repoManifest: RepoThemeManifest | undefined,
    editRequest: PipelineEditRequestDto | undefined,
    modelName: string,
    logPath?: string,
  ): Promise<PlanResult> {
    const concurrency =
      this.configService.get<number>('planner.visualPlanConcurrency') ?? 3;
    const batchDelay =
      this.configService.get<number>('reactGenerator.delayBetweenComponents') ??
      3000;

    const result: PlanResult = new Array(plan.length);
    for (
      let batchStart = 0;
      batchStart < plan.length;
      batchStart += concurrency
    ) {
      if (batchStart > 0) {
        await new Promise((res) => setTimeout(res, batchDelay));
      }

      const batch = plan.slice(batchStart, batchStart + concurrency);
      const batchResults = await Promise.all(
        batch.map((componentPlan) =>
          this.generateVisualPlanForComponent(
            componentPlan,
            sourceMap.get(componentPlan.templateName) ?? '',
            sourceMap,
            content,
            tokens,
            globalPalette,
            globalTypography,
            plan,
            repoManifest,
            editRequest,
            modelName,
            logPath,
          ),
        ),
      );

      for (let j = 0; j < batchResults.length; j++) {
        result[batchStart + j] = batchResults[j];
      }

      this.logger.log(
        `[Phase C: AI Visual Sections] Batch ${Math.floor(batchStart / concurrency) + 1}/${Math.ceil(plan.length / concurrency)} done`,
      );
    }

    const withPlan = result.filter((c) => c.visualPlan).length;
    this.logger.log(
      `[Phase C: AI Visual Sections] Done: ${withPlan}/${result.length} components have pre-computed visual plans`,
    );

    return result;
  }

  private async generateVisualPlanForComponent(
    componentPlan: PlanResult[number],
    templateSource: string,
    sourceMap: Map<string, string>,
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
    globalPalette: ColorPalette,
    globalTypography: TypographyTokens,
    fullPlan: PlanResult,
    repoManifest: RepoThemeManifest | undefined,
    editRequest: PipelineEditRequestDto | undefined,
    modelName: string,
    logPath?: string,
  ): Promise<PlanResult[number]> {
    let visualPlan: ComponentVisualPlan | undefined;
    let detectedCustomClassNames: string[] = [];
    let sourceBackedAuxiliaryLabels: string[] = [];
    let draftSections: ReturnType<typeof mapWpNodesToDraftSections> | undefined;
    let planningSource: PlanningSourceContext | undefined;
    let sourceWidgetHints: string[] = [];
    const hasSharedLayoutPartials = fullPlan.some(
      (item) =>
        item.type === 'partial' &&
        isSharedChromePartialComponent(item.componentName),
    );
    const deterministicPlan = this.buildDeterministicVisualPlanForComponent(
      componentPlan,
      content,
      tokens,
      globalPalette,
      globalTypography,
      fullPlan,
    );
    if (deterministicPlan) {
      this.logger.log(
        `[Phase C: AI Visual Sections] "${componentPlan.componentName}": deterministic visual plan ✓ ${this.formatSectionList(deterministicPlan.sections)}`,
      );
      return {
        ...componentPlan,
        planningSourceLabel: `deterministic:${componentPlan.templateName}`,
        planningSourceReason: 'deterministic visual plan path',
        planningSourceFile: inferFseSourceFile(
          componentPlan.templateName,
          componentPlan.type,
        ),
        planningSourceSummary:
          'Deterministic visual-plan path; no AI source synthesis needed.',
        visualPlan: {
          ...deterministicPlan,
          ...(componentPlan.fixedSlug
            ? {
                pageBinding: {
                  id: componentPlan.fixedPageId,
                  slug: componentPlan.fixedSlug,
                  title: componentPlan.fixedTitle,
                  route: componentPlan.route ?? undefined,
                },
              }
            : {}),
        },
      };
    }
    if (this.shouldSkipAiVisualPlan(componentPlan)) {
      this.logger.log(
        `[Phase C: AI Visual Sections] "${componentPlan.componentName}": skipped AI visual plan (standard partial without matching section schema)`,
      );
      return {
        ...componentPlan,
        planningSourceLabel: `repo:${componentPlan.templateName}`,
        planningSourceReason: 'visual plan skipped for standard partial',
        planningSourceFile: inferFseSourceFile(
          componentPlan.templateName,
          componentPlan.type,
        ),
        planningSourceSummary:
          'AI visual-plan stage skipped for standard partial without section schema.',
        visualPlan: undefined,
      };
    }
    try {
      const visualDataNeeds = this.toVisualDataNeeds(componentPlan.dataNeeds);
      const scopedEditRequest = this.capturePlanning.scopeRequestToComponent({
        request: editRequest,
        componentName: componentPlan.componentName,
        route: componentPlan.route,
        maxAttachments: 3,
      });
      planningSource = this.buildPlanningSourceContext(
        componentPlan,
        templateSource,
        sourceMap,
        content,
        hasSharedLayoutPartials,
      );
      // Deterministically parse the WordPress block tree to get an ordered
      // draft of sections. This is injected into the prompt as a hard-ordered
      // skeleton so AI only needs to fill in content, not infer layout order.
      draftSections = this.buildDraftSectionsForPlanningSource(
        planningSource,
        componentPlan,
        tokens,
      );
      detectedCustomClassNames =
        this.collectDraftCustomClassNames(draftSections);
      sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
        planningSource.sourceBackedAuxiliaryLabels,
        ...(componentPlan.type === 'partial'
          ? [extractAuxiliaryLabelsFromSections(draftSections)]
          : []),
      );
      sourceWidgetHints = this.detectInteractiveWidgetsFromSource(
        planningSource.source,
      );
      let visualContract: VisualPlanContract = {
        componentType: componentPlan.type,
        route: componentPlan.route,
        isDetail: componentPlan.isDetail,
        dataNeeds: visualDataNeeds,
        stripLayoutChrome: componentPlan.type === 'page',
        sourceBackedAuxiliaryLabels,
        requiredSourceWidgets: sourceWidgetHints,
      };

      const buildPromptArtifacts = (extraContextNote?: string) => {
        const activePlanningSource = planningSource;
        if (!activePlanningSource) {
          throw new Error(
            `Missing planning source for component ${componentPlan.componentName}`,
          );
        }
        return buildVisualPlanPrompt({
          componentName: componentPlan.componentName,
          templateSource: activePlanningSource.source,
          content,
          tokens,
          repoManifest,
          componentType: componentPlan.type,
          route: componentPlan.route,
          isDetail: componentPlan.isDetail,
          dataNeeds: visualDataNeeds,
          sourceAnalysis: activePlanningSource.sourceAnalysis,
          sourceBackedAuxiliaryLabels,
          sourceWidgetHints,
          draftSections,
          editRequestContextNote: [
            buildEditRequestContextNote(scopedEditRequest, {
              audience: 'visual-plan',
              componentName: componentPlan.componentName,
              route: componentPlan.route,
            }),
            extraContextNote,
          ]
            .filter(Boolean)
            .join('\n\n'),
        });
      };

      let { systemPrompt, userPrompt } = buildPromptArtifacts();
      let allowedImageSrcs = this.collectAllowedImageSrcs(
        planningSource.source,
        content,
      );
      let repairState: PlannerVisualPlanRepairState = {
        planningSource,
        draftSections,
        detectedCustomClassNames,
        sourceBackedAuxiliaryLabels,
        sourceWidgetHints,
        allowedImageSrcs,
        visualContract,
      };
      const repairDelegate = this.createVisualRepairDelegate(
        scopedEditRequest ? 'edit-request' : 'base',
      );
      const syncRepairState = (nextState: PlannerVisualPlanRepairState) => {
        repairState = nextState;
        planningSource = nextState.planningSource;
        draftSections = nextState.draftSections;
        detectedCustomClassNames = nextState.detectedCustomClassNames;
        sourceBackedAuxiliaryLabels = nextState.sourceBackedAuxiliaryLabels;
        sourceWidgetHints = nextState.sourceWidgetHints;
        allowedImageSrcs = nextState.allowedImageSrcs;
        visualContract = nextState.visualContract;
      };
      let lastRaw = '';
      let lastReason = 'unknown visual plan parse failure';
      let lastDropped = '';
      const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
      if (tokenLogPath) {
        await this.tokenTracker.init(tokenLogPath);
      }

      const maxTransportRetries = 3;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (
          attempt === 2 &&
          this.visualRepair.shouldAttemptSelfHeal(
            lastReason,
            lastDropped,
            lastRaw,
          )
        ) {
          const repairAttempt = this.visualRepair.prepareAttemptTwoRepair({
            componentPlan,
            sourceMap,
            content,
            tokens,
            repoManifest,
            scopedEditRequest,
            visualDataNeeds,
            hasSharedLayoutPartials,
            currentState: repairState,
            previousReason: lastReason,
            previousDropped: lastDropped,
            previousRaw: lastRaw,
            delegate: repairDelegate,
          });
          syncRepairState(repairAttempt.state);
          systemPrompt = repairAttempt.systemPrompt;
          userPrompt = repairAttempt.userPrompt;
          this.logger.log(
            repairAttempt.sourceChanged
              ? `[Phase C: AI Visual Sections] "${componentPlan.componentName}" attempt 2 repair context: ${repairAttempt.previousSourceLabel ?? 'unknown'} -> ${planningSource.sourceLabel ?? 'unknown'}`
              : `[Phase C: AI Visual Sections] "${componentPlan.componentName}" attempt 2 self-heal: ${repairAttempt.diagnosis.summary}`,
          );
        }

        const effectivePrompt = userPrompt;
        let raw = '';
        let inTok = 0;
        let outTok = 0;
        let completionReceived = false;
        let lastTransportError = '';

        for (
          let transportAttempt = 1;
          transportAttempt <= maxTransportRetries;
          transportAttempt++
        ) {
          try {
            if (transportAttempt > 1) {
              this.logger.log(
                `[Phase C: AI Visual Sections] "${componentPlan.componentName}" request retry ${transportAttempt}/${maxTransportRetries}`,
              );
            }
            const completion = await this.requestVisualPlanCompletion({
              model: modelName,
              systemPrompt,
              userPrompt: effectivePrompt,
              maxTokens: 4096,
            });
            raw = completion.text;
            inTok = completion.inputTokens;
            outTok = completion.outputTokens;
            completionReceived = true;
            break;
          } catch (err: any) {
            lastTransportError = err?.message ?? String(err);
            if (
              !this.isRetryableVisualPlanError(err) ||
              transportAttempt >= maxTransportRetries
            ) {
              throw err;
            }
            this.logger.warn(
              `[Phase C: AI Visual Sections] "${componentPlan.componentName}" transient request error on attempt ${transportAttempt}/${maxTransportRetries}: ${lastTransportError} — retrying`,
            );
            await this.delay(1200 * transportAttempt);
          }
        }

        if (!completionReceived) {
          throw new Error(
            lastTransportError ||
              'visual plan request failed before a response was received',
          );
        }
        if (tokenLogPath) {
          await this.tokenTracker.track(
            modelName,
            inTok,
            outTok,
            `${componentPlan.componentName}:visual-plan:${attempt}`,
            {
              scope: scopedEditRequest ? 'edit-request' : 'base',
            },
          );
        }

        lastRaw = raw;
        const parsedResult = parseVisualPlanDetailed(
          raw,
          componentPlan.componentName,
          {
            allowedImageSrcs,
            contract: visualContract,
            draftSections,
          },
        );
        const parsed = parsedResult.plan;
        if (parsed) {
          const layout = this.deriveComponentLayout(
            tokens,
            componentPlan.componentName,
          );
          visualPlan = {
            ...parsed,
            dataNeeds: this.toVisualDataNeeds(componentPlan.dataNeeds),
            ...(componentPlan.fixedSlug
              ? {
                  pageBinding: {
                    id: componentPlan.fixedPageId,
                    slug: componentPlan.fixedSlug,
                    title: componentPlan.fixedTitle,
                    route: componentPlan.route ?? undefined,
                  },
                }
              : {}),
            palette: globalPalette,
            typography: globalTypography,
            layout,
            blockStyles: tokens?.blockStyles,
            sections: this.mergeDraftSectionPresentation(
              parsed.sections,
              draftSections,
              visualContract,
            ),
          };
          this.logger.log(
            `[Phase C: AI Visual Sections] "${componentPlan.componentName}": ${parsed.sections.length} sections ✓ (attempt ${attempt}) ${this.formatSectionList(parsed.sections)}`,
          );
          break;
        }

        lastReason =
          parsedResult.diagnostic?.reason ??
          'unknown visual plan parse failure';
        lastDropped = parsedResult.diagnostic?.droppedSections?.length
          ? ` | droppedSections: ${parsedResult.diagnostic.droppedSections.join('; ')}`
          : '';

        if (attempt < 2) {
          this.logger.warn(
            `[Phase C: AI Visual Sections] "${componentPlan.componentName}" parse attempt ${attempt}/2 failed: ${lastReason}${lastDropped} — retrying once`,
          );
        }
      }

      if (!visualPlan) {
        if (
          this.visualRepair.shouldAttemptSelfHeal(
            lastReason,
            lastDropped,
            lastRaw,
          )
        ) {
          this.logger.warn(
            `[Phase C: AI Visual Sections] "${componentPlan.componentName}" attempt 2 did not yield a valid plan: ${lastReason}${lastDropped} — escalating to Phase C.5 investigate/replan`,
          );
          const investigateResult =
            await this.visualRepair.investigateAndReplanVisualPlan({
              componentPlan,
              sourceMap,
              content,
              tokens,
              globalPalette,
              globalTypography,
              repoManifest,
              modelName,
              scopedEditRequest,
              visualDataNeeds,
              hasSharedLayoutPartials,
              currentState: repairState,
              previousReason: lastReason,
              previousDropped: lastDropped,
              previousRaw: lastRaw,
              delegate: repairDelegate,
            });
          if (investigateResult.visualPlan) {
            visualPlan = investigateResult.visualPlan;
            syncRepairState(investigateResult.state);
          } else {
            syncRepairState(investigateResult.state);
            lastReason = investigateResult.lastReason;
            lastDropped = investigateResult.lastDropped;
            lastRaw = investigateResult.lastRaw;
          }
        }
      }

      if (!visualPlan) {
        this.logger.warn(
          `[Phase C: AI Visual Sections] "${componentPlan.componentName}" plan parse failed: ${lastReason}${lastDropped} — generator will fallback to D3${this.formatRawOutput(lastRaw)}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[Phase C: AI Visual Sections] "${componentPlan.componentName}" error: ${err?.message} — generator will fallback to D3`,
      );
    }

    return {
      ...componentPlan,
      ...(draftSections?.length ? { draftSections } : {}),
      ...(detectedCustomClassNames.length > 0
        ? { customClassNames: detectedCustomClassNames }
        : {}),
      ...(sourceBackedAuxiliaryLabels.length > 0
        ? { sourceBackedAuxiliaryLabels }
        : {}),
      ...(planningSource?.sourceLabel
        ? { planningSourceLabel: planningSource.sourceLabel }
        : {}),
      ...(planningSource?.sourceReason
        ? { planningSourceReason: planningSource.sourceReason }
        : {}),
      ...(planningSource?.sourceFile
        ? { planningSourceFile: planningSource.sourceFile }
        : {}),
      ...(planningSource?.sourceAnalysis
        ? { planningSourceSummary: planningSource.sourceAnalysis }
        : {}),
      visualPlan,
    };
  }

  private async requestVisualPlanCompletion(input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    truncated?: boolean;
  }> {
    const { model, systemPrompt, userPrompt, maxTokens } = input;
    return this.llmFactory.chat({
      model,
      systemPrompt,
      userPrompt,
      maxTokens,
    });
  }

  private buildDeterministicVisualPlanForComponent(
    componentPlan: PlanResult[number],
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
    globalPalette: ColorPalette,
    globalTypography: TypographyTokens,
    fullPlan: PlanResult,
  ): ComponentVisualPlan | undefined {
    const layout = this.deriveComponentLayout(
      tokens,
      componentPlan.componentName,
    );
    const dataNeeds = this.toVisualDataNeeds(componentPlan.dataNeeds);
    const base = {
      componentName: componentPlan.componentName,
      dataNeeds,
      palette: globalPalette,
      typography: globalTypography,
      layout,
      blockStyles: tokens?.blockStyles,
    } as const;
    const strategy = getComponentStrategy(componentPlan.componentName);
    const isFixedBoundPageDetail =
      componentPlan.fixedSlug &&
      componentPlan.type === 'page' &&
      componentPlan.isDetail === true &&
      dataNeeds.includes('pageDetail');

    if (isFixedBoundPageDetail) {
      const normalizedTemplate = this.normalizeTemplateIdentifier(
        componentPlan.templateName,
      );
      const hasSidebarTemplate =
        /sidebar/.test(normalizedTemplate) ||
        /withsidebar|sidebar/i.test(componentPlan.componentName);
      const richBoundPageSections = this.buildRichBoundPageDetailSections(
        componentPlan,
        content,
        tokens,
      );
      if (richBoundPageSections?.length) {
        return {
          ...base,
          layout: hasSidebarTemplate
            ? { ...layout, contentLayout: 'sidebar-right' as const }
            : layout,
          sections: hasSidebarTemplate
            ? [
                ...richBoundPageSections,
                {
                  type: 'sidebar' as const,
                  title: 'Explore',
                  showSiteInfo: false,
                  showPages: true,
                  showPosts: content.posts.length > 0,
                  maxItems: 8,
                },
              ]
            : richBoundPageSections,
        };
      }
      return {
        ...base,
        layout: hasSidebarTemplate
          ? { ...layout, contentLayout: 'sidebar-right' as const }
          : layout,
        sections: hasSidebarTemplate
          ? [
              { type: 'page-content', showTitle: true },
              {
                type: 'sidebar',
                title: 'Explore',
                showSiteInfo: false,
                showPages: true,
                showPosts: content.posts.length > 0,
                maxItems: 8,
              },
            ]
          : [{ type: 'page-content', showTitle: true }],
      };
    }

    switch (strategy.kind) {
      case 'not-found':
        return {
          ...base,
          sections: [
            {
              type: 'hero',
              layout: 'centered',
              heading: 'Page not found',
              subheading:
                'The page you are looking for does not exist or may have moved.',
              cta: { text: 'Back to home', link: '/' },
            },
          ],
        };
      case 'header':
        // When deterministicFirst is false the AI reads the actual WP template
        // to generate a faithful visual plan — skip the generic navbar stub.
        if (!strategy.deterministicFirst) return undefined;
        return {
          ...base,
          sections: [
            {
              type: 'navbar',
              sticky: true,
              menuSlug: content.menus[0]?.slug ?? 'primary',
              orientation: 'horizontal',
              overlayMenu: 'mobile',
              isResponsive: true,
            },
          ],
        };
      case 'footer':
        // Same as header — let AI derive the real layout from the WP template.
        if (!strategy.deterministicFirst) return undefined;
        return {
          ...base,
          sections: [
            {
              type: 'footer',
              menuColumns: content.menus.slice(0, 3).map((menu) => ({
                title: menu.name,
                menuSlug: menu.slug,
              })),
              showSiteLogo: true,
              showSiteTitle: true,
              showTagline: true,
            },
          ],
        };
      case 'sidebar':
        return {
          ...base,
          sections: [
            {
              type: 'sidebar',
              title: 'Explore',
              showSiteInfo: false,
              showPages: true,
              showPosts: content.posts.length > 0,
              maxItems: 6,
            },
          ],
        };
      case 'breadcrumb':
        return {
          ...base,
          sections: [{ type: 'breadcrumb' }],
        };
      case 'comments':
        return {
          ...base,
          sections: [
            {
              type: 'comments',
              showForm: true,
              requireName: true,
              requireEmail: false,
            },
          ],
        };
      default:
        return undefined;
    }
  }

  private shouldSkipAiVisualPlan(componentPlan: PlanResult[number]): boolean {
    if (componentPlan.type !== 'partial') return false;
    return getComponentStrategy(componentPlan.componentName).skipAiVisualPlan;
  }

  // ── Global typography: deterministic from theme tokens, no AI ────────────

  private deriveGlobalTypography(tokens?: ThemeTokens): TypographyTokens {
    const d: ThemeDefaults = tokens?.defaults ?? {};
    const fontSizeMap = new Map<string, string>(
      tokens?.fontSizes.map((f) => [f.slug, f.size]) ?? [],
    );
    const fontMap = new Map<string, string>(
      tokens?.fonts.map((f) => [f.slug, f.family]) ?? [],
    );

    const pickSize = (...slugs: string[]): string | undefined => {
      for (const s of slugs) {
        const v = fontSizeMap.get(s);
        if (v) return v;
      }
      return undefined;
    };

    const headingFamily =
      d.headingFontFamily ??
      fontMap.get('heading') ??
      fontMap.get('headings') ??
      d.fontFamily ??
      'inherit';

    const bodyFamily =
      d.fontFamily ?? fontMap.get('body') ?? fontMap.get('base') ?? 'inherit';

    const h1Size =
      d.headings?.h1?.fontSize ??
      pickSize('xx-large', 'x-large', 'huge') ??
      '2.5rem';
    const h2Size =
      d.headings?.h2?.fontSize ?? pickSize('x-large', 'large') ?? '2rem';
    const h3Size =
      d.headings?.h3?.fontSize ?? pickSize('large', 'medium') ?? '1.5rem';
    const bodySize =
      d.fontSize ?? pickSize('medium', 'normal', 'base') ?? '1rem';

    return {
      headingFamily,
      bodyFamily,
      h1: `text-[${h1Size}] leading-tight`,
      h2: `text-[${h2Size}] leading-snug`,
      h3: `text-[${h3Size}] leading-snug`,
      body: `text-[${bodySize}]`,
      small: 'text-sm',
      buttonRadius: this.radiusToClass(d.buttonBorderRadius),
    };
  }

  private radiusToClass(radius?: string): string {
    if (!radius) return 'rounded';
    const normalized = radius.trim();
    if (normalized === '0' || normalized === '0px') return 'rounded-none';
    if (normalized.includes('9999')) return 'rounded-full';
    const n = parseFloat(radius);
    if (!Number.isNaN(n) && n >= 9999) return 'rounded-full';
    return `rounded-[${normalized}]`;
  }

  async writeArtifact(
    logPath: string | undefined,
    fileName: string,
    payload: unknown,
  ): Promise<void> {
    if (!logPath) return;
    try {
      const targetPath = this.buildPlannerArtifactPath(logPath, fileName);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error: any) {
      this.logger.warn(
        `[Planner Artifact] Failed to write ${fileName}: ${error?.message ?? error}`,
      );
    }
  }

  private buildPlannerArtifactPath(logPath: string, fileName: string): string {
    const normalized = logPath.replace(/\\/g, '/');
    const baseDir = normalized.endsWith('.json')
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : normalized;
    return `${baseDir}/${fileName}`.replace(/\//g, '\\');
  }

  async writeSplitComponentPlanArtifacts(
    logPath: string | undefined,
    artifactPrefix: string,
    payload: {
      stage?: string;
      generatedAt?: string;
      attempt?: number;
      isValid?: boolean;
      errors?: string[];
      plan?: PlanResult;
      warnings?: string[];
      blockingIssues?: string[];
      strictReview?: boolean;
    },
  ): Promise<void> {
    const plan = Array.isArray(payload.plan) ? payload.plan : [];
    if (!logPath || plan.length === 0) return;

    const generatedAt = payload.generatedAt ?? new Date().toISOString();
    const groups: Array<{
      type: ComponentPlan['type'];
      bucketName: 'pages' | 'partials';
    }> = [
      { type: 'page', bucketName: 'pages' },
      { type: 'partial', bucketName: 'partials' },
    ];

    for (const group of groups) {
      const componentPlans = plan.filter((item) => item.type === group.type);
      if (componentPlans.length === 0) continue;

      const manifest = componentPlans.map((componentPlan) => {
        const fileName = this.buildSplitPlanComponentFileName(componentPlan);
        return {
          componentName: componentPlan.componentName,
          templateName: componentPlan.templateName,
          route: componentPlan.route,
          fixedSlug: componentPlan.fixedSlug,
          file: `${artifactPrefix}.${group.bucketName}/${fileName}`,
        };
      });

      await this.writeArtifact(
        logPath,
        `${artifactPrefix}.${group.bucketName}/manifest.json`,
        {
          stage: payload.stage ?? 'planner-final',
          generatedAt,
          attempt: payload.attempt,
          isValid: payload.isValid,
          count: manifest.length,
          componentType: group.type,
          [group.bucketName]: manifest,
          warnings: payload.warnings,
          errors: payload.errors,
          blockingIssues: payload.blockingIssues,
          strictReview: payload.strictReview,
        },
      );

      for (let index = 0; index < componentPlans.length; index++) {
        const componentPlan = componentPlans[index];
        const entry = manifest[index];
        await this.writeArtifact(logPath, entry.file, {
          stage: payload.stage ?? 'planner-final',
          generatedAt,
          attempt: payload.attempt,
          isValid: payload.isValid,
          warnings: payload.warnings,
          errors: payload.errors,
          blockingIssues: payload.blockingIssues,
          strictReview: payload.strictReview,
          componentName: componentPlan.componentName,
          templateName: componentPlan.templateName,
          route: componentPlan.route,
          fixedSlug: componentPlan.fixedSlug,
          type: componentPlan.type,
          componentPlan,
        });
      }
    }
  }

  private buildSplitPlanComponentFileName(
    componentPlan: Pick<
      ComponentPlan,
      'componentName' | 'route' | 'fixedSlug' | 'templateName'
    >,
  ): string {
    const preferredName =
      componentPlan.fixedSlug?.trim() ||
      componentPlan.route?.trim().replace(/^\/+|\/+$/g, '').replace(/\//g, '__') ||
      componentPlan.componentName ||
      componentPlan.templateName;
    const safeName = preferredName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
    const componentSuffix = componentPlan.componentName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${safeName || 'page'}--${componentSuffix || 'component'}.json`;
  }

  // ── Layout hints: map extracted theme tokens to generator-friendly classes ─
  // This step does not parse source theme files directly. It only converts the
  // already-merged ThemeTokens into a small layout contract that the visual
  // planner / code generator can reuse consistently.

  private deriveComponentLayout(
    tokens: ThemeTokens | undefined,
    componentName: string,
  ): LayoutTokens {
    const d: ThemeDefaults = tokens?.defaults ?? {};
    const imageRadius =
      tokens?.blockStyles?.image?.border?.radius ??
      tokens?.blockStyles?.gallery?.border?.radius;
    const cardRadius =
      tokens?.blockStyles?.group?.border?.radius ??
      tokens?.blockStyles?.column?.border?.radius ??
      tokens?.blockStyles?.quote?.border?.radius ??
      tokens?.blockStyles?.pullquote?.border?.radius ??
      tokens?.blockStyles?.cover?.border?.radius;
    const cardPadding =
      tokens?.blockStyles?.group?.spacing?.padding ??
      tokens?.blockStyles?.column?.spacing?.padding ??
      tokens?.blockStyles?.quote?.spacing?.padding ??
      tokens?.blockStyles?.pullquote?.spacing?.padding;
    const isSidebarLayout = /WithSidebar$/i.test(componentName);

    // WordPress contentSize is usually the prose/article width, not the outer
    // shell width for heroes, cards, grids, headers, footers, or sidebars.
    // Likewise, rootPadding from theme defaults is a site-shell concern and is
    // intentionally NOT propagated into per-component layout tokens, because it
    // causes generated pages to double-pad and look unnaturally narrow.
    const sectionMaxW = d.wideWidth ?? '1280px';
    const contentMaxW = d.contentWidth ?? '800px';
    const containerClass = `max-w-[${sectionMaxW}] mx-auto w-full`;
    const contentContainerClass = `max-w-[${contentMaxW}] mx-auto w-full`;

    const blockGap = d.blockGap ? `gap-[${d.blockGap}]` : 'gap-16';

    // Header/Footer are rendered by the shared Layout wrapper (preview-builder
    // generates Layout.tsx that wraps all Routes). Page components must NOT import
    // them directly — doing so causes Header/Footer to appear twice on screen.
    const includes: string[] = [];

    return {
      containerClass,
      contentContainerClass,
      blockGap,
      contentLayout: isSidebarLayout ? 'sidebar-right' : 'single-column',
      sidebarWidth: '320px',
      buttonPadding: d.buttonPadding,
      imageRadius,
      cardRadius,
      cardPadding,
      includes,
    };
  }

  // ── Global palette: deterministic from theme tokens, no AI ───────────────

  private deriveGlobalPalette(tokens?: ThemeTokens): ColorPalette {
    const d: ThemeDefaults = tokens?.defaults ?? {};
    const colorMap = new Map<string, string>(
      tokens?.colors.map((c) => [c.slug, c.value]) ?? [],
    );

    const pick = (...slugs: string[]): string | undefined => {
      for (const s of slugs) {
        const v = colorMap.get(s);
        if (v) return v;
      }
      return undefined;
    };

    return {
      background: d.bgColor ?? pick('background', 'base', 'white') ?? '#ffffff',
      surface: pick('surface', 'secondary', 'light') ?? '#f5f5f5',
      text: d.textColor ?? pick('foreground', 'contrast', 'dark') ?? '#111111',
      textMuted: d.captionColor ?? pick('secondary-text', 'muted') ?? '#666666',
      accent:
        d.linkColor ??
        d.buttonBgColor ??
        pick('primary', 'accent', 'contrast-3') ??
        '#0066cc',
      accentText: d.buttonTextColor ?? pick('base', 'white') ?? '#ffffff',
      dark: pick('dark', 'contrast') ?? d.textColor,
      darkText: pick('light', 'base', 'white') ?? d.bgColor,
    };
  }

  // ── Layer 2: enrich dataNeeds by scanning template source ─────────────────

  private enrichPlan(
    plan: PlanResult,
    sourceMap: Map<string, string>,
  ): PlanResult {
    const hasSharedChromePartials = plan.some(
      (candidate) =>
        candidate.type === 'partial' &&
        /^(header|footer|nav|navigation)(?:[-_].+)?$/i.test(
          candidate.componentName,
        ),
    );

    return plan.map((item) => {
      const source = sourceMap.get(item.templateName) ?? '';
      const needs = new Set(item.dataNeeds);
      const ownsSharedChromeData =
        item.type === 'partial' || !hasSharedChromePartials;
      const componentKey =
        `${item.componentName} ${item.templateName}`.toLowerCase();
      const isFooterPartial =
        item.type === 'partial' &&
        /(^|[\s/_-])footer(?:$|[\s/_-])/.test(componentKey);
      const isHeaderLikePartial =
        item.type === 'partial' &&
        /(^|[\s/_-])(header|nav|navigation)(?:$|[\s/_-])/.test(componentKey);

      // Determine whether this template renders a page (page-detail) or a post (post-detail)
      // based on the template name, which is authoritative at this stage.
      const templateBase = item.templateName
        .replace(/\.(php|html)$/i, '')
        .toLowerCase();
      const isPageTemplate =
        templateBase.startsWith('page') || templateBase === 'frontend-page';
      const detailNeed = isPageTemplate ? 'page-detail' : 'post-detail';

      // FSE block theme
      if (
        source.includes('wp:navigation') ||
        source.includes('block:"navigation"') ||
        source.includes('"navigation"')
      )
        if (ownsSharedChromeData) {
          if (isFooterPartial) needs.add('footer-links');
          else needs.add('menus');
        }
      if (source.includes('wp:query') || source.includes('"query"'))
        needs.add('posts');
      if (
        source.includes('wp:post-content') ||
        source.includes('"post-content"')
      )
        needs.add(detailNeed);
      if (
        source.includes('wp:site-title') ||
        source.includes('"site-title"') ||
        source.includes('wp:site-tagline')
      )
        if (ownsSharedChromeData) needs.add('site-info');

      // Classic PHP theme
      if (
        source.includes('{/* WP: <Header />') ||
        source.includes('{/* WP: <Navigation />') ||
        source.includes('{/* WP: <Footer />')
      )
        if (ownsSharedChromeData) {
          if (isFooterPartial) needs.add('footer-links');
          else needs.add('menus');
        }
      if (source.includes('{/* WP: loop start */}')) needs.add('posts');
      if (
        source.includes('{/* WP: post.content') ||
        source.includes('{/* WP: post.title')
      )
        needs.add(detailNeed);
      if (
        source.includes('{/* WP: comments') ||
        source.includes('comments_template')
      )
        needs.add('comments');

      // FSE block: comments block inside single post template
      if (
        source.includes('wp:comments') ||
        source.includes('"comments"') ||
        source.includes('"comment-template"')
      )
        needs.add('comments');

      if (isFooterPartial && ownsSharedChromeData) {
        needs.add('footer-links');
        needs.add('site-info');
        needs.delete('menus');
      }
      if (isHeaderLikePartial && ownsSharedChromeData) {
        needs.delete('footer-links');
      }

      // When the plan already has dedicated Header/Footer/Nav partials, page
      // components must not keep site chrome data needs for duplicated layout.
      if (item.type === 'page' && hasSharedChromePartials) {
        needs.delete('menus');
        needs.delete('site-info');
        needs.delete('footer-links');
      }

      return { ...item, dataNeeds: Array.from(needs) };
    });
  }

  private materializeConcretePagePlans(
    plan: PlanResult,
    content: DbContentResult,
  ): PlanResult {
    const result: PlanResult = [];
    const usedComponentNames = new Set<string>();
    let materializedCount = 0;

    for (const item of plan) {
      if (item.fixedSlug || !this.shouldExpandConcretePages(item)) {
        result.push(item);
        usedComponentNames.add(item.componentName);
        continue;
      }

      const matchedPages = this.findConcretePagesForTemplate(item, content);
      if (matchedPages.length === 0) {
        result.push(item);
        usedComponentNames.add(item.componentName);
        continue;
      }

      for (const page of matchedPages) {
        const route = this.buildConcretePageRoute(page, content);
        const componentName = this.buildConcretePageComponentName(
          page,
          route,
          usedComponentNames,
        );
        result.push({
          ...item,
          componentName,
          route,
          isDetail: true,
          fixedSlug: page.slug,
          fixedPageId: page.id,
          fixedTitle: page.title,
          description: this.buildConcretePageDescription(item, page, route),
          visualPlan: undefined,
          planningSourceLabel: undefined,
          planningSourceReason: undefined,
          planningSourceFile: undefined,
          planningSourceSummary: undefined,
        });
        usedComponentNames.add(componentName);
        materializedCount += 1;
      }
    }

    if (materializedCount > 0) {
      this.logger.log(
        `[Phase B: Concrete Page Expansion] Materialized ${materializedCount} exact page component(s) from DB page bindings`,
      );
    }

    return result;
  }

  private shouldExpandConcretePages(item: PlanResult[number]): boolean {
    if (item.type !== 'page') return false;
    if (!item.isDetail) return false;
    if (!Array.isArray(item.dataNeeds)) return false;

    const normalizedNeeds = new Set(item.dataNeeds.map((need) => need.trim()));
    if (!normalizedNeeds.has('page-detail')) return false;

    const templateBase = item.templateName
      .replace(/\.(php|html)$/i, '')
      .toLowerCase();
    return templateBase.startsWith('page') || templateBase === 'frontend-page';
  }

  private findConcretePagesForTemplate(
    componentPlan: PlanResult[number],
    content: DbContentResult,
  ): DbContentResult['pages'] {
    if (componentPlan.type !== 'page') return [];

    const templateName = this.normalizeTemplateIdentifier(
      componentPlan.templateName,
    );
    const frontPageId = content.readingSettings?.pageOnFrontId;
    const postsPageId = content.readingSettings?.pageForPostsId;

    return content.pages
      .filter((page) => {
        if (!page.slug?.trim()) return false;
        if (page.id === frontPageId) return false;
        if (page.id === postsPageId) return false;

        const pageTemplate = this.normalizeTemplateIdentifier(page.template);
        if (templateName === 'page') {
          return pageTemplate === '' || pageTemplate === 'default';
        }
        return pageTemplate === templateName;
      })
      .sort((a, b) => {
        const routeCompare = this.buildConcretePageRoute(
          a,
          content,
        ).localeCompare(this.buildConcretePageRoute(b, content));
        if (routeCompare !== 0) return routeCompare;
        return String(a.id).localeCompare(String(b.id));
      });
  }

  private buildConcretePageRoute(
    page: DbContentResult['pages'][number],
    content: DbContentResult,
  ): string {
    const slug = page.slug?.trim();
    if (slug) return `/page/${slug}`;

    const fallbackSlug = String(page.id ?? '').trim();
    return fallbackSlug ? `/page/${fallbackSlug}` : '/page';
  }

  private buildConcretePageComponentName(
    page: DbContentResult['pages'][number],
    route: string,
    usedNames: Set<string>,
  ): string {
    const routeSegments = route
      .split('/')
      .filter(Boolean)
      .map((segment) =>
        segment
          .split(/[^a-zA-Z0-9]+/)
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(''),
      )
      .filter(Boolean);
    const baseName = `Page${routeSegments.join('') || this.toComponentName(page.slug || String(page.id))}`;
    let candidate = baseName;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${baseName}${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private buildConcretePageDescription(
    basePlan: PlanResult[number],
    page: DbContentResult['pages'][number],
    route: string,
  ): string {
    const title =
      String(page.title ?? '').trim() || String(page.slug ?? page.id);
    const baseDescription = String(basePlan.description ?? '').trim();
    const prefix = baseDescription
      ? `${baseDescription} Exact page binding for`
      : 'Exact page binding for';
    return `${prefix} "${title}" at route "${route}" using fixed page slug "${page.slug}".`;
  }

  private buildSystemPrompt(): string {
    return `You are a WordPress-to-React architecture planner.
Given a list of WordPress theme templates and the site's database content, you output a JSON plan describing how each template maps to a React component.

For each template, decide:
1. Is it a page (has its own route) or a partial (used inside pages — header, footer, sidebar, navigation, etc.)?
2. What route should it have? Use React Router v6 path syntax.
3. What data does it need from the API?
4. Is it a detail view that needs useParams() to fetch by slug?
5. Write a concise 1-2 sentence description of what the component renders.
6. The description MUST mention the major source-backed structure or widgets when they exist
   (for example hero, slider, modal, cover, multi-column features, query grid, comments, sidebar).
7. Avoid generic descriptions like "page showing content" when the source clearly contains richer structure.

── ROUTING RULES ──────────────────────────────────────────────────────────────
- frontend-page → route "/"
- home → route "/" ONLY when no frontend-page template exists; otherwise route "/blog"
- index → route "/" ONLY when neither frontend-page nor home exists; otherwise route "/index"
- archive → route "/archive"  (WordPress archive fallback: handles category/tag/author/date archives — App.tsx will register alias routes /category/:slug, /author/:slug, /tag/:slug pointing to this component)
- search → route "/search"
- 404 → route "*"
- single / single-post → route "/post/:slug"   (isDetail: true)
- page (the default page template) → route "/page/:slug"   (isDetail: true)
- Every OTHER page template → route "/<exact-template-name>/:slug"  (isDetail: true)
  e.g. template "single-with-sidebar" → "/single-with-sidebar/:slug"
       template "page-custom"         → "/page-custom/:slug"
  The route segment MUST match the template name exactly — do NOT invent a different name.
- header / footer / sidebar / nav / navigation / searchform / comments / comment /
  post-meta / widget / breadcrumb / pagination / loop / content-none / no-results /
  functions → type "partial", route null

── DATA NEEDS RULES ───────────────────────────────────────────────────────────
Allowed values: "posts" | "pages" | "menus" | "site-info" | "footer-links" | "post-detail" | "page-detail" | "comments"

- "post-detail"  → ONLY for single-post templates (route /post/:slug or /single-*/:slug)
- "page-detail"  → ONLY for page templates (route /page/:slug or /page-*/:slug)
- Page templates MUST use "page-detail" — NEVER "post-detail"
- Partial components (type "partial") MUST NOT include "post-detail" or "page-detail"
- Archive / listing pages use "posts", not "post-detail"
- Dedicated Header / Navigation partials may include "menus"
- Dedicated Footer partials should use "footer-links" for footer columns and may include "site-info" for brand/title/tagline
- Ordinary page components MUST NOT request "menus", "site-info", or "footer-links" just because the original WordPress template referenced shared header/footer chrome.
- Global chrome belongs to shared layout partials. Page components MUST NOT own header/footer/navigation data.
- If a page template has a content sidebar, keep it content-only (recent posts / page links). Do NOT model shared nav menus or site branding inside a page sidebar.

── UNIQUE ROUTES ──────────────────────────────────────────────────────────────
Every page component MUST have a different route.
If a conflict would arise, use the template name to disambiguate (see routing rules above).
Never assign the same route to two different components.

── TEMPLATE NAME CONTRACT ─────────────────────────────────────────────────────
"templateName" MUST exactly match one of the provided template names.
Do not add ".php" or ".html" unless it is already present in the provided name.
Do not append notes such as "(DB: ...)" or any explanation to templateName.

OUTPUT FORMAT — respond with ONLY a valid JSON array, no markdown fences, no explanation:
[
  {
    "templateName": "index",
    "componentName": "Index",
    "type": "page",
    "route": "/",
    "dataNeeds": ["posts"],
    "isDetail": false,
    "description": "Main blog/home page with source-backed hero sections, interactive widgets, and a posts listing area."
  },
  ...
]`;
  }

  private buildUserPrompt(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    templateNames: string[],
    sourceMap: Map<string, string>,
    repoManifest?: RepoThemeManifest,
    editRequestContext?: string,
  ): string {
    const lines: string[] = [];
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    const templateMap = new Map(
      allTemplates.map((template) => [template.name, template] as const),
    );
    const templates = templateNames
      .map((name) => templateMap.get(name))
      .filter(
        (
          template,
        ): template is
          | { name: string; html: string }
          | { name: string; markup: string } => !!template,
      );

    lines.push(`## Theme`);
    lines.push(
      `Type: ${theme.type === 'fse' ? 'Full Site Editing (Block)' : 'Classic PHP'}`,
    );
    lines.push('');

    const repoContext = buildRepoManifestContextNote(repoManifest);
    if (repoContext) {
      lines.push(repoContext);
      lines.push('');
    }

    lines.push('## Templates to plan (name → key block types found inside):');
    for (const t of templates) {
      const source = 'markup' in t ? t.markup : t.html;
      const hints = this.extractTemplateHints(source);
      lines.push(`- ${t.name}${hints ? ` [${hints}]` : ''}`);
    }
    lines.push('');

    lines.push('## Site info');
    lines.push(`Site name: ${content.siteInfo.siteName}`);
    lines.push(`Site URL: ${content.siteInfo.siteUrl}`);
    lines.push('');

    lines.push('## Reading settings');
    lines.push(
      `show_on_front: ${content.readingSettings?.showOnFront ?? 'posts'}`,
    );
    lines.push(
      `page_on_front: ${content.readingSettings?.pageOnFrontId ?? '(none)'}`,
    );
    lines.push(
      `page_for_posts: ${content.readingSettings?.pageForPostsId ?? '(none)'}`,
    );
    lines.push('');

    lines.push('## Runtime capabilities');
    lines.push(
      `Active plugins: ${content.capabilities.activePluginSlugs.join(', ') || '(none)'}`,
    );
    lines.push('');

    if (content.discovery.elementorWidgetTypes.length > 0) {
      lines.push('## Elementor widget types in use');
      lines.push(content.discovery.elementorWidgetTypes.join(', '));
      lines.push(
        'npm package hints: slides/carousel → swiper, form → react-hook-form, ' +
          'popup → @radix-ui/react-dialog, accordion → @radix-ui/react-accordion, ' +
          'tabs → @radix-ui/react-tabs, video → react-player, countdown → react-countdown, ' +
          'google-maps → @react-google-maps/api',
      );
      lines.push('');
    }

    if (content.discovery.topBlockTypes.length > 0) {
      lines.push('## Gutenberg block types in use');
      lines.push(content.discovery.topBlockTypes.join(', '));
      lines.push('');
    }

    if (content.discovery.topShortcodes.length > 0) {
      lines.push('## Shortcodes found in content');
      lines.push(content.discovery.topShortcodes.join(', '));
      lines.push('');
    }

    lines.push(`## Pages in database (${content.pages.length} total):`);
    for (const p of content.pages.slice(0, 20)) {
      lines.push(
        `- slug: "${p.slug}" title: "${p.title}" template: "${p.template || 'default'}"`,
      );
    }
    lines.push('');

    lines.push(`## Menus in database (${content.menus.length} total):`);
    for (const m of content.menus) {
      lines.push(`- "${m.name}" (slug: ${m.slug}) — ${m.items.length} items`);
    }
    lines.push('');

    lines.push(`## Posts: ${content.posts.length} total`);
    lines.push('');

    lines.push('## Template evidence');
    for (const t of templates) {
      const source = 'markup' in t ? t.markup : t.html;
      const evidenceLines = this.buildPlannerTemplateEvidence(
        t.name,
        source,
        sourceMap,
        content,
      );
      lines.push(`### ${t.name}`);
      lines.push(...evidenceLines);
      lines.push('');
    }

    if (editRequestContext) {
      lines.push('');
      lines.push(editRequestContext);
    }

    return lines.join('\n');
  }

  private tryParseResponseDetailed(
    raw: string,
    expectedTemplateNames: string[],
  ): {
    plan: PlanResult | null;
    reason: string;
  } {
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err: any) {
      return {
        plan: null,
        reason: `invalid JSON: ${err?.message ?? 'unknown parse error'}`,
      };
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        plan: null,
        reason: 'parsed output is not a non-empty array',
      };
    }

    const valid = (parsed as any[])
      .filter(
        (item) =>
          item &&
          typeof item.templateName === 'string' &&
          typeof item.componentName === 'string' &&
          (item.type === 'page' || item.type === 'partial'),
      )
      .map((item) => ({
        ...item,
        templateName: this.normalizeTemplateNameToExpected(
          item.templateName,
          expectedTemplateNames,
        ),
      }));

    if (valid.length === 0) {
      return {
        plan: null,
        reason:
          'array parsed but no valid component objects were found (need templateName, componentName, type)',
      };
    }

    if (valid.length !== (parsed as any[]).length) {
      return {
        plan: null,
        reason: `response contained invalid items: kept ${valid.length}/${(parsed as any[]).length} valid objects`,
      };
    }

    const expected = new Set(expectedTemplateNames);
    const seen = new Set<string>();
    const missing: string[] = [];
    const unexpected: string[] = [];
    const duplicates: string[] = [];

    for (const item of valid as PlanResult) {
      if (!expected.has(item.templateName)) {
        unexpected.push(item.templateName);
      }
      if (seen.has(item.templateName)) {
        duplicates.push(item.templateName);
      }
      seen.add(item.templateName);
    }

    for (const templateName of expectedTemplateNames) {
      if (!seen.has(templateName)) {
        missing.push(templateName);
      }
    }

    // Standard templates injected synthetically — AI doesn't need to produce them.
    // Small numbers of other omissions are also tolerated because the planner
    // can inject deterministic fallback components after Phase A.
    // 'archive' is injected when neither archive/author/category exist in the theme.
    const INJECTABLE_STANDARDS = new Set(['archive']);
    const missingRequired = missing.filter((n) => !INJECTABLE_STANDARDS.has(n));
    const maxInjectableMissing = Math.max(
      1,
      Math.floor(expectedTemplateNames.length * 0.25),
    );

    if (
      missingRequired.length > maxInjectableMissing ||
      unexpected.length > 0 ||
      duplicates.length > 0
    ) {
      const reasons: string[] = [];
      if (missingRequired.length > maxInjectableMissing) {
        reasons.push(`missing templates: ${missingRequired.join(', ')}`);
      }
      if (unexpected.length > 0) {
        reasons.push(`unexpected templates: ${unexpected.join(', ')}`);
      }
      if (duplicates.length > 0) {
        reasons.push(`duplicate templates: ${duplicates.join(', ')}`);
      }
      return {
        plan: null,
        reason: reasons.join(' | '),
      };
    }

    return {
      plan: valid as PlanResult,
      reason: 'ok',
    };
  }

  private formatRawOutput(raw: string): string {
    return `${this.rawOutputDivider}${raw || '(empty)'}\n----- RAW OUTPUT END -----`;
  }

  private createVisualRepairDelegate(
    scope: 'edit-request' | 'base',
  ): PlannerVisualRepairDelegate {
    return {
      buildPlanningSourceCandidates: (
        componentPlan,
        templateSource,
        sourceMap,
        content,
      ) =>
        this.buildPlanningSourceCandidates(
          componentPlan as PlanResult[number],
          templateSource,
          sourceMap,
          content,
        ),
      buildPlanningSourceContext: (
        componentPlan,
        templateSource,
        sourceMap,
        content,
        hasSharedLayoutPartials,
      ) =>
        this.buildPlanningSourceContext(
          componentPlan as PlanResult[number],
          templateSource,
          sourceMap,
          content,
          hasSharedLayoutPartials,
        ),
      buildPlanningSourceContextFromResolvedSource: (
        componentPlan,
        preferredSource,
        hasSharedLayoutPartials,
      ) =>
        this.buildPlanningSourceContextFromResolvedSource(
          componentPlan as PlanResult[number],
          preferredSource,
          hasSharedLayoutPartials,
        ),
      buildDraftSectionsForPlanningSource: (
        planningSource,
        componentPlan,
        tokens,
      ) =>
        this.buildDraftSectionsForPlanningSource(
          planningSource,
          componentPlan as PlanResult[number],
          tokens,
        ),
      collectDraftCustomClassNames: (draftSections) =>
        this.collectDraftCustomClassNames(draftSections),
      detectInteractiveWidgetsFromSource: (source) =>
        this.detectInteractiveWidgetsFromSource(source),
      extractHeadingTextsFromSource: (source) =>
        this.extractHeadingTextsFromSource(source),
      countDraftSectionsInSource: (source) =>
        this.countDraftSectionsInSource(source),
      scorePlanningSourceRichness: (source) =>
        this.scorePlanningSourceRichness(source),
      findRepresentativePagesForTemplate: (componentPlan, content) =>
        this.findRepresentativePagesForTemplate(
          componentPlan as PlanResult[number],
          content,
        ),
      collectAllowedImageSrcs: (planningSource, content) =>
        this.collectAllowedImageSrcs(planningSource, content),
      requestVisualPlanCompletion: (input) =>
        this.requestVisualPlanCompletion(input),
      isRetryableVisualPlanError: (error) =>
        this.isRetryableVisualPlanError(error),
      delay: (ms) => this.delay(ms),
      trackVisualPlanTokens: async ({
        modelName,
        inputTokens,
        outputTokens,
        label,
      }) => {
        await this.tokenTracker.track(
          modelName,
          inputTokens,
          outputTokens,
          label,
          {
            scope,
          },
        );
      },
      deriveComponentLayout: (tokens, componentName) =>
        this.deriveComponentLayout(tokens, componentName),
      mergeDraftSectionPresentation: (sections, draftSections, contract) =>
        this.mergeDraftSectionPresentation(sections, draftSections, contract),
    };
  }

  private mergeDraftSectionPresentation(
    sections: SectionPlan[],
    draftSections?: SectionPlan[],
    contract?: VisualPlanContract,
  ): SectionPlan[] {
    if (!draftSections?.length) return sections;
    const effectiveDraft = contract
      ? sanitizeSectionsForContract(draftSections, contract).sections
      : draftSections;
    return sections.map((section, index) =>
      this.mergeDraftSection(section, effectiveDraft[index]),
    );
  }

  private mergeDraftSection(
    section: SectionPlan,
    draft?: SectionPlan,
  ): SectionPlan {
    if (!draft) return section;
    // Always carry identity fields (sectionKey, sourceRef) regardless of type
    // substitution — the AI may legitimately replace a layout hero with a
    // search, post-list, or comments section for the given component context.
    if (draft.type !== section.type) {
      return {
        ...section,
        ...(draft.sectionKey ? { sectionKey: draft.sectionKey } : {}),
        ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
      };
    }

    const mergedBase = {
      ...section,
      ...(draft.sectionKey ? { sectionKey: draft.sectionKey } : {}),
      ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
      ...(draft.background ? { background: draft.background } : {}),
      ...(draft.textColor ? { textColor: draft.textColor } : {}),
      ...(draft.paddingStyle ? { paddingStyle: draft.paddingStyle } : {}),
      ...(draft.marginStyle ? { marginStyle: draft.marginStyle } : {}),
      ...(draft.gapStyle ? { gapStyle: draft.gapStyle } : {}),
    };

    switch (section.type) {
      case 'navbar': {
        const navbarDraft = draft as typeof section;
        return {
          ...mergedBase,
          menuSlug: navbarDraft.menuSlug ?? section.menuSlug,
          sticky:
            typeof navbarDraft.sticky === 'boolean'
              ? navbarDraft.sticky
              : section.sticky,
          ...(navbarDraft.orientation
            ? { orientation: navbarDraft.orientation }
            : {}),
          ...(navbarDraft.overlayMenu
            ? { overlayMenu: navbarDraft.overlayMenu }
            : {}),
          ...(typeof navbarDraft.isResponsive === 'boolean'
            ? { isResponsive: navbarDraft.isResponsive }
            : {}),
          ...(typeof navbarDraft.showSiteLogo === 'boolean'
            ? { showSiteLogo: navbarDraft.showSiteLogo }
            : {}),
          ...(typeof navbarDraft.showSiteTitle === 'boolean'
            ? { showSiteTitle: navbarDraft.showSiteTitle }
            : {}),
          ...(navbarDraft.logoWidth
            ? { logoWidth: navbarDraft.logoWidth }
            : {}),
        } as SectionPlan;
      }
      case 'footer': {
        const footerDraft = draft as any;
        const footerSection = section as any;
        return {
          ...mergedBase,
          menuColumns:
            (footerDraft.menuColumns?.length ?? 0) > 0
              ? footerDraft.menuColumns
              : footerSection.menuColumns,
          ...(footerDraft.columnWidths
            ? { columnWidths: footerDraft.columnWidths }
            : {}),
          ...(typeof footerDraft.showSiteLogo === 'boolean'
            ? { showSiteLogo: footerDraft.showSiteLogo }
            : {}),
          ...(typeof footerDraft.showSiteTitle === 'boolean'
            ? { showSiteTitle: footerDraft.showSiteTitle }
            : {}),
          ...(typeof footerDraft.showTagline === 'boolean'
            ? { showTagline: footerDraft.showTagline }
            : {}),
          ...(footerDraft.logoWidth
            ? { logoWidth: footerDraft.logoWidth }
            : {}),
          ...(footerDraft.brandDescription
            ? { brandDescription: footerDraft.brandDescription }
            : {}),
        } as SectionPlan;
      }
      case 'hero': {
        const heroDraft = draft as typeof section;
        return {
          ...mergedBase,
          ...(heroDraft.headingStyle
            ? { headingStyle: heroDraft.headingStyle }
            : {}),
          ...(heroDraft.subheadingStyle
            ? { subheadingStyle: heroDraft.subheadingStyle }
            : {}),
        } as SectionPlan;
      }
      case 'cover': {
        const coverDraft = draft as typeof section;
        return {
          ...mergedBase,
          minHeight: coverDraft.minHeight ?? section.minHeight,
          ...(coverDraft.headingStyle
            ? { headingStyle: coverDraft.headingStyle }
            : {}),
          ...(coverDraft.subheadingStyle
            ? { subheadingStyle: coverDraft.subheadingStyle }
            : {}),
        } as SectionPlan;
      }
      case 'card-grid': {
        const cardGridDraft = draft as any;
        const cardGridSection = section as any;
        // The mapper (draft) is the authoritative source for card content.
        // If the AI returned fewer cards than the draft, restore the full list —
        // the AI tends to truncate long card arrays to save tokens.
        const draftCards: unknown[] = cardGridDraft.cards ?? [];
        const aiCards: unknown[] = cardGridSection.cards ?? [];
        const mergedCards =
          draftCards.length > aiCards.length ? draftCards : aiCards;
        return {
          ...mergedBase,
          cards: mergedCards,
          ...(cardGridDraft.columnWidths
            ? { columnWidths: cardGridDraft.columnWidths }
            : {}),
        } as SectionPlan;
      }
      case 'media-text': {
        const mediaTextDraft = draft as typeof section;
        return {
          ...mergedBase,
          ...(mediaTextDraft.columnWidths
            ? { columnWidths: mediaTextDraft.columnWidths }
            : {}),
          ...(mediaTextDraft.headingStyle
            ? { headingStyle: mediaTextDraft.headingStyle }
            : {}),
          ...(mediaTextDraft.bodyStyle
            ? { bodyStyle: mediaTextDraft.bodyStyle }
            : {}),
        } as SectionPlan;
      }
      case 'modal': {
        const modalDraft = draft as any;
        const modalSection = section as any;
        return {
          ...mergedBase,
          triggerText: modalSection.triggerText ?? modalDraft.triggerText,
          heading: modalSection.heading ?? modalDraft.heading,
          body: modalSection.body ?? modalDraft.body,
          imageSrc: modalSection.imageSrc ?? modalDraft.imageSrc,
          imageAlt: modalSection.imageAlt ?? modalDraft.imageAlt,
          cta: modalSection.cta ?? modalDraft.cta,
          layout: modalSection.layout ?? modalDraft.layout,
        } as SectionPlan;
      }
      case 'tabs': {
        const tabsDraft = draft as any;
        const tabsSection = section as any;
        const draftTabs: unknown[] = tabsDraft.tabs ?? [];
        const aiTabs: unknown[] = tabsSection.tabs ?? [];
        return {
          ...mergedBase,
          tabs: draftTabs.length > aiTabs.length ? draftTabs : aiTabs,
        } as SectionPlan;
      }
      case 'accordion': {
        const accordionDraft = draft as any;
        const accordionSection = section as any;
        const draftItems: unknown[] = accordionDraft.items ?? [];
        const aiItems: unknown[] = accordionSection.items ?? [];
        return {
          ...mergedBase,
          items: draftItems.length > aiItems.length ? draftItems : aiItems,
          ...(typeof accordionDraft.allowMultiple === 'boolean'
            ? { allowMultiple: accordionDraft.allowMultiple }
            : {}),
        } as SectionPlan;
      }
      default:
        return mergedBase as SectionPlan;
    }
  }

  private buildValidationFeedbackPrompt(
    errors: string[],
    templateNames: string[],
    editRequestContext?: string,
  ): string {
    return `Your previous plan failed validation with these errors:

${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Templates that MUST be planned: ${templateNames.join(', ')}

${editRequestContext ? `\n${editRequestContext}\n` : ''}

Fix all of the above errors and return a corrected JSON array. Key rules:
- Every required template from the normalized theme input must be represented in the plan at least once
- A page-like template may expand into multiple exact bound page components when the plan intentionally materializes concrete DB pages (for example multiple \`Page*\` entries with different \`fixedSlug\` values)
- Pages must have a non-null route starting with "/"
- Partials must have route: null, isDetail: false
- isDetail must be true when route contains :slug
- Valid dataNeeds values: posts, pages, menus, site-info, footer-links, post-detail, page-detail, comments, categoryDetail
- description must stay specific and source-backed; mention major layout/widgets when visible

Return ONLY a valid JSON array — no markdown fences, no explanation.`;
  }

  private buildRetryPrompt(
    badRaw: string,
    templateNames: string[],
    editRequestContext?: string,
  ): string {
    const preview = badRaw.slice(0, 500);
    return `Your previous response could not be parsed as a valid JSON array.

Here is the start of what you returned:
\`\`\`
${preview}${badRaw.length > 500 ? '\n... (truncated)' : ''}
\`\`\`

Templates that MUST be planned: ${templateNames.join(', ')}

${editRequestContext ? `\n${editRequestContext}\n` : ''}

Return ONLY a valid JSON array — no markdown fences, no explanation, no text before or after the array.
Each object must have: templateName, componentName, type ("page"|"partial"), route (string|null), dataNeeds (string[]), isDetail (boolean), description (string).
Descriptions must be specific and mention major source-backed structure/widgets instead of generic wording.`;
  }

  private buildVisualPlanRetryPrompt(input: {
    componentPlan: PlanResult[number];
    planningSource?: PlanningSourceContext;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    draftSections?: ReturnType<typeof mapWpNodesToDraftSections>;
    sourceWidgetHints: string[];
    allowedImageSrcs: string[];
    reason: string;
    badRaw: string;
  }): string {
    const {
      componentPlan,
      planningSource,
      sourceMap,
      content,
      draftSections,
      sourceWidgetHints,
      allowedImageSrcs,
      reason,
      badRaw,
    } = input;
    const componentName = componentPlan.componentName;
    const preview = badRaw.slice(0, 700);
    const extraRules: string[] = [];
    if (/carousel section/i.test(reason)) {
      extraRules.push(
        '- The corrected output MUST include a `carousel` section because source hints require it.',
      );
    }
    if (/modal section/i.test(reason)) {
      extraRules.push(
        '- The corrected output MUST include a `modal` section because source hints require it.',
      );
    }
    if (/accordion section/i.test(reason) || /accordion\.items/i.test(reason)) {
      extraRules.push(
        '- `accordion.items` must be a non-empty array of `{ heading, body }` objects.',
      );
    }
    if (/\"cta\"/.test(preview) || /label|href/.test(preview)) {
      extraRules.push(
        '- Use `cta.text` and `cta.link` keys, never `cta.label` or `cta.href`.',
      );
    }
    const investigationContext = this.buildVisualPlanRetryInvestigationContext({
      componentPlan,
      planningSource,
      sourceMap,
      content,
      draftSections,
      sourceWidgetHints,
      allowedImageSrcs,
      reason,
    });
    return `Your previous response for component "${componentName}" could not be parsed.

Failure reason: ${reason}

Start of previous response:
\`\`\`
${preview}${badRaw.length > 700 ? '\n... (truncated)' : ''}
\`\`\`

${extraRules.length > 0 ? `Specific corrections:\n${extraRules.join('\n')}\n\n` : ''}${investigationContext ? `${investigationContext}\n\n` : ''}Return ONLY a single valid JSON object matching ComponentVisualPlan.
Do not include markdown fences, comments, extra prose, or malformed JSON.`;
  }

  private buildDraftSectionsForPlanningSource(
    planningSource: PlanningSourceContext | undefined,
    componentPlan: PlanResult[number],
    tokens: ThemeTokens | undefined,
  ): ReturnType<typeof mapWpNodesToDraftSections> | undefined {
    try {
      const sources: PlanningSourceSupplement[] = [
        {
          source: planningSource?.source ?? '',
          label: planningSource?.sourceLabel ?? componentPlan.templateName,
          templateName:
            planningSource?.sourceTemplateName ?? componentPlan.templateName,
          sourceFile:
            planningSource?.sourceFile ??
            inferFseSourceFile(componentPlan.templateName, componentPlan.type),
        },
        ...(planningSource?.supplementalSources ?? []),
      ].filter((entry) => entry.source.trim().length > 0);
      if (sources.length === 0) return undefined;

      let mergedDraft: SectionPlan[] = [];
      for (const source of sources) {
        const parsedNodes = this.parsePlanningSourceNodes({
          source: source.source,
          templateName: source.templateName ?? componentPlan.templateName,
          sourceFile:
            source.sourceFile ??
            inferFseSourceFile(componentPlan.templateName, componentPlan.type),
        });
        if (parsedNodes.length === 0) continue;

        const nodes = this.styleResolver.resolve(parsedNodes, tokens);
        const draft = mapWpNodesToDraftSections(nodes);
        if (draft.length === 0) continue;

        mergedDraft = this.mergeDraftSectionsAcrossSources(mergedDraft, draft);
      }

      if (mergedDraft.length === 0) return undefined;

      return sanitizeSectionsForContract(mergedDraft, {
        componentType: componentPlan.type,
        route: componentPlan.route,
        isDetail: componentPlan.isDetail,
        dataNeeds: this.toVisualDataNeeds(componentPlan.dataNeeds),
        stripLayoutChrome: componentPlan.type === 'page',
        sourceBackedAuxiliaryLabels:
          planningSource?.sourceBackedAuxiliaryLabels ?? [],
      }).sections;
    } catch {
      return undefined;
    }
  }

  private buildRichBoundPageDetailSections(
    componentPlan: PlanResult[number],
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
  ): SectionPlan[] | undefined {
    const boundPage = content.pages.find(
      (page) =>
        String(page.id) === String(componentPlan.fixedPageId ?? '') ||
        page.slug === componentPlan.fixedSlug,
    );
    const source = String(boundPage?.content ?? '').trim();
    if (!source) return undefined;

    try {
      const nodes = this.styleResolver.resolve(
        this.parsePlanningSourceNodes({
          source,
          templateName: componentPlan.templateName,
          sourceFile: boundPage
            ? `db:pages/${boundPage.slug || boundPage.id}`
            : `db:pages/${componentPlan.fixedSlug}`,
        }),
        tokens,
      );
      if (nodes.length === 0) return undefined;

      const draftSections = sanitizeSectionsForContract(
        mapWpNodesToDraftSections(nodes),
        {
          componentType: componentPlan.type,
          route: componentPlan.route,
          isDetail: componentPlan.isDetail,
          dataNeeds: this.toVisualDataNeeds(componentPlan.dataNeeds),
          stripLayoutChrome: componentPlan.type === 'page',
          sourceBackedAuxiliaryLabels: [],
        },
      ).sections;
      if (!this.shouldPromoteBoundPageDetailToRichSections(draftSections)) {
        return undefined;
      }
      return draftSections;
    } catch {
      return undefined;
    }
  }

  private shouldPromoteBoundPageDetailToRichSections(
    sections: SectionPlan[] | undefined,
  ): boolean {
    if (!sections?.length) return false;
    const meaningful = sections.filter(
      (section) =>
        section.type !== 'page-content' &&
        section.type !== 'post-content' &&
        section.type !== 'sidebar' &&
        section.type !== 'navbar' &&
        section.type !== 'footer',
    );
    const interactiveTypes = new Set<SectionPlan['type']>([
      'carousel',
      'modal',
      'tabs',
      'accordion',
    ]);
    if (meaningful.some((section) => interactiveTypes.has(section.type))) {
      return true;
    }
    if (meaningful.length < 3) return false;

    const richTypes = new Set<SectionPlan['type']>([
      'hero',
      'cover',
      'media-text',
      'card-grid',
      'carousel',
      'testimonial',
      'modal',
      'tabs',
      'accordion',
    ]);
    const richSectionCount = meaningful.filter((section) =>
      richTypes.has(section.type),
    ).length;
    const distinctTypes = new Set(meaningful.map((section) => section.type)).size;

    return richSectionCount >= 2 || distinctTypes >= 3 || meaningful.length >= 4;
  }

  private parsePlanningSourceNodes(input: {
    source: string;
    templateName: string;
    sourceFile: string;
  }): WpNode[] {
    const trimmed = input.source.trim();
    if (!trimmed) return [];

    if (
      (trimmed.startsWith('[') || trimmed.startsWith('{')) &&
      trimmed.includes('"block"')
    ) {
      const parsed = JSON.parse(trimmed) as WpNode[] | WpNode;
      return ensureWpNodesHaveSourceRefs({
        nodes: Array.isArray(parsed) ? parsed : [parsed],
        templateName: input.templateName,
        sourceFile: input.sourceFile,
      });
    }

    return wpBlocksToJsonWithSourceRefs({
      markup: trimmed,
      templateName: input.templateName,
      sourceFile: input.sourceFile,
    });
  }

  private scopePlanningSourceMarkup(
    componentPlan: PlanResult[number],
    source: string,
    templateName: string,
    sourceFile: string,
    hints?: string[],
  ): string {
    let scopedSource = source;

    if (componentPlan.type === 'page') {
      scopedSource = this.stripClassicSharedIncludes(scopedSource, hints ?? []);
      scopedSource = this.stripFseSharedTemplateParts(
        scopedSource,
        hints ?? [],
      );
    }

    if (!this.looksLikeBlockMarkup(scopedSource)) {
      return scopedSource;
    }

    const bodyNodes = wpBlocksToJsonWithSourceRefs({
      markup: scopedSource,
      templateName,
      sourceFile,
    });
    if (bodyNodes.length === 0) {
      return scopedSource;
    }

    if (componentPlan.type === 'page') {
      const filteredNodes = bodyNodes.filter(
        (node) => !this.isSharedLayoutBlockNode(node),
      );
      if (filteredNodes.length !== bodyNodes.length) {
        hints?.push('removed top-level shared layout blocks from block tree');
      }
      if (filteredNodes.length > 0) {
        return wpJsonToString(filteredNodes);
      }
    }

    return wpJsonToString(bodyNodes);
  }

  private mergeDraftSectionsAcrossSources(
    existing: SectionPlan[],
    incoming: SectionPlan[],
  ): SectionPlan[] {
    if (existing.length === 0) return [...incoming];
    const merged = [...existing];
    const incomingKeys = incoming.map((section) =>
      this.buildDraftSectionKey(section),
    );
    const rebuildSeen = () =>
      new Set(merged.map((section) => this.buildDraftSectionKey(section)));
    let seen = rebuildSeen();

    for (let index = 0; index < incoming.length; index++) {
      const section = incoming[index];
      const key = incomingKeys[index];
      if (seen.has(key)) continue;

      let insertIndex = merged.length;

      for (let next = index + 1; next < incoming.length; next++) {
        const nextKey = incomingKeys[next];
        const nextIndex = merged.findIndex(
          (candidate) => this.buildDraftSectionKey(candidate) === nextKey,
        );
        if (nextIndex !== -1) {
          insertIndex = nextIndex;
          break;
        }
      }

      if (insertIndex === merged.length) {
        for (let prev = index - 1; prev >= 0; prev--) {
          const prevKey = incomingKeys[prev];
          const prevIndex = merged.findIndex(
            (candidate) => this.buildDraftSectionKey(candidate) === prevKey,
          );
          if (prevIndex !== -1) {
            insertIndex = prevIndex + 1;
            break;
          }
        }
      }

      merged.splice(insertIndex, 0, section);
      seen = rebuildSeen();
    }

    return merged;
  }

  private buildDraftSectionKey(section: SectionPlan): string {
    const normalize = (value: unknown): string =>
      String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    switch (section.type) {
      case 'hero':
        return [
          section.type,
          normalize(section.heading),
          // Strip decorators like "—\nby\n" that differ between DB and repo sources
          // for the same logical section (e.g. blog listing headings).
          normalize(section.subheading)
            .replace(/^[-–—\s]+by\s*/i, '')
            .replace(/\bno posts were found\b/gi, '')
            .trim(),
          normalize(section.layout),
        ].join('|');
      case 'cover':
        return [
          section.type,
          normalize(section.heading),
          normalize(section.subheading),
          normalize(section.imageSrc),
        ].join('|');
      case 'media-text':
        return [
          section.type,
          normalize(section.heading),
          normalize(section.body),
          normalize(section.imageSrc),
          normalize(section.imagePosition),
          (section.listItems ?? []).map((item) => normalize(item)).join('|'),
        ].join('|');
      case 'card-grid':
        return [
          section.type,
          normalize(section.title),
          normalize(section.subtitle),
          section.cards
            .slice(0, 8)
            .map((card) => `${normalize(card.heading)}:${normalize(card.body)}`)
            .join('|'),
        ].join('|');
      case 'testimonial':
        return [
          section.type,
          normalize(section.quote),
          normalize(section.authorName),
          normalize(section.authorTitle),
        ].join('|');
      case 'post-list':
        return [
          section.type,
          normalize(section.title),
          normalize(section.layout),
        ].join('|');
      case 'newsletter':
        return [
          section.type,
          normalize(section.heading),
          normalize(section.subheading),
          normalize(section.buttonText),
          normalize(section.layout),
        ].join('|');
      case 'carousel':
        return [
          section.type,
          section.slides
            .slice(0, 8)
            .map((slide) =>
              [
                normalize(slide.heading),
                normalize(slide.subheading),
                normalize(slide.imageSrc),
              ].join(':'),
            )
            .join('|'),
        ].join('|');
      case 'accordion':
        return [
          section.type,
          section.items
            .slice(0, 8)
            .map((item) => `${normalize(item.heading)}:${normalize(item.body)}`)
            .join('|'),
        ].join('|');
      case 'tabs':
        return [
          section.type,
          section.tabs
            .slice(0, 8)
            .map(
              (tab) =>
                `${normalize(tab.label)}:${normalize(tab.heading)}:${normalize(tab.body)}`,
            )
            .join('|'),
        ].join('|');
      case 'modal':
        return [
          section.type,
          normalize(section.triggerText),
          normalize(section.heading),
          normalize(section.body),
          normalize(section.imageSrc),
        ].join('|');
      default:
        return [section.type, normalize(section.sectionKey)].join('|');
    }
  }

  private pickInvestigativePlanningSource(input: {
    componentPlan: PlanResult[number];
    sourceMap: Map<string, string>;
    content: DbContentResult;
    currentPlanningSource?: PlanningSourceContext;
    previousReason: string;
  }): PlanningSourceCandidate | null {
    const {
      componentPlan,
      sourceMap,
      content,
      currentPlanningSource,
      previousReason,
    } = input;
    const focusWidgets = new Set<string>();
    if (/carousel|slider/i.test(previousReason)) focusWidgets.add('carousel');
    if (/modal/i.test(previousReason)) focusWidgets.add('modal');
    if (/accordion/i.test(previousReason)) focusWidgets.add('accordion');
    if (/tabs/i.test(previousReason)) focusWidgets.add('tabs');
    const imageSensitive = /imagesrc|image/i.test(previousReason);

    const candidates = this.buildPlanningSourceCandidates(
      componentPlan,
      currentPlanningSource?.source ?? '',
      sourceMap,
      content,
    );
    if (candidates.length === 0) return null;

    const ranked = candidates
      .map((candidate) => {
        const widgets = new Set(
          this.detectInteractiveWidgetsFromSource(candidate.source),
        );
        let score = candidate.richness + candidate.priority;
        for (const widget of focusWidgets) {
          if (widgets.has(widget)) score += 140;
        }
        if (imageSensitive) {
          score += extractStaticImageSources(candidate.source).length * 20;
        }
        if (candidate.label === currentPlanningSource?.sourceLabel) score -= 40;
        if (candidate.source === currentPlanningSource?.source) score -= 40;
        return { candidate, score };
      })
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.candidate ?? null;
  }

  private async investigateAndReplanVisualPlan(input: {
    componentPlan: PlanResult[number];
    sourceMap: Map<string, string>;
    content: DbContentResult;
    tokens: ThemeTokens | undefined;
    globalPalette: ColorPalette;
    globalTypography: TypographyTokens;
    repoManifest: RepoThemeManifest | undefined;
    modelName: string;
    logPath?: string;
    scopedEditRequest: PipelineEditRequestDto | undefined;
    visualDataNeeds: DataNeed[];
    hasSharedLayoutPartials: boolean;
    previousPlanningSource?: PlanningSourceContext;
    previousDraftSections?: ReturnType<typeof mapWpNodesToDraftSections>;
    previousReason: string;
    previousDropped: string;
    previousRaw: string;
  }): Promise<{
    visualPlan?: ComponentVisualPlan;
    planningSource: PlanningSourceContext;
    draftSections?: ReturnType<typeof mapWpNodesToDraftSections>;
    detectedCustomClassNames: string[];
    sourceBackedAuxiliaryLabels: string[];
    sourceWidgetHints: string[];
    allowedImageSrcs: string[];
    lastReason: string;
    lastDropped: string;
    lastRaw: string;
  }> {
    const {
      componentPlan,
      sourceMap,
      content,
      tokens,
      globalPalette,
      globalTypography,
      repoManifest,
      modelName,
      logPath,
      scopedEditRequest,
      visualDataNeeds,
      hasSharedLayoutPartials,
      previousPlanningSource,
      previousReason,
      previousDropped,
      previousRaw,
    } = input;

    const chosenCandidate = this.pickInvestigativePlanningSource({
      componentPlan,
      sourceMap,
      content,
      currentPlanningSource: previousPlanningSource,
      previousReason,
    });

    const planningSource = chosenCandidate
      ? this.buildPlanningSourceContextFromResolvedSource(
          componentPlan,
          chosenCandidate,
          hasSharedLayoutPartials,
        )
      : (previousPlanningSource ??
        this.buildPlanningSourceContext(
          componentPlan,
          sourceMap.get(componentPlan.templateName) ?? '',
          sourceMap,
          content,
          hasSharedLayoutPartials,
        ));

    this.logger.log(
      `[Phase C.5: Investigate/Replan] "${componentPlan.componentName}" investigating source ${previousPlanningSource?.sourceLabel ?? 'unknown'} -> ${planningSource.sourceLabel ?? 'unknown'}`,
    );

    const draftSections = this.buildDraftSectionsForPlanningSource(
      planningSource,
      componentPlan,
      tokens,
    );
    const detectedCustomClassNames =
      this.collectDraftCustomClassNames(draftSections);
    const sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
      planningSource.sourceBackedAuxiliaryLabels,
      ...(componentPlan.type === 'partial'
        ? [extractAuxiliaryLabelsFromSections(draftSections)]
        : []),
    );
    const sourceWidgetHints = this.detectInteractiveWidgetsFromSource(
      planningSource.source,
    );
    const visualContract = {
      componentType: componentPlan.type,
      route: componentPlan.route,
      isDetail: componentPlan.isDetail,
      dataNeeds: visualDataNeeds,
      stripLayoutChrome: componentPlan.type === 'page',
      sourceBackedAuxiliaryLabels,
      requiredSourceWidgets: sourceWidgetHints,
    } as const;
    const allowedImageSrcs = this.collectAllowedImageSrcs(
      planningSource.source,
      content,
    );
    const investigationContext = this.buildVisualPlanRetryInvestigationContext({
      componentPlan,
      planningSource,
      sourceMap,
      content,
      draftSections,
      sourceWidgetHints,
      allowedImageSrcs,
      reason: `${previousReason}${previousDropped}`,
    });
    const c5Note = [
      'Phase C.5 investigation is active because the previous visual plan could not be parsed.',
      `Previous failure: ${previousReason}${previousDropped}`,
      'Use the newly selected source and deterministic draft below to repair the plan instead of repeating the same structure.',
      investigationContext,
    ].join('\n');
    const { systemPrompt, userPrompt } = buildVisualPlanPrompt({
      componentName: componentPlan.componentName,
      templateSource: planningSource.source,
      content,
      tokens,
      repoManifest,
      componentType: componentPlan.type,
      route: componentPlan.route,
      isDetail: componentPlan.isDetail,
      dataNeeds: visualDataNeeds,
      sourceAnalysis: planningSource.sourceAnalysis,
      sourceBackedAuxiliaryLabels,
      sourceWidgetHints,
      draftSections,
      editRequestContextNote: [
        buildEditRequestContextNote(scopedEditRequest, {
          audience: 'visual-plan',
          componentName: componentPlan.componentName,
          route: componentPlan.route,
        }),
        c5Note,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });

    let lastRaw = previousRaw;
    let lastReason = previousReason;
    let lastDropped = previousDropped;
    let completionReceived = false;
    let inTok = 0;
    let outTok = 0;
    let lastTransportError = '';
    const maxTransportRetries = 3;

    for (
      let transportAttempt = 1;
      transportAttempt <= maxTransportRetries;
      transportAttempt++
    ) {
      try {
        if (transportAttempt > 1) {
          this.logger.log(
            `[Phase C.5: Investigate/Replan] "${componentPlan.componentName}" request retry ${transportAttempt}/${maxTransportRetries}`,
          );
        }
        const completion = await this.requestVisualPlanCompletion({
          model: modelName,
          systemPrompt,
          userPrompt,
          maxTokens: 4096,
        });
        lastRaw = completion.text;
        inTok = completion.inputTokens;
        outTok = completion.outputTokens;
        completionReceived = true;
        break;
      } catch (err: any) {
        lastTransportError = err?.message ?? String(err);
        if (
          !this.isRetryableVisualPlanError(err) ||
          transportAttempt >= maxTransportRetries
        ) {
          break;
        }
        this.logger.warn(
          `[Phase C.5: Investigate/Replan] "${componentPlan.componentName}" transient request error on attempt ${transportAttempt}/${maxTransportRetries}: ${lastTransportError} — retrying`,
        );
        await this.delay(1200 * transportAttempt);
      }
    }

    if (!completionReceived) {
      return {
        planningSource,
        draftSections,
        detectedCustomClassNames,
        sourceBackedAuxiliaryLabels,
        sourceWidgetHints,
        allowedImageSrcs,
        lastReason: lastTransportError || previousReason,
        lastDropped: previousDropped,
        lastRaw,
      };
    }

    const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
    if (tokenLogPath) {
      await this.tokenTracker.track(
        modelName,
        inTok,
        outTok,
        `${componentPlan.componentName}:visual-plan:c5`,
        {
          scope: scopedEditRequest ? 'edit-request' : 'base',
        },
      );
    }

    const parsedResult = parseVisualPlanDetailed(
      lastRaw,
      componentPlan.componentName,
      {
        allowedImageSrcs,
        contract: visualContract,
        draftSections,
      },
    );
    if (parsedResult.plan) {
      const layout = this.deriveComponentLayout(
        tokens,
        componentPlan.componentName,
      );
      const visualPlan = {
        ...parsedResult.plan,
        dataNeeds: this.toVisualDataNeeds(componentPlan.dataNeeds),
        ...(componentPlan.fixedSlug
          ? {
              pageBinding: {
                id: componentPlan.fixedPageId,
                slug: componentPlan.fixedSlug,
                title: componentPlan.fixedTitle,
                route: componentPlan.route ?? undefined,
              },
            }
          : {}),
        palette: globalPalette,
        typography: globalTypography,
        layout,
        blockStyles: tokens?.blockStyles,
        sections: this.mergeDraftSectionPresentation(
          parsedResult.plan.sections,
          draftSections,
          visualContract,
        ),
      };
      this.logger.log(
        `[Phase C.5: Investigate/Replan] "${componentPlan.componentName}" replan succeeded with ${parsedResult.plan.sections.length} sections`,
      );
      return {
        visualPlan,
        planningSource,
        draftSections,
        detectedCustomClassNames,
        sourceBackedAuxiliaryLabels,
        sourceWidgetHints,
        allowedImageSrcs,
        lastReason: '',
        lastDropped: '',
        lastRaw,
      };
    }

    lastReason =
      parsedResult.diagnostic?.reason ??
      'unknown investigate/replan parse failure';
    lastDropped = parsedResult.diagnostic?.droppedSections?.length
      ? ` | droppedSections: ${parsedResult.diagnostic.droppedSections.join('; ')}`
      : '';
    this.logger.warn(
      `[Phase C.5: Investigate/Replan] "${componentPlan.componentName}" replan failed: ${lastReason}${lastDropped}${this.formatRawOutput(lastRaw)}`,
    );

    return {
      planningSource,
      draftSections,
      detectedCustomClassNames,
      sourceBackedAuxiliaryLabels,
      sourceWidgetHints,
      allowedImageSrcs,
      lastReason,
      lastDropped,
      lastRaw,
    };
  }

  private ensureStandardTemplates(
    templates: Array<{ name: string; html?: string; markup?: string }>,
    themeType: 'classic' | 'fse',
    content?: DbContentResult,
  ): Array<{ name: string; html?: string; markup?: string }> {
    const filteredTemplates = this.filterUnusedCustomPageTemplates(
      templates,
      content,
    );
    const existingTemplateNames = new Set(
      filteredTemplates.map((t) => t.name.toLowerCase()),
    );

    // Ensure standard routes are generated even when not present in theme templates.
    // Per WordPress template hierarchy: author/category/tag pages fall back to archive.php.
    // So we inject a single 'archive' fallback instead of separate author/category templates.
    const createFallbackTemplate = (name: string, body: string) =>
      themeType === 'classic' ? { name, html: body } : { name, markup: body };

    const hasArchiveVariant =
      existingTemplateNames.has('archive') ||
      existingTemplateNames.has('author') ||
      existingTemplateNames.has('category');

    if (!hasArchiveVariant) {
      filteredTemplates.push(
        createFallbackTemplate(
          'archive',
          '<div><!-- Archive fallback: lists posts filtered by category, author, or tag --></div>',
        ),
      );
    }
    if (!existingTemplateNames.has('page')) {
      filteredTemplates.push(
        createFallbackTemplate(
          'page',
          '<div><!-- Page template fallback --></div>',
        ),
      );
    }
    return filteredTemplates;
  }

  private buildVisualPlanRetryInvestigationContext(input: {
    componentPlan: PlanResult[number];
    planningSource?: PlanningSourceContext;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    draftSections?: ReturnType<typeof mapWpNodesToDraftSections>;
    sourceWidgetHints: string[];
    allowedImageSrcs: string[];
    reason: string;
  }): string {
    const {
      componentPlan,
      planningSource,
      sourceMap,
      content,
      draftSections,
      sourceWidgetHints,
      allowedImageSrcs,
      reason,
    } = input;

    const lines: string[] = ['## Retry Investigation Context'];

    if (planningSource?.sourceLabel) {
      lines.push(`Selected source label: ${planningSource.sourceLabel}`);
    }
    if (planningSource?.sourceReason) {
      lines.push(`Selected source reason: ${planningSource.sourceReason}`);
    }
    if (sourceWidgetHints.length > 0) {
      lines.push(`Required source widgets: ${sourceWidgetHints.join(', ')}`);
    }

    const candidateLines = this.buildRetrySourceCandidateEvidence(
      componentPlan,
      sourceMap,
      content,
      planningSource,
    );
    if (candidateLines.length > 0) {
      lines.push('Additional source candidates reviewed:');
      lines.push(...candidateLines.map((line) => `- ${line}`));
    }

    const draftLines = this.buildRetryDraftEvidence(draftSections, reason);
    if (draftLines.length > 0) {
      lines.push('Deterministic draft evidence:');
      lines.push(...draftLines.map((line) => `- ${line}`));
    }

    const dbLines = this.buildRetryDbEvidence(componentPlan, content, reason);
    if (dbLines.length > 0) {
      lines.push('DB evidence reviewed:');
      lines.push(...dbLines.map((line) => `- ${line}`));
    }

    const imageLines = allowedImageSrcs
      .slice(0, 15)
      .map((src) => `allowed image: ${src}`);
    if (imageLines.length > 0) {
      lines.push('Validated static image pool:');
      lines.push(...imageLines.map((line) => `- ${line}`));
    }

    const snippetLines = this.buildRetryWidgetSnippetEvidence(
      planningSource?.source ?? '',
      sourceWidgetHints,
    );
    if (snippetLines.length > 0) {
      lines.push('Relevant widget/source snippets:');
      lines.push(...snippetLines.map((line) => `- ${line}`));
    }

    lines.push(
      'Use this investigation context to correct the JSON now. You may revise section types, restore missing source-backed widgets, and prefer richer DB/repo evidence over the failed first attempt.',
    );

    return lines.join('\n');
  }

  getExpectedTemplateNames(
    theme: PhpParseResult | BlockParseResult,
    content?: DbContentResult,
  ): string[] {
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    return this.ensureStandardTemplates(allTemplates, theme.type, content).map(
      (template) => template.name,
    );
  }

  private filterUnusedCustomPageTemplates(
    templates: Array<{ name: string; html?: string; markup?: string }>,
    content?: DbContentResult,
  ): Array<{ name: string; html?: string; markup?: string }> {
    if (!content?.pages?.length) return templates;

    const usedPageTemplates = new Set(
      content.pages
        .map((page) => this.normalizeWordPressTemplateName(page.template))
        .filter(Boolean),
    );
    if (usedPageTemplates.size === 0) return templates;

    const droppedTemplates: string[] = [];
    const nextTemplates = templates.filter((template) => {
      const normalized = this.normalizeWordPressTemplateName(template.name);
      if (!this.isOptionalCustomPageTemplate(normalized)) {
        return true;
      }
      const keep = usedPageTemplates.has(normalized);
      if (!keep) droppedTemplates.push(template.name);
      return keep;
    });

    if (droppedTemplates.length > 0) {
      this.logger.log(
        `[Phase A] Skipping unused custom page template(s): ${droppedTemplates.join(', ')}`,
      );
    }

    return nextTemplates;
  }

  private normalizeWordPressTemplateName(value?: string | null): string {
    const trimmed = String(value ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!trimmed) return '';

    const unscoped = trimmed.includes('//')
      ? (trimmed.split('//').pop() ?? trimmed)
      : trimmed;
    const base = unscoped.split('/').pop() ?? unscoped;
    return base.replace(/\.(php|html)$/i, '').toLowerCase();
  }

  private isOptionalCustomPageTemplate(templateName: string): boolean {
    return /^page-[a-z0-9-]+$/.test(templateName);
  }

  private buildFallbackPlan(templateNames: string[]): PlanResult {
    return templateNames.map((name) => {
      const componentName = this.toComponentName(name);
      const isPartial = isPartialComponentName(componentName);

      // Determine appropriate data needs based on template type
      let dataNeeds: string[] = ['posts'];
      let route: string | null = isPartial
        ? null
        : `/${componentName.toLowerCase()}`;
      let isDetail = false;

      if (name.toLowerCase() === 'archive') {
        dataNeeds = ['posts'];
        route = '/archive';
        isDetail = false;
      } else if (name.toLowerCase() === 'author') {
        dataNeeds = ['posts'];
        route = '/author/:slug';
        isDetail = true;
      } else if (name.toLowerCase() === 'category') {
        dataNeeds = ['posts'];
        route = '/category/:slug';
        isDetail = true;
      } else if (name.toLowerCase() === 'page') {
        dataNeeds = ['page-detail'];
        route = '/:slug';
        isDetail = true;
      }

      return {
        templateName: name,
        componentName,
        type: isPartial ? 'partial' : 'page',
        route,
        dataNeeds,
        isDetail,
        description: `Component generated from ${name}`,
      };
    });
  }

  /**
   * Ensures any templates the AI omitted are added deterministically after
   * Phase A so near-complete plans do not need a full retry.
   */
  private injectMissingTemplates(
    plan: PlanResult,
    templateNames: string[],
  ): PlanResult {
    const seenTemplates = new Set(plan.map((p) => p.templateName));
    const missingTemplateNames = templateNames.filter(
      (name) => !seenTemplates.has(name),
    );
    if (missingTemplateNames.length === 0) return plan;

    const fallbackByTemplate = new Map(
      this.buildFallbackPlan(missingTemplateNames).map((item) => [
        item.templateName,
        item,
      ]),
    );

    for (const name of missingTemplateNames) {
      const fallback = fallbackByTemplate.get(name);
      if (!fallback) continue;
      this.logger.log(
        `[Phase A] Injecting deterministic fallback component for missing template "${name}" → "${fallback.componentName}"`,
      );
    }

    const ordered: PlanResult = [];
    for (const name of templateNames) {
      const existing = plan.find((item) => item.templateName === name);
      if (existing) {
        ordered.push(existing);
        continue;
      }
      const fallback = fallbackByTemplate.get(name);
      if (fallback) {
        ordered.push(fallback);
      }
    }

    return ordered;
  }

  private buildPlanningSourceContext(
    componentPlan: PlanResult[number],
    templateSource: string,
    sourceMap: Map<string, string>,
    content: DbContentResult,
    hasSharedLayoutPartials: boolean,
  ): PlanningSourceContext {
    const candidates = this.buildPlanningSourceCandidates(
      componentPlan,
      templateSource,
      sourceMap,
      content,
    );
    const preferredSource = candidates[0] ?? {
      source: templateSource,
      label: `repo:${componentPlan.templateName}`,
      reason: 'default component template source',
      templateName: componentPlan.templateName,
      sourceFile: inferFseSourceFile(
        componentPlan.templateName,
        componentPlan.type,
      ),
      priority: 0,
      richness: this.scorePlanningSourceRichness(templateSource),
    };
    return this.buildPlanningSourceContextFromResolvedSource(
      componentPlan,
      preferredSource,
      hasSharedLayoutPartials,
      candidates,
    );
  }

  private buildPlanningSourceContextFromResolvedSource(
    componentPlan: PlanResult[number],
    preferredSource: PlanningSourceCandidate,
    hasSharedLayoutPartials: boolean,
    candidates: PlanningSourceCandidate[] = [],
  ): PlanningSourceContext {
    const hints: string[] = [];
    const sourceTemplateName =
      preferredSource.templateName ?? componentPlan.templateName;
    const sourceFile =
      preferredSource.sourceFile ??
      inferFseSourceFile(componentPlan.templateName, componentPlan.type);
    const scopedSource = this.scopePlanningSourceMarkup(
      componentPlan,
      preferredSource.source,
      sourceTemplateName,
      sourceFile,
      hints,
    );

    const trimmed = scopedSource.trim();
    const fallbackSource =
      trimmed.length > 0 ? trimmed : preferredSource.source;
    const preferredOrigin = this.extractPlanningSourceOrigin(
      preferredSource.label,
    );
    const supplementalSources: PlanningSourceSupplement[] = candidates
      .filter((candidate) => candidate.label !== preferredSource.label)
      .filter(
        (candidate) =>
          this.extractPlanningSourceOrigin(candidate.label) !== preferredOrigin,
      )
      .filter((candidate) =>
        this.isCompatibleSupplementalPlanningSource(
          componentPlan,
          preferredSource,
          candidate,
        ),
      )
      .slice(0, 2)
      .map((candidate) => {
        const candidateTemplateName =
          candidate.templateName ?? componentPlan.templateName;
        const candidateSourceFile =
          candidate.sourceFile ??
          inferFseSourceFile(componentPlan.templateName, componentPlan.type);
        return {
          source: this.scopePlanningSourceMarkup(
            componentPlan,
            candidate.source,
            candidateTemplateName,
            candidateSourceFile,
          ),
          label: candidate.label,
          reason: candidate.reason,
          templateName: candidateTemplateName,
          sourceFile: candidateSourceFile,
        };
      })
      .filter((candidate) => candidate.source.trim().length > 0);
    const mode = this.looksLikeBlockMarkup(preferredSource.source)
      ? 'body-only block JSON'
      : 'body-only markup';
    const summaryLines = ['## Extracted source scope'];
    summaryLines.push(`Mode: ${mode}`);
    summaryLines.push(`Selected source: ${preferredSource.label}`);
    summaryLines.push(`Selection reason: ${preferredSource.reason}`);
    summaryLines.push(
      `Selected source richness score: ${preferredSource.richness}`,
    );
    if (typeof preferredSource.selectionScore === 'number') {
      summaryLines.push(
        `Selected source combined selection score: ${preferredSource.selectionScore}`,
      );
    }
    summaryLines.push(
      `Shared Header/Footer partials in overall plan: ${hasSharedLayoutPartials ? 'yes' : 'no'}`,
    );
    summaryLines.push(
      `Component body source narrowed to route-owned content: ${componentPlan.type === 'page' ? 'yes' : 'partial/full-source'}`,
    );
    if (hints.length > 0) {
      summaryLines.push(...hints.map((hint) => `- ${hint}`));
    }
    if (candidates.length > 1) {
      summaryLines.push('Alternate source candidates considered:');
      for (const candidate of candidates.slice(0, 4)) {
        if (candidate.label === preferredSource.label) continue;
        summaryLines.push(
          `- ${candidate.label} (selectionScore=${candidate.selectionScore ?? candidate.richness}, richness=${candidate.richness}, priority=${candidate.priority})`,
        );
      }
    }
    const customClassNames =
      this.extractCustomClassNamesFromSource(fallbackSource);
    const sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
      extractSourceBackedAuxiliaryLabels({
        source: fallbackSource,
      }),
      ...(componentPlan.type === 'partial'
        ? supplementalSources.map((source) =>
            extractSourceBackedAuxiliaryLabels({
              source: source.source,
            }),
          )
        : []),
    );
    if (customClassNames.length > 0) {
      summaryLines.push(
        `Custom classes detected in source: ${customClassNames
          .slice(0, 12)
          .map((className) => `\`${className}\``)
          .join(
            ', ',
          )}${customClassNames.length > 12 ? ` (+${customClassNames.length - 12} more)` : ''}`,
      );
    }
    if (sourceBackedAuxiliaryLabels.length > 0) {
      summaryLines.push(
        `Source-backed auxiliary labels allowed for this component: ${sourceBackedAuxiliaryLabels
          .map((label) => `\`${label}\``)
          .join(', ')}`,
      );
    }
    if (supplementalSources.length > 0) {
      summaryLines.push(
        `Supplemental planning sources merged for draft extraction: ${supplementalSources
          .map((source) => `\`${source.label}\``)
          .join(', ')}`,
      );
    }
    const interactiveWidgets =
      this.detectInteractiveWidgetsFromSource(fallbackSource);
    const sampledHeadings = this.extractHeadingTextsFromSource(fallbackSource);
    const sourceImageCount = extractStaticImageSources(fallbackSource).length;
    const sourceSectionCount = this.countDraftSectionsInSource(fallbackSource);
    if (sampledHeadings.length > 0) {
      summaryLines.push(
        `Source-backed heading samples: ${sampledHeadings
          .slice(0, 8)
          .map((heading) => `"${heading}"`)
          .join(', ')}${sampledHeadings.length > 8 ? ' ...' : ''}`,
      );
    }
    if (sourceImageCount > 0) {
      summaryLines.push(`Static image sources detected: ${sourceImageCount}`);
    }
    if (sourceSectionCount > 0) {
      summaryLines.push(
        `Approximate draft section count from source: ${sourceSectionCount}`,
      );
    }
    if (interactiveWidgets.length > 0) {
      summaryLines.push(
        `Interactive/widget hints detected from source: ${interactiveWidgets
          .map((item) => `\`${item}\``)
          .join(
            ', ',
          )}. Preserve them as interactive UI where the source shows real behavior; do not flatten them into static sections by default.`,
      );
    }

    return {
      source: fallbackSource,
      sourceAnalysis: summaryLines.join('\n'),
      sourceBackedAuxiliaryLabels,
      supplementalSources,
      sourceLabel: preferredSource.label,
      sourceTemplateName,
      sourceFile,
      sourceReason: preferredSource.reason,
    };
  }

  private buildRetrySourceCandidateEvidence(
    componentPlan: PlanResult[number],
    sourceMap: Map<string, string>,
    content: DbContentResult,
    planningSource?: PlanningSourceContext,
  ): string[] {
    const candidates = this.buildPlanningSourceCandidates(
      componentPlan,
      planningSource?.source ?? '',
      sourceMap,
      content,
    )
      .filter((candidate) => candidate.label !== planningSource?.sourceLabel)
      .slice(0, 3);

    return candidates.map((candidate) => {
      const widgets = this.detectInteractiveWidgetsFromSource(candidate.source);
      const headings = this.extractHeadingTextsFromSource(candidate.source);
      const imageCount = extractStaticImageSources(candidate.source).length;
      return `${candidate.label} | score=${candidate.richness} | widgets=${widgets.join(', ') || 'none'} | images=${imageCount} | headings=${headings.slice(0, 3).join(' | ') || 'none'}`;
    });
  }

  private buildRetryDraftEvidence(
    draftSections: ReturnType<typeof mapWpNodesToDraftSections> | undefined,
    reason: string,
  ): string[] {
    if (!draftSections?.length) return [];

    const focusTypes = new Set<string>();
    if (/carousel|slider/i.test(reason)) focusTypes.add('carousel');
    if (/modal/i.test(reason)) focusTypes.add('modal');
    if (/accordion/i.test(reason)) focusTypes.add('accordion');
    if (/tabs/i.test(reason)) focusTypes.add('tabs');

    const relevant =
      focusTypes.size > 0
        ? draftSections.filter((section) => focusTypes.has(section.type))
        : draftSections.slice(0, 6);

    return relevant.slice(0, 6).map((section, index) => {
      const identity = `${section.type}${section.sectionKey ? `:${section.sectionKey}` : ''}`;
      switch (section.type) {
        case 'carousel':
          return `${identity} | slides=${section.slides.length}`;
        case 'modal':
          return `${identity} | trigger=${JSON.stringify(section.triggerText ?? '')} | heading=${JSON.stringify(section.heading ?? '')}`;
        case 'tabs':
          return `${identity} | tabs=${section.tabs
            .map((tab) => tab.label)
            .slice(0, 5)
            .join(' | ')}`;
        case 'accordion':
          return `${identity} | items=${section.items
            .map((item) => item.heading)
            .slice(0, 5)
            .join(' | ')}`;
        default:
          return `${identity} | position=${index + 1}`;
      }
    });
  }

  private buildRetryDbEvidence(
    componentPlan: PlanResult[number],
    content: DbContentResult,
    reason: string,
  ): string[] {
    const pages = this.findRepresentativePagesForTemplate(
      componentPlan,
      content,
    ).slice(0, 2);
    const lines: string[] = pages.map((page) => {
      const widgets = this.detectInteractiveWidgetsFromSource(page.content);
      const headings = this.extractHeadingTextsFromSource(page.content);
      return `page:${page.slug || page.id} | title=${JSON.stringify(page.title)} | widgets=${widgets.join(', ') || 'none'} | headings=${headings.slice(0, 4).join(' | ') || 'none'}`;
    });

    if (
      componentPlan.route === '/' &&
      /modal|carousel|accordion|tabs|image/i.test(reason)
    ) {
      const frontPage = content.readingSettings?.pageOnFrontId
        ? content.pages.find(
            (page) => page.id === content.readingSettings.pageOnFrontId,
          )
        : undefined;
      if (frontPage) {
        lines.unshift(
          `front-page-db:${frontPage.slug || frontPage.id} | title=${JSON.stringify(frontPage.title)} | widgets=${this.detectInteractiveWidgetsFromSource(frontPage.content).join(', ') || 'none'}`,
        );
      }
    }

    return lines.slice(0, 3);
  }

  private buildRetryWidgetSnippetEvidence(
    source: string,
    widgetHints: string[],
  ): string[] {
    if (!source.trim() || widgetHints.length === 0) return [];

    const patterns = widgetHints.map((hint) => {
      switch (hint) {
        case 'slider':
        case 'carousel':
          return /uagb\/slider[\s\S]{0,220}/gi;
        case 'modal':
          return /uagb\/modal[\s\S]{0,220}/gi;
        case 'tabs':
          return /uagb\/tabs[\s\S]{0,220}/gi;
        case 'accordion':
          return /(accordion|faq|content-toggle|toggle)[\s\S]{0,220}/gi;
        default:
          return null;
      }
    });

    const snippets: string[] = [];
    for (const pattern of patterns) {
      if (!pattern) continue;
      for (const match of source.matchAll(pattern)) {
        const snippet = match[0].replace(/\s+/g, ' ').trim().slice(0, 220);
        if (snippet) snippets.push(snippet);
        if (snippets.length >= 4) return snippets;
      }
    }

    return snippets;
  }

  private buildPlanningSourceCandidates(
    componentPlan: PlanResult[number],
    templateSource: string,
    sourceMap: Map<string, string>,
    content: DbContentResult,
  ): PlanningSourceCandidate[] {
    const candidates: Array<{
      source: string;
      label: string;
      templateName?: string;
      sourceFile?: string;
      priority: number;
    }> = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: {
      source?: string;
      label: string;
      templateName?: string;
      sourceFile?: string;
      priority: number;
    }) => {
      const normalized = String(candidate.source ?? '').trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push({
        source: normalized,
        label: candidate.label,
        templateName: candidate.templateName,
        sourceFile: candidate.sourceFile,
        priority: candidate.priority,
      });
    };

    if (componentPlan.fixedSlug) {
      const boundPage = content.pages.find(
        (page) =>
          String(page.id) === String(componentPlan.fixedPageId ?? '') ||
          page.slug === componentPlan.fixedSlug,
      );
      pushCandidate({
        source: boundPage?.content,
        label: boundPage
          ? `db:bound-page:${boundPage.slug || boundPage.id}`
          : `db:bound-page:${componentPlan.fixedSlug}`,
        templateName: componentPlan.templateName,
        sourceFile: boundPage
          ? `db:pages/${boundPage.slug || boundPage.id}`
          : `db:pages/${componentPlan.fixedSlug}`,
        priority: 120,
      });
    }

    pushCandidate({
      source: templateSource,
      label: `repo:${componentPlan.templateName}`,
      templateName: componentPlan.templateName,
      sourceFile: inferFseSourceFile(
        componentPlan.templateName,
        componentPlan.type,
      ),
      priority: 15,
    });

    if (componentPlan.route === '/') {
      for (const templateName of ['front-page', 'home', 'index']) {
        pushCandidate({
          source: sourceMap.get(templateName),
          label: `repo:${templateName}`,
          templateName,
          sourceFile: inferFseSourceFile(templateName, componentPlan.type),
          priority:
            templateName === 'front-page'
              ? 30
              : templateName === 'home'
                ? 20
                : 10,
        });
      }

      const frontPage = content.readingSettings?.pageOnFrontId
        ? content.pages.find(
            (page) => page.id === content.readingSettings.pageOnFrontId,
          )
        : undefined;
      pushCandidate({
        source: frontPage?.content,
        label: frontPage
          ? `db:page-on-front:${frontPage.slug || frontPage.id}`
          : 'db:page-on-front',
        templateName: componentPlan.templateName,
        sourceFile: frontPage
          ? `db:pages/${frontPage.slug || frontPage.id}`
          : 'db:pages/front-page',
        priority: content.readingSettings?.showOnFront === 'page' ? 60 : 25,
      });

      const postsPage = content.readingSettings?.pageForPostsId
        ? content.pages.find(
            (page) => page.id === content.readingSettings.pageForPostsId,
          )
        : undefined;
      pushCandidate({
        source: postsPage?.content,
        label: postsPage
          ? `db:page-for-posts:${postsPage.slug || postsPage.id}`
          : 'db:page-for-posts',
        templateName: componentPlan.templateName,
        sourceFile: postsPage
          ? `db:pages/${postsPage.slug || postsPage.id}`
          : 'db:pages/posts-page',
        priority: 45,
      });

      for (const dbTemplate of content.dbTemplates.filter((entry) =>
        ['front-page', 'home', 'index'].includes(entry.slug),
      )) {
        pushCandidate({
          source: dbTemplate.content,
          label: `db:${dbTemplate.postType}:${dbTemplate.slug}`,
          templateName: dbTemplate.slug,
          sourceFile: `db:${dbTemplate.postType}/${dbTemplate.slug}`,
          priority:
            dbTemplate.slug === 'front-page'
              ? 55
              : dbTemplate.slug === 'home'
                ? 50
                : 40,
        });
      }
    }

    for (const page of this.findRepresentativePagesForTemplate(
      componentPlan,
      content,
    )) {
      pushCandidate({
        source: page.content,
        label: `db:page:${page.slug || page.id}`,
        templateName: componentPlan.templateName,
        sourceFile: `db:pages/${page.slug || page.id}`,
        priority: 35,
      });
    }

    return candidates
      .map((candidate) => ({
        ...candidate,
        richness:
          this.scorePlanningSourceRichness(candidate.source) +
          (componentPlan.fixedSlug &&
          candidate.label.startsWith('db:bound-page:')
            ? 10000
            : 0),
      }))
      .map((candidate) => ({
        ...candidate,
        selectionScore: candidate.richness + candidate.priority * 20,
      }))
      .sort((a, b) => {
        if (
          (b.selectionScore ?? Number.NEGATIVE_INFINITY) !==
          (a.selectionScore ?? Number.NEGATIVE_INFINITY)
        ) {
          return (
            (b.selectionScore ?? Number.NEGATIVE_INFINITY) -
            (a.selectionScore ?? Number.NEGATIVE_INFINITY)
          );
        }
        if (b.richness !== a.richness) return b.richness - a.richness;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.source.length - a.source.length;
      })
      .map((candidate, index) => ({
        ...candidate,
        reason:
          index === 0
            ? `highest combined source selected (selectionScore=${candidate.selectionScore ?? candidate.richness}, richness=${candidate.richness}, priority=${candidate.priority})`
            : `alternate candidate (selectionScore=${candidate.selectionScore ?? candidate.richness}, richness=${candidate.richness}, priority=${candidate.priority})`,
      }));
  }

  private scorePlanningSourceRichness(source: string): number {
    const trimmed = source.trim();
    if (!trimmed) return 0;

    let score = Math.min(80, Math.floor(trimmed.length / 120));
    score += this.detectInteractiveWidgetsFromSource(trimmed).length * 25;
    score += extractStaticImageSources(trimmed).length * 8;
    score += (trimmed.match(/<!--\s*wp:/g) ?? []).length * 3;
    score += (trimmed.match(/<img\b/gi) ?? []).length * 4;
    score +=
      (
        trimmed.match(
          /\b(core\/|wp:)(cover|columns|group|gallery|image|media-text|query|buttons?|heading|paragraph)\b/gi,
        ) ?? []
      ).length * 2;

    try {
      const nodes = wpBlocksToJson(trimmed);
      const draftSections = mapWpNodesToDraftSections(nodes);
      const distinctBlocks = new Set(
        nodes.flatMap((node) => this.flattenBlockNames(node)),
      );
      score += draftSections.length * 40;
      score += distinctBlocks.size * 4;
      score += nodes.length * 2;
    } catch {
      // Best-effort scoring only.
    }

    return score;
  }

  private countDraftSectionsInSource(source: string): number {
    try {
      const nodes = wpBlocksToJson(source);
      return mapWpNodesToDraftSections(nodes).length;
    } catch {
      return 0;
    }
  }

  private extractHeadingTextsFromSource(source: string): string[] {
    const collected = new Set<string>();
    const pushText = (value: string | undefined) => {
      const normalized = String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.length >= 3) collected.add(normalized);
    };

    try {
      const visit = (node: WpNode) => {
        if (/heading|site-title|post-title|query-title/i.test(node.block)) {
          pushText(node.text);
          pushText(node.html);
          const contentValue =
            typeof node.params?.content === 'string'
              ? node.params.content
              : undefined;
          pushText(contentValue);
        }
        for (const child of node.children ?? []) visit(child);
      };
      for (const node of wpBlocksToJson(source)) visit(node);
    } catch {
      const matches = source.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi);
      for (const match of matches) {
        pushText(match[1]);
      }
    }

    return [...collected].slice(0, 12);
  }

  private findRepresentativePagesForTemplate(
    componentPlan: PlanResult[number],
    content: DbContentResult,
  ) {
    if (componentPlan.type !== 'page') return [];
    if (componentPlan.fixedSlug) {
      const exactPage = content.pages.find(
        (page) =>
          String(page.id) === String(componentPlan.fixedPageId ?? '') ||
          page.slug === componentPlan.fixedSlug,
      );
      return exactPage ? [exactPage] : [];
    }

    const templateName = this.normalizeTemplateIdentifier(
      componentPlan.templateName,
    );
    if (
      componentPlan.route === '/' ||
      /^(search|archive|index|home|front-page|404|single|single-with-sidebar)$/i.test(
        templateName,
      )
    ) {
      return [];
    }

    const matches = content.pages.filter((page) => {
      const pageTemplate = this.normalizeTemplateIdentifier(page.template);
      if (templateName === 'page') {
        return pageTemplate === '' || pageTemplate === 'default';
      }
      return pageTemplate === templateName;
    });

    return matches
      .sort((a, b) => {
        const byRichness =
          this.scorePlanningSourceRichness(b.content) -
          this.scorePlanningSourceRichness(a.content);
        if (byRichness !== 0) return byRichness;
        return b.content.length - a.content.length;
      })
      .slice(0, 2);
  }

  private normalizeTemplateIdentifier(value: string | undefined): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    return basename(trimmed)
      .replace(/\.(php|html)$/i, '')
      .toLowerCase();
  }

  private flattenBlockNames(node: WpNode): string[] {
    return [
      node.block,
      ...(node.children ?? []).flatMap((child) =>
        this.flattenBlockNames(child),
      ),
    ];
  }

  private collectDraftCustomClassNames(
    draftSections?: SectionPlan[],
  ): string[] {
    if (!draftSections?.length) return [];
    return [
      ...new Set(
        draftSections.flatMap((section) => section.customClassNames ?? []),
      ),
    ];
  }

  private extractCustomClassNamesFromSource(source: string): string[] {
    try {
      const parsed = JSON.parse(source);
      return [...new Set(this.collectCustomClassNamesFromValue(parsed))];
    } catch {
      return [];
    }
  }

  private detectInteractiveWidgetsFromSource(source: string): string[] {
    const normalized = source.toLowerCase();
    const hints = new Set<string>();
    const hasMarker = (pattern: RegExp) => pattern.test(normalized);

    if (
      normalized.includes('"block":"uagb/') ||
      normalized.includes('wp:uagb/') ||
      normalized.includes('uagb-') ||
      normalized.includes('spectra')
    ) {
      hints.add('spectra/uagb');
    }
    if (
      hasMarker(
        /(?:wp:|\"block\":\")(?:uagb\/(?:modal(?:-popup)?|popup)|kadence\/modal)/,
      ) ||
      hasMarker(/\b(?:wp-block-uagb-modal-popup|uagb-modal-popup)\b/)
    ) {
      hints.add('modal');
    }
    if (
      hasMarker(
        /(?:wp:|\"block\":\")(?:uagb\/(?:slider|content-slider|post-carousel|testimonials|team)|kadence\/(?:slider|carousel))/,
      ) ||
      hasMarker(/\b(?:swiper(?:-container|-wrapper)?|slick-slider)\b/)
    ) {
      hints.add('slider');
    }
    if (
      hasMarker(
        /(?:wp:|\"block\":\")(?:uagb\/(?:post-carousel|slider|content-slider)|kadence\/carousel)/,
      ) ||
      hasMarker(
        /\b(?:swiper(?:-container|-wrapper)?|slick-slider|wp-block-kadence-carousel)\b/,
      )
    ) {
      hints.add('carousel');
    }
    if (
      hasMarker(
        /(?:wp:|\"block\":\")(?:uagb\/(?:faq|content-toggle)|(?:core\/)?details)/,
      ) ||
      hasMarker(
        /\b(?:wp-block-details|wp-block-uagb-faq|wp-block-uagb-content-toggle)\b/,
      )
    ) {
      hints.add('accordion');
    }
    if (
      hasMarker(/(?:wp:|\"block\":\")uagb\/tabs/) ||
      hasMarker(/\b(?:wp-block-uagb-tabs|uagb-tabs__wrap)\b/)
    ) {
      hints.add('tabs');
    }
    if (
      hasMarker(/\b(?:lightbox|data-lightbox|glightbox|fslightbox)\b/) &&
      (hasMarker(
        /(?:wp:|\"block\":\")(?:core\/gallery|core\/image|uagb\/image-gallery)/,
      ) ||
        hasMarker(/\b(?:wp-block-gallery|wp-block-image|uagb-image-gallery)\b/))
    ) {
      hints.add('lightbox');
    }

    return [...hints];
  }

  private collectCustomClassNamesFromValue(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.flatMap((entry) =>
        this.collectCustomClassNamesFromValue(entry),
      );
    }
    if (typeof value !== 'object') return [];

    const record = value as Record<string, unknown>;
    const own = Array.isArray(record.customClassNames)
      ? record.customClassNames
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

    return [
      ...own,
      ...Object.values(record).flatMap((entry) =>
        this.collectCustomClassNamesFromValue(entry),
      ),
    ];
  }

  private stripClassicSharedIncludes(source: string, hints: string[]): string {
    return this.stripDelimitedSections(
      hints,
      source,
      /\{\/\*\s*WP: include start → ([^*]+?)\s*\*\/\}/g,
      (label) => `{/* WP: include end → ${label} */}`,
      (label) => this.isSharedLayoutLabel(label),
      (label) => `removed classic shared include "${label}" from page body`,
    );
  }

  private stripFseSharedTemplateParts(source: string, hints: string[]): string {
    return this.stripDelimitedSections(
      hints,
      source,
      /<!--\s*vibepress:part:start\s+([^>]+?)\s*-->/g,
      (label) => `<!-- vibepress:part:end ${label} -->`,
      (label) => this.isSharedLayoutLabel(label),
      (label) => `removed FSE shared template-part "${label}" from page body`,
    );
  }

  private stripDelimitedSections(
    hints: string[],
    source: string,
    startPattern: RegExp,
    endMarkerFor: (label: string) => string,
    shouldRemove: (label: string) => boolean,
    hintFor: (label: string) => string,
  ): string {
    let result = '';
    let cursor = 0;
    const regex = new RegExp(startPattern.source, startPattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(source)) !== null) {
      const label = String(match[1] ?? '').trim();
      if (!shouldRemove(label)) continue;

      result += source.slice(cursor, match.index);
      const endMarker = endMarkerFor(label);
      const endIdx = source.indexOf(endMarker, regex.lastIndex);
      if (endIdx === -1) {
        cursor = regex.lastIndex;
      } else {
        cursor = endIdx + endMarker.length;
        regex.lastIndex = cursor;
      }
      hints.push(hintFor(label));
    }

    result += source.slice(cursor);
    return result;
  }

  private isSharedLayoutLabel(label: string): boolean {
    const name = basename(label.trim()).replace(/\.(php|html)$/i, '');
    return /^(header|footer)(?:[-_].+)?$/i.test(name);
  }

  private looksLikeBlockMarkup(source: string): boolean {
    return source.includes('<!-- wp:');
  }

  private extractPlanningSourceOrigin(label: string): string {
    const [origin] = label.split(':', 1);
    return origin?.trim().toLowerCase() || 'unknown';
  }

  private isCompatibleSupplementalPlanningSource(
    componentPlan: PlanResult[number],
    preferredSource: PlanningSourceCandidate,
    candidate: PlanningSourceCandidate,
  ): boolean {
    const normalize = (value: string | undefined): string =>
      String(value ?? '')
        .trim()
        .toLowerCase();

    const preferredTemplate = normalize(preferredSource.templateName);
    const candidateTemplate = normalize(candidate.templateName);
    if (!preferredTemplate || !candidateTemplate) return false;
    if (preferredTemplate === candidateTemplate) return true;

    if (componentPlan.route === '/') {
      const homeLikeTemplates = new Set(['front-page', 'home']);
      if (
        homeLikeTemplates.has(preferredTemplate) &&
        homeLikeTemplates.has(candidateTemplate)
      ) {
        return true;
      }
    }

    return false;
  }

  private isSharedLayoutBlockNode(node: WpNode): boolean {
    if (/^(header|footer|core\/header|core\/footer)$/i.test(node.block)) {
      return true;
    }
    if (
      node.block === 'template-part' &&
      this.isSharedLayoutLabel(String(node.params?.slug ?? ''))
    ) {
      return true;
    }
    return /^(navigation|site-title|site-tagline)$/i.test(node.block);
  }

  private extractTemplateHints(source: string): string {
    const hints: string[] = [];
    if (source.includes('wp:navigation') || source.includes('wp_nav_menu'))
      hints.push('navigation');
    if (source.includes('wp:query') || source.includes('have_posts'))
      hints.push('query/posts');
    if (source.includes('wp:post-content') || source.includes('the_content'))
      hints.push('post-content');
    if (source.includes('wp:site-title') || source.includes('bloginfo'))
      hints.push('site-title');
    if (source.includes('wp:site-tagline')) hints.push('site-tagline');
    if (source.includes('wp:cover')) hints.push('cover');
    if (source.includes('wp:columns')) hints.push('columns');
    if (source.includes('wp:template-part')) hints.push('template-part');
    if (source.includes('wp:search')) hints.push('search');
    if (source.includes('wp:comments')) hints.push('comments');
    return hints.join(', ');
  }

  private buildPlannerTemplateEvidence(
    templateName: string,
    source: string,
    sourceMap: Map<string, string>,
    content: DbContentResult,
  ): string[] {
    const lines: string[] = [];
    const templateHints = this.extractTemplateHints(source);
    const widgets = this.detectInteractiveWidgetsFromSource(source);
    const headings = this.extractHeadingTextsFromSource(source);
    const imageCount = extractStaticImageSources(source).length;
    const sectionCount = this.countDraftSectionsInSource(source);
    const customClasses = this.extractCustomClassNamesFromSource(source);
    const richness = this.scorePlanningSourceRichness(source);

    lines.push(`- Repo source richness: ${richness}`);
    if (templateHints) lines.push(`- Repo structure hints: ${templateHints}`);
    if (sectionCount > 0)
      lines.push(`- Approx draft sections in repo source: ${sectionCount}`);
    if (widgets.length > 0)
      lines.push(`- Interactive widgets: ${widgets.join(', ')}`);
    if (headings.length > 0)
      lines.push(
        `- Heading samples: ${headings
          .slice(0, 5)
          .map((heading) => `"${heading}"`)
          .join(', ')}`,
      );
    if (imageCount > 0) lines.push(`- Static image count: ${imageCount}`);
    if (customClasses.length > 0) {
      lines.push(
        `- Custom classes: ${customClasses
          .slice(0, 6)
          .map((className) => `\`${className}\``)
          .join(', ')}${customClasses.length > 6 ? ' ...' : ''}`,
      );
    }

    if (['front-page', 'home', 'index'].includes(templateName)) {
      const homeCandidates = this.buildPlanningSourceCandidates(
        {
          templateName,
          componentName: this.toComponentName(templateName),
          type: 'page',
          route: '/',
          dataNeeds: [],
          isDetail: false,
          description: '',
        },
        source,
        sourceMap,
        content,
      );
      if (homeCandidates.length > 1) {
        lines.push(
          `- Home-route candidate winners: ${homeCandidates
            .slice(0, 3)
            .map(
              (candidate) =>
                `${candidate.label} (score=${candidate.richness}, priority=${candidate.priority})`,
            )
            .join(' | ')}`,
        );
      }
    }

    const representativePages = this.findRepresentativePagesForTemplate(
      {
        templateName,
        componentName: this.toComponentName(templateName),
        type: 'page',
        route: `/${templateName}`,
        dataNeeds: [],
        isDetail: false,
        description: '',
      },
      content,
    );
    if (representativePages.length > 0) {
      lines.push(
        `- Matching DB pages: ${representativePages
          .map(
            (page) =>
              `"${page.title}" (slug=${page.slug || page.id}, score=${this.scorePlanningSourceRichness(page.content)})`,
          )
          .join(' | ')}`,
      );
    }

    return lines;
  }

  private collectAllowedImageSrcs(
    planningSource: string,
    content: DbContentResult,
  ): string[] {
    const result = new Set<string>(extractStaticImageSources(planningSource));

    const collectFromMarkup = (value?: string | null) => {
      if (!value?.trim()) return;
      for (const src of extractStaticImageSources(value)) {
        result.add(src);
      }
    };

    const collectDirectUrl = (value?: string | null) => {
      if (typeof value !== 'string' || !value.trim()) return;
      result.add(value.trim());
    };

    collectDirectUrl(content.siteInfo.logoUrl);

    for (const post of content.posts) {
      collectDirectUrl(post.featuredImage);
      collectFromMarkup(post.content);
    }
    for (const page of content.pages) {
      collectDirectUrl(page.featuredImage);
      collectFromMarkup(page.content);
    }
    for (const template of content.dbTemplates) {
      collectFromMarkup(template.content);
    }
    for (const globalStyle of content.dbGlobalStyles) {
      collectFromMarkup(globalStyle.content);
    }
    for (const customCss of content.customCssEntries) {
      collectFromMarkup(customCss.content);
    }

    return [...result];
  }

  private toComponentName(templateName: string): string {
    const name = templateName
      .replace(/\.(php|html)$/, '')
      .split(/[\\/_-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    return /^\d/.test(name) ? `Page${name}` : name;
  }

  private toVisualDataNeeds(dataNeeds: string[]): DataNeed[] {
    const ordered: DataNeed[] = [
      'postDetail',
      'pageDetail',
      'comments',
      'posts',
      'pages',
      'menus',
      'siteInfo',
      'footerLinks',
    ];
    const mapped = new Set<DataNeed>();

    for (const need of dataNeeds) {
      switch (need) {
        case 'site-info':
          mapped.add('siteInfo');
          break;
        case 'footer-links':
          mapped.add('footerLinks');
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

  private formatSectionList(
    sections: Array<Pick<SectionPlan, 'type' | 'sectionKey'>>,
  ): string {
    if (!Array.isArray(sections) || sections.length === 0) return '[]';

    const seen = new Map<string, number>();
    const labels = sections.map((section, index) => {
      const base =
        section.sectionKey?.trim() ||
        section.type?.trim() ||
        `section-${index + 1}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count > 1 ? `${base}#${count}` : base;
    });

    return `[${labels.join(', ')}]`;
  }

  private isRetryableVisualPlanError(error: unknown): boolean {
    const message = String(
      (error as any)?.message ?? error ?? '',
    ).toLowerCase();
    return (
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('429') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('temporarily unavailable')
    );
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeTemplateNameToExpected(
    candidate: string,
    expectedTemplateNames: string[],
  ): string {
    if (expectedTemplateNames.includes(candidate)) return candidate;

    const normalizedCandidate = this.normalizeTemplateKey(candidate);
    const matches = expectedTemplateNames.filter(
      (expected) => this.normalizeTemplateKey(expected) === normalizedCandidate,
    );

    return matches.length === 1 ? matches[0] : candidate;
  }

  private normalizeTemplateKey(value: string): string {
    return value
      .trim()
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .replace(/\.(php|html)$/i, '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .toLowerCase();
  }
}

function inferFseSourceFile(
  templateName: string,
  componentType?: 'page' | 'partial',
): string {
  const normalized = templateName.endsWith('.html')
    ? templateName
    : `${templateName}.html`;
  if (normalized.includes('/')) return normalized;
  return `${componentType === 'partial' ? 'parts' : 'templates'}/${normalized}`;
}
