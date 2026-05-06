import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname } from 'path';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import {
  wpBlocksToJsonWithSourceRefs,
  ensureWpNodesHaveSourceRefs,
  wpJsonToString,
  type WpNode,
} from '../../../common/utils/wp-block-to-json.js';
import {
  canonicalizeThemeAssetReference,
  extractStaticImageSources,
} from '../../../common/utils/theme-asset.util.js';
import {
  mapWpNodesToDraftSections,
  mapWpNodesToLosslessPageSections,
  buildPlannerChunksFromNodes,
} from '../../../common/utils/wp-node-to-sections-mapper.js';
import { buildCanonicalPagePath } from '../../../common/utils/wp-page-path.util.js';
import type { ChunkPlan } from '../../../common/types/chunk.schema.js';
import {
  mapWpNodesToBlockTree,
  type BlockNode,
} from '../../../common/utils/wp-node-to-block-tree.js';
import { StyleResolverService } from '../../../common/style-resolver/style-resolver.service.js';
import { buildEditRequestContextNote } from '../../edit-request/edit-request-prompt.util.js';
import { CapturePlanningService } from '../../edit-request/capture-planning.service.js';
import type { PipelineEditRequestDto } from '../../orchestrator/orchestrator.dto.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import { toVisualDataNeeds } from '../shared/visual-data-needs.util.js';
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
  CommentsSection,
  ComponentVisualPlan,
  ColorPalette,
  DataNeed,
  TypographyTokens,
  LayoutTokens,
  PageContentSection,
  PostListSection,
  PostContentSection,
  PostFeaturedImageSection,
  PostMetaSection,
  PostNavigationSection,
  PostTermsSection,
  PostTitleSection,
  SearchSection,
  SectionPlan,
  SidebarSection,
} from '../react-generator/visual-plan.schema.js';
import { normalizeVisualPlanArchitecture } from '../react-generator/visual-plan.schema.js';
import {
  PlannerVisualRepairService,
  composeSectionsFromChunkPlans,
  type CanonicalPlanningSource,
  type PlanningSourceCandidate,
  type PlanningSourceContext,
  type PlanningSourceSupplement,
  type PlannerVisualPlanRepairState,
  type PlannerVisualRepairDelegate,
} from './planner-visual-repair.service.js';
import {
  buildChunkLabelingPrompt,
  parseChunkLabelingResponse,
} from './chunk-labeling.prompt.js';
import {
  countDraftSectionsInSource,
  detectInteractiveWidgetsFromSource,
  extractCustomClassNamesFromSource,
  extractHeadingTextsFromSource,
  extractNavigationLinkItemsFromSource,
  extractParagraphTextsFromSource,
  scorePlanningSourceRichness,
  sourceContainsBlock,
} from './planning-source-analysis.util.js';
import {
  buildBlockTreeDrivenVisualPlanForComponent,
  shouldBypassCoverageAuditForBlockTreeListingPlan,
  shouldShortCircuitBlockTreeVisualPlan,
  shouldUseAiVisualPlanningForProfolioSurface,
} from './block-tree-deterministic-planner.util.js';
import { summarizeSharedLayoutSubtree } from './shared-layout-subtree.util.js';
import {
  buildPlanningSourceCandidates,
  extractPlanningSourceOrigin,
  getTrustedPlanningDbTemplateSlugs,
  isCompatibleSupplementalPlanningSource,
  normalizePlanningTemplateIdentifier,
} from './planning-source-policy.util.js';
import {
  buildLayoutAnalysisComponentEntry,
  createLayoutAnalysisArtifact,
  createUnsupportedLayoutAnalysisArtifact,
  type LayoutAnalysisArtifact,
} from './layout-analysis.util.js';
import {
  buildDeterministicRenderContractArtifact,
  type DeterministicRenderContractArtifact,
} from './deterministic-render-contract.util.js';
import {
  buildComponentRenderContract,
  type ComponentRenderContract,
} from './render-contract.schema.js';
import { isDefaultRuntimePageTemplateCandidate } from './runtime-page-policy.util.js';
import type {
  PlannerAuthorityLevel,
  PlannerClusterKind,
  PlannerPageIntentKind,
  PlannerSourceFactsSummary,
  PlannerSurfacePlan,
  PlannerWidgetKind,
} from './planner-surface-plan.schema.js';
import {
  buildRepoRouteHints,
  type DeterministicHomeMode,
  type HomeTemplateBase,
  inferDeterministicRouteContract,
  matchesRepoEntrySourceTemplate,
  resolveHomeHierarchy,
  toHomeTemplateBase,
} from './route-contract.util.js';
import { ThemeProfileRegistry } from '../../theme/profiles/theme-profile.registry.js';

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
  draftBlockTree?: BlockNode[];
  planningSourceLabel?: string;
  planningSourceReason?: string;
  planningSourceFile?: string;
  planningSourceSummary?: string;
  fixedSlug?: string;
  fixedPageId?: number | string;
  fixedTitle?: string;
  runtimeRenderer?: 'runtime-page';
  homeTemplateBase?: HomeTemplateBase | null;
  homeMode?: DeterministicHomeMode | null;
  /** Evidence-guided surface brief for page/home/post composition. */
  surfacePlan?: PlannerSurfacePlan;
  /** Pre-computed visual plan from Phase B — generator skips Stage 1 if present */
  visualPlan?: ComponentVisualPlan;
  /** Canonical source-preserving render contract derived from blockTree. */
  renderContract?: ComponentRenderContract;
}

const PLANNER_INVENTED_AUXILIARY_LABEL_SET = new Set<string>([
  'about',
  'privacy',
  'resources',
  'useful links',
  'navigation',
  'pages',
  'latest posts',
  'social',
]);

export type PlanResult = ComponentPlan[];

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly phaseCLogLabel = 'Phase C: Surface+Visual Plan';
  private readonly rawOutputDivider = '\n----- RAW OUTPUT BEGIN -----\n';
  private readonly tokenTracker = new TokenTracker();

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    private readonly aiLogger: AiLoggerService,
    private readonly styleResolver: StyleResolverService,
    private readonly capturePlanning: CapturePlanningService,
    private readonly visualRepair: PlannerVisualRepairService,
    private readonly themeProfiles: ThemeProfileRegistry,
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

    const templateNames = this.getExpectedTemplateNames(
      theme,
      content,
      options?.repoManifest,
    );

    // ── Phase A: architecture plan ─────────────────────────────────────────
    this.logger.log(
      `[Phase A] Planning architecture for ${templateNames.length} components in "${content.siteInfo.siteName}"`,
    );
    this.logger.log(
      `[Phase A] Component targets: ${this.formatPhaseAComponentTargets(templateNames)}`,
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
      this.applyDeterministicRouteContracts(
        this.enrichPlan(plan, sourceMap, content),
        content,
        options?.repoManifest,
      ),
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
        this.formatPhaseCLog(
          `Skipped visual plan generation (${includeVisualPlans ? 'minimalVisualPlan=true' : 'deferred until after plan review'}), plan only includes route/data contract`,
        ),
      );
      return enriched;
    }

    this.logger.log(
      this.formatPhaseCLog(
        `Generating visual plans for ${enriched.length} components (theme tokens stay deterministic; surfacePlan drives composition policy)`,
      ),
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
    logPath?: string,
  ): Promise<PlanResult> {
    const skipVisualPlan =
      this.configService.get<boolean>('planner.minimalVisualPlan') ?? false;
    if (skipVisualPlan) {
      this.logger.log(
        this.formatPhaseCLog(
          'Skipped visual plan generation (minimalVisualPlan=true), plan only includes route/data contract',
        ),
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

    this.logger.log(
      this.formatPhaseCLog(
        `Generating visual plans for ${plan.length} reviewed components (theme tokens stay deterministic; surfacePlan drives composition policy)`,
      ),
    );

    return this.buildVisualPlans(
      plan,
      sourceMap,
      content,
      tokens,
      globalPalette,
      globalTypography,
      repoManifest,
      editRequest,
      resolvedModel,
      logPath,
    );
  }

  async attachSharedChromePartialVisualPlans(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    plan: PlanResult,
    modelName?: string,
    repoManifest?: RepoThemeManifest,
    editRequest?: PipelineEditRequestDto,
    logPath?: string,
  ): Promise<PlanResult> {
    const targets = plan
      .map((componentPlan, index) => ({ componentPlan, index }))
      .filter(
        ({ componentPlan }) =>
          componentPlan.type === 'partial' &&
          isSharedChromePartialComponent(componentPlan.componentName) &&
          !componentPlan.visualPlan,
      );
    if (targets.length === 0) return plan;

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
    const result = [...plan];

    this.logger.log(
      this.formatPhaseCLog(
        `Precomputing visual plans for ${targets.length} shared chrome partial(s) before architecture review`,
      ),
    );

    const plannedTargets = await Promise.all(
      targets.map(async ({ componentPlan, index }) => ({
        index,
        componentPlan: await this.generateVisualPlanForComponent(
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
          resolvedModel,
          logPath,
        ),
      })),
    );

    for (const { index, componentPlan } of plannedTargets) {
      result[index] = componentPlan;
    }

    return result;
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
        this.formatPhaseCLog(
          `Batch ${Math.floor(batchStart / concurrency) + 1}/${Math.ceil(plan.length / concurrency)} done`,
        ),
      );
    }

    const withPlan = result.filter((c) => c.visualPlan).length;
    this.logger.log(
      this.formatPhaseCLog(
        `Done: ${withPlan}/${result.length} components have pre-computed visual plans`,
      ),
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
    let draftBlockTree: BlockNode[] | undefined;
    let planningSource: PlanningSourceContext | undefined;
    let sourceWidgetHints: string[] = [];
    const hasSharedLayoutPartials = fullPlan.some(
      (item) =>
        item.type === 'partial' &&
        isSharedChromePartialComponent(item.componentName),
    );
    const shouldDeferDeterministicPartialToBlockTree =
      componentPlan.type === 'partial' &&
      /^(header|footer|navigation|nav|sidebar|postmeta)$/i.test(
        componentPlan.componentName,
      ) &&
      this.looksLikeBlockMarkup(templateSource);
    const deterministicPlan = shouldDeferDeterministicPartialToBlockTree
      ? undefined
      : this.buildDeterministicVisualPlanForComponent(
          componentPlan,
          content,
          tokens,
          globalPalette,
          globalTypography,
          fullPlan,
        );
    if (deterministicPlan) {
      const visualPlanWithRepoDefaults = this.applyRepoInteractiveDefaults(
        {
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
        repoManifest,
      );
      const deterministicSurfacePlan = this.buildSurfacePlanForComponent({
        componentPlan,
        content,
        visualPlan: visualPlanWithRepoDefaults,
        hasSharedLayoutPartials,
        globalPalette,
        globalTypography,
        tokens,
      });
      this.logger.log(
        this.formatPhaseCLog(
          `deterministic plan ✓ ${this.formatPhaseCPlanSnapshot({
            componentPlan,
            planningSourceLabel: `deterministic:${componentPlan.templateName}`,
            surfacePlan: deterministicSurfacePlan,
            visualPlan: visualPlanWithRepoDefaults,
          })}`,
        ),
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
        visualPlan: visualPlanWithRepoDefaults,
        surfacePlan: deterministicSurfacePlan,
        renderContract: buildComponentRenderContract({
          componentName: componentPlan.componentName,
          templateName: componentPlan.templateName,
          planningSourceFile: inferFseSourceFile(
            componentPlan.templateName,
            componentPlan.type,
          ),
          planningSourceSummary:
            'Deterministic visual-plan path; no AI source synthesis needed.',
          sectionTypes: visualPlanWithRepoDefaults.sections.map(
            (section) => section.type,
          ),
          fallbackSections: visualPlanWithRepoDefaults.sections,
          visualRenderMode: visualPlanWithRepoDefaults.renderMode,
          deterministicAuthority:
            visualPlanWithRepoDefaults.deterministicAuthority,
          draftBlockTree: visualPlanWithRepoDefaults.blockTree,
        }),
      };
    }
    if (this.shouldSkipAiVisualPlan(componentPlan)) {
      const skipSummary =
        componentPlan.runtimeRenderer === 'runtime-page'
          ? `"${componentPlan.componentName}": skipped AI visual plan (built-in runtime page renderer owns structure at runtime)`
          : `"${componentPlan.componentName}": skipped AI visual plan (standard partial without matching section schema)`;
      this.logger.log(this.formatPhaseCLog(skipSummary));
      return {
        ...componentPlan,
        planningSourceLabel:
          componentPlan.runtimeRenderer === 'runtime-page'
            ? 'runtime:page-detail'
            : `repo:${componentPlan.templateName}`,
        planningSourceReason:
          componentPlan.runtimeRenderer === 'runtime-page'
            ? 'visual plan skipped for built-in runtime page renderer'
            : 'visual plan skipped for standard partial',
        planningSourceFile:
          componentPlan.runtimeRenderer === 'runtime-page'
            ? 'templates/react-preview/src/pages/RuntimePage.tsx'
            : inferFseSourceFile(
                componentPlan.templateName,
                componentPlan.type,
              ),
        planningSourceSummary:
          componentPlan.runtimeRenderer === 'runtime-page'
            ? 'Runtime page uses a built-in renderer and the /api/runtime/pages/:slug endpoint instead of a precomputed visual plan.'
            : 'AI visual-plan stage skipped for standard partial without section schema.',
        visualPlan: undefined,
      };
    }
    try {
      const visualDataNeeds = toVisualDataNeeds(componentPlan.dataNeeds);
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
        tokens,
        repoManifest,
      );
      draftBlockTree = this.buildDraftBlockTreeForPlanningSource(
        planningSource,
        componentPlan,
        tokens,
      );
      const forceAiVisualPlan =
        shouldUseAiVisualPlanningForProfolioSurface({
          componentPlan,
          content,
        });
      const earlyBlockTreeVisualPlan =
        forceAiVisualPlan
          ? undefined
          : this.buildBlockTreeDrivenVisualPlanForComponent({
              componentPlan,
              draftBlockTree,
              content,
              tokens,
              globalPalette,
              globalTypography,
            });
      if (
        earlyBlockTreeVisualPlan &&
        this.shouldShortCircuitBlockTreeVisualPlan(
          componentPlan,
          draftBlockTree,
        )
      ) {
        const earlyBlockTreeSurfacePlan = this.buildSurfacePlanForComponent({
          componentPlan,
          content,
          planningSource,
          draftSections: earlyBlockTreeVisualPlan.sections,
          draftBlockTree,
          visualPlan: {
            ...earlyBlockTreeVisualPlan,
            renderMode: earlyBlockTreeVisualPlan.renderMode ?? 'hybrid',
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
            ...(draftBlockTree?.length ? { blockTree: draftBlockTree } : {}),
          },
          detectedCustomClassNames,
          sourceWidgetHints,
          hasSharedLayoutPartials,
          globalPalette,
          globalTypography,
          tokens,
        });
        this.logger.log(
          this.formatPhaseCLog(
            `block-tree deterministic plan ✓ ${this.formatPhaseCPlanSnapshot({
              componentPlan,
              planningSourceLabel:
                planningSource.sourceLabel ??
                `block-tree:${componentPlan.templateName}`,
              surfacePlan: earlyBlockTreeSurfacePlan,
              visualPlan: {
                ...earlyBlockTreeVisualPlan,
                renderMode: earlyBlockTreeVisualPlan.renderMode ?? 'hybrid',
              },
            })}`,
          ),
        );
        return {
          ...componentPlan,
          draftSections: earlyBlockTreeVisualPlan.sections.map((section) => ({
            ...section,
          })),
          ...(draftBlockTree?.length ? { draftBlockTree } : {}),
          planningSourceLabel:
            planningSource.sourceLabel ??
            `block-tree:${componentPlan.templateName}`,
          planningSourceReason: 'block-tree deterministic visual plan path',
          ...(planningSource.sourceFile
            ? { planningSourceFile: planningSource.sourceFile }
            : {}),
          planningSourceSummary:
            'Deterministic visual-plan path derived from preserved WordPress block tree.',
          visualPlan: {
            ...earlyBlockTreeVisualPlan,
            renderMode: earlyBlockTreeVisualPlan.renderMode ?? 'hybrid',
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
            ...(draftBlockTree?.length ? { blockTree: draftBlockTree } : {}),
          },
          surfacePlan: earlyBlockTreeSurfacePlan,
          renderContract: buildComponentRenderContract({
            componentName: componentPlan.componentName,
            templateName: componentPlan.templateName,
            planningSourceFile: planningSource.sourceFile,
            planningSourceSummary:
              'Deterministic visual-plan path derived from preserved WordPress block tree.',
            sectionTypes: earlyBlockTreeVisualPlan.sections.map(
              (section) => section.type,
            ),
            fallbackSections: earlyBlockTreeVisualPlan.sections,
            visualRenderMode: earlyBlockTreeVisualPlan.renderMode ?? 'hybrid',
            deterministicAuthority:
              earlyBlockTreeVisualPlan.deterministicAuthority,
            draftBlockTree,
          }),
        };
      }
      // Chunk-label then compose draft sections (PR2).
      // Falls back to the deterministic mapper if chunking yields nothing.
      const composedSections = await this.labelAndComposeChunks(
        planningSource,
        componentPlan,
        tokens,
        modelName,
        logPath,
      );
      draftSections =
        composedSections ??
        this.buildDraftSectionsForPlanningSource(
          planningSource,
          componentPlan,
          tokens,
        );
      const blockTreeVisualPlan =
        forceAiVisualPlan
          ? undefined
          : this.buildBlockTreeDrivenVisualPlanForComponent({
              componentPlan,
              draftSections,
              draftBlockTree,
              content,
              tokens,
              globalPalette,
              globalTypography,
            });
      if (blockTreeVisualPlan) {
        const blockTreeSurfacePlan = this.buildSurfacePlanForComponent({
          componentPlan,
          content,
          planningSource,
          draftSections: blockTreeVisualPlan.sections,
          draftBlockTree,
          visualPlan: {
            ...blockTreeVisualPlan,
            renderMode: blockTreeVisualPlan.renderMode ?? 'hybrid',
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
            ...(draftBlockTree?.length ? { blockTree: draftBlockTree } : {}),
          },
          detectedCustomClassNames,
          sourceWidgetHints,
          hasSharedLayoutPartials,
          globalPalette,
          globalTypography,
          tokens,
        });
        this.logger.log(
          this.formatPhaseCLog(
            `block-tree deterministic plan ✓ ${this.formatPhaseCPlanSnapshot({
              componentPlan,
              planningSourceLabel:
                planningSource.sourceLabel ??
                `block-tree:${componentPlan.templateName}`,
              surfacePlan: blockTreeSurfacePlan,
              visualPlan: {
                ...blockTreeVisualPlan,
                renderMode: blockTreeVisualPlan.renderMode ?? 'hybrid',
              },
            })}`,
          ),
        );
        return {
          ...componentPlan,
          draftSections: blockTreeVisualPlan.sections.map((section) => ({
            ...section,
          })),
          ...(draftBlockTree?.length ? { draftBlockTree } : {}),
          planningSourceLabel:
            planningSource.sourceLabel ??
            `block-tree:${componentPlan.templateName}`,
          planningSourceReason: 'block-tree deterministic visual plan path',
          ...(planningSource.sourceFile
            ? { planningSourceFile: planningSource.sourceFile }
            : {}),
          planningSourceSummary:
            'Deterministic visual-plan path derived from preserved WordPress block tree.',
          visualPlan: {
            ...blockTreeVisualPlan,
            renderMode: blockTreeVisualPlan.renderMode ?? 'hybrid',
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
            ...(draftBlockTree?.length ? { blockTree: draftBlockTree } : {}),
          },
          surfacePlan: blockTreeSurfacePlan,
          renderContract: buildComponentRenderContract({
            componentName: componentPlan.componentName,
            templateName: componentPlan.templateName,
            planningSourceFile: planningSource.sourceFile,
            planningSourceSummary:
              'Deterministic visual-plan path derived from preserved WordPress block tree.',
            sectionTypes: blockTreeVisualPlan.sections.map(
              (section) => section.type,
            ),
            fallbackSections: blockTreeVisualPlan.sections,
            visualRenderMode: blockTreeVisualPlan.renderMode ?? 'hybrid',
            deterministicAuthority: blockTreeVisualPlan.deterministicAuthority,
            draftBlockTree,
          }),
        };
      }
      detectedCustomClassNames =
        this.collectDraftCustomClassNames(draftSections);
      sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
        planningSource.sourceBackedAuxiliaryLabels,
        ...(componentPlan.type === 'partial'
          ? [extractAuxiliaryLabelsFromSections(draftSections)]
          : []),
      );
      sourceWidgetHints = detectInteractiveWidgetsFromSource(
        this.getPlanningSourcePromptSource(planningSource),
      );
      const augmentedDraftSections = this.augmentDraftSectionsWithSourceWidgets(
        {
          draftSections,
          planningSource,
          sourceWidgetHints,
          componentName: componentPlan.componentName,
        },
      );
      if (augmentedDraftSections) {
        draftSections = augmentedDraftSections;
      }
      let visualContract: VisualPlanContract = {
        componentType: componentPlan.type,
        route: componentPlan.route,
        isDetail: componentPlan.isDetail,
        dataNeeds: visualDataNeeds,
        stripLayoutChrome: componentPlan.type === 'page',
        sourceBackedAuxiliaryLabels,
        requiredSourceWidgets: sourceWidgetHints,
      };
      let surfacePlan = this.buildSurfacePlanForComponent({
        componentPlan,
        content,
        planningSource,
        draftSections,
        draftBlockTree,
        detectedCustomClassNames,
        sourceWidgetHints,
        hasSharedLayoutPartials,
        globalPalette,
        globalTypography,
        tokens,
      });

      const buildPromptArtifacts = (extraContextNote?: string) => {
        const activePlanningSource = planningSource;
        if (!activePlanningSource) {
          throw new Error(
            `Missing planning source for component ${componentPlan.componentName}`,
          );
        }
        return buildVisualPlanPrompt({
          componentName: componentPlan.componentName,
          templateSource:
            this.getPlanningSourcePromptSource(activePlanningSource),
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
          surfacePlan,
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
        planningSource,
        content,
      );
      let repairState: PlannerVisualPlanRepairState = {
        planningSource,
        draftSections,
        draftBlockTree,
        surfacePlan,
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
        draftBlockTree = nextState.draftBlockTree;
        surfacePlan = nextState.surfacePlan;
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
            globalPalette,
            globalTypography,
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
              ? this.formatPhaseCLog(
                  `"${componentPlan.componentName}" attempt 2 repair context: ${repairAttempt.previousSourceLabel ?? 'unknown'} -> ${planningSource.sourceLabel ?? 'unknown'} | diagnosis=${repairAttempt.diagnosis.summary}`,
                )
              : this.formatPhaseCLog(
                  `"${componentPlan.componentName}" attempt 2 self-heal: diagnosis=${repairAttempt.diagnosis.summary} | ${this.formatPhaseCPlanSnapshot(
                    {
                      componentPlan,
                      planningSourceLabel: planningSource.sourceLabel,
                      surfacePlan,
                      visualPlan: {
                        sections: draftSections ?? [],
                        renderMode: 'section-centric',
                        deterministicAuthority: false,
                      },
                    },
                  )}`,
                ),
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
                this.formatPhaseCLog(
                  `"${componentPlan.componentName}" request retry ${transportAttempt}/${maxTransportRetries}`,
                ),
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
              this.formatPhaseCLog(
                `"${componentPlan.componentName}" transient request error on attempt ${transportAttempt}/${maxTransportRetries}: ${lastTransportError} — retrying`,
              ),
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
          const degenerateSections = this.describeDegenerateSections(
            parsed.sections,
          );
          const filteredParsedSections =
            degenerateSections.length > 0
              ? this.filterDegenerateDraftSections(parsed.sections)
              : parsed.sections;
          if (degenerateSections.length > 0) {
            lastReason = 'visual plan contains degenerate sections';
            lastDropped = ` | degenerateSections: ${degenerateSections.join('; ')}`;
            if (filteredParsedSections.length === 0) {
              if (attempt < 2) {
                this.logger.warn(
                  this.formatPhaseCLog(
                    `"${componentPlan.componentName}" parse attempt ${attempt}/2 failed: ${lastReason}${lastDropped} — retrying once`,
                  ),
                );
              }
              continue;
            }
            this.logger.debug(
              this.formatPhaseCLog(
                `"${componentPlan.componentName}" dropped ${degenerateSections.length} degenerate visual-plan section(s) before contract assembly${lastDropped}`,
              ),
            );
          }

          const layout = this.deriveComponentLayout(
            tokens,
            componentPlan.componentName,
            componentPlan.isDetail === true && componentPlan.route !== '/',
          );
          visualPlan = this.applyRepoInteractiveDefaults(
            {
              ...parsed,
              dataNeeds: toVisualDataNeeds(componentPlan.dataNeeds),
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
              sections: this.stabilizeAiVisualPlanSections({
                componentPlan,
                content,
                aiSections: this.injectMissingDraftSections(
                  this.mergeDraftSectionPresentation(
                    filteredParsedSections,
                    draftSections,
                    visualContract,
                  ),
                  draftSections,
                  visualContract,
                  componentPlan.componentName,
                ),
                draftSections,
                visualContract,
              }),
            },
            repoManifest,
          );
          const qualityIssues =
            this.visualRepair.assessAcceptedVisualPlanQuality(
              visualPlan,
              repairState,
            );
          if (qualityIssues.length > 0) {
            lastReason = `visual plan quality gate failed: ${qualityIssues[0]}`;
            lastDropped = ` | qualityIssues: ${qualityIssues.join('; ')}`;
            if (attempt < 2) {
              this.logger.warn(
                this.formatPhaseCLog(
                  `"${componentPlan.componentName}" parse attempt ${attempt}/2 failed: ${lastReason}${lastDropped} — retrying once`,
                ),
              );
            }
            visualPlan = undefined;
            continue;
          }
          this.logger.log(
            this.formatPhaseCLog(
              `accepted AI visual plan ✓ (attempt ${attempt}) ${this.formatPhaseCPlanSnapshot(
                {
                  componentPlan,
                  planningSourceLabel: planningSource?.sourceLabel,
                  surfacePlan,
                  visualPlan: {
                    sections: parsed.sections,
                    renderMode: 'section-centric',
                    deterministicAuthority: false,
                  },
                },
              )}`,
            ),
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
            this.formatPhaseCLog(
              `"${componentPlan.componentName}" parse attempt ${attempt}/2 failed: ${lastReason}${lastDropped} — retrying once`,
            ),
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
            this.formatPhaseCLog(
              `"${componentPlan.componentName}" attempt 2 did not yield a valid plan: ${lastReason}${lastDropped} — escalating to Phase C.5 investigate/replan`,
            ),
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
          this.formatPhaseCLog(
            `"${componentPlan.componentName}" plan parse failed: ${lastReason}${lastDropped} — generator will fallback to D3${this.formatRawOutput(lastRaw)}`,
          ),
        );
      }
    } catch (err: any) {
      this.logger.warn(
        this.formatPhaseCLog(
          `"${componentPlan.componentName}" error: ${err?.message} — generator will fallback to D3`,
        ),
      );
    }

    const normalizedAiVisualPlan = visualPlan
      ? this.normalizeAiVisualPlanForComponent(visualPlan, componentPlan)
      : undefined;
    const finalizedDraftSections =
      normalizedAiVisualPlan?.sections?.length &&
      Array.isArray(normalizedAiVisualPlan.sections)
        ? normalizedAiVisualPlan.sections.map((section) => ({ ...section }))
        : draftSections;
    const finalizedVisualPlan =
      normalizedAiVisualPlan && draftBlockTree?.length
        ? { ...normalizedAiVisualPlan, blockTree: draftBlockTree }
        : normalizedAiVisualPlan;
    const renderContract = buildComponentRenderContract({
      componentName: componentPlan.componentName,
      templateName: componentPlan.templateName,
      planningSourceFile: planningSource?.sourceFile,
      planningSourceSummary: planningSource?.sourceAnalysis,
      sectionTypes: finalizedVisualPlan?.sections.map(
        (section) => section.type,
      ),
      fallbackSections: finalizedDraftSections,
      visualRenderMode: finalizedVisualPlan?.renderMode,
      deterministicAuthority: finalizedVisualPlan?.deterministicAuthority,
      draftBlockTree,
    });

    return {
      ...componentPlan,
      ...(finalizedDraftSections?.length
        ? { draftSections: finalizedDraftSections }
        : {}),
      ...(draftBlockTree?.length ? { draftBlockTree } : {}),
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
      surfacePlan: this.buildSurfacePlanForComponent({
        componentPlan,
        content,
        planningSource,
        draftSections: finalizedDraftSections,
        draftBlockTree,
        visualPlan: finalizedVisualPlan,
        detectedCustomClassNames,
        sourceWidgetHints,
        hasSharedLayoutPartials,
        globalPalette,
        globalTypography,
        tokens,
      }),
      visualPlan: finalizedVisualPlan,
      ...(renderContract ? { renderContract } : {}),
    };
  }

  private buildSurfacePlanForComponent(input: {
    componentPlan: PlanResult[number];
    content: DbContentResult;
    planningSource?: PlanningSourceContext;
    draftSections?: SectionPlan[];
    draftBlockTree?: BlockNode[];
    visualPlan?: ComponentVisualPlan;
    detectedCustomClassNames?: string[];
    sourceWidgetHints?: string[];
    hasSharedLayoutPartials: boolean;
    globalPalette: ColorPalette;
    globalTypography: TypographyTokens;
    tokens: ThemeTokens | undefined;
  }): PlannerSurfacePlan | undefined {
    const { componentPlan } = input;
    if (componentPlan.type !== 'page') return undefined;

    const sections = input.draftSections?.length
      ? input.draftSections
      : input.visualPlan?.sections;
    const authority = this.buildSurfacePlanAuthority({
      componentPlan,
      visualPlan: input.visualPlan,
      draftBlockTree: input.draftBlockTree,
      draftSections: sections,
    });
    const sourceEvidence = this.buildSurfacePlanSourceEvidence({
      componentPlan,
      content: input.content,
      planningSource: input.planningSource,
      draftBlockTree: input.draftBlockTree,
      draftSections: sections,
      visualPlan: input.visualPlan,
      detectedCustomClassNames: input.detectedCustomClassNames ?? [],
      sourceWidgetHints: input.sourceWidgetHints ?? [],
    });
    const pageIntent = {
      kind: this.inferSurfacePlanIntentKind({
        componentPlan,
        sourceEvidence,
        sections,
      }),
      confidence:
        sourceEvidence.contentClusters.length > 0
          ? 0.86
          : sections && sections.length > 0
            ? 0.8
            : input.draftBlockTree?.length
              ? 0.72
              : 0.6,
    } as const;
    const designEvidence = this.buildSurfacePlanDesignEvidence({
      sections,
      pageIntent: pageIntent.kind,
      customClassNames: sourceEvidence.customClassNames,
      sourceEvidence,
      globalPalette: input.globalPalette,
      globalTypography: input.globalTypography,
      tokens: input.tokens,
    });
    const compositionHints = this.buildSurfacePlanCompositionHints(
      sourceEvidence.contentClusters,
      pageIntent.kind,
    );
    const acceptance = this.buildSurfacePlanAcceptance({
      componentPlan,
      authorityLevel: authority.level,
      pageIntent: pageIntent.kind,
      sourceEvidence,
    });
    const sharedChromeOwnership: 'layout' | 'self' =
      input.hasSharedLayoutPartials ? 'layout' : 'self';
    const base = {
      kind: 'standard-page' as const,
      componentName: componentPlan.componentName,
      templateName: componentPlan.templateName,
      contract: {
        route: componentPlan.route,
        dataNeeds: toVisualDataNeeds(componentPlan.dataNeeds),
        isDetail: componentPlan.isDetail,
        componentType: componentPlan.type,
        sharedChromeOwnership,
      },
      authority,
      pageIntent,
      sourceEvidence,
      designEvidence,
      compositionHints,
      acceptance,
      debug:
        sections?.length || input.draftBlockTree?.length
          ? {
              ...(sections?.length
                ? {
                    legacyDraftSections: sections.map((section) => ({
                      ...section,
                    })),
                  }
                : {}),
            }
          : undefined,
    };

    if (this.isHomeLikeComponentPlan(componentPlan)) {
      const openingKinds = new Set(
        sourceEvidence.contentClusters
          .slice(0, 2)
          .map((cluster) => cluster.kind),
      );
      const heroLikeCluster = sourceEvidence.contentClusters.find(
        (cluster) => cluster.kind === 'hero-like' || cluster.kind === 'opening',
      );
      const feedCluster = sourceEvidence.contentClusters.find(
        (cluster) => cluster.kind === 'posts-feed',
      );
      const trustSignalKinds = new Set(['testimonials', 'logo-cloud', 'stats']);
      return {
        ...base,
        kind: 'home-page',
        homeMode:
          componentPlan.homeMode ??
          this.inferHomeMode(componentPlan, sourceEvidence.contentClusters),
        heroEvidence: {
          headingPresent: sourceEvidence.primaryHeadings.length > 0,
          primaryCtaPresent: sourceEvidence.contentClusters.some(
            (cluster) => (cluster.ctaEvidence?.length ?? 0) > 0,
          ),
          mediaPresent: sourceEvidence.primaryImages.length > 0,
          backgroundMediaPresent:
            heroLikeCluster?.kind === 'hero-like' &&
            (heroLikeCluster.imageEvidence?.length ?? 0) > 0,
          sourceRef: heroLikeCluster?.sourceRef,
        },
        feedEvidence: {
          kind: feedCluster ? 'posts' : 'none',
          required:
            !!feedCluster ||
            toVisualDataNeeds(componentPlan.dataNeeds).includes('posts'),
          sourceRef: feedCluster?.sourceRef,
        },
        brandEvidence: {
          siteTitleProminence: openingKinds.has('opening') ? 'high' : 'medium',
          logoProminence: input.hasSharedLayoutPartials ? 'medium' : 'low',
          taglineProminence: openingKinds.has('hero-like') ? 'medium' : 'low',
          trustSignalsPresent: sourceEvidence.contentClusters.some((cluster) =>
            trustSignalKinds.has(cluster.kind),
          ),
          sourceRef: heroLikeCluster?.sourceRef,
        },
        homepageRules: {
          preserveOpeningImpact:
            openingKinds.has('hero-like') || openingKinds.has('opening'),
          preserveBrandFirstRead: true,
          preserveEditorialFlow: !!feedCluster,
          allowHeroToRecompose: authority.level !== 'strict',
          allowFeedSectionToMove: authority.level === 'free',
        },
      };
    }

    if (
      this.isPostDetailComponentPlan(componentPlan) ||
      this.isProductDetailComponentPlan(componentPlan)
    ) {
      const sectionTypes = new Set(
        sections?.map((section) => section.type) ?? [],
      );
      const metaIndex =
        sections?.findIndex((section) => section.type === 'post-meta') ?? -1;
      const titleIndex =
        sections?.findIndex((section) => section.type === 'post-title') ?? -1;
      const featuredIndex =
        sections?.findIndex(
          (section) => section.type === 'post-featured-image',
        ) ?? -1;
      const hasSidebar =
        sourceEvidence.wrapperFacts.some((fact) => fact.kind === 'sidebar') ||
        sectionTypes.has('sidebar');
      return {
        ...base,
        kind: 'post-detail',
        postMeta: {
          titleRequired: true,
          featuredImageRequired: sectionTypes.has('post-featured-image'),
          publishDatePresent: sectionTypes.has('post-meta'),
          authorPresent: sectionTypes.has('post-meta'),
          categoryOrTagPresent:
            sectionTypes.has('post-meta') || sectionTypes.has('post-terms'),
          commentsPresent:
            sectionTypes.has('comments') ||
            toVisualDataNeeds(componentPlan.dataNeeds).includes('comments'),
          postNavigationPresent: sectionTypes.has('post-navigation'),
        },
        postBody: {
          proseDensity:
            sourceEvidence.contentClusters.filter(
              (cluster) =>
                cluster.kind === 'article-body' || cluster.kind === 'prose',
            ).length > 1
              ? 'heavy'
              : sourceEvidence.primaryHeadings.length > 1
                ? 'medium'
                : 'light',
          bodyHasImages: sourceEvidence.primaryImages.length > 0,
          bodyHasGallery: sourceEvidence.widgets.some(
            (widget) => widget.kind === 'gallery',
          ),
          bodyHasLists: sourceEvidence.contentClusters.some(
            (cluster) => cluster.kind === 'feature-list',
          ),
          bodyHasQuotes: sourceEvidence.contentClusters.some(
            (cluster) => cluster.kind === 'testimonials',
          ),
          bodyHasTables: false,
        },
        postLayout: {
          shell: hasSidebar
            ? 'with-sidebar'
            : designEvidence.spacingRhythm.density === 'airy'
              ? 'narrow-article'
              : 'full-width',
          metaPlacement:
            metaIndex !== -1 && titleIndex !== -1 && metaIndex < titleIndex
              ? 'above-title'
              : metaIndex !== -1 && titleIndex !== -1
                ? 'below-title'
                : 'mixed',
          featuredImagePlacement:
            featuredIndex === -1
              ? 'none'
              : titleIndex !== -1 && featuredIndex < titleIndex
                ? 'before-title'
                : titleIndex !== -1
                  ? 'after-title'
                  : 'inside-body',
          authorBoxPlacement: sectionTypes.has('comments')
            ? 'after-comments'
            : sourceEvidence.contentClusters.some(
                  (cluster) => cluster.kind === 'author-box',
                )
              ? 'after-body'
              : 'none',
        },
        articleRules: {
          preserveReadingFlow: true,
          preserveSemanticMeta: true,
          preserveCommentsCapability: toVisualDataNeeds(
            componentPlan.dataNeeds,
          ).includes('comments'),
          forbidLandingPageRecomposition: true,
        },
      };
    }

    return base;
  }

  private buildSurfacePlanAuthority(input: {
    componentPlan: PlanResult[number];
    visualPlan?: ComponentVisualPlan;
    draftBlockTree?: BlockNode[];
    draftSections?: SectionPlan[];
  }) {
    const preserveExactBlockStructure =
      input.visualPlan?.deterministicAuthority === true ||
      input.visualPlan?.renderAuthority === 'deterministic-pixel' ||
      input.visualPlan?.renderAuthority === 'deterministic-structure';
    const hasStructureEvidence =
      (input.draftBlockTree?.length ?? 0) > 0 ||
      (input.draftSections?.length ?? 0) > 0;
    const level: PlannerAuthorityLevel = preserveExactBlockStructure
      ? 'strict'
      : this.isHomeLikeComponentPlan(input.componentPlan) ||
          this.isPostDetailComponentPlan(input.componentPlan) ||
          this.isProductDetailComponentPlan(input.componentPlan) ||
          input.componentPlan.isDetail ||
          hasStructureEvidence
        ? 'guided'
        : 'free';
    const reason =
      level === 'strict'
        ? 'Deterministic render authority already exists for this surface.'
        : level === 'guided'
          ? 'Preserve route-owned evidence and grouping while allowing composition changes.'
          : 'Low-constraint page surface; composition may adapt more freely.';
    return {
      level,
      reason,
      allowSectionTypeSubstitution: level !== 'strict',
      allowReorderWithinGroups: level === 'free',
      allowWrapperRecomposition: level !== 'strict',
      preserveExactBlockStructure,
    };
  }

  private inferSurfacePlanIntentKind(input: {
    componentPlan: PlanResult[number];
    sourceEvidence: {
      sourceFacts?: PlannerSourceFactsSummary;
      contentClusters: Array<{ kind: PlannerClusterKind }>;
      representativeBindings?: Array<{ kind: 'page' | 'post' }>;
      navigationLabels?: string[];
      paragraphSnippets?: string[];
      primaryHeadings: string[];
      widgets: Array<{ kind: PlannerWidgetKind }>;
    };
    sections?: SectionPlan[];
  }): PlannerPageIntentKind {
    const template = input.componentPlan.templateName.toLowerCase();
    const route = input.componentPlan.route ?? '';
    const dataNeeds = new Set(
      toVisualDataNeeds(input.componentPlan.dataNeeds).map((need) =>
        String(need).toLowerCase(),
      ),
    );
    const sectionTypes = new Set(
      input.sections?.map((section) => section.type) ?? [],
    );
    const clusterKinds = new Set(
      input.sourceEvidence.contentClusters.map((cluster) => cluster.kind),
    );
    const sourceFacts = input.sourceEvidence.sourceFacts;
    if (this.isHomeLikeComponentPlan(input.componentPlan)) {
      if (
        dataNeeds.has('posts') &&
        (sectionTypes.has('post-list') ||
          clusterKinds.has('posts-feed') ||
          sourceFacts?.hasQuery)
      ) {
        return template === 'front-page'
          ? 'homepage-hybrid'
          : 'homepage-content';
      }
      return 'homepage-brand';
    }
    if (
      this.isPostDetailComponentPlan(input.componentPlan) ||
      this.isProductDetailComponentPlan(input.componentPlan)
    ) {
      return 'article';
    }
    if (
      sectionTypes.has('post-list') ||
      sectionTypes.has('search') ||
      clusterKinds.has('posts-feed') ||
      input.sourceEvidence.widgets.some((widget) => widget.kind === 'query') ||
      sourceFacts?.hasQuery
    ) {
      return 'directory';
    }
    if (
      sectionTypes.has('card-grid') &&
      (sectionTypes.has('hero') || sectionTypes.has('cover'))
    ) {
      return 'service';
    }
    if (
      clusterKinds.has('form') &&
      clusterKinds.has('cta') &&
      (clusterKinds.has('hero-like') || clusterKinds.has('opening'))
    ) {
      return 'landing';
    }
    if (
      input.sourceEvidence.navigationLabels &&
      input.sourceEvidence.navigationLabels.length >= 4 &&
      input.sourceEvidence.paragraphSnippets &&
      input.sourceEvidence.paragraphSnippets.length <= 2
    ) {
      return 'directory';
    }
    if (sectionTypes.has('hero') || sectionTypes.has('cover')) {
      return 'landing';
    }
    if (
      input.sourceEvidence.representativeBindings?.some(
        (binding) => binding.kind === 'page',
      ) &&
      input.sourceEvidence.primaryHeadings.length <= 2 &&
      (input.sourceEvidence.paragraphSnippets?.length ?? 0) >= 2
    ) {
      return 'minimal-prose';
    }
    if (input.componentPlan.isDetail && route.startsWith('/page/')) {
      return 'minimal-prose';
    }
    return 'editorial';
  }

  private buildSurfacePlanSourceEvidence(input: {
    componentPlan: PlanResult[number];
    content: DbContentResult;
    planningSource?: PlanningSourceContext;
    draftBlockTree?: BlockNode[];
    draftSections?: SectionPlan[];
    visualPlan?: ComponentVisualPlan;
    detectedCustomClassNames: string[];
    sourceWidgetHints: string[];
  }) {
    const promptSource = this.getPlanningSourcePromptSource(
      input.planningSource,
    );
    const paragraphSnippets = extractParagraphTextsFromSource(promptSource);
    const navigationLabels = extractNavigationLinkItemsFromSource(
      promptSource,
    ).map((link) => link.label);
    const sourceFacts = input.planningSource?.canonicalSource?.sourceFacts;
    const headingTexts =
      input.planningSource?.canonicalSource?.headingTexts ??
      extractHeadingTextsFromSource(promptSource);
    const primaryImages =
      input.planningSource?.canonicalSource?.assetRefs ??
      extractStaticImageSources(promptSource);
    const contentClusters = this.buildSurfacePlanContentClusters(
      input.draftSections ?? input.visualPlan?.sections,
      input.componentPlan,
    );
    const widgetHints = [
      ...input.sourceWidgetHints,
      ...(input.planningSource?.canonicalSource?.interactiveWidgets ?? []),
    ];
    const representativeBindings = this.buildSurfacePlanRepresentativeBindings(
      input.componentPlan,
      input.content,
    );
    const evidenceNotes = this.buildSurfacePlanEvidenceNotes({
      componentPlan: input.componentPlan,
      sourceFacts,
      contentClusters,
      paragraphSnippets,
      navigationLabels,
      representativeBindings,
    });
    return {
      planningSourceLabel: input.planningSource?.sourceLabel,
      planningSourceFile: input.planningSource?.sourceFile,
      ...(input.draftBlockTree?.length
        ? { blockTree: input.draftBlockTree }
        : {}),
      ...(sourceFacts ? { sourceFacts } : {}),
      primaryHeadings: this.dedupeStringList(headingTexts).slice(0, 8),
      primaryImages: this.dedupeStringList(primaryImages).slice(0, 8),
      ...(paragraphSnippets.length
        ? {
            paragraphSnippets: this.dedupeStringList(paragraphSnippets).slice(
              0,
              6,
            ),
          }
        : {}),
      ...(navigationLabels.length
        ? {
            navigationLabels: this.dedupeStringList(navigationLabels).slice(
              0,
              8,
            ),
          }
        : {}),
      customClassNames: this.dedupeStringList([
        ...input.detectedCustomClassNames,
        ...(input.planningSource?.canonicalSource?.customClassNames ?? []),
      ]).slice(0, 20),
      contentClusters,
      wrapperFacts: this.buildSurfacePlanWrapperFacts(
        input.draftSections ?? input.visualPlan?.sections,
        input.planningSource,
      ),
      widgets: this.buildSurfacePlanWidgetEvidence(
        widgetHints,
        input.componentPlan,
      ),
      ...(representativeBindings.length ? { representativeBindings } : {}),
      ...(evidenceNotes.length ? { evidenceNotes } : {}),
    };
  }

  private buildSurfacePlanDesignEvidence(input: {
    sections?: SectionPlan[];
    pageIntent: PlannerPageIntentKind;
    customClassNames: string[];
    sourceEvidence?: {
      sourceFacts?: PlannerSourceFactsSummary;
      paragraphSnippets?: string[];
      navigationLabels?: string[];
    };
    globalPalette: ColorPalette;
    globalTypography: TypographyTokens;
    tokens: ThemeTokens | undefined;
  }) {
    const density = this.inferSurfacePlanDensity(input.sections);
    const rhythmHints = [
      density === 'airy'
        ? 'Favor generous breathing room between primary clusters.'
        : density === 'compact'
          ? 'Keep section spacing efficient and editorially tight.'
          : 'Balance separation between clusters without over-expanding the page.',
    ];
    if (
      input.sections?.some(
        (section) => section.type === 'hero' || section.type === 'cover',
      )
    ) {
      rhythmHints.push('Preserve a visually distinct opening block.');
    }
    if (input.sections?.some((section) => section.type === 'post-list')) {
      rhythmHints.push(
        'Listing/feed regions may be denser than the opening section.',
      );
    }
    if (input.sourceEvidence?.sourceFacts?.hasSidebarTemplatePart) {
      rhythmHints.push(
        'Preserve a primary content column with a complementary side rail.',
      );
    }
    if ((input.sourceEvidence?.navigationLabels?.length ?? 0) >= 5) {
      rhythmHints.push(
        'Navigation-heavy source suggests a more structured, utility-forward rhythm.',
      );
    }
    return {
      importantClassNames: input.customClassNames.slice(0, 12),
      spacingRhythm: {
        density,
        rhythmHints,
      },
      visualToneHints: this.buildSurfacePlanToneHints(
        input.pageIntent,
        input.sections,
        input.sourceEvidence,
      ),
      tokens: {
        palette: input.globalPalette,
        typography: input.globalTypography,
        blockStyles: input.tokens?.blockStyles,
      },
    };
  }

  private buildSurfacePlanCompositionHints(
    clusters: Array<{
      id: string;
      kind: PlannerClusterKind;
      importance: string;
    }>,
    pageIntent: PlannerPageIntentKind,
  ) {
    const macroOrder = clusters.map((cluster) => cluster.id);
    const preferredGrouping: string[][] = [];
    const keepAdjacentClusterPairs: Array<[string, string]> = [];
    for (let index = 0; index < clusters.length; index++) {
      const current = clusters[index];
      const next = clusters[index + 1];
      if (!current) continue;
      preferredGrouping.push([current.id]);
      if (
        next &&
        current.importance === 'high' &&
        next.importance === 'high' &&
        current.kind !== 'posts-feed'
      ) {
        keepAdjacentClusterPairs.push([current.id, next.id]);
      }
    }
    return {
      macroOrder,
      preferredGrouping,
      keepAdjacentClusterPairs,
      mayCollapseClusters: clusters
        .filter((cluster) => cluster.importance === 'low')
        .map((cluster) => cluster.id)
        .slice(0, 4),
      mayExpandClusters: clusters
        .filter((cluster) =>
          ['feature-list', 'gallery', 'posts-feed', 'article-body'].includes(
            cluster.kind,
          ),
        )
        .map((cluster) => cluster.id)
        .slice(0, pageIntent.startsWith('homepage') ? 3 : 2),
    };
  }

  private buildSurfacePlanAcceptance(input: {
    componentPlan: PlanResult[number];
    authorityLevel: PlannerAuthorityLevel;
    pageIntent: PlannerPageIntentKind;
    sourceEvidence: {
      primaryHeadings: string[];
      widgets: Array<{ kind: PlannerWidgetKind; required: boolean }>;
      contentClusters: Array<{ kind: PlannerClusterKind; importance: string }>;
    };
  }) {
    const mustKeep = [
      ...input.sourceEvidence.primaryHeadings
        .slice(0, 2)
        .map((heading) => `Preserve source heading: "${heading}"`),
      ...input.sourceEvidence.widgets
        .filter((widget) => widget.required)
        .map((widget) => `Preserve source widget: ${widget.kind}`),
      ...input.sourceEvidence.contentClusters
        .filter((cluster) => cluster.importance === 'high')
        .slice(0, 4)
        .map(
          (cluster) =>
            `Preserve ${cluster.kind} cluster in the final composition`,
        ),
    ];
    const mustNotInvent = [
      'Do not invent extra shared chrome inside the page body.',
      'Do not add out-of-contract dynamic data requirements.',
      ...(input.pageIntent === 'article'
        ? ['Do not reframe the article as a marketing landing page.']
        : []),
    ];
    const mayRecompose = [
      input.authorityLevel === 'strict'
        ? 'Keep the block structure fixed.'
        : 'Section taxonomy may change if the same source-backed evidence survives.',
      input.pageIntent.startsWith('homepage')
        ? 'Opening brand composition may adapt if headline, CTA, and feed intent remain visible.'
        : 'Wrapper composition may adapt while preserving route-owned evidence.',
    ];
    return {
      mustKeep: this.dedupeStringList(mustKeep).slice(0, 8),
      mustNotInvent: this.dedupeStringList(mustNotInvent).slice(0, 6),
      mayRecompose: this.dedupeStringList(mayRecompose).slice(0, 6),
    };
  }

  private buildSurfacePlanContentClusters(
    sections: SectionPlan[] | undefined,
    componentPlan: PlanResult[number],
  ) {
    if (!sections?.length) return [];
    const clusters = sections.map((section, index) => {
      const kind = this.mapSurfacePlanClusterKind(
        section,
        componentPlan,
        index,
      );
      const sourceRef = section.sourceRef
        ? {
            sourceNodeId: section.sourceRef.sourceNodeId,
            sourceFile: section.sourceRef.sourceFile,
            templateName: section.sourceRef.templateName,
            blockName: section.sourceRef.blockName,
          }
        : undefined;
      const importance: 'high' | 'medium' | 'low' =
        index < 2 ||
        kind === 'posts-feed' ||
        kind === 'article-body' ||
        kind === 'cta'
          ? 'high'
          : kind === 'comments' || kind === 'post-navigation'
            ? 'medium'
            : section.sourceRef
              ? 'medium'
              : 'low';
      return {
        id: section.debugKey ?? section.sectionKey ?? `${kind}-${index + 1}`,
        kind,
        importance,
        ...(sourceRef ? { sourceRef } : {}),
        ...(this.extractSurfacePlanSectionTexts(section).length
          ? {
              textEvidence: this.extractSurfacePlanSectionTexts(section).slice(
                0,
                4,
              ),
            }
          : {}),
        ...(this.extractSurfacePlanSectionImages(section).length
          ? {
              imageEvidence: this.extractSurfacePlanSectionImages(
                section,
              ).slice(0, 4),
            }
          : {}),
        ...(this.extractSurfacePlanSectionCtas(section).length
          ? {
              ctaEvidence: this.extractSurfacePlanSectionCtas(section).slice(
                0,
                3,
              ),
            }
          : {}),
        ...(this.extractSurfacePlanItemCountHint(section)
          ? { itemCountHint: this.extractSurfacePlanItemCountHint(section) }
          : {}),
        ...(section.customClassNames?.length
          ? { customClassNames: section.customClassNames.slice(0, 6) }
          : {}),
      };
    });
    return this.normalizeSurfacePlanClusters(clusters);
  }

  private buildSurfacePlanWrapperFacts(
    sections: SectionPlan[] | undefined,
    planningSource?: PlanningSourceContext,
  ) {
    const facts: Array<{
      id: string;
      kind:
        | 'stack'
        | 'contained-group'
        | 'full-bleed'
        | 'two-column'
        | 'three-column'
        | 'sidebar'
        | 'article-shell';
      importance: 'high' | 'medium';
      hints?: string[];
    }> = [];
    const pushFact = (
      id: string,
      kind:
        | 'stack'
        | 'contained-group'
        | 'full-bleed'
        | 'two-column'
        | 'three-column'
        | 'sidebar'
        | 'article-shell',
      importance: 'high' | 'medium',
      hint?: string,
    ) => {
      if (facts.some((fact) => fact.kind === kind)) return;
      facts.push({
        id,
        kind,
        importance,
        ...(hint ? { hints: [hint] } : {}),
      });
    };

    pushFact(
      'stack-root',
      'stack',
      'high',
      'Preserve top-to-bottom page flow.',
    );

    for (const section of sections ?? []) {
      switch (section.type) {
        case 'media-text':
          pushFact(
            'two-column',
            'two-column',
            'high',
            'Source contains a split content block.',
          );
          break;
        case 'sidebar':
          pushFact(
            'sidebar',
            'sidebar',
            'high',
            'Sidebar layout exists in source.',
          );
          break;
        case 'hero':
        case 'cover':
          pushFact(
            'full-bleed-opening',
            'full-bleed',
            'medium',
            'Opening section may need stronger edge-to-edge treatment.',
          );
          break;
        case 'card-grid': {
          const cards = (section as { cards?: unknown[] }).cards ?? [];
          if (cards.length >= 3) {
            pushFact(
              'three-column-grid',
              'three-column',
              'medium',
              'Multi-card region likely benefits from repeated columns.',
            );
          } else {
            pushFact(
              'contained-group',
              'contained-group',
              'medium',
              'Grouped feature content should stay visually associated.',
            );
          }
          break;
        }
        case 'post-content':
        case 'page-content':
        case 'prose-block':
          pushFact(
            'article-shell',
            'article-shell',
            'medium',
            'Reading-focused shell should preserve content hierarchy.',
          );
          break;
      }
    }

    if (planningSource?.canonicalSource?.sourceFacts.hasSidebarTemplatePart) {
      pushFact(
        'sidebar-source-fact',
        'sidebar',
        'high',
        'Sidebar template part exists.',
      );
    }
    if (planningSource?.canonicalSource?.sourceFacts.hasNavigation) {
      pushFact(
        'contained-navigation',
        'contained-group',
        'medium',
        'Source includes navigation-driven grouping that should read as one system.',
      );
    }
    if (planningSource?.canonicalSource?.sourceFacts.hasQuery) {
      pushFact(
        'feed-shell',
        'contained-group',
        'medium',
        'Query/feed blocks should keep a coherent listing shell.',
      );
    }

    return facts;
  }

  private buildSurfacePlanWidgetEvidence(
    widgetHints: string[],
    componentPlan: PlanResult[number],
  ) {
    const entries = this.dedupeStringList(widgetHints)
      .map((hint) => this.mapSurfacePlanWidgetKind(hint))
      .filter((kind): kind is PlannerWidgetKind => !!kind)
      .map((kind) => ({
        kind,
        required: true,
      }));

    if (
      (this.isPostDetailComponentPlan(componentPlan) ||
        this.isProductDetailComponentPlan(componentPlan)) &&
      toVisualDataNeeds(componentPlan.dataNeeds).includes('comments') &&
      !entries.some((entry) => entry.kind === 'comments')
    ) {
      entries.push({ kind: 'comments', required: true });
    }

    return entries;
  }

  private buildSurfacePlanRepresentativeBindings(
    componentPlan: PlanResult[number],
    content: DbContentResult,
  ) {
    const representativePages = this.findRepresentativePagesForTemplate(
      componentPlan,
      content,
    ).map((page) => ({
      kind: 'page' as const,
      id: page.id,
      slug: page.slug,
      title: page.title,
      template: page.template ?? null,
    }));
    const representativePosts = this.findRepresentativePostsForTemplate(
      componentPlan,
      content,
    ).map((post) => ({
      kind: 'post' as const,
      id: post.id,
      slug: post.slug,
      title: post.title,
      template: null,
    }));
    return [...representativePages, ...representativePosts].slice(0, 3);
  }

  private buildSurfacePlanEvidenceNotes(input: {
    componentPlan: PlanResult[number];
    sourceFacts?: PlannerSourceFactsSummary;
    contentClusters: Array<{ kind: PlannerClusterKind; importance: string }>;
    paragraphSnippets: string[];
    navigationLabels: string[];
    representativeBindings: Array<{ kind: 'page' | 'post'; title: string }>;
  }): string[] {
    const notes: string[] = [];
    const highPriorityClusters = input.contentClusters.filter(
      (cluster) => cluster.importance === 'high',
    ).length;
    if (input.sourceFacts?.hasQuery) {
      notes.push(
        'Source contains a query/listing pattern that should remain visually legible.',
      );
    }
    if (input.sourceFacts?.hasComments) {
      notes.push(
        'Source includes comments capability; preserve a discussion affordance.',
      );
    }
    if (input.sourceFacts?.hasNavigation && input.componentPlan.route === '/') {
      notes.push(
        'Homepage source mixes navigational identity with route-owned content.',
      );
    }
    if (input.navigationLabels.length >= 5) {
      notes.push(
        'Source exposes many navigation labels; avoid collapsing all utility links into a single CTA.',
      );
    }
    if (highPriorityClusters >= 4) {
      notes.push(
        'Source contains several high-priority clusters; maintain clear macro-order.',
      );
    }
    if (input.paragraphSnippets.length >= 3) {
      notes.push('Paragraph-rich source suggests an editorial reading rhythm.');
    }
    if (input.representativeBindings.length > 0) {
      notes.push(
        `Representative content sampled from ${input.representativeBindings
          .map((binding) => `"${binding.title}"`)
          .join(', ')}.`,
      );
    }
    return notes.slice(0, 6);
  }

  private normalizeSurfacePlanClusters(
    clusters: Array<{
      id: string;
      kind: PlannerClusterKind;
      importance: 'high' | 'medium' | 'low';
      sourceRef?: {
        sourceNodeId?: string;
        sourceFile?: string;
        templateName?: string;
        blockName?: string;
      };
      textEvidence?: string[];
      imageEvidence?: string[];
      ctaEvidence?: string[];
      itemCountHint?: number;
      customClassNames?: string[];
    }>,
  ) {
    const normalized: typeof clusters = [];
    for (const cluster of clusters) {
      const previous = normalized[normalized.length - 1];
      const proseLike =
        cluster.kind === 'prose' || cluster.kind === 'article-body';
      if (
        previous &&
        previous.kind === cluster.kind &&
        proseLike &&
        (previous.textEvidence?.length ?? 0) < 6
      ) {
        previous.textEvidence = this.dedupeStringList([
          ...(previous.textEvidence ?? []),
          ...(cluster.textEvidence ?? []),
        ]).slice(0, 6);
        previous.imageEvidence = this.dedupeStringList([
          ...(previous.imageEvidence ?? []),
          ...(cluster.imageEvidence ?? []),
        ]).slice(0, 4);
        previous.ctaEvidence = this.dedupeStringList([
          ...(previous.ctaEvidence ?? []),
          ...(cluster.ctaEvidence ?? []),
        ]).slice(0, 3);
        previous.customClassNames = this.dedupeStringList([
          ...(previous.customClassNames ?? []),
          ...(cluster.customClassNames ?? []),
        ]).slice(0, 6);
        previous.itemCountHint = Math.max(
          previous.itemCountHint ?? 0,
          cluster.itemCountHint ?? 0,
        );
        continue;
      }
      normalized.push({ ...cluster });
    }
    return normalized;
  }

  private mapSurfacePlanClusterKind(
    section: SectionPlan,
    componentPlan: PlanResult[number],
    index: number,
  ): PlannerClusterKind {
    switch (section.type) {
      case 'hero':
      case 'cover':
        return index === 0 ? 'hero-like' : 'opening';
      case 'card-grid':
      case 'tabs':
      case 'accordion':
        return section.type === 'accordion' ? 'faq' : 'feature-list';
      case 'media-text':
        return 'split-content';
      case 'post-list':
      case 'search':
        return 'posts-feed';
      case 'newsletter':
        return 'form';
      case 'testimonial':
        return 'testimonials';
      case 'carousel':
        return 'gallery';
      case 'comments':
        return 'comments';
      case 'post-navigation':
        return 'post-navigation';
      case 'post-meta':
        return 'article-meta';
      case 'post-content':
      case 'page-content':
      case 'prose-block':
        return this.isPostDetailComponentPlan(componentPlan) ||
          this.isProductDetailComponentPlan(componentPlan)
          ? 'article-body'
          : 'prose';
      case 'post-title':
      case 'post-featured-image':
        return 'opening';
      case 'sidebar':
        return 'related-posts';
      default:
        return index === 0 ? 'opening' : 'cta';
    }
  }

  private extractSurfacePlanSectionTexts(section: SectionPlan): string[] {
    const values = new Set<string>();
    const push = (value: unknown) => {
      const cleaned = String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) values.add(cleaned);
    };

    switch (section.type) {
      case 'hero':
      case 'cover':
        push(section.heading);
        push(section.subheading);
        break;
      case 'media-text':
        push(section.subtitle);
        push(section.heading);
        push(section.body);
        (section.listItems ?? []).forEach(push);
        break;
      case 'card-grid':
        push(section.title);
        push(section.subtitle);
        (section.cards ?? []).forEach((card) => {
          push(card.heading);
          push(card.body);
        });
        break;
      case 'prose-block':
        (section.sourceSegments ?? []).forEach((segment) => {
          if ('text' in segment) push(segment.text);
          if ('html' in segment) push(segment.html);
        });
        break;
      case 'accordion':
        (section.items ?? []).forEach((item) => {
          push(item.heading);
          push(item.body);
        });
        break;
      case 'tabs':
        (section.tabs ?? []).forEach((tab) => {
          push(tab.label);
          push(tab.heading);
          push(tab.body);
        });
        break;
      case 'modal':
        push(section.triggerText);
        push(section.heading);
        push(section.body);
        break;
      default:
        push((section as { title?: string }).title);
        push((section as { heading?: string }).heading);
    }

    return [...values];
  }

  private extractSurfacePlanSectionImages(section: SectionPlan): string[] {
    const values = new Set<string>();
    const push = (value: unknown) => {
      const cleaned = String(value ?? '').trim();
      if (cleaned) values.add(cleaned);
    };
    switch (section.type) {
      case 'hero':
        push(section.image?.src);
        break;
      case 'cover':
        push(section.imageSrc);
        break;
      case 'media-text':
        push(section.imageSrc);
        break;
      case 'card-grid':
        (section.cards ?? []).forEach((card) => push(card.imageSrc));
        break;
      case 'carousel':
        (section.slides ?? []).forEach((slide) => push(slide.imageSrc));
        break;
      case 'modal':
        push(section.imageSrc);
        break;
      case 'post-featured-image':
        push((section as { imageSrc?: string }).imageSrc);
        break;
    }
    return [...values];
  }

  private extractSurfacePlanSectionCtas(section: SectionPlan): string[] {
    const values = new Set<string>();
    const push = (value: unknown) => {
      const cleaned = String(value ?? '').trim();
      if (cleaned) values.add(cleaned);
    };
    if ('cta' in section && section.cta) {
      push(section.cta.text);
      push(section.cta.link);
    }
    if ('ctas' in section && Array.isArray(section.ctas)) {
      section.ctas.forEach((cta) => {
        push(cta?.text);
        push(cta?.link);
      });
    }
    if (section.type === 'newsletter') {
      push(section.buttonText);
    }
    if (section.type === 'modal') {
      push(section.triggerText);
    }
    return [...values];
  }

  private extractSurfacePlanItemCountHint(
    section: SectionPlan,
  ): number | undefined {
    switch (section.type) {
      case 'card-grid':
        return section.cards?.length || undefined;
      case 'carousel':
        return section.slides?.length || undefined;
      case 'accordion':
        return section.items?.length || undefined;
      case 'tabs':
        return section.tabs?.length || undefined;
      case 'media-text':
        return section.listItems?.length || undefined;
      default:
        return undefined;
    }
  }

  private inferSurfacePlanDensity(
    sections: SectionPlan[] | undefined,
  ): 'compact' | 'balanced' | 'airy' {
    if (!sections?.length) return 'balanced';
    const hasLargeOpening = sections.some(
      (section) => section.type === 'hero' || section.type === 'cover',
    );
    const proseHeavy = sections.filter(
      (section) =>
        section.type === 'prose-block' ||
        section.type === 'post-content' ||
        section.type === 'page-content',
    ).length;
    if (hasLargeOpening && sections.length <= 4) return 'airy';
    if (sections.length >= 7 || proseHeavy >= 2) return 'compact';
    return 'balanced';
  }

  private buildSurfacePlanToneHints(
    pageIntent: PlannerPageIntentKind,
    sections: SectionPlan[] | undefined,
    sourceEvidence?: {
      sourceFacts?: PlannerSourceFactsSummary;
      paragraphSnippets?: string[];
      navigationLabels?: string[];
    },
  ): string[] {
    const hints = new Set<string>();
    switch (pageIntent) {
      case 'homepage-brand':
      case 'homepage-hybrid':
        hints.add('brand-forward');
        hints.add('high-contrast opening hierarchy');
        break;
      case 'homepage-content':
        hints.add('editorial homepage');
        break;
      case 'article':
        hints.add('reading-first article presentation');
        break;
      case 'landing':
        hints.add('campaign-style lead section');
        break;
      case 'service':
        hints.add('service-oriented content grouping');
        break;
      default:
        hints.add('source-faithful visual rhythm');
    }
    if (sections?.some((section) => section.type === 'media-text')) {
      hints.add('asymmetric split-content moments');
    }
    if (sections?.some((section) => section.type === 'card-grid')) {
      hints.add('repeated card-based content grouping');
    }
    if (sourceEvidence?.sourceFacts?.hasQuery) {
      hints.add('content-discovery surface');
    }
    if ((sourceEvidence?.paragraphSnippets?.length ?? 0) >= 3) {
      hints.add('editorial copy-led pacing');
    }
    if ((sourceEvidence?.navigationLabels?.length ?? 0) >= 5) {
      hints.add('utility-rich navigation vocabulary');
    }
    return [...hints].slice(0, 5);
  }

  private mapSurfacePlanWidgetKind(
    hint: string,
  ): PlannerWidgetKind | undefined {
    const normalized = hint.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized.includes('search')) return 'search';
    if (normalized.includes('comment')) return 'comments';
    if (normalized.includes('gallery')) return 'gallery';
    if (normalized.includes('tab')) return 'tabs';
    if (normalized.includes('accordion')) return 'accordion';
    if (normalized.includes('modal') || normalized.includes('popup'))
      return 'modal';
    if (normalized.includes('slider') || normalized.includes('carousel'))
      return 'slider';
    if (normalized.includes('nav') || normalized.includes('menu'))
      return 'navigation';
    if (normalized.includes('newsletter') || normalized.includes('subscribe')) {
      return 'newsletter';
    }
    if (normalized.includes('query') || normalized.includes('post-list'))
      return 'query';
    return undefined;
  }

  private isHomeLikeComponentPlan(componentPlan: PlanResult[number]): boolean {
    const template = componentPlan.templateName.toLowerCase();
    return (
      componentPlan.route === '/' ||
      template === 'front-page' ||
      template === 'frontend-page' ||
      template === 'home' ||
      template === 'index'
    );
  }

  private isPostDetailComponentPlan(
    componentPlan: PlanResult[number],
  ): boolean {
    const needs = new Set(toVisualDataNeeds(componentPlan.dataNeeds));
    return (
      componentPlan.isDetail === true &&
      (needs.has('postDetail') ||
        componentPlan.templateName.toLowerCase().startsWith('single') ||
        (componentPlan.route ?? '').startsWith('/post/'))
    );
  }

  private isProductDetailComponentPlan(
    componentPlan: PlanResult[number],
  ): boolean {
    const needs = new Set(toVisualDataNeeds(componentPlan.dataNeeds));
    return (
      componentPlan.isDetail === true &&
      (needs.has('productDetail') ||
        componentPlan.templateName.toLowerCase().startsWith('single-product') ||
        (componentPlan.route ?? '').startsWith('/product/'))
    );
  }

  private inferHomeMode(
    componentPlan: PlanResult[number],
    clusters: Array<{ kind: PlannerClusterKind }>,
  ): 'front-page' | 'posts-index' | 'hybrid-home' {
    const template = componentPlan.templateName.toLowerCase();
    const hasFeed = clusters.some((cluster) => cluster.kind === 'posts-feed');
    if (template === 'front-page' || template === 'frontend-page') {
      return hasFeed ? 'hybrid-home' : 'front-page';
    }
    if (template === 'home' || template === 'index') {
      return hasFeed ? 'posts-index' : 'hybrid-home';
    }
    return hasFeed ? 'hybrid-home' : 'front-page';
  }

  private dedupeStringList(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
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
      componentPlan.isDetail === true && componentPlan.route !== '/',
    );
    const dataNeeds = toVisualDataNeeds(componentPlan.dataNeeds);
    const base = {
      componentName: componentPlan.componentName,
      dataNeeds,
      palette: globalPalette,
      typography: globalTypography,
      layout,
      blockStyles: tokens?.blockStyles,
    } as const;
    const strategy = getComponentStrategy(componentPlan.componentName);
    const prefersBlockTreeSharedChrome =
      this.themeProfiles.prefersBlockTreeSharedChrome(
        content.siteInfo?.activeTheme,
      ) && (componentPlan.draftBlockTree?.length ?? 0) > 0;
    switch (strategy.kind) {
      case 'not-found':
        if (!strategy.deterministicFirst) return undefined;
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
        // When a source-faithful shared-chrome theme already has block-tree
        // evidence, let the block-tree deterministic planner own Header.
        // Keeping the legacy semantic navbar stub here creates conflicting
        // plans and drops theme-specific wrappers/classes.
        if (prefersBlockTreeSharedChrome) return undefined;
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
        // Same policy as Header: prefer preserved source block trees for
        // source-faithful shared chrome instead of the old semantic stub.
        if (prefersBlockTreeSharedChrome) return undefined;
        if (!strategy.deterministicFirst) return undefined;
        return {
          ...base,
          sections: [
            {
              type: 'footer',
              // Filter out menus whose name matches invented auxiliary labels
              // (e.g. "Navigation") to avoid the footer section being pruned by
              // pruneTrailingInventedAuxiliarySections when its only column is a
              // generic "Navigation" menu. The auxiliary guard now also skips
              // footer/navbar sections entirely, but keep this filter as defense-in-depth.
              menuColumns: content.menus
                .slice(0, 3)
                .filter(
                  (menu) =>
                    !PLANNER_INVENTED_AUXILIARY_LABEL_SET.has(
                      menu.name.trim().toLowerCase(),
                    ),
                )
                .map((menu) => ({
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
        if (!strategy.deterministicFirst) return undefined;
        return {
          ...base,
          sections: [
            {
              type: 'sidebar',
              title: 'Explore',
              widgets: [
                { kind: 'pages-list', title: 'Pages' },
                ...(content.posts.length > 0
                  ? ([{ kind: 'recent-posts', title: 'Recent Posts' }] as const)
                  : []),
              ],
              maxItems: 6,
            },
          ],
        };
      case 'breadcrumb':
        if (!strategy.deterministicFirst) return undefined;
        return {
          ...base,
          sections: [{ type: 'breadcrumb' }],
        };
      case 'comments':
        if (!strategy.deterministicFirst) return undefined;
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
      case 'post-meta':
        if (!strategy.deterministicFirst) return undefined;
        return {
          ...base,
          sections: [
            {
              type: 'post-meta',
              layout: 'inline',
              showDate: true,
              showAuthor: true,
              showCategories: true,
              showSeparator: true,
            },
          ],
        };
      default:
        return undefined;
    }
  }

  private shouldSkipAiVisualPlan(componentPlan: PlanResult[number]): boolean {
    if (componentPlan.runtimeRenderer === 'runtime-page') return true;
    if (componentPlan.type !== 'partial') return false;
    return getComponentStrategy(componentPlan.componentName).skipAiVisualPlan;
  }

  private normalizeAiVisualPlanForComponent(
    visualPlan: ComponentVisualPlan,
    componentPlan: PlanResult[number],
  ): ComponentVisualPlan {
    const visualDataNeeds = toVisualDataNeeds(componentPlan.dataNeeds);
    const isProductListing =
      visualDataNeeds.includes('products') &&
      !visualDataNeeds.includes('posts') &&
      !componentPlan.isDetail;

    return {
      ...visualPlan,
      renderMode: visualPlan.renderMode ?? 'section-centric',
      renderAuthority: visualPlan.renderAuthority ?? 'ai',
      deterministicAuthority: visualPlan.deterministicAuthority ?? false,
      sections: visualPlan.sections.map((section) => {
        if (section.type !== 'post-list' || !isProductListing) {
          return section;
        }

        const minItems = section.obligation?.minItems;
        const normalizedMinItems = minItems
          ? {
              ...(minItems.slides ? { slides: minItems.slides } : {}),
              ...(minItems.cards ? { cards: minItems.cards } : {}),
              products: minItems.products ?? minItems.posts ?? 1,
            }
          : undefined;

        return {
          ...section,
          resource: 'products',
          obligation: section.obligation
            ? {
                ...section.obligation,
                required: section.obligation.required.map((capability) =>
                  capability === 'posts' ? 'products' : capability,
                ),
                ...(normalizedMinItems ? { minItems: normalizedMinItems } : {}),
              }
            : section.obligation,
        };
      }),
    };
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
      tokens?.blockStyles?.heading?.typography?.fontFamily ??
      fontMap.get('heading') ??
      fontMap.get('headings') ??
      fontMap.get('display') ??
      d.fontFamily ??
      'inherit';

    const bodyFamily =
      d.fontFamily ??
      fontMap.get('body') ??
      fontMap.get('base') ??
      fontMap.get('text') ??
      'inherit';

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

  buildLayoutAnalysisArtifact(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    repoManifest?: RepoThemeManifest,
  ): LayoutAnalysisArtifact {
    if (theme.type !== 'fse') {
      return createUnsupportedLayoutAnalysisArtifact({
        parserType: theme.type,
        supportReason:
          'Layout analysis artifact currently supports only FSE themes.',
        manifest: repoManifest,
        resolvedSource: repoManifest?.resolvedSource,
        content,
      });
    }

    const detectedThemeKind = repoManifest?.themeTypeHints.detectedThemeKind;
    if (
      detectedThemeKind &&
      detectedThemeKind !== 'block' &&
      detectedThemeKind !== 'hybrid'
    ) {
      return createUnsupportedLayoutAnalysisArtifact({
        parserType: theme.type,
        supportReason: `Theme kind "${detectedThemeKind}" is outside the current deterministic FSE scope.`,
        manifest: repoManifest,
        resolvedSource: repoManifest?.resolvedSource,
        content,
      });
    }

    const sourceMap = new Map<string, string>();
    const allTemplates = [...theme.templates, ...theme.parts];
    for (const template of allTemplates) {
      sourceMap.set(template.name, template.markup);
    }

    const candidatePlans = this.enrichPlan(
      theme.parts
        .map((part) => ({
          templateName: part.name,
          componentName: this.toComponentName(part.name),
          type: 'partial' as const,
          route: null,
          dataNeeds: [],
          isDetail: false,
          description: `Deterministic layout analysis for ${part.name}`,
        }))
        .filter((plan) => isSharedChromePartialComponent(plan.componentName)),
      sourceMap,
      content,
    );

    const globalPalette = this.deriveGlobalPalette(theme.tokens);
    const globalTypography = this.deriveGlobalTypography(theme.tokens);
    const hasSharedLayoutPartials = candidatePlans.length > 0;

    const components = candidatePlans.map((componentPlan) => {
      const templateSource = sourceMap.get(componentPlan.templateName) ?? '';
      const sourceCandidates = this.buildPlanningSourceCandidates(
        componentPlan,
        templateSource,
        sourceMap,
        content,
        repoManifest,
      );
      const preferredSource = sourceCandidates[0];
      const planningSource = preferredSource
        ? this.buildPlanningSourceContextFromResolvedSource(
            componentPlan,
            preferredSource,
            hasSharedLayoutPartials,
            theme.tokens,
            sourceCandidates,
            content,
          )
        : undefined;
      const draftSections = this.buildDraftSectionsForPlanningSource(
        planningSource,
        componentPlan,
        theme.tokens,
      );
      const draftBlockTree = this.buildDraftBlockTreeForPlanningSource(
        planningSource,
        componentPlan,
        theme.tokens,
      );
      const visualPlan = this.buildBlockTreeDrivenVisualPlanForComponent({
        componentPlan,
        draftSections,
        draftBlockTree,
        content,
        tokens: theme.tokens,
        globalPalette,
        globalTypography,
      });
      const renderContract = buildComponentRenderContract({
        componentName: componentPlan.componentName,
        templateName: componentPlan.templateName,
        planningSourceFile: planningSource?.sourceFile,
        planningSourceSummary: planningSource?.sourceAnalysis,
        sectionTypes: visualPlan?.sections.map((section) => section.type),
        fallbackSections: draftSections,
        visualRenderMode: visualPlan?.renderMode,
        deterministicAuthority: visualPlan?.deterministicAuthority,
        draftBlockTree,
      });

      const reason = !planningSource
        ? 'No planning source could be resolved for this shared chrome component.'
        : !draftBlockTree?.length
          ? 'Planning source was resolved, but it did not produce a usable block tree.'
          : visualPlan?.deterministicAuthority === true
            ? 'Resolved FSE source produced a block tree and deterministic visual plan; downstream codegen should preserve structure and bind data only.'
            : 'Block tree was recovered, but no deterministic shared-chrome visual plan was produced yet.';

      return buildLayoutAnalysisComponentEntry({
        templateName: componentPlan.templateName,
        componentName: componentPlan.componentName,
        componentType: componentPlan.type,
        dataNeeds: componentPlan.dataNeeds,
        planningSource,
        sourceCandidates,
        draftBlockTree,
        draftSections,
        renderContract,
        visualPlan,
        reason,
      });
    });

    return createLayoutAnalysisArtifact({
      parserType: theme.type,
      manifest: repoManifest,
      resolvedSource: repoManifest?.resolvedSource,
      content,
      components,
    });
  }

  buildDeterministicRenderContractArtifact(
    plan: PlanResult,
  ): DeterministicRenderContractArtifact {
    return buildDeterministicRenderContractArtifact(plan);
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
      componentPlan.route
        ?.trim()
        .replace(/^\/+|\/+$/g, '')
        .replace(/\//g, '__') ||
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
    isDetailPage: boolean = false,
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
    const isCanonicalSingleWithSidebar = /^SingleWithSidebar$/i.test(
      componentName,
    );

    // containerClass wraps each section at wideSize so wide/full-aligned blocks
    // can span the full allowed width. contentContainerClass constrains prose
    // and inline content to contentSize. Both rules apply to all page types —
    // using contentSize as the section container incorrectly clips full-width
    // sections on bound-page templates (title1, senior-swe, etc.).
    const sectionMaxW = d.wideWidth ?? d.contentWidth ?? '1280px';
    const contentMaxW = d.contentWidth ?? '800px';
    // Clamp wide width to a sane upper bound — some themes set wideSize to
    // e.g. "100vw" or "100%" which breaks arbitrary Tailwind values.
    const sectionMaxWNormalized = /^\d+(\.\d+)?(px|rem|em)$/.test(sectionMaxW)
      ? sectionMaxW
      : '1280px';
    const containerClass = `max-w-[${sectionMaxWNormalized}] mx-auto w-full`;
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
      sidebarWidth: isCanonicalSingleWithSidebar ? '30%' : '320px',
      sidebarScope: isCanonicalSingleWithSidebar ? 'all-content' : 'main-only',
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

    const background =
      d.bgColor ??
      pick('background', 'base', 'white', 'neutral-100', 'off-white') ??
      '#ffffff';
    const textColor =
      d.textColor ??
      pick(
        'foreground',
        'contrast',
        'dark',
        'primary-text',
        'neutral-900',
        'black',
        'text',
      ) ??
      '#111111';

    // Button bg is the most reliable accent signal — it's the brand CTA color.
    // Link color is only used as accent when it's visually distinct from body text.
    const linkAsAccent =
      d.linkColor && d.linkColor !== textColor ? d.linkColor : undefined;
    const accent =
      d.buttonBgColor ??
      linkAsAccent ??
      pick(
        'primary',
        'accent',
        'brand',
        'highlight',
        'cta',
        'contrast-3',
        'contrast-2',
        'secondary',
        'vivid-red',
        'vivid-cyan-blue',
        'luminous-vivid-amber',
      ) ??
      this.pickMostSaturatedColor(tokens?.colors) ??
      '#0066cc';

    return {
      background,
      surface:
        pick(
          'surface',
          'secondary',
          'light',
          'neutral-50',
          'neutral-100',
          'gray-100',
          'off-white',
          'subtle',
        ) ?? '#f5f5f5',
      text: textColor,
      textMuted:
        d.captionColor ??
        pick('secondary-text', 'muted', 'neutral-600', 'gray', 'subtle') ??
        '#666666',
      accent,
      accentText:
        d.buttonTextColor ?? pick('base', 'white', 'neutral-50') ?? '#ffffff',
      dark:
        pick('dark', 'contrast', 'black', 'neutral-900') ??
        d.textColor ??
        '#111111',
      darkText:
        pick('light', 'base', 'white', 'neutral-50') ?? d.bgColor ?? '#ffffff',
    };
  }

  /** Returns the most saturated hex color from the palette, or undefined if none is vivid. */
  private pickMostSaturatedColor(
    colors: ThemeTokens['colors'] | undefined,
  ): string | undefined {
    if (!colors?.length) return undefined;
    let bestColor: string | undefined;
    let bestSat = 0;
    for (const { value } of colors) {
      const sat = this.estimateColorSaturation(value);
      if (sat > bestSat) {
        bestSat = sat;
        bestColor = value;
      }
    }
    return bestSat > 30 ? bestColor : undefined;
  }

  private estimateColorSaturation(hex: string): number {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) return 0;
    const r = parseInt(m[1], 16) / 255;
    const g = parseInt(m[2], 16) / 255;
    const b = parseInt(m[3], 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const l = (max + min) / 2;
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    return Math.round(s * 100);
  }

  // ── Layer 2: enrich dataNeeds by scanning template source ─────────────────

  private enrichPlan(
    plan: PlanResult,
    sourceMap: Map<string, string>,
    content: DbContentResult,
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
      const prefersBlockTreeSharedChrome =
        this.themeProfiles.prefersBlockTreeSharedChrome(
          content.siteInfo?.activeTheme,
        );
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
      const isSidebarLike =
        /(^|[\s/_-])sidebar(?:$|[\s/_-])/.test(componentKey) ||
        templateBase.includes('sidebar');
      const isPageTemplate =
        templateBase.startsWith('page') || templateBase === 'frontend-page';
      const isWooProductTemplate =
        templateBase === 'archive-product' ||
        templateBase === 'single-product' ||
        source.includes('"postType":"product"') ||
        source.includes('"postType": "product"') ||
        source.includes('woocommerce/product-query') ||
        source.includes('woocommerce/related-products') ||
        source.includes('term":"product_cat"') ||
        source.includes('term":"product_tag"');
      const detailNeed = isPageTemplate
        ? 'page-detail'
        : isWooProductTemplate
          ? 'product-detail'
          : 'post-detail';
      const listingNeed = isWooProductTemplate ? 'products' : 'posts';
      const hasNavigationEvidence =
        source.includes('wp:navigation') ||
        source.includes('block:"navigation"') ||
        source.includes('"navigation"');
      const hasSiteInfoEvidence =
        source.includes('wp:site-logo') ||
        source.includes('"site-logo"') ||
        source.includes('wp:site-title') ||
        source.includes('"site-title"') ||
        source.includes('wp:site-tagline') ||
        source.includes('"site-tagline"');

      // FSE block theme
      if (hasNavigationEvidence)
        if (ownsSharedChromeData) {
          if (isFooterPartial) needs.add('footer-links');
          else needs.add('menus');
        }
      if (source.includes('wp:query') || source.includes('"query"'))
        needs.add(listingNeed);
      if (
        source.includes('wp:post-content') ||
        source.includes('"post-content"')
      )
        needs.add(detailNeed);
      if (hasSiteInfoEvidence) if (ownsSharedChromeData) needs.add('site-info');
      if (
        isSidebarLike &&
        (source.includes('wp:post-author-biography') ||
          source.includes('"post-author-biography"') ||
          source.includes('wp:avatar') ||
          source.includes('"avatar"'))
      ) {
        needs.add(listingNeed);
        needs.add('site-info');
      }
      if (
        isSidebarLike &&
        (source.includes('wp:categories') || source.includes('"categories"'))
      ) {
        needs.add(listingNeed);
      }
      if (
        isSidebarLike &&
        (source.includes('wp:latest-posts') ||
          source.includes('"latest-posts"'))
      ) {
        needs.add(listingNeed);
      }

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
      if (source.includes('{/* WP: loop start */}')) needs.add(listingNeed);
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
        if (prefersBlockTreeSharedChrome) {
          if (hasNavigationEvidence) needs.add('footer-links');
          else needs.delete('footer-links');
          if (hasSiteInfoEvidence) needs.add('site-info');
          else needs.delete('site-info');
        } else {
          needs.add('footer-links');
          needs.add('site-info');
        }
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

  private applyDeterministicRouteContracts(
    plan: PlanResult,
    content: DbContentResult,
    repoManifest?: RepoThemeManifest,
  ): PlanResult {
    const homeHierarchy = resolveHomeHierarchy({
      templateNames: plan.map((item) => item.templateName),
      repoManifest,
      explicitTemplateNames: getTrustedPlanningDbTemplateSlugs(content),
      readingSettings: content.readingSettings,
    });
    return plan.map((item) => {
      const homeTemplateBase =
        item.homeTemplateBase ?? toHomeTemplateBase(item.templateName);
      const resolvedHomeRoute = homeTemplateBase
        ? homeHierarchy.routeByBase[homeTemplateBase]
        : undefined;
      const concretePageBindings =
        item.type === 'page' && !item.fixedSlug
          ? this.findConcretePagesForTemplate(item, content)
          : [];
      const repoRouteHints = buildRepoRouteHints(
        item.templateName,
        repoManifest,
      );
      const shouldPromoteToExactPageBinding =
        item.type === 'page' &&
        concretePageBindings.length > 0 &&
        !item.fixedSlug &&
        !item.dataNeeds.includes('post-detail');

      const contract = shouldPromoteToExactPageBinding
        ? {
            ...inferDeterministicRouteContract({
              templateName: item.templateName,
              componentName: item.componentName,
              type: item.type,
              route: '/page/:slug',
              dataNeeds: [...item.dataNeeds, 'page-detail'],
              isDetail: true,
              fixedPageId: item.fixedPageId,
              draftBlockTree: item.draftBlockTree,
              renderContract: item.renderContract,
              planningSourceFile: item.planningSourceFile,
              planningSourceLabel: item.planningSourceLabel,
              planningSourceSummary: item.planningSourceSummary,
              hasConcretePageBindings: true,
              repoRouteHints,
              readingSettings: content.readingSettings,
              homeMode: item.homeMode ?? undefined,
            }),
            route: '/page/:slug',
            isDetail: true,
            requiredDataNeeds: ['page-detail'] as const,
          }
        : inferDeterministicRouteContract({
            templateName: item.templateName,
            componentName: item.componentName,
            type: item.type,
            route: resolvedHomeRoute ?? item.route,
            dataNeeds: item.dataNeeds,
            isDetail: item.isDetail,
            fixedSlug: item.fixedSlug,
            fixedPageId: item.fixedPageId,
            draftBlockTree: item.draftBlockTree,
            renderContract: item.renderContract,
            planningSourceFile: item.planningSourceFile,
            planningSourceLabel: item.planningSourceLabel,
            planningSourceSummary: item.planningSourceSummary,
            hasConcretePageBindings: concretePageBindings.length > 0,
            repoRouteHints,
            readingSettings: content.readingSettings,
            homeMode: item.homeMode ?? undefined,
          });

      const normalizedNeeds = new Set(item.dataNeeds);
      for (const disallowedNeed of contract.disallowedDetailDataNeeds) {
        normalizedNeeds.delete(disallowedNeed);
      }
      for (const requiredNeed of contract.requiredDataNeeds) {
        normalizedNeeds.add(requiredNeed);
      }

      return {
        ...item,
        type: contract.type,
        route: contract.route,
        isDetail: contract.isDetail,
        dataNeeds: this.orderPlannerDataNeeds([...normalizedNeeds]),
        planningSourceLabel:
          item.planningSourceLabel ??
          (repoRouteHints ? `repo-chain:${item.templateName}` : undefined),
        planningSourceFile:
          item.planningSourceFile ?? repoRouteHints?.entryFile,
        planningSourceSummary:
          item.planningSourceSummary ??
          (repoRouteHints
            ? [
                repoRouteHints.templatePartArea
                  ? `templatePartArea=${repoRouteHints.templatePartArea}`
                  : null,
                repoRouteHints.blockTypes.length > 0
                  ? `entryChainBlocks=${repoRouteHints.blockTypes.join(', ')}`
                  : null,
                repoRouteHints.notes.length > 0
                  ? `entryChainNotes=${repoRouteHints.notes.join(', ')}`
                  : null,
              ]
                .filter(Boolean)
                .join(' | ')
            : undefined),
        homeTemplateBase: contract.homeTemplateBase ?? item.homeTemplateBase,
        homeMode: contract.homeMode ?? item.homeMode,
      };
    });
  }

  private materializeConcretePagePlans(
    plan: PlanResult,
    content: DbContentResult,
  ): PlanResult {
    const result: PlanResult = [];
    const usedComponentNames = new Set<string>();
    let materializedCount = 0;
    let runtimeBackedGenericCount = 0;
    let runtimeBackedPageCount = 0;
    let runtimePageAdded = false;

    for (const item of plan) {
      if (item.fixedSlug || !this.shouldExpandConcretePages(item)) {
        result.push(item);
        usedComponentNames.add(item.componentName);
        continue;
      }

      const matchedPages = this.findConcretePagesForTemplate(item, content);
      const runtimeTemplateCandidate =
        isDefaultRuntimePageTemplateCandidate(item);

      if (runtimeTemplateCandidate) {
        // Only emit one RuntimePage entry regardless of how many templates
        // resolve to /page/:slug (e.g. blank, full-width, template-about, page).
        if (!runtimePageAdded) {
          const genericRuntimeItem = this.buildRuntimePageBasePlan(
            item,
            matchedPages.length,
          );
          result.push(genericRuntimeItem);
          usedComponentNames.add(genericRuntimeItem.componentName);
          runtimePageAdded = true;
        }
        runtimeBackedGenericCount += 1;
        runtimeBackedPageCount += matchedPages.length;
        continue;
      }

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

    if (materializedCount > 0 || runtimeBackedGenericCount > 0) {
      const detail = [
        materializedCount > 0
          ? `materialized ${materializedCount} exact page component(s)`
          : null,
        runtimeBackedGenericCount > 0
          ? `kept ${runtimeBackedGenericCount} runtime-backed generic page route(s)${
              runtimeBackedPageCount > 0
                ? ` covering ${runtimeBackedPageCount} DB page(s)`
                : ''
            }`
          : null,
      ]
        .filter(Boolean)
        .join(' | ');
      this.logger.log(`[Phase B: Concrete Page Expansion] ${detail}`);
    }

    return result;
  }

  private buildRuntimePageBasePlan(
    item: PlanResult[number],
    runtimeBackedPageCount: number,
  ): PlanResult[number] {
    return {
      ...item,
      componentName: 'RuntimePage',
      route: '/page/:slug',
      isDetail: true,
      dataNeeds: ['page-detail'],
      runtimeRenderer: 'runtime-page',
      fixedSlug: undefined,
      fixedPageId: undefined,
      fixedTitle: undefined,
      visualPlan: undefined,
      surfacePlan: undefined,
      renderContract: undefined,
      planningSourceLabel: 'runtime:page-detail',
      planningSourceReason: 'generic runtime page route',
      planningSourceFile: 'templates/react-preview/src/pages/RuntimePage.tsx',
      planningSourceSummary:
        runtimeBackedPageCount > 0
          ? `Default page route kept generic for ${runtimeBackedPageCount} DB page(s) through the runtime page endpoint.`
          : 'Default page route kept generic so newly added WordPress pages can render through the runtime page endpoint.',
      description:
        'Generic runtime-rendered WordPress page route backed by /api/runtime/pages/:slug.',
    };
  }

  private orderPlannerDataNeeds(dataNeeds: string[]): string[] {
    const order = [
      'post-detail',
      'product-detail',
      'page-detail',
      'categoryDetail',
      'comments',
      'posts',
      'products',
      'pages',
      'menus',
      'site-info',
      'footer-links',
    ];
    return order.filter((need) => dataNeeds.includes(need));
  }

  private shouldExpandConcretePages(item: PlanResult[number]): boolean {
    if (item.type !== 'page') return false;
    if (!item.isDetail) return false;
    if (!Array.isArray(item.dataNeeds)) return false;

    const normalizedNeeds = new Set(item.dataNeeds.map((need) => need.trim()));
    if (!normalizedNeeds.has('page-detail')) return false;
    return true;
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
        return this.pageMatchesPlanningTemplate(page, templateName, content);
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

  private pageMatchesPlanningTemplate(
    page: DbContentResult['pages'][number],
    templateName: string,
    content: DbContentResult,
  ): boolean {
    const pageTemplate = this.normalizeTemplateIdentifier(page.template);
    const normalizedTemplate = this.normalizeTemplateIdentifier(templateName);
    if (!normalizedTemplate) return false;

    if (normalizedTemplate === 'page') {
      return pageTemplate === '' || pageTemplate === 'default';
    }
    if (pageTemplate === normalizedTemplate) {
      return true;
    }

    // Concrete page expansion must only bind named templates to pages when the
    // page is actually assigned that template in WordPress. Semantic route
    // heuristics remain useful for planning-source hints, but they are too
    // broad to safely materialize exact route/component bindings.
    if (/^(template-|blank$|full-width$)/.test(normalizedTemplate)) {
      return false;
    }

    const resolvedRoute = content.themeResolvedContent?.routes.find(
      (route) =>
        Number(route.pageId) === Number(page.id) || route.slug === page.slug,
    );
    if (!resolvedRoute) return false;

    return [
      ...resolvedRoute.templateCandidates,
      ...resolvedRoute.matchedDbTemplateSlugs,
    ]
      .map((candidate) => this.normalizeTemplateIdentifier(candidate))
      .includes(normalizedTemplate);
  }

  buildRoutingDecisionArtifact(input: {
    plan: PlanResult;
    content: DbContentResult;
    repoManifest?: RepoThemeManifest;
    expectedTemplateNames?: string[];
  }): Record<string, unknown> {
    const { plan, content, repoManifest, expectedTemplateNames = [] } = input;
    const explicitTemplateNames = plan
      .filter((item) => {
        const base =
          item.homeTemplateBase ?? toHomeTemplateBase(item.templateName);
        if (!base) return false;
        const sourceFile = String(item.planningSourceFile ?? '').toLowerCase();
        const sourceLabel = String(
          item.planningSourceLabel ?? '',
        ).toLowerCase();
        return (
          sourceFile.endsWith(`/${base}`) ||
          sourceLabel.endsWith(`:${base}`) ||
          sourceLabel.endsWith(`/${base}`)
        );
      })
      .map((item) => item.templateName);

    const homeHierarchy = resolveHomeHierarchy({
      templateNames: [
        ...expectedTemplateNames,
        ...plan.map((item) => item.templateName),
      ],
      repoManifest,
      explicitTemplateNames,
      readingSettings: content.readingSettings,
    });

    return {
      generatedAt: new Date().toISOString(),
      readingSettings: content.readingSettings,
      homeHierarchy,
      routes: plan.map((item) => {
        const repoRouteHints = buildRepoRouteHints(
          item.templateName,
          repoManifest,
        );
        const concretePageBindings =
          item.type === 'page' && !item.fixedSlug
            ? this.findConcretePagesForTemplate(item, content)
            : [];
        const contract = inferDeterministicRouteContract({
          templateName: item.templateName,
          componentName: item.componentName,
          type: item.type,
          route: item.route,
          dataNeeds: item.dataNeeds,
          isDetail: item.isDetail,
          fixedSlug: item.fixedSlug,
          fixedPageId: item.fixedPageId,
          draftBlockTree: item.draftBlockTree,
          renderContract: item.renderContract,
          planningSourceFile: item.planningSourceFile,
          planningSourceLabel: item.planningSourceLabel,
          planningSourceSummary: item.planningSourceSummary,
          hasConcretePageBindings: concretePageBindings.length > 0,
          repoRouteHints,
          readingSettings: content.readingSettings,
          homeMode: item.homeMode ?? undefined,
        });

        return {
          templateName: item.templateName,
          componentName: item.componentName,
          type: item.type,
          route: item.route,
          isDetail: item.isDetail,
          dataNeeds: item.dataNeeds,
          fixedSlug: item.fixedSlug ?? null,
          fixedPageId: item.fixedPageId ?? null,
          planningSource: {
            label: item.planningSourceLabel ?? null,
            file: item.planningSourceFile ?? null,
            summary: item.planningSourceSummary ?? null,
          },
          repoRouteHints,
          inferredContract: contract,
        };
      }),
    };
  }

  private buildConcretePageRoute(
    page: DbContentResult['pages'][number],
    content: DbContentResult,
  ): string {
    return buildCanonicalPagePath(page, content.pages, {
      frontPageId: content.readingSettings.pageOnFrontId,
    });
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
 - frontend-page OR front-page → highest-priority home route "/"
 - If both a front-page-like template and a posts-index template exist:
   use home for "/blog" only when there is real dedicated home source evidence; otherwise let index own "/blog"
 - index → route "/" only when there is no higher-priority front-page/home template.
   If front-page owns "/", index may be "/blog" when it is the posts index fallback, otherwise "/index"
- archive → route "/archive"  (WordPress archive fallback: handles category/tag/author/date archives — App.tsx will register alias routes /category/:slug, /author/:slug, /tag/:slug pointing to this component)
- search → route "/search"
- 404 → route "*"
- single / single-post → route "/post/:slug"   (isDetail: true)
- page (the default page template) → route "/page/:slug"   (isDetail: true)
- page-* templates may use "/<exact-template-name>/:slug" ONLY when they are acting as page-detail templates
  and are expected to materialize exact DB-backed pages later.
- Custom templates that are NOT clear singular detail templates should default to a static route
  "/<exact-template-name>" with isDetail: false.
- Do NOT assume every custom template is a slug-detail page.
- If a custom template has clear DB page bindings, prefer exact bound page components with fixedSlug
  over inventing a generic "/template-name/:slug" route.
- header / footer / sidebar / nav / navigation / searchform / comments / comment /
  post-meta / widget / breadcrumb / pagination / loop / content-none / no-results /
  functions → type "partial", route null

── DATA NEEDS RULES ───────────────────────────────────────────────────────────
Allowed values: "posts" | "products" | "pages" | "menus" | "site-info" | "footer-links" | "post-detail" | "product-detail" | "page-detail" | "comments"

- "post-detail"  → ONLY for single-post templates (route /post/:slug or /single-*/:slug)
- "product-detail" → ONLY for Woo single-product templates (route /product/:slug)
- "page-detail"  → ONLY for true page-detail templates or exact bound DB pages
- Page templates MUST use "page-detail" — NEVER "post-detail"
- Static custom templates MUST NOT keep "post-detail", "product-detail", or "page-detail" unless they are truly singular/detail routes
- Partial components (type "partial") MUST NOT include "post-detail", "product-detail", or "page-detail"
- Archive / listing pages use "posts" or "products", not detail data needs
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

    const repoContext = buildRepoManifestContextNote(repoManifest, {
      mode: 'full',
      includeLayoutHints: true,
      includeStyleHints: true,
      includeStructureHints: true,
    });
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

    lines.push(`## DB navigations (${content.dbNavigations.length} total):`);
    for (const nav of content.dbNavigations.slice(0, 12)) {
      lines.push(
        `- "${nav.title}" (slug: ${nav.slug}) status=${nav.status} location=${nav.location ?? '(none)'} items=${nav.items.length} blockTypes=${nav.blockTypes.join(', ') || '(none)'}`,
      );
    }
    lines.push('');

    lines.push(`## Taxonomies (${content.taxonomies.length} total):`);
    for (const taxonomy of content.taxonomies.slice(0, 12)) {
      const termPreview = taxonomy.terms
        .slice(0, 8)
        .map((term) => `${term.slug}(${term.count})`)
        .join(', ');
      lines.push(
        `- ${taxonomy.taxonomy}: ${taxonomy.terms.length} terms${termPreview ? ` — ${termPreview}` : ''}`,
      );
    }
    lines.push('');

    lines.push('## Parsed global style tokens');
    if (content.parsedGlobalStyles) {
      lines.push(
        `- palette=${content.parsedGlobalStyles.colorPalette.length} gradients=${content.parsedGlobalStyles.gradients.length} fontSizes=${content.parsedGlobalStyles.fontSizes.length} fontFamilies=${content.parsedGlobalStyles.fontFamilies.length} spacingSizes=${content.parsedGlobalStyles.spacingSizes.length} cssVariables=${Object.keys(content.parsedGlobalStyles.customCssVariables).length}`,
      );
      if (content.parsedGlobalStyles.globalColor) {
        lines.push(`- globalColor: ${content.parsedGlobalStyles.globalColor}`);
      }
      if (content.parsedGlobalStyles.globalBackgroundColor) {
        lines.push(
          `- globalBackgroundColor: ${content.parsedGlobalStyles.globalBackgroundColor}`,
        );
      }
      if (content.parsedGlobalStyles.globalFontFamily) {
        lines.push(
          `- globalFontFamily: ${content.parsedGlobalStyles.globalFontFamily}`,
        );
      }
      if (content.parsedGlobalStyles.globalFontSize) {
        lines.push(
          `- globalFontSize: ${content.parsedGlobalStyles.globalFontSize}`,
        );
      }
      const palettePreview = content.parsedGlobalStyles.colorPalette
        .slice(0, 8)
        .map((entry) => `${entry.slug}=${entry.color}`)
        .join(', ');
      if (palettePreview) {
        lines.push(`- palette preview: ${palettePreview}`);
      }
    } else {
      lines.push('- none');
    }
    lines.push('');

    lines.push(
      `## Media attachments (${content.mediaAttachments.length} total):`,
    );
    for (const media of content.mediaAttachments.slice(0, 20)) {
      lines.push(
        `- [${media.mimeType || 'unknown'}] "${media.title}" slug=${media.slug || '(none)'} alt="${media.altText || ''}" file=${media.filePath ?? media.guid}`,
      );
    }
    lines.push('');

    lines.push(
      `## Custom CSS entries (${content.customCssEntries.length} total):`,
    );
    for (const customCss of content.customCssEntries.slice(0, 10)) {
      const cssPreview = customCss.content
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
      lines.push(
        `- "${customCss.title}" (slug: ${customCss.slug}) status=${customCss.status}${cssPreview ? ` — ${cssPreview}` : ''}`,
      );
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
        repoManifest,
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
        repoManifest,
      ) =>
        this.buildPlanningSourceCandidates(
          componentPlan as PlanResult[number],
          templateSource,
          sourceMap,
          content,
          repoManifest,
        ),
      buildPlanningSourceContext: (
        componentPlan,
        templateSource,
        sourceMap,
        content,
        hasSharedLayoutPartials,
        tokens,
        repoManifest,
      ) =>
        this.buildPlanningSourceContext(
          componentPlan as PlanResult[number],
          templateSource,
          sourceMap,
          content,
          hasSharedLayoutPartials,
          tokens,
          repoManifest,
        ),
      buildPlanningSourceContextFromResolvedSource: (
        componentPlan,
        preferredSource,
        hasSharedLayoutPartials,
        tokens,
      ) =>
        this.buildPlanningSourceContextFromResolvedSource(
          componentPlan as PlanResult[number],
          preferredSource,
          hasSharedLayoutPartials,
          tokens,
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
      buildDraftBlockTreeForPlanningSource: (
        planningSource,
        componentPlan,
        tokens,
      ) =>
        this.buildDraftBlockTreeForPlanningSource(
          planningSource,
          componentPlan as PlanResult[number],
          tokens,
        ),
      buildSurfacePlanForComponent: (input) =>
        this.buildSurfacePlanForComponent({
          componentPlan: input.componentPlan as PlanResult[number],
          content: input.content,
          planningSource: input.planningSource,
          draftSections: input.draftSections,
          draftBlockTree: input.draftBlockTree,
          visualPlan: input.visualPlan,
          detectedCustomClassNames: input.detectedCustomClassNames,
          sourceWidgetHints: input.sourceWidgetHints,
          hasSharedLayoutPartials: input.hasSharedLayoutPartials,
          globalPalette: input.globalPalette,
          globalTypography: input.globalTypography,
          tokens: input.tokens,
        }),
      collectDraftCustomClassNames: (draftSections) =>
        this.collectDraftCustomClassNames(draftSections),
      detectInteractiveWidgetsFromSource: (source) =>
        detectInteractiveWidgetsFromSource(source),
      extractHeadingTextsFromSource: (source) =>
        extractHeadingTextsFromSource(source),
      countDraftSectionsInSource: (source) =>
        countDraftSectionsInSource(source),
      scorePlanningSourceRichness: (source) =>
        scorePlanningSourceRichness(source),
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
      deriveComponentLayout: (tokens, componentName, isDetailPage) =>
        this.deriveComponentLayout(tokens, componentName, isDetailPage),
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
    const mergeMode = this.shouldUseLightDraftMerge(contract)
      ? 'light'
      : 'full';
    return sections.map((section, index) =>
      this.mergeDraftSection(section, effectiveDraft[index], mergeMode),
    );
  }

  private mergeDraftSection(
    section: SectionPlan,
    draft?: SectionPlan,
    mergeMode: 'light' | 'full' = 'full',
  ): SectionPlan {
    if (!draft) return section;
    // Always carry debug/source trace fields regardless of type
    // substitution — the AI may legitimately replace a layout hero with a
    // search, post-list, or comments section for the given component context.
    if (draft.type !== section.type) {
      return {
        ...section,
        ...(draft.sectionKey ? { sectionKey: draft.sectionKey } : {}),
        ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
      };
    }

    const traceBase = {
      ...section,
      ...(draft.sectionKey ? { sectionKey: draft.sectionKey } : {}),
      ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
      ...(draft.customClassNames?.length
        ? {
            customClassNames: this.dedupeStringList([
              ...(section.customClassNames ?? []),
              ...draft.customClassNames,
            ]),
          }
        : {}),
      ...(draft.obligation && !section.obligation
        ? { obligation: draft.obligation }
        : {}),
    };
    const mergedBase =
      mergeMode === 'light'
        ? traceBase
        : {
            ...traceBase,
            ...(draft.background ? { background: draft.background } : {}),
            ...(draft.textColor ? { textColor: draft.textColor } : {}),
            ...(draft.paddingStyle ? { paddingStyle: draft.paddingStyle } : {}),
            ...(draft.marginStyle ? { marginStyle: draft.marginStyle } : {}),
            ...(draft.gapStyle ? { gapStyle: draft.gapStyle } : {}),
          };

    switch (section.type) {
      case 'navbar': {
        const navbarDraft = draft as typeof section;
        if (mergeMode === 'light') {
          return mergedBase as SectionPlan;
        }
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
        if (mergeMode === 'light') {
          return {
            ...mergedBase,
            menuColumns:
              (footerDraft.menuColumns?.length ?? 0) > 0
                ? footerDraft.menuColumns
                : footerSection.menuColumns,
          } as SectionPlan;
        }
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
        } as SectionPlan;
      }
      case 'hero': {
        const heroDraft = draft as typeof section;
        if (mergeMode === 'light') {
          return mergedBase as SectionPlan;
        }
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
        if (mergeMode === 'light') {
          return {
            ...mergedBase,
            minHeight: coverDraft.minHeight ?? section.minHeight,
          } as SectionPlan;
        }
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
          ...(mergeMode === 'full' && cardGridDraft.columnWidths
            ? { columnWidths: cardGridDraft.columnWidths }
            : {}),
        } as SectionPlan;
      }
      case 'media-text': {
        const mediaTextDraft = draft as typeof section;
        if (mergeMode === 'light') {
          return mergedBase as SectionPlan;
        }
        return {
          ...mergedBase,
          ...(mediaTextDraft.columnWidths
            ? { columnWidths: mediaTextDraft.columnWidths }
            : {}),
          ...(mediaTextDraft.subtitleStyle
            ? { subtitleStyle: mediaTextDraft.subtitleStyle }
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
          ...(mergeMode === 'full' &&
          typeof accordionDraft.allowMultiple === 'boolean'
            ? { allowMultiple: accordionDraft.allowMultiple }
            : {}),
        } as SectionPlan;
      }
      default:
        return mergedBase as SectionPlan;
    }
  }

  private injectMissingDraftSections(
    sections: SectionPlan[],
    draftSections: SectionPlan[] | undefined,
    contract: VisualPlanContract | undefined,
    componentName: string,
  ): SectionPlan[] {
    if (!draftSections?.length) return sections;

    const effectiveDraft = contract
      ? sanitizeSectionsForContract(draftSections, contract).sections
      : draftSections;

    if (!effectiveDraft.length) return sections;
    if (this.shouldSkipFullDraftInjection(contract)) {
      return sections;
    }

    // AI-generated sections never carry debugKey/sectionKey (those come from the
    // draft mapper). Using key-based matching would always see an empty coveredKeys
    // set and inject every draft section on top of the AI output, doubling content.
    // Type-count comparison is the correct signal: if AI produced N sections of a
    // given type and the draft has M > N, inject the remaining M-N from the draft.
    const planTypeCounts = new Map<string, number>();
    for (const s of sections) {
      planTypeCounts.set(s.type, (planTypeCounts.get(s.type) ?? 0) + 1);
    }

    const draftTypeConsumed = new Map<string, number>();
    const toInject: SectionPlan[] = [];

    for (const draft of effectiveDraft) {
      const consumed = draftTypeConsumed.get(draft.type) ?? 0;
      const planCount = planTypeCounts.get(draft.type) ?? 0;
      if (consumed >= planCount) {
        toInject.push(draft);
      }
      draftTypeConsumed.set(draft.type, consumed + 1);
    }

    if (!toInject.length) return sections;

    this.logger.warn(
      `[Visual Plan] "${componentName}": injecting ${toInject.length} missing draft section(s) not generated by AI: ${toInject.map((s) => s.debugKey ?? s.sectionKey ?? s.type).join(', ')}`,
    );
    return [...sections, ...toInject];
  }

  private shouldUseLightDraftMerge(contract?: VisualPlanContract): boolean {
    return contract?.componentType === 'page';
  }

  private shouldSkipFullDraftInjection(contract?: VisualPlanContract): boolean {
    return contract?.componentType === 'page';
  }

  private stabilizeAiVisualPlanSections(input: {
    componentPlan: PlanResult[number];
    content: DbContentResult;
    aiSections: SectionPlan[];
    draftSections: SectionPlan[] | undefined;
    visualContract: VisualPlanContract | undefined;
  }): SectionPlan[] {
    const draftSections = input.draftSections ?? [];
    if (draftSections.length < 2) return input.aiSections;
    if (
      !shouldUseAiVisualPlanningForProfolioSurface({
        componentPlan: input.componentPlan,
        content: input.content,
      })
    ) {
      return input.aiSections;
    }

    const effectiveDraft = input.visualContract
      ? sanitizeSectionsForContract(draftSections, input.visualContract).sections
      : draftSections;
    if (effectiveDraft.length < 2) return input.aiSections;
    if (!this.shouldPreferDraftSkeletonForAiPlan(input.aiSections, effectiveDraft)) {
      return input.aiSections;
    }

    this.logger.warn(
      this.formatPhaseCLog(
        `"${input.componentPlan.componentName}" AI visual plan shape diverged from source-derived draft; using stable draft section skeleton (${effectiveDraft
          .map((section) => section.debugKey ?? section.sectionKey ?? section.type)
          .join(', ')})`,
      ),
    );
    return effectiveDraft.map((section) => ({
      ...section,
      generationMode: section.generationMode ?? 'section-assembly',
    }));
  }

  private shouldPreferDraftSkeletonForAiPlan(
    aiSections: SectionPlan[],
    draftSections: SectionPlan[],
  ): boolean {
    const structuredTypes = new Set([
      'card-grid',
      'media-text',
      'testimonial',
      'accordion',
      'tabs',
      'carousel',
      'modal',
      'post-list',
    ]);
    const draftStructuredCount = draftSections.filter((section) =>
      structuredTypes.has(section.type),
    ).length;
    if (draftStructuredCount === 0) return false;

    const draftCounts = this.countSectionTypes(draftSections);
    const aiCounts = this.countSectionTypes(aiSections);
    for (const [type, draftCount] of draftCounts) {
      if (!structuredTypes.has(type)) continue;
      if ((aiCounts.get(type) ?? 0) < draftCount) return true;
    }

    const wrapperTypes = new Set(['cover', 'hero', 'prose-block']);
    const aiWrapperCount = aiSections.filter((section) =>
      wrapperTypes.has(section.type),
    ).length;
    const draftWrapperCount = draftSections.filter((section) =>
      wrapperTypes.has(section.type),
    ).length;
    if (
      aiSections.length >= draftSections.length + 3 &&
      aiWrapperCount > draftWrapperCount + 2
    ) {
      return true;
    }

    return false;
  }

  private countSectionTypes(sections: SectionPlan[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const section of sections) {
      counts.set(section.type, (counts.get(section.type) ?? 0) + 1);
    }
    return counts;
  }

  private applyRepoInteractiveDefaults(
    visualPlan: ComponentVisualPlan,
    repoManifest?: RepoThemeManifest,
  ): ComponentVisualPlan {
    const spectra = repoManifest?.interactiveContracts?.spectra;
    if (!spectra?.detected) {
      return normalizeVisualPlanArchitecture(visualPlan);
    }

    return normalizeVisualPlanArchitecture({
      ...visualPlan,
      sections: visualPlan.sections.map((section) => {
        switch (section.type) {
          case 'modal': {
            const defaults = spectra.widgets.modal?.defaults;
            if (!defaults) return section;
            return {
              ...section,
              ...(section.width
                ? {}
                : defaults.width
                  ? { width: defaults.width }
                  : {}),
              ...(section.height
                ? {}
                : defaults.height
                  ? { height: defaults.height }
                  : {}),
            } as SectionPlan;
          }
          case 'tabs': {
            const defaults = spectra.widgets.tabs?.defaults;
            if (!defaults) return section;
            return {
              ...section,
              ...(typeof section.activeTab === 'number'
                ? {}
                : typeof defaults.activeTab === 'number'
                  ? { activeTab: defaults.activeTab }
                  : {}),
              ...(section.variant
                ? {}
                : defaults.variant
                  ? { variant: defaults.variant }
                  : {}),
              ...(section.tabAlign
                ? {}
                : defaults.tabAlign === 'left' ||
                    defaults.tabAlign === 'center' ||
                    defaults.tabAlign === 'right'
                  ? { tabAlign: defaults.tabAlign }
                  : {}),
            } as SectionPlan;
          }
          case 'accordion': {
            const defaults = spectra.widgets.accordion?.defaults;
            if (!defaults) return section;
            return {
              ...section,
              ...(typeof section.allowMultiple === 'boolean'
                ? {}
                : typeof defaults.allowMultiple === 'boolean'
                  ? { allowMultiple: defaults.allowMultiple }
                  : {}),
              ...(typeof section.enableToggle === 'boolean'
                ? {}
                : typeof defaults.enableToggle === 'boolean'
                  ? { enableToggle: defaults.enableToggle }
                  : {}),
              ...(section.defaultOpenItems?.length
                ? {}
                : defaults.defaultOpenItems
                  ? { defaultOpenItems: defaults.defaultOpenItems }
                  : {}),
              ...(section.variant
                ? {}
                : defaults.layout
                  ? { variant: defaults.layout }
                  : defaults.variant
                    ? { variant: defaults.variant }
                    : {}),
            } as SectionPlan;
          }
          case 'carousel': {
            const defaults = spectra.widgets.slider?.defaults;
            if (!defaults) return section;
            const sliderEffect =
              defaults.effect === 'slide' ||
              defaults.effect === 'fade' ||
              defaults.effect === 'flip' ||
              defaults.effect === 'coverflow'
                ? defaults.effect
                : undefined;
            return {
              ...section,
              ...(section.slideHeight
                ? {}
                : defaults.slideHeight
                  ? { slideHeight: defaults.slideHeight }
                  : {}),
              ...(section.arrowBackground
                ? {}
                : defaults.arrowBackground
                  ? { arrowBackground: defaults.arrowBackground }
                  : {}),
              ...(section.arrowColor
                ? {}
                : defaults.arrowColor
                  ? { arrowColor: defaults.arrowColor }
                  : {}),
              ...(section.dotsColor
                ? {}
                : defaults.dotsColor
                  ? { dotsColor: defaults.dotsColor }
                  : {}),
              ...(typeof section.autoplay === 'boolean'
                ? {}
                : typeof defaults.autoplay === 'boolean'
                  ? { autoplay: defaults.autoplay }
                  : {}),
              ...(typeof section.autoplaySpeed === 'number'
                ? {}
                : typeof defaults.autoplaySpeed === 'number'
                  ? { autoplaySpeed: defaults.autoplaySpeed }
                  : {}),
              ...(typeof section.loop === 'boolean'
                ? {}
                : typeof defaults.loop === 'boolean'
                  ? { loop: defaults.loop }
                  : {}),
              ...(section.effect
                ? {}
                : sliderEffect
                  ? { effect: sliderEffect }
                  : {}),
              ...(typeof section.showDots === 'boolean'
                ? {}
                : typeof defaults.showDots === 'boolean'
                  ? { showDots: defaults.showDots }
                  : {}),
              ...(typeof section.showArrows === 'boolean'
                ? {}
                : typeof defaults.showArrows === 'boolean'
                  ? { showArrows: defaults.showArrows }
                  : {}),
              ...(typeof section.vertical === 'boolean'
                ? {}
                : typeof defaults.vertical === 'boolean'
                  ? { vertical: defaults.vertical }
                  : {}),
              ...(typeof section.transitionSpeed === 'number'
                ? {}
                : typeof defaults.transitionSpeed === 'number'
                  ? { transitionSpeed: defaults.transitionSpeed }
                  : {}),
              ...(section.pauseOn
                ? {}
                : defaults.pauseOn &&
                    (defaults.pauseOn === 'hover' ||
                      defaults.pauseOn === 'click')
                  ? { pauseOn: defaults.pauseOn }
                  : {}),
            } as SectionPlan;
          }
          default:
            return section;
        }
      }),
    });
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
- Custom templates without clear singular/detail evidence should stay static (\`/template-name\`), not \`/template-name/:slug\`
- Do not keep \`post-detail\` or \`page-detail\` on static custom templates
- Valid dataNeeds values: posts, products, pages, menus, site-info, footer-links, post-detail, product-detail, page-detail, comments, categoryDetail
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
    repoManifest?: RepoThemeManifest;
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
      repoManifest,
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
      repoManifest,
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
      const sources: Array<PlanningSourceSupplement & { isPrimary?: boolean }> =
        [
          {
            source: planningSource?.source ?? '',
            label: planningSource?.sourceLabel ?? componentPlan.templateName,
            templateName:
              planningSource?.sourceTemplateName ?? componentPlan.templateName,
            sourceFile:
              planningSource?.sourceFile ??
              inferFseSourceFile(
                componentPlan.templateName,
                componentPlan.type,
              ),
            canonicalSource: planningSource?.canonicalSource,
            isPrimary: true,
          },
          ...(planningSource?.supplementalSources ?? []),
        ].filter((entry) => entry.source.trim().length > 0);
      if (sources.length === 0) return undefined;

      let mergedDraft: SectionPlan[] = [];
      let expectedCoverageUnits = 0;
      for (const source of sources) {
        const nodes = source.canonicalSource?.resolvedNodes?.length
          ? source.canonicalSource.resolvedNodes
          : this.styleResolver.resolve(
              this.parsePlanningSourceNodes({
                source: source.source,
                templateName: source.templateName ?? componentPlan.templateName,
                sourceFile:
                  source.sourceFile ??
                  inferFseSourceFile(
                    componentPlan.templateName,
                    componentPlan.type,
                  ),
              }),
              tokens,
            );
        if (nodes.length === 0) continue;
        // For fixed page-detail routes, use the lossless mapper so that the
        // full block structure of the actual DB page is preserved in the draft.
        // The standard mapper is too aggressive at collapsing prose into single
        // hero sections, losing heading hierarchy and layout fidelity.
        const useLosslessDraft =
          componentPlan.isDetail === true &&
          componentPlan.fixedSlug != null &&
          source.label?.startsWith('db:bound-page:')
            ? true
            : this.shouldUseLosslessPlanningDraft(componentPlan, nodes);
        const draft = this.filterDegenerateDraftSections(
          useLosslessDraft
            ? mapWpNodesToLosslessPageSections(nodes)
            : mapWpNodesToDraftSections(nodes),
        );
        if (draft.length === 0) continue;
        expectedCoverageUnits += this.countCoverageUnits(draft);

        mergedDraft = this.mergeDraftSectionsAcrossSources(mergedDraft, draft);
      }

      // Deduplicate listing sections that appear more than once due to multiple
      // sources all containing the same query loop (e.g. archive.html + archive.php).
      const listingTypes = new Set(['post-list', 'search']);
      const seenListingTypes = new Set<string>();
      mergedDraft = mergedDraft.filter((s) => {
        if (!listingTypes.has(s.type)) return true;
        if (seenListingTypes.has(s.type)) return false;
        seenListingTypes.add(s.type);
        return true;
      });

      if (mergedDraft.length === 0) return undefined;

      const sanitizedSections = sanitizeSectionsForContract(mergedDraft, {
        componentType: componentPlan.type,
        route: componentPlan.route,
        isDetail: componentPlan.isDetail,
        dataNeeds: toVisualDataNeeds(componentPlan.dataNeeds),
        stripLayoutChrome: componentPlan.type === 'page',
        sourceBackedAuxiliaryLabels:
          planningSource?.sourceBackedAuxiliaryLabels ?? [],
      }).sections;
      const filteredSections =
        this.filterDegenerateDraftSections(sanitizedSections);
      if (filteredSections.length === 0) return undefined;

      const semanticPartialDraft = this.buildSemanticPartialDraftSections({
        componentPlan,
        source: sources.map((entry) => entry.source).join('\n\n'),
        sections: filteredSections,
      });
      if (semanticPartialDraft?.length) {
        return semanticPartialDraft;
      }

      if (
        this.shouldBypassCoverageAuditForBlockTreeListingPlan(
          componentPlan,
          filteredSections,
        )
      ) {
        return filteredSections;
      }

      const coverageAudit = this.assessPlanningSourceDraftCoverage({
        componentPlan,
        sections: filteredSections,
        expectedCoverageUnits,
        planningSource,
      });
      if (!coverageAudit.ok) {
        this.logger.warn(
          this.formatPhaseCLog(
            `"${componentPlan.componentName}": rejected low-coverage draft sections from ${planningSource?.sourceLabel ?? componentPlan.templateName} (${coverageAudit.reason})`,
          ),
        );
        return undefined;
      }

      return filteredSections;
    } catch {
      return undefined;
    }
  }

  // ── Chunk labeling + composition (PR2) ────────────────────────────────────

  private async labelAndComposeChunks(
    planningSource: PlanningSourceContext | undefined,
    componentPlan: PlanResult[number],
    tokens: ThemeTokens | undefined,
    modelName: string,
    logPath: string | undefined,
  ): Promise<ReturnType<typeof mapWpNodesToDraftSections> | undefined> {
    const rawChunks = this.buildChunkPlansForPlanningSource(
      planningSource,
      componentPlan,
      tokens,
    );
    if (rawChunks.length === 0) return undefined;

    const labeledChunks = await this.labelChunksWithAi(rawChunks, modelName);

    if (logPath) {
      void this.writeArtifact(
        logPath,
        `plan.chunks.${componentPlan.componentName}.json`,
        {
          componentName: componentPlan.componentName,
          generatedAt: new Date().toISOString(),
          chunkCount: labeledChunks.length,
          chunks: labeledChunks,
        },
      );
    }

    const composed = composeSectionsFromChunkPlans(labeledChunks);
    if (composed.length === 0) return undefined;

    // PR3: annotate sections for home-like components so generator can use
    // per-section codegen and targeted retry (PR4 reads this field).
    if (this.isHomeLikeComponentPlan(componentPlan)) {
      return composed.map((section) => ({
        ...section,
        generationMode: 'section-assembly' as const,
      }));
    }

    return composed;
  }

  private async labelChunksWithAi(
    chunks: ChunkPlan[],
    modelName: string,
  ): Promise<ChunkPlan[]> {
    try {
      const { systemPrompt, userPrompt } = buildChunkLabelingPrompt(chunks);
      const { text } = await this.requestVisualPlanCompletion({
        model: modelName,
        systemPrompt,
        userPrompt,
        maxTokens: 1024,
      });
      const results = parseChunkLabelingResponse(text, chunks);
      const resultIndex = new Map(results.map((r) => [r.chunkId, r]));
      return chunks.map((chunk) => {
        const label = resultIndex.get(chunk.chunkId);
        if (!label) return chunk;
        return {
          ...chunk,
          aiLabel: {
            semanticKind: label.semanticKind,
            suggestedSectionType: label.suggestedSectionType,
            mergeHint: label.mergeHint,
            confidence: label.confidence,
            ...(label.rationale ? { rationale: label.rationale } : {}),
          },
        };
      });
    } catch {
      return chunks;
    }
  }

  // ── Chunk plan builder (shared by PR1 artifact + PR2 labeling) ────────────

  private buildChunkPlansForPlanningSource(
    planningSource: PlanningSourceContext | undefined,
    componentPlan: PlanResult[number],
    tokens: ThemeTokens | undefined,
  ): ChunkPlan[] {
    try {
      const nodes = planningSource?.canonicalSource?.resolvedNodes?.length
        ? planningSource.canonicalSource.resolvedNodes
        : this.styleResolver.resolve(
            this.parsePlanningSourceNodes({
              source: planningSource?.source ?? '',
              templateName:
                planningSource?.sourceTemplateName ??
                componentPlan.templateName,
              sourceFile:
                planningSource?.sourceFile ??
                inferFseSourceFile(
                  componentPlan.templateName,
                  componentPlan.type,
                ),
            }),
            tokens,
          );
      if (nodes.length === 0) return [];
      return buildPlannerChunksFromNodes(nodes);
    } catch {
      return [];
    }
  }

  private augmentDraftSectionsWithSourceWidgets(input: {
    draftSections?: SectionPlan[];
    planningSource?: PlanningSourceContext;
    sourceWidgetHints?: string[];
    componentName: string;
  }): SectionPlan[] | undefined {
    const baseSections = input.draftSections ? [...input.draftSections] : [];
    const hints = new Set(input.sourceWidgetHints ?? []);
    if (hints.size === 0) {
      return input.draftSections;
    }

    const widgetSectionTypes = new Map<string, SectionPlan['type']>([
      ['accordion', 'accordion'],
      ['tabs', 'tabs'],
      ['modal', 'modal'],
      ['slider', 'carousel'],
      ['carousel', 'carousel'],
    ]);

    const missingHints = [...hints].filter((hint) => {
      const sectionType = widgetSectionTypes.get(hint);
      return (
        sectionType &&
        !baseSections.some((section) => section.type === sectionType)
      );
    });
    if (missingHints.length === 0) {
      return input.draftSections;
    }

    const resolvedNodes =
      input.planningSource?.canonicalSource?.resolvedNodes ?? [];
    if (resolvedNodes.length === 0) {
      return input.draftSections;
    }

    const injected: SectionPlan[] = [];
    const visit = (node: WpNode) => {
      for (const hint of [...missingHints]) {
        if (!this.matchesRequiredWidgetHint(node, hint)) continue;
        const expectedType = widgetSectionTypes.get(hint);
        if (!expectedType) continue;
        const mappedSections = this.filterDegenerateDraftSections(
          mapWpNodesToDraftSections([node]),
        );
        const recovered = mappedSections.find(
          (section) => section.type === expectedType,
        );
        if (!recovered) continue;
        baseSections.push(recovered);
        injected.push(recovered);
        missingHints.splice(missingHints.indexOf(hint), 1);
        break;
      }
      if (missingHints.length === 0) return;
      for (const child of node.children ?? []) {
        visit(child);
        if (missingHints.length === 0) return;
      }
    };

    for (const node of resolvedNodes) {
      visit(node);
      if (missingHints.length === 0) break;
    }

    if (injected.length > 0) {
      this.logger.warn(
        this.formatPhaseCLog(
          `"${input.componentName}": injected ${injected.length} nested source widget fallback section(s): ${injected
            .map(
              (section) =>
                section.debugKey ?? section.sectionKey ?? section.type,
            )
            .join(', ')}`,
        ),
      );
    }

    return injected.length > 0 ? baseSections : input.draftSections;
  }

  private matchesRequiredWidgetHint(node: WpNode, hint: string): boolean {
    const block = String(node.block ?? '')
      .trim()
      .toLowerCase();
    switch (hint) {
      case 'accordion':
        return /\b(accordion|faq|content-toggle|toggle|details)\b/.test(block);
      case 'tabs':
        return /\btabs\b/.test(block);
      case 'modal':
        return /\b(modal|popup|dialog)\b/.test(block);
      case 'slider':
      case 'carousel':
        return /\b(slider|carousel)\b/.test(block);
      default:
        return false;
    }
  }

  private buildDraftBlockTreeForPlanningSource(
    planningSource: PlanningSourceContext | undefined,
    componentPlan: PlanResult[number],
    tokens: ThemeTokens | undefined,
  ): BlockNode[] | undefined {
    try {
      if (planningSource?.canonicalSource?.blockTree?.length) {
        return planningSource.canonicalSource.blockTree;
      }

      const source = planningSource?.source?.trim() ?? '';
      if (!source) return undefined;

      const parsedNodes = this.parsePlanningSourceNodes({
        source,
        templateName:
          planningSource?.sourceTemplateName ?? componentPlan.templateName,
        sourceFile:
          planningSource?.sourceFile ??
          inferFseSourceFile(componentPlan.templateName, componentPlan.type),
      });
      if (parsedNodes.length === 0) return undefined;

      const nodes = this.styleResolver.resolve(parsedNodes, tokens);
      const blockTree = mapWpNodesToBlockTree(nodes);
      return blockTree.length > 0 ? blockTree : undefined;
    } catch {
      return undefined;
    }
  }

  private buildBlockTreeDrivenVisualPlanForComponent(input: {
    componentPlan: PlanResult[number];
    draftSections?: SectionPlan[];
    draftBlockTree?: BlockNode[];
    content: DbContentResult;
    tokens: ThemeTokens | undefined;
    globalPalette: ColorPalette;
    globalTypography: TypographyTokens;
  }): ComponentVisualPlan | undefined {
    return buildBlockTreeDrivenVisualPlanForComponent({
      ...input,
      deriveComponentLayout: (tokens, componentName, isDetailPage) =>
        this.deriveComponentLayout(tokens, componentName, isDetailPage),
      buildRichBoundPageDetailSections: (componentPlan, content, tokens) =>
        this.buildRichBoundPageDetailSections(
          componentPlan as ComponentPlan,
          content,
          tokens,
        ),
      buildBoundPageContentFallbackSection: (
        componentPlan,
        content,
        showTitle,
      ) =>
        this.buildBoundPageContentFallbackSection(
          componentPlan as ComponentPlan,
          content,
          showTitle,
        ),
    });
  }

  private shouldBypassCoverageAuditForBlockTreeListingPlan(
    componentPlan: PlanResult[number],
    sections: SectionPlan[],
  ): boolean {
    return shouldBypassCoverageAuditForBlockTreeListingPlan(
      componentPlan,
      sections,
    );
  }

  private shouldShortCircuitBlockTreeVisualPlan(
    componentPlan: PlanResult[number],
    draftBlockTree?: BlockNode[],
  ): boolean {
    return shouldShortCircuitBlockTreeVisualPlan(componentPlan, draftBlockTree);
  }

  private shouldUseLosslessPlanningDraft(
    componentPlan: PlanResult[number],
    _nodes: WpNode[],
  ): boolean {
    // Partials (header/footer/sidebar) use deterministic rendering — not lossless draft.
    if (componentPlan.type !== 'page') return false;
    // Detail pages (single-post, single-page) use their own section builders — not lossless draft.
    if (componentPlan.isDetail === true) return false;
    // All general pages use the lossless mapper to preserve full block-tree context
    // (group headers, labels, container text) so that every source-backed text node
    // is available to the visual planner and can satisfy the render contract.
    return true;
  }

  private containsTransactionalCommerceBlocks(nodes: WpNode[]): boolean {
    const transactionalBlockPattern =
      /^woocommerce\/(cart|checkout|my-account|order-pay|order-received)(?:$|-)/i;
    const visit = (node: WpNode): boolean => {
      if (transactionalBlockPattern.test(String(node.block ?? '').trim())) {
        return true;
      }
      return (node.children ?? []).some((child) => visit(child));
    };

    return nodes.some((node) => visit(node));
  }

  private countCoverageUnits(sections: SectionPlan[] | undefined): number {
    if (!sections?.length) return 0;
    return sections.reduce((count, section) => {
      if (section.type !== 'prose-block') return count + 1;
      return count + Math.max(1, section.sourceSegments.length);
    }, 0);
  }

  private buildSemanticPartialDraftSections(input: {
    componentPlan: PlanResult[number];
    source: string;
    sections: SectionPlan[];
  }): SectionPlan[] | undefined {
    const { componentPlan, source, sections } = input;
    if (componentPlan.type !== 'partial' || sections.length === 0) {
      return undefined;
    }

    const strategy = getComponentStrategy(componentPlan.componentName);
    switch (strategy.kind) {
      case 'post-meta':
        return this.buildCanonicalPostMetaDraftSections(source, sections);
      case 'sidebar':
        return this.buildCanonicalSidebarDraftSections(source, sections);
      default:
        return undefined;
    }
  }

  private buildCanonicalPostMetaDraftSections(
    source: string,
    sections: SectionPlan[],
  ): SectionPlan[] | undefined {
    const hasDate = sourceContainsBlock(source, 'post-date');
    const hasAuthor = sourceContainsBlock(source, 'post-author-name');
    const hasCategories = sourceContainsBlock(source, 'post-terms');
    if (!hasDate && !hasAuthor && !hasCategories) {
      return undefined;
    }

    const textColor =
      sections.find((section) => typeof section.textColor === 'string')
        ?.textColor ?? undefined;
    const sourceRef =
      sections.find((section) => section.sourceRef)?.sourceRef ?? undefined;
    const customClassNames = this.collectSectionCustomClassNames(sections);
    const sourceEvidence = this.collectSectionSourceEvidence(sections);
    const showSeparator = sections.some(
      (section) =>
        section.type === 'hero' &&
        ['—', '–', '-'].includes(section.heading.trim()),
    );

    const canonicalSection: PostMetaSection = {
      type: 'post-meta',
      layout: 'inline',
      showDate: hasDate,
      showAuthor: hasAuthor,
      showCategories: hasCategories,
      ...(showSeparator ? { showSeparator: true } : {}),
      ...(textColor ? { textColor } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(customClassNames.length > 0 ? { customClassNames } : {}),
      ...(sourceEvidence
        ? {
            obligation: {
              role: 'post-meta',
              required: [],
              sourceEvidence,
            },
          }
        : {}),
      debugKey: 'post-meta-0',
      sectionKey: 'post-meta-0',
    };

    return [canonicalSection];
  }

  private buildCanonicalSidebarDraftSections(
    source: string,
    sections: SectionPlan[],
  ): SectionPlan[] | undefined {
    const hasNavigation = sourceContainsBlock(source, 'navigation');
    const hasSearch = sourceContainsBlock(source, 'search');
    const hasAuthorBio =
      sourceContainsBlock(source, 'post-author-biography') ||
      sourceContainsBlock(source, 'avatar');
    const hasCategories = sourceContainsBlock(source, 'categories');
    const hasRecentPosts =
      sourceContainsBlock(source, 'query') ||
      sourceContainsBlock(source, 'latest-posts');

    const headingTexts = extractHeadingTextsFromSource(source);
    const paragraphTexts = extractParagraphTextsFromSource(source);
    const navigationLinks = extractNavigationLinkItemsFromSource(source);
    const existingNavbar = sections.find(
      (section) => section.type === 'navbar',
    );
    const existingSearch = sections.find(
      (section): section is SearchSection => section.type === 'search',
    );
    const sourceRef =
      sections.find((section) => section.sourceRef)?.sourceRef ?? undefined;
    const customClassNames = this.collectSectionCustomClassNames(
      sections.filter((section) => section.type !== 'search'),
    );
    const sourceEvidence = this.collectSectionSourceEvidence(sections);
    const widgets: SidebarSection['widgets'] = [];

    if (hasSearch) {
      widgets.push({
        kind: 'search',
        ...(headingTexts.find((heading) => /search/i.test(heading))
          ? {
              title: headingTexts.find((heading) => /search/i.test(heading)),
            }
          : {}),
      });
    }

    if (hasAuthorBio) {
      widgets.push({
        kind: 'author-bio',
        title:
          headingTexts.find((heading) => /author/i.test(heading)) ??
          'About the author',
        showAvatar: sourceContainsBlock(source, 'avatar'),
      });
    }

    if (hasCategories) {
      widgets.push({
        kind: 'categories',
        title:
          headingTexts.find((heading) => /categor/i.test(heading)) ??
          'Popular Categories',
        showCounts: /"showPostCounts"\s*:\s*true/i.test(source),
      });
    }

    if (hasNavigation) {
      widgets.push({
        kind: 'navigation',
        title:
          headingTexts.find((heading) =>
            /link|resource|menu|explore/i.test(heading),
          ) ?? 'Useful Links',
        ...(paragraphTexts.find((text) => !/search/i.test(text))
          ? {
              description: paragraphTexts.find((text) => !/search/i.test(text)),
            }
          : {}),
        menuSlug:
          existingNavbar?.type === 'navbar'
            ? existingNavbar.menuSlug
            : 'primary',
        ...(navigationLinks.length > 0 ? { links: navigationLinks } : {}),
      });
    }

    if (!hasNavigation && hasRecentPosts) {
      widgets.push({
        kind: 'recent-posts',
        title:
          headingTexts.find((heading) => /recent|latest/i.test(heading)) ??
          'Recent Posts',
      });
    }

    if (
      widgets.length === 0 &&
      !hasNavigation &&
      !hasRecentPosts &&
      hasCategories
    ) {
      widgets.push({
        kind: 'pages-list',
        title:
          headingTexts.find((heading) => /page|explore/i.test(heading)) ??
          'Pages',
      });
    }

    const requiredCapabilities = new Set<
      'menus' | 'pages' | 'posts' | 'site-info'
    >();
    for (const widget of widgets) {
      if (widget.kind === 'author-bio') {
        requiredCapabilities.add('posts');
        requiredCapabilities.add('site-info');
      }
      if (widget.kind === 'categories') requiredCapabilities.add('posts');
      if (widget.kind === 'tags') requiredCapabilities.add('posts');
      if (widget.kind === 'navigation') requiredCapabilities.add('menus');
      if (widget.kind === 'pages-list') requiredCapabilities.add('pages');
      if (widget.kind === 'recent-posts') requiredCapabilities.add('posts');
    }

    if (widgets.length === 0 && !hasSearch && existingSearch == null) {
      return undefined;
    }

    const sidebarSection: SidebarSection = {
      type: 'sidebar',
      widgets,
      ...(widgets.length > 0 ? { maxItems: 6 } : {}),
      ...(sourceRef ? { sourceRef } : {}),
      ...(customClassNames.length > 0 ? { customClassNames } : {}),
      ...(sourceEvidence
        ? {
            obligation: {
              role: 'sidebar',
              required: Array.from(requiredCapabilities),
              sourceEvidence,
            },
          }
        : {}),
      debugKey: 'sidebar-0',
      sectionKey: 'sidebar-0',
    };

    const canonicalSections: SectionPlan[] = [sidebarSection];

    if (hasSearch || existingSearch) {
      const searchSection: SearchSection = {
        type: 'search',
        ...(existingSearch?.title
          ? { title: existingSearch.title }
          : headingTexts.find((heading) => /search/i.test(heading))
            ? {
                title: headingTexts.find((heading) => /search/i.test(heading)),
              }
            : {}),
        ...(existingSearch?.sourceRef
          ? { sourceRef: existingSearch.sourceRef }
          : {}),
        ...(existingSearch?.customClassNames?.length
          ? { customClassNames: existingSearch.customClassNames }
          : {}),
        ...(existingSearch?.obligation
          ? { obligation: existingSearch.obligation }
          : sourceEvidence
            ? {
                obligation: {
                  role: 'search',
                  required: ['search-input'],
                  sourceEvidence,
                },
              }
            : {}),
        debugKey: 'search-0',
        sectionKey: 'search-0',
      };
      canonicalSections.push(searchSection);
    }

    return canonicalSections;
  }

  private collectSectionCustomClassNames(sections: SectionPlan[]): string[] {
    return this.uniqueStrings(
      sections.flatMap((section) => section.customClassNames ?? []),
    );
  }

  private collectSectionSourceEvidence(sections: SectionPlan[]) {
    const sourceNodeIds = this.uniqueStrings(
      sections.flatMap(
        (section) => section.obligation?.sourceEvidence?.sourceNodeIds ?? [],
      ),
    );
    const sourceFiles = this.uniqueStrings(
      sections.flatMap(
        (section) => section.obligation?.sourceEvidence?.sourceFiles ?? [],
      ),
    );
    const blockNames = this.uniqueStrings(
      sections.flatMap(
        (section) => section.obligation?.sourceEvidence?.blockNames ?? [],
      ),
    );
    const templateNames = this.uniqueStrings(
      sections.flatMap(
        (section) => section.obligation?.sourceEvidence?.templateNames ?? [],
      ),
    );

    if (
      sourceNodeIds.length === 0 &&
      sourceFiles.length === 0 &&
      blockNames.length === 0 &&
      templateNames.length === 0
    ) {
      return undefined;
    }

    return {
      ...(sourceNodeIds.length > 0 ? { sourceNodeIds } : {}),
      ...(sourceFiles.length > 0 ? { sourceFiles } : {}),
      ...(blockNames.length > 0 ? { blockNames } : {}),
      ...(templateNames.length > 0 ? { templateNames } : {}),
    };
  }

  private uniqueStrings(values: Array<string | undefined | null>): string[] {
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      if (!normalized) continue;
      seen.add(normalized);
    }
    return [...seen];
  }

  private assessPlanningSourceDraftCoverage(input: {
    componentPlan: PlanResult[number];
    sections: SectionPlan[];
    expectedCoverageUnits: number;
    planningSource?: PlanningSourceContext;
  }): { ok: boolean; reason?: string } {
    const { componentPlan, sections, expectedCoverageUnits, planningSource } =
      input;
    if (expectedCoverageUnits <= 0) return { ok: true };

    const actualCoverageUnits = this.countCoverageUnits(sections);
    const auxiliaryOnlyTypes = new Set<SectionPlan['type']>([
      'breadcrumb',
      'search',
      'card-grid',
      'hero',
      'cover',
    ]);
    const canonicalContentTypes = new Set<SectionPlan['type']>([
      'page-content',
      'post-content',
      'post-meta',
      'post-terms',
      'post-navigation',
      'prose-block',
      'comments',
      'sidebar',
    ]);
    const nonCanonical = sections.filter(
      (section) => !canonicalContentTypes.has(section.type),
    );
    const hasOnlyAuxiliarySections =
      nonCanonical.length > 0 &&
      nonCanonical.every((section) => auxiliaryOnlyTypes.has(section.type));
    const hasPageBody = sections.some(
      (section) =>
        section.type === 'page-content' || section.type === 'prose-block',
    );
    const hasPostBody = sections.some(
      (section) => section.type === 'post-content',
    );
    const expectsPageBody = componentPlan.dataNeeds.includes('page-detail');
    const expectsPostBody = componentPlan.dataNeeds.includes('post-detail');
    const isDbBackedPageSource =
      planningSource?.sourceLabel?.startsWith('db:') ||
      planningSource?.sourceFile?.startsWith('db:');

    if (expectsPageBody && !hasPageBody) {
      return {
        ok: false,
        reason: 'page-detail source draft lost canonical page body section(s)',
      };
    }
    if (expectsPostBody && !hasPostBody && hasOnlyAuxiliarySections) {
      return {
        ok: false,
        reason:
          'post-detail source draft collapsed into auxiliary sections only',
      };
    }

    if (
      expectedCoverageUnits >= 4 &&
      actualCoverageUnits <= 2 &&
      hasOnlyAuxiliarySections
    ) {
      return {
        ok: false,
        reason: `source-backed section coverage collapsed to ${actualCoverageUnits}/${expectedCoverageUnits} auxiliary units`,
      };
    }

    const minimumCoverageRatio =
      expectsPageBody || expectsPostBody || isDbBackedPageSource ? 0.55 : 0.4;
    const minimumCoverageUnits =
      expectedCoverageUnits >= 6
        ? Math.max(3, Math.ceil(expectedCoverageUnits * minimumCoverageRatio))
        : expectedCoverageUnits >= 4
          ? 3
          : 0;

    if (
      minimumCoverageUnits > 0 &&
      actualCoverageUnits < minimumCoverageUnits
    ) {
      return {
        ok: false,
        reason: `source-backed section coverage too low (${actualCoverageUnits}/${expectedCoverageUnits}; expected at least ${minimumCoverageUnits})`,
      };
    }

    return { ok: true };
  }

  /**
   * Classify a page's post_content to determine whether it is a candidate for
   * rich section mapping or should fall through directly to page-content.
   *
   * Strategy: map-first → score-second → fallback-last
   *
   * - simple_body: mostly paragraph/list/heading, no layout blocks → page-content
   * - rich_candidate: has cover, uagb interactive blocks, group+columns with
   *   image/text/buttons, team grid, stats, gallery → attempt mapping, then score
   */
  private classifyBoundPageDetailContent(
    postContent: string,
  ): 'rich_candidate' | 'simple_body' {
    // UAGB interactive blocks are strong rich signals
    if (
      /<!--\s*wp:(uagb\/tabs|uagb\/slider|uagb\/accordion|uagb\/modal)\b/i.test(
        postContent,
      )
    ) {
      return 'rich_candidate';
    }

    // Cover block = explicit rich layout section
    if (/<!--\s*wp:cover\b/i.test(postContent)) return 'rich_candidate';

    // 2+ full-width/wide group blocks containing columns = composite layout
    const groupMatches = [
      ...postContent.matchAll(/<!--\s*wp:group\b[^>]*?-->/gi),
    ];
    let compositeGroupCount = 0;
    for (const match of groupMatches) {
      const startIdx = match.index ?? 0;
      const nextClose = postContent.indexOf('<!-- /wp:group -->', startIdx);
      const slice =
        nextClose > startIdx
          ? postContent.slice(startIdx, nextClose)
          : postContent.slice(startIdx);
      const hasColumns = /<!--\s*wp:columns\b/i.test(slice);
      const hasImage = /<!--\s*wp:image\b/i.test(slice);
      const hasButtons = /<!--\s*wp:buttons?\b/i.test(slice);
      const isWideOrFull = /\"align\"\s*:\s*\"(?:full|wide)\"/i.test(match[0]);
      if (hasColumns && (hasImage || hasButtons || isWideOrFull))
        compositeGroupCount++;
    }
    if (compositeGroupCount >= 2) return 'rich_candidate';

    // Standalone columns block at top level = layout-bearing
    if (/<!--\s*wp:columns\b/i.test(postContent)) return 'rich_candidate';

    return 'simple_body';
  }

  /**
   * Score draft sections to decide whether they are high-quality enough to use
   * as rich sections, or whether page-content fallback is safer.
   *
   * Returns true (promote) when the draft has sufficient rich structure.
   * Returns false (fallback) when it collapsed into too few, too sparse, or
   * unrecognised sections.
   */
  private assessBoundPageDetailDraftQuality(
    sections: SectionPlan[] | undefined,
  ): boolean {
    if (!sections?.length) return false;

    const CHROME = new Set<SectionPlan['type']>([
      'page-content',
      'post-content',
      'sidebar',
      'navbar',
      'footer',
    ]);
    const meaningful = sections.filter((s) => !CHROME.has(s.type));
    if (!meaningful.length) return false;

    const STRONG_RICH = new Set<SectionPlan['type']>([
      'hero',
      'cover',
      'media-text',
      'card-grid',
      'cta-strip',
      'testimonial',
      'carousel',
      'tabs',
      'accordion',
      'newsletter',
    ]);
    const WEAK_RICH = new Set<SectionPlan['type']>([
      'post-list',
      'search',
      'breadcrumb',
    ]);
    const proseOnlyCount = meaningful.filter(
      (section) => section.type === 'prose-block',
    ).length;

    const strongCount = meaningful.filter((s) =>
      STRONG_RICH.has(s.type),
    ).length;
    const weakCount = meaningful.filter((s) => WEAK_RICH.has(s.type)).length;

    // A fixed DB-backed page that only decomposes into prose blocks is usually
    // safer as one canonical page-content render path. Treat prose-only drafts
    // as insufficiently rich so we fall back before validator over-enforces
    // dozens of page-backed literals section-by-section.
    if (proseOnlyCount === meaningful.length) return false;

    // Reject if everything collapsed into one weak section
    if (meaningful.length === 1 && !strongCount) return false;

    // Require at least 1 strong rich section, OR 2+ meaningful sections that
    // include at least one recognisable non-weak type
    if (strongCount >= 1) return true;
    if (meaningful.length >= 2 && weakCount < meaningful.length) return true;

    return false;
  }

  private hasSufficientBoundPageDraftCoverage(
    nodes: { block?: string }[],
    sections: SectionPlan[] | undefined,
  ): boolean {
    if (!sections?.length) return false;

    const meaningfulNodeCount = nodes.filter((node) => {
      const block = String(node.block ?? '')
        .trim()
        .toLowerCase();
      if (!block) return false;
      return ![
        'core/separator',
        'separator',
        'core/spacer',
        'spacer',
        'core/buttons',
        'buttons',
        'core/button',
        'button',
      ].includes(block);
    }).length;

    if (meaningfulNodeCount < 6) return true;

    const minimumSectionCount = Math.max(
      3,
      Math.ceil(meaningfulNodeCount * 0.45),
    );
    const coveredUnits = sections.reduce((count, section) => {
      if (section.type !== 'prose-block') return count + 1;
      return count + Math.max(1, section.sourceSegments.length);
    }, 0);
    return coveredUnits >= minimumSectionCount;
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
      if (this.classifyBoundPageDetailContent(source) !== 'rich_candidate') {
        return undefined;
      }

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
        mapWpNodesToLosslessPageSections(nodes),
        {
          componentType: componentPlan.type,
          route: componentPlan.route,
          isDetail: componentPlan.isDetail,
          dataNeeds: toVisualDataNeeds(componentPlan.dataNeeds),
          stripLayoutChrome: componentPlan.type === 'page',
          sourceBackedAuxiliaryLabels: [],
        },
      ).sections;

      // map-first → score-second → fallback-last
      if (!this.hasSufficientBoundPageDraftCoverage(nodes, draftSections)) {
        return undefined;
      }
      if (!this.assessBoundPageDetailDraftQuality(draftSections)) {
        return undefined;
      }
      return draftSections;
    } catch {
      return undefined;
    }
  }

  private buildBoundPageContentFallbackSection(
    componentPlan: PlanResult[number],
    content: DbContentResult,
    showTitle: boolean,
  ): PageContentSection {
    const boundPage = content.pages.find(
      (page) =>
        String(page.id) === String(componentPlan.fixedPageId ?? '') ||
        page.slug === componentPlan.fixedSlug,
    );
    const source = String(boundPage?.content ?? '').trim();
    const classification = source
      ? this.classifyBoundPageDetailContent(source)
      : 'simple_body';
    const hasColumns = /<!--\s*wp:columns\b/i.test(source);
    const hasWideBlocks =
      /\balignwide\b|"align"\s*:\s*"wide"|align="wide"/i.test(source);
    const hasFullWidthBlocks =
      /\balignfull\b|"align"\s*:\s*"full"|align="full"/i.test(source);
    const hasInteractiveBlocks =
      /<!--\s*wp:(uagb\/tabs|uagb\/slider|uagb\/accordion|uagb\/modal)\b/i.test(
        source,
      );
    const shellVariant =
      classification === 'simple_body' &&
      !hasColumns &&
      !hasWideBlocks &&
      !hasFullWidthBlocks
        ? 'article'
        : 'wide';

    return {
      type: 'page-content',
      showTitle,
      shellVariant,
      bodyPresentation:
        shellVariant === 'article' ? 'prose' : 'wordpress-blocks',
      hasColumns,
      hasWideBlocks,
      hasFullWidthBlocks,
      hasInteractiveBlocks,
    };
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

  private buildCanonicalPlanningSource(input: {
    source: string;
    templateName: string;
    sourceFile: string;
    tokens: ThemeTokens | undefined;
  }): CanonicalPlanningSource | undefined {
    try {
      const rawSource = input.source.trim();
      if (!rawSource) return undefined;

      const wpNodes = this.parsePlanningSourceNodes({
        source: rawSource,
        templateName: input.templateName,
        sourceFile: input.sourceFile,
      });
      if (wpNodes.length === 0) return undefined;

      const resolvedNodes = this.styleResolver.resolve(wpNodes, input.tokens);
      const normalizedSource = wpJsonToString(resolvedNodes);
      const blockTree = mapWpNodesToBlockTree(resolvedNodes);

      return {
        rawSource,
        normalizedSource,
        sourceTemplateName: input.templateName,
        sourceFile: input.sourceFile,
        wpNodes,
        resolvedNodes,
        blockTree,
        customClassNames: extractCustomClassNamesFromSource(normalizedSource),
        headingTexts: extractHeadingTextsFromSource(normalizedSource),
        interactiveWidgets:
          detectInteractiveWidgetsFromSource(normalizedSource),
        assetRefs: extractStaticImageSources(normalizedSource),
        sourceFacts: this.collectCanonicalPlanningSourceFacts(resolvedNodes),
      };
    } catch {
      return undefined;
    }
  }

  private collectCanonicalPlanningSourceFacts(
    resolvedNodes: WpNode[],
  ): CanonicalPlanningSource['sourceFacts'] {
    const blockNames = new Set<string>();
    const templatePartHints: string[] = [];

    const visitWpNode = (node: WpNode) => {
      const normalizedBlock = String(node.block ?? '')
        .trim()
        .toLowerCase();
      if (normalizedBlock) {
        blockNames.add(normalizedBlock);
        const shortName = normalizedBlock.includes('/')
          ? normalizedBlock.slice(normalizedBlock.lastIndexOf('/') + 1)
          : normalizedBlock;
        blockNames.add(shortName);
      }
      if (normalizedBlock === 'core/template-part') {
        const slug =
          typeof node.params?.slug === 'string' ? node.params.slug : '';
        const area =
          typeof node.params?.area === 'string' ? node.params.area : '';
        const classNames = Array.isArray(node.customClassNames)
          ? node.customClassNames.join(' ')
          : '';
        templatePartHints.push(`${slug} ${area} ${classNames}`.trim());
      }
      for (const child of node.children ?? []) visitWpNode(child);
    };

    for (const node of resolvedNodes) visitWpNode(node);

    const hasBlock = (...candidates: string[]) =>
      candidates.some((candidate) => blockNames.has(candidate.toLowerCase()));
    const hasSidebarTemplatePart = templatePartHints.some((hint) =>
      /sidebar|widget/i.test(hint),
    );

    return {
      hasQuery: hasBlock(
        'core/query',
        'query',
        'core/latest-posts',
        'latest-posts',
      ),
      hasSidebarTemplatePart,
      hasSearch: hasBlock('core/search', 'search'),
      hasPostContent: hasBlock('core/post-content', 'post-content'),
      hasPageList: hasBlock('core/page-list', 'page-list'),
      hasComments: hasBlock(
        'core/comments',
        'comments',
        'core/post-comments-form',
        'post-comments-form',
      ),
      hasNavigation: hasBlock('core/navigation', 'navigation'),
      hasWooCart: hasBlock('woocommerce/cart', 'cart'),
      hasWooCheckout: hasBlock('woocommerce/checkout', 'checkout'),
    };
  }

  private countBlockTreeNodes(nodes: BlockNode[] | undefined): number {
    if (!nodes?.length) return 0;
    let count = 0;
    const visit = (node: BlockNode) => {
      count += 1;
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    return count;
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
      const filteredNodes = this.filterOutSharedLayoutBlockNodes(
        bodyNodes,
        hints,
      );
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

  private filterDegenerateDraftSections(
    sections: SectionPlan[],
  ): SectionPlan[] {
    return sections.filter(
      (section) => !this.isDegenerateDraftSection(section),
    );
  }

  private describeDegenerateSections(sections: SectionPlan[]): string[] {
    return sections
      .filter((section) => this.isDegenerateDraftSection(section))
      .map((section) => {
        const sectionId =
          section.debugKey ||
          section.sectionKey ||
          section.sourceRef?.sourceNodeId ||
          `${section.type}-${section.sourceRef?.topLevelIndex ?? 'unknown'}`;
        return `${section.type}:${sectionId}`;
      });
  }

  private isDegenerateDraftSection(section: SectionPlan): boolean {
    const hasText = (value: unknown): boolean =>
      String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length > 0;
    const hasCta = (
      cta: { text?: string; link?: string } | undefined,
    ): boolean => !!cta && (hasText(cta.text) || hasText(cta.link));

    // WP dynamic-title blocks that survive into draft sections carry a
    // generic placeholder like "WordPress" that never reflects real content.
    const WP_GENERIC_PLACEHOLDERS = new Set(['WordPress', 'wordpress', 'by']);
    const isPlaceholderOnly = (value: unknown): boolean => {
      const cleaned = String(value ?? '')
        .replace(/<[^>]+>/g, '')
        .trim();
      return WP_GENERIC_PLACEHOLDERS.has(cleaned);
    };

    switch (section.type) {
      case 'prose-block':
        return section.sourceSegments.length === 0;
      case 'hero':
        // Empty hero
        if (
          !hasText(section.heading) &&
          !hasText(section.subheading) &&
          !section.image?.src &&
          !hasCta(section.cta) &&
          !(section.ctas ?? []).some(hasCta)
        ) {
          return true;
        }
        // Heading-only hero whose heading is a generic WP placeholder
        return (
          isPlaceholderOnly(section.heading) &&
          !hasText(section.subheading) &&
          !section.image?.src &&
          !hasCta(section.cta) &&
          !(section.ctas ?? []).some(hasCta)
        );
      case 'card-grid':
        return (
          !hasText(section.title) &&
          !hasText(section.subtitle) &&
          !(section.cards ?? []).some(
            (card) =>
              hasText(card.heading) ||
              hasText(card.body) ||
              hasText(card.imageSrc) ||
              hasText(card.imageAlt),
          )
        );
      case 'media-text':
        return (
          !hasText(section.subtitle) &&
          !hasText(section.heading) &&
          !hasText(section.body) &&
          !hasText(section.imageSrc) &&
          !(section.listItems ?? []).some(hasText) &&
          !hasCta(section.cta) &&
          !(section.ctas ?? []).some(hasCta)
        );
      case 'cover':
        return (
          !hasText(section.heading) &&
          !hasText(section.subheading) &&
          !hasText(section.imageSrc)
        );
      case 'testimonial':
        return (
          !hasText(section.quote) &&
          !hasText(section.authorName) &&
          !hasText(section.authorTitle) &&
          !hasText(section.authorAvatar)
        );
      default:
        return false;
    }
  }

  private buildDraftSectionKey(section: SectionPlan): string {
    const normalize = (value: unknown): string =>
      String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    switch (section.type) {
      case 'prose-block':
        return [
          section.type,
          section.sourceSegments
            .slice(0, 10)
            .map((segment) => {
              switch (segment.type) {
                case 'heading':
                  return normalize(segment.text);
                case 'paragraph':
                  return normalize(segment.text ?? segment.html);
                case 'list':
                  return segment.items.map((item) => normalize(item)).join('|');
                case 'image':
                  return normalize(segment.src);
                case 'html':
                  return normalize(segment.html);
              }
            })
            .join('|'),
        ].join('|');
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
          normalize(section.subtitle),
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
        if (section.sourceRef?.sourceNodeId) {
          return [section.type, normalize(section.sourceRef.sourceNodeId)].join(
            '|',
          );
        }
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
        return [
          section.type,
          normalize(section.debugKey ?? section.sectionKey),
        ].join('|');
    }
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
    repoManifest?: RepoThemeManifest;
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
      input.repoManifest,
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
      this.getPlanningSourcePromptSource(planningSource),
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
    repoManifest?: RepoThemeManifest,
  ): string[] {
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    const templateNames = this.ensureStandardTemplates(
      allTemplates,
      theme.type,
      content,
    ).map((template) => template.name);
    return resolveHomeHierarchy({
      templateNames,
      repoManifest,
      explicitTemplateNames: content
        ? getTrustedPlanningDbTemplateSlugs(content)
        : [],
      readingSettings: content?.readingSettings,
    }).orderedTemplateNames;
  }

  private formatPhaseAComponentTargets(templateNames: string[]): string {
    if (templateNames.length === 0) return '(none)';

    return templateNames
      .map(
        (templateName) =>
          `${templateName} -> ${this.toComponentName(templateName)}`,
      )
      .join(', ');
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
      const routeContract = inferDeterministicRouteContract({
        templateName: name,
        componentName,
        type: isPartialComponentName(componentName) ? 'partial' : 'page',
      });

      return {
        templateName: name,
        componentName,
        type: routeContract.type,
        route: routeContract.route,
        dataNeeds: [...routeContract.requiredDataNeeds],
        isDetail: routeContract.isDetail,
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
    tokens: ThemeTokens | undefined,
    repoManifest?: RepoThemeManifest,
  ): PlanningSourceContext {
    const candidates = this.buildPlanningSourceCandidates(
      componentPlan,
      templateSource,
      sourceMap,
      content,
      repoManifest,
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
      richness: scorePlanningSourceRichness(templateSource),
    };
    return this.buildPlanningSourceContextFromResolvedSource(
      componentPlan,
      preferredSource,
      hasSharedLayoutPartials,
      tokens,
      candidates,
      content,
    );
  }

  private buildPlanningSourceContextFromResolvedSource(
    componentPlan: PlanResult[number],
    preferredSource: PlanningSourceCandidate,
    hasSharedLayoutPartials: boolean,
    tokens: ThemeTokens | undefined,
    candidates: PlanningSourceCandidate[] = [],
    content?: DbContentResult,
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
    const canonicalSource = this.buildCanonicalPlanningSource({
      source: fallbackSource,
      templateName: sourceTemplateName,
      sourceFile,
      tokens,
    });
    const supplementalSources = this.buildSupplementalPlanningSources({
      componentPlan,
      preferredSource,
      candidates,
      tokens,
      content,
    });
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
    summaryLines.push(
      supplementalSources.length > 0
        ? 'Source of truth policy: primary planning source is preserved, and compatible supplemental sources are merged to combine repo archetypes with DB-backed content evidence.'
        : 'Source of truth policy: only the selected primary planning source is used; supplemental planning sources are disabled.',
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
    const canonicalAnalysisSource =
      canonicalSource?.normalizedSource ?? fallbackSource;
    const customClassNames = canonicalSource?.customClassNames.length
      ? canonicalSource.customClassNames
      : extractCustomClassNamesFromSource(canonicalAnalysisSource);
    const sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
      extractSourceBackedAuxiliaryLabels({
        source: canonicalAnalysisSource,
      }),
      ...supplementalSources.map((source) =>
        extractSourceBackedAuxiliaryLabels({
          source: source.source,
        }),
      ),
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
    const interactiveWidgets = canonicalSource?.interactiveWidgets.length
      ? canonicalSource.interactiveWidgets
      : detectInteractiveWidgetsFromSource(canonicalAnalysisSource);
    const sampledHeadings = canonicalSource?.headingTexts.length
      ? canonicalSource.headingTexts
      : extractHeadingTextsFromSource(canonicalAnalysisSource);
    const sourceImageCount =
      canonicalSource?.assetRefs.length ??
      extractStaticImageSources(canonicalAnalysisSource).length;
    const sourceSectionCount = countDraftSectionsInSource(
      canonicalAnalysisSource,
    );
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
    if (canonicalSource) {
      summaryLines.push(
        `Canonical planner source prepared: ${canonicalSource.resolvedNodes.length} root node(s), ${this.countBlockTreeNodes(canonicalSource.blockTree)} block-tree node(s)`,
      );
      summaryLines.push(
        `Canonical source facts: query=${canonicalSource.sourceFacts.hasQuery ? 'yes' : 'no'}, search=${canonicalSource.sourceFacts.hasSearch ? 'yes' : 'no'}, navigation=${canonicalSource.sourceFacts.hasNavigation ? 'yes' : 'no'}, sidebarPart=${canonicalSource.sourceFacts.hasSidebarTemplatePart ? 'yes' : 'no'}, comments=${canonicalSource.sourceFacts.hasComments ? 'yes' : 'no'}`,
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
    const widgetSnippets = this.buildRetryWidgetSnippetEvidence(
      fallbackSource,
      interactiveWidgets,
    );
    if (widgetSnippets.length > 0) {
      summaryLines.push('Source widget snippets (exact source evidence):');
      for (const snippet of widgetSnippets) {
        summaryLines.push(`- ${snippet}`);
      }
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
      canonicalSource,
    };
  }

  private buildSupplementalPlanningSources(input: {
    componentPlan: PlanResult[number];
    preferredSource: PlanningSourceCandidate;
    candidates: PlanningSourceCandidate[];
    tokens: ThemeTokens | undefined;
    content?: DbContentResult;
  }): PlanningSourceSupplement[] {
    if (input.content?.themeResolvedContent?.themeSlug !== 'profolio-fse') {
      return [];
    }

    const preferredOrigin = extractPlanningSourceOrigin(
      input.preferredSource.label,
    );
    const isRepoLikeOrigin = (origin: string): boolean =>
      origin === 'repo' ||
      origin === 'repo-chain' ||
      origin === 'repo-archetype';
    const pageArchetypeTemplates = new Set([
      'page',
      'template-about',
      'template-contact',
      'template-services',
      'blank',
      'full-width',
    ]);

    const selected = input.candidates
      .filter((candidate) => {
        if (candidate.label === input.preferredSource.label) return false;
        if (!candidate.source.trim()) return false;

        const candidateOrigin = extractPlanningSourceOrigin(candidate.label);
        const normalizedTemplate = normalizePlanningTemplateIdentifier(
          candidate.templateName,
        );

        if (input.componentPlan.fixedSlug) {
          if (
            preferredOrigin === 'db' &&
            isRepoLikeOrigin(candidateOrigin) &&
            pageArchetypeTemplates.has(normalizedTemplate)
          ) {
            return true;
          }
          if (
            preferredOrigin === 'repo' &&
            candidateOrigin === 'db' &&
            /^db:(bound-page|page):/i.test(candidate.label)
          ) {
            return true;
          }
        }

        if (input.componentPlan.route === '/') {
          if (
            isRepoLikeOrigin(preferredOrigin) &&
            candidateOrigin === 'db' &&
            (/^db:page-on-front(?::|$)/i.test(candidate.label) ||
              /^db:page-for-posts(?::|$)/i.test(candidate.label) ||
              /^db:[^:]+:(front-page|home)$/i.test(candidate.label))
          ) {
            return true;
          }
          if (
            preferredOrigin === 'db' &&
            isRepoLikeOrigin(candidateOrigin) &&
            ['front-page', 'home', 'index'].includes(normalizedTemplate)
          ) {
            return true;
          }
        }

        return isCompatibleSupplementalPlanningSource(
          input.componentPlan,
          input.preferredSource,
          candidate,
        );
      })
      .sort((a, b) => {
        const aOrigin = extractPlanningSourceOrigin(a.label);
        const bOrigin = extractPlanningSourceOrigin(b.label);
        const aOpposite = aOrigin !== preferredOrigin ? 1 : 0;
        const bOpposite = bOrigin !== preferredOrigin ? 1 : 0;
        if (bOpposite !== aOpposite) return bOpposite - aOpposite;

        const aArchetype = /^repo-archetype:/i.test(a.label) ? 1 : 0;
        const bArchetype = /^repo-archetype:/i.test(b.label) ? 1 : 0;
        if (bArchetype !== aArchetype) return bArchetype - aArchetype;

        const aRepoChain = /^repo-chain:/i.test(a.label) ? 1 : 0;
        const bRepoChain = /^repo-chain:/i.test(b.label) ? 1 : 0;
        if (bRepoChain !== aRepoChain) return bRepoChain - aRepoChain;

        return (
          (b.selectionScore ?? b.richness) - (a.selectionScore ?? a.richness)
        );
      })
      .slice(0, input.componentPlan.fixedSlug ? 2 : 1);

    return selected.map((candidate) => {
      const sourceTemplateName =
        candidate.templateName ?? input.componentPlan.templateName;
      const sourceFile =
        candidate.sourceFile ??
        inferFseSourceFile(
          input.componentPlan.templateName,
          input.componentPlan.type,
        );
      const hints: string[] = [];
      const scopedSource = this.scopePlanningSourceMarkup(
        input.componentPlan,
        candidate.source,
        sourceTemplateName,
        sourceFile,
        hints,
      );
      const fallbackSource = scopedSource.trim().length
        ? scopedSource
        : candidate.source;
      const canonicalSource = this.buildCanonicalPlanningSource({
        source: fallbackSource,
        templateName: sourceTemplateName,
        sourceFile,
        tokens: input.tokens,
      });

      return {
        source: fallbackSource,
        label: candidate.label,
        reason:
          hints.length > 0
            ? `${candidate.reason}; ${hints.join('; ')}`
            : candidate.reason,
        templateName: sourceTemplateName,
        sourceFile,
        canonicalSource,
      };
    });
  }

  private buildRetrySourceCandidateEvidence(
    componentPlan: PlanResult[number],
    sourceMap: Map<string, string>,
    content: DbContentResult,
    planningSource?: PlanningSourceContext,
    repoManifest?: RepoThemeManifest,
  ): string[] {
    const candidates = this.buildPlanningSourceCandidates(
      componentPlan,
      planningSource?.source ?? '',
      sourceMap,
      content,
      repoManifest,
    )
      .filter((candidate) => candidate.label !== planningSource?.sourceLabel)
      .slice(0, 3);

    return candidates.map((candidate) => {
      const widgets = detectInteractiveWidgetsFromSource(candidate.source);
      const headings = extractHeadingTextsFromSource(candidate.source);
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
      const identity = `${section.type}${(section.debugKey ?? section.sectionKey) ? `:${section.debugKey ?? section.sectionKey}` : ''}`;
      switch (section.type) {
        case 'prose-block':
          return `${identity} | segments=${section.sourceSegments.length}`;
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
      const widgets = detectInteractiveWidgetsFromSource(page.content);
      const headings = extractHeadingTextsFromSource(page.content);
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
          `front-page-db:${frontPage.slug || frontPage.id} | title=${JSON.stringify(frontPage.title)} | widgets=${detectInteractiveWidgetsFromSource(frontPage.content).join(', ') || 'none'}`,
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
    repoManifest?: RepoThemeManifest,
  ): PlanningSourceCandidate[] {
    return buildPlanningSourceCandidates({
      componentPlan,
      templateSource,
      sourceMap,
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, repoManifest) =>
        this.findRepoEntrySourceChain(templateName, repoManifest),
      inferSourceFile: (templateName, componentType) =>
        inferFseSourceFile(templateName, componentType),
      findRepresentativePagesForTemplate: (componentPlan, content) =>
        this.findRepresentativePagesForTemplate(
          componentPlan as ComponentPlan,
          content,
        ),
      findRepresentativePostsForTemplate: (componentPlan, content) =>
        this.findRepresentativePostsForTemplate(
          componentPlan as ComponentPlan,
          content,
        ),
    });
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
      return this.pageMatchesPlanningTemplate(page, templateName, content);
    });

    return matches
      .sort((a, b) => {
        const byRichness =
          scorePlanningSourceRichness(b.content) -
          scorePlanningSourceRichness(a.content);
        if (byRichness !== 0) return byRichness;
        return b.content.length - a.content.length;
      })
      .slice(0, 2);
  }

  private findRepresentativePostsForTemplate(
    componentPlan: PlanResult[number],
    content: DbContentResult,
  ) {
    if (componentPlan.type !== 'page') return [];
    if (!componentPlan.dataNeeds.includes('post-detail')) return [];
    if (componentPlan.fixedSlug) return [];

    const templateName = this.normalizeTemplateIdentifier(
      componentPlan.templateName,
    );
    if (!/^(single|single-with-sidebar)$/.test(templateName)) {
      return [];
    }

    return content.posts
      .filter((post) => String(post.content ?? '').trim().length > 0)
      .sort((a, b) => {
        const byRichness =
          scorePlanningSourceRichness(b.content) -
          scorePlanningSourceRichness(a.content);
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

  private filterOutSharedLayoutBlockNodes(
    nodes: WpNode[],
    hints?: string[],
  ): WpNode[] {
    let removedCount = 0;
    const visit = (node: WpNode): WpNode | null => {
      if (this.isSharedLayoutSubtree(node)) {
        removedCount += 1;
        return null;
      }

      const nextChildren = (node.children ?? [])
        .map((child) => visit(child))
        .filter((child): child is WpNode => child !== null);
      if (nextChildren.length === (node.children?.length ?? 0)) {
        return node;
      }
      const { children: _children, ...rest } = node;
      return nextChildren.length > 0
        ? { ...rest, children: nextChildren }
        : rest;
    };

    const filtered = nodes
      .map((node) => visit(node))
      .filter((node): node is WpNode => node !== null);
    if (removedCount > 0) {
      hints?.push(
        removedCount === 1
          ? 'removed shared layout subtree from block tree'
          : `removed ${removedCount} shared layout subtrees from block tree`,
      );
    }
    return filtered;
  }

  private isSharedLayoutSubtree(node: WpNode): boolean {
    if (this.isSharedLayoutBlockNode(node)) {
      return true;
    }

    const summary = summarizeSharedLayoutSubtree(node);
    if (summary.hasRouteOwnedContent) {
      return false;
    }

    if (
      summary.hasFooterClass &&
      (summary.hasCopyrightCopy ||
        summary.socialLinkCount > 0 ||
        summary.linkLikeCount > 0 ||
        summary.headingCount > 0)
    ) {
      return true;
    }

    if (
      summary.hasCopyrightCopy &&
      (summary.socialLinkCount > 0 ||
        summary.linkLikeCount > 0 ||
        summary.headingCount > 0)
    ) {
      return true;
    }

    const hasIdentity =
      summary.kinds.has('site-logo') ||
      summary.kinds.has('site-title') ||
      summary.kinds.has('site-tagline');
    const hasNavigation =
      summary.kinds.has('navigation') || summary.kinds.has('navigation-link');

    if (hasIdentity && (hasNavigation || summary.headingCount > 0)) {
      return true;
    }

    return false;
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
    repoManifest?: RepoThemeManifest,
  ): string[] {
    const lines: string[] = [];
    const templateHints = this.extractTemplateHints(source);
    const widgets = detectInteractiveWidgetsFromSource(source);
    const headings = extractHeadingTextsFromSource(source);
    const imageCount = extractStaticImageSources(source).length;
    const sectionCount = countDraftSectionsInSource(source);
    const customClasses = extractCustomClassNamesFromSource(source);
    const richness = scorePlanningSourceRichness(source);

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

    const repoEntryChain = this.findRepoEntrySourceChain(
      templateName,
      repoManifest,
    );
    if (repoEntryChain) {
      lines.push(
        `- Repo source chain: ${repoEntryChain.chainFiles.slice(0, 8).join(' -> ')}${repoEntryChain.chainFiles.length > 8 ? ' ...' : ''}`,
      );
      if (repoEntryChain.assetFiles.length > 0) {
        lines.push(
          `- Repo asset files: ${repoEntryChain.assetFiles.slice(0, 6).join(', ')}${repoEntryChain.assetFiles.length > 6 ? ' ...' : ''}`,
        );
      }
      if (repoEntryChain.headingTexts.length > 0) {
        lines.push(
          `- Repo headings: ${repoEntryChain.headingTexts
            .slice(0, 4)
            .map((heading) => `"${heading}"`)
            .join(', ')}`,
        );
      }
      if (repoEntryChain.notes.length > 0) {
        lines.push(`- Repo chain notes: ${repoEntryChain.notes.join(', ')}`);
      }
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
        repoManifest,
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
              `"${page.title}" (slug=${page.slug || page.id}, score=${scorePlanningSourceRichness(page.content)})`,
          )
          .join(' | ')}`,
      );
    }

    return lines;
  }

  private findRepoEntrySourceChain(
    templateName: string,
    repoManifest?: RepoThemeManifest,
  ) {
    if (!repoManifest) return undefined;

    return repoManifest.structureHints.entrySourceChains.find((chain) =>
      matchesRepoEntrySourceTemplate(templateName, chain.entryFile),
    );
  }

  private collectAllowedImageSrcs(
    planningSource: PlanningSourceContext | string,
    content: DbContentResult,
  ): string[] {
    const promptSource =
      typeof planningSource === 'string'
        ? planningSource
        : this.getPlanningSourcePromptSource(planningSource);
    const result = new Set<string>(extractStaticImageSources(promptSource));

    const collectFromMarkup = (value?: string | null) => {
      if (!value?.trim()) return;
      for (const src of extractStaticImageSources(value)) {
        result.add(src);
      }
    };

    const collectDirectUrl = (value?: string | null) => {
      const canonical = canonicalizeThemeAssetReference(value);
      if (canonical) result.add(canonical);
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

  private getPlanningSourcePromptSource(
    planningSource?: PlanningSourceContext,
  ): string {
    return (
      planningSource?.canonicalSource?.normalizedSource ??
      planningSource?.source ??
      ''
    );
  }

  private toComponentName(templateName: string): string {
    const name = templateName
      .replace(/\.(php|html)$/, '')
      .split(/[\\/_-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    return /^\d/.test(name) ? `Page${name}` : name;
  }

  private formatSectionList(
    sections: Array<Pick<SectionPlan, 'type' | 'sectionKey' | 'debugKey'>>,
  ): string {
    if (!Array.isArray(sections) || sections.length === 0) return '[]';

    const seen = new Map<string, number>();
    const labels = sections.map((section, index) => {
      const base =
        section.debugKey?.trim() ||
        section.sectionKey?.trim() ||
        section.type?.trim() ||
        `section-${index + 1}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count > 1 ? `${base}#${count}` : base;
    });

    return `[${labels.join(', ')}]`;
  }

  private formatPhaseCLog(message: string): string {
    return `[${this.phaseCLogLabel}] ${message}`;
  }

  private formatPhaseCPlanSnapshot(input: {
    componentPlan: PlanResult[number];
    planningSourceLabel?: string;
    surfacePlan?: PlannerSurfacePlan;
    visualPlan?: Pick<
      ComponentVisualPlan,
      'sections' | 'renderMode' | 'deterministicAuthority'
    >;
  }): string {
    const sectionList = this.formatSectionList(
      input.visualPlan?.sections ?? [],
    );
    const visualMode = input.visualPlan?.renderMode ?? 'ai';
    const deterministicAuthority =
      input.visualPlan?.deterministicAuthority === true ? 'yes' : 'no';
    const parts = [
      `kind=${input.surfacePlan?.kind ?? 'unknown'}`,
      `authority=${input.surfacePlan?.authority.level ?? 'unknown'}`,
      `pageIntent=${input.surfacePlan?.pageIntent.kind ?? 'unknown'}`,
      `source=${input.planningSourceLabel ?? input.componentPlan.planningSourceLabel ?? input.componentPlan.templateName}`,
      `visualMode=${visualMode}`,
      `deterministicAuthority=${deterministicAuthority}`,
      `sections=${sectionList}`,
    ];
    if (input.componentPlan.fixedSlug) {
      parts.push(`fixedSlug=${input.componentPlan.fixedSlug}`);
    }
    if (input.componentPlan.dataNeeds?.length) {
      parts.push(`dataNeeds=${input.componentPlan.dataNeeds.join(',')}`);
    }
    return `"${input.componentPlan.componentName}": ${parts.join(' | ')}`;
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
