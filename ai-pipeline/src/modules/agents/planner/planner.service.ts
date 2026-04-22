import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { basename } from 'path';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import {
  wpBlocksToJson,
  wpBlocksToJsonWithSourceRefs,
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
  /** Pre-computed visual plan from Phase B — generator skips Stage 1 if present */
  visualPlan?: ComponentVisualPlan;
}

export type PlanResult = ComponentPlan[];

interface PlanningSourceContext {
  source: string;
  sourceAnalysis: string;
  sourceBackedAuxiliaryLabels: string[];
}

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
    const enriched = this.enrichPlan(plan, sourceMap);
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

    this.logger.log(
      `[Phase C: AI Visual Sections] Generating visual plans for ${plan.length} reviewed components (palette + typography from theme tokens)`,
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
        `[Phase C: AI Visual Sections] "${componentPlan.componentName}": deterministic visual plan ✓`,
      );
      return { ...componentPlan, visualPlan: deterministicPlan };
    }
    if (this.shouldSkipAiVisualPlan(componentPlan)) {
      this.logger.log(
        `[Phase C: AI Visual Sections] "${componentPlan.componentName}": skipped AI visual plan (standard partial without matching section schema)`,
      );
      return { ...componentPlan, visualPlan: undefined };
    }
    try {
      const visualDataNeeds = this.toVisualDataNeeds(componentPlan.dataNeeds);
      const scopedEditRequest = this.capturePlanning.scopeRequestToComponent({
        request: editRequest,
        componentName: componentPlan.componentName,
        route: componentPlan.route,
        maxAttachments: 3,
      });
      const planningSource = this.buildPlanningSourceContext(
        componentPlan,
        templateSource,
        fullPlan.some(
          (item) =>
            item.type === 'partial' &&
            isSharedChromePartialComponent(item.componentName),
        ),
      );
      // Deterministically parse the WordPress block tree to get an ordered
      // draft of sections. This is injected into the prompt as a hard-ordered
      // skeleton so AI only needs to fill in content, not infer layout order.
      const draftSections = (() => {
        try {
          const rawMarkup = templateSource;
          if (!rawMarkup) return undefined;
          const nodes = this.styleResolver.resolve(
            wpBlocksToJsonWithSourceRefs({
              markup: rawMarkup,
              templateName: componentPlan.templateName,
              sourceFile: inferFseSourceFile(
                componentPlan.templateName,
                componentPlan.type,
              ),
            }),
            tokens,
          );
          const draft = mapWpNodesToDraftSections(nodes);
          return draft.length > 0 ? draft : undefined;
        } catch {
          return undefined;
        }
      })();
      detectedCustomClassNames =
        this.collectDraftCustomClassNames(draftSections);
      sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
        planningSource.sourceBackedAuxiliaryLabels,
        extractAuxiliaryLabelsFromSections(draftSections),
      );
      const visualContract = {
        componentType: componentPlan.type,
        route: componentPlan.route,
        isDetail: componentPlan.isDetail,
        dataNeeds: visualDataNeeds,
        stripLayoutChrome: componentPlan.type === 'page',
        sourceBackedAuxiliaryLabels,
      } as const;

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
        draftSections,
        editRequestContextNote: buildEditRequestContextNote(scopedEditRequest, {
          audience: 'visual-plan',
          componentName: componentPlan.componentName,
          route: componentPlan.route,
        }),
      });
      const allowedImageSrcs = extractStaticImageSources(planningSource.source);
      let lastRaw = '';
      let lastReason = 'unknown visual plan parse failure';
      let lastDropped = '';
      const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
      if (tokenLogPath) {
        await this.tokenTracker.init(tokenLogPath);
      }

      for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt =
          attempt === 1
            ? userPrompt
            : this.buildVisualPlanRetryPrompt(
                componentPlan.componentName,
                lastReason,
                lastRaw,
              );

        const {
          text: raw,
          inputTokens: inTok,
          outputTokens: outTok,
        } = await this.requestVisualPlanCompletion({
          model: modelName,
          systemPrompt,
          userPrompt: prompt,
          maxTokens: 4096,
        });
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
          { allowedImageSrcs, contract: visualContract },
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
            palette: globalPalette,
            typography: globalTypography,
            layout,
            blockStyles: tokens?.blockStyles,
            sections: this.mergeDraftSectionPresentation(
              parsed.sections,
              draftSections,
            ),
          };
          this.logger.log(
            `[Phase C: AI Visual Sections] "${componentPlan.componentName}": ${parsed.sections.length} sections ✓ (attempt ${attempt})`,
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
      ...(detectedCustomClassNames.length > 0
        ? { customClassNames: detectedCustomClassNames }
        : {}),
      ...(sourceBackedAuxiliaryLabels.length > 0
        ? { sourceBackedAuxiliaryLabels }
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
      tokens?.blockStyles?.cover?.border?.radius;
    const cardPadding =
      tokens?.blockStyles?.group?.spacing?.padding ??
      tokens?.blockStyles?.column?.spacing?.padding;
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
        if (ownsSharedChromeData) needs.add('menus');
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
        if (ownsSharedChromeData) needs.add('menus');
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

      // When the plan already has dedicated Header/Footer/Nav partials, page
      // components must not keep site chrome data needs for duplicated layout.
      if (item.type === 'page' && hasSharedChromePartials) {
        needs.delete('menus');
        needs.delete('site-info');
      }

      return { ...item, dataNeeds: Array.from(needs) };
    });
  }

  private buildSystemPrompt(): string {
    return `You are a WordPress-to-React architecture planner.
Given a list of WordPress theme templates and the site's database content, you output a JSON plan describing how each template maps to a React component.

For each template, decide:
1. Is it a page (has its own route) or a partial (used inside pages — header, footer, sidebar, navigation, etc.)?
2. What route should it have? Use React Router v6 path syntax.
3. What data does it need from the API?
4. Is it a detail view that needs useParams() to fetch by slug?
5. Write a one-line description of what the component renders.

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
Allowed values: "posts" | "pages" | "menus" | "site-info" | "post-detail" | "page-detail" | "comments"

- "post-detail"  → ONLY for single-post templates (route /post/:slug or /single-*/:slug)
- "page-detail"  → ONLY for page templates (route /page/:slug or /page-*/:slug)
- Page templates MUST use "page-detail" — NEVER "post-detail"
- Partial components (type "partial") MUST NOT include "post-detail" or "page-detail"
- Archive / listing pages use "posts", not "post-detail"
- Dedicated Header / Footer / Navigation partials may include "menus"
- Dedicated Header / Footer partials that render site title or tagline may include "site-info"
- Ordinary page components MUST NOT request "menus" or "site-info" just because the original WordPress template referenced shared header/footer chrome.
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
    "description": "Main blog index showing a list of posts"
  },
  ...
]`;
  }

  private buildUserPrompt(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    templateNames: string[],
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

  private mergeDraftSectionPresentation(
    sections: SectionPlan[],
    draftSections?: SectionPlan[],
  ): SectionPlan[] {
    if (!draftSections?.length) return sections;
    return sections.map((section, index) =>
      this.mergeDraftSection(section, draftSections[index]),
    );
  }

  private mergeDraftSection(
    section: SectionPlan,
    draft?: SectionPlan,
  ): SectionPlan {
    if (!draft || draft.type !== section.type) return section;

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
- Every template must appear exactly once
- Pages must have a non-null route starting with "/"
- Partials must have route: null, isDetail: false
- isDetail must be true when route contains :slug
- Valid dataNeeds values: posts, pages, menus, site-info, post-detail, page-detail, comments, categoryDetail

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
Each object must have: templateName, componentName, type ("page"|"partial"), route (string|null), dataNeeds (string[]), isDetail (boolean), description (string).`;
  }

  private buildVisualPlanRetryPrompt(
    componentName: string,
    reason: string,
    badRaw: string,
  ): string {
    const preview = badRaw.slice(0, 700);
    return `Your previous response for component "${componentName}" could not be parsed.

Failure reason: ${reason}

Start of previous response:
\`\`\`
${preview}${badRaw.length > 700 ? '\n... (truncated)' : ''}
\`\`\`

Return ONLY a single valid JSON object matching ComponentVisualPlan.
Do not include markdown fences, comments, extra prose, or malformed JSON.`;
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

  getExpectedTemplateNames(
    theme: PhpParseResult | BlockParseResult,
    content?: DbContentResult,
  ): string[] {
    const allTemplates =
      theme.type === 'classic' ? theme.templates : [...theme.templates, ...theme.parts];
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
    hasSharedLayoutPartials: boolean,
  ): PlanningSourceContext {
    const hints: string[] = [];
    let scopedSource = templateSource;

    if (componentPlan.type === 'page') {
      scopedSource = this.stripClassicSharedIncludes(scopedSource, hints);
      scopedSource = this.stripFseSharedTemplateParts(scopedSource, hints);
    }

    if (this.looksLikeBlockMarkup(scopedSource)) {
      const bodyNodes = wpBlocksToJson(scopedSource);
      if (componentPlan.type === 'page' && bodyNodes.length > 0) {
        const filteredNodes = bodyNodes.filter(
          (node) => !this.isSharedLayoutBlockNode(node),
        );
        if (filteredNodes.length !== bodyNodes.length) {
          hints.push('removed top-level shared layout blocks from block tree');
        }
        if (filteredNodes.length > 0) {
          scopedSource = wpJsonToString(filteredNodes);
        } else if (bodyNodes.length > 0) {
          scopedSource = wpJsonToString(bodyNodes);
        }
      } else if (bodyNodes.length > 0) {
        scopedSource = wpJsonToString(bodyNodes);
      }
    }

    const trimmed = scopedSource.trim();
    const fallbackSource = trimmed.length > 0 ? trimmed : templateSource;
    const mode = this.looksLikeBlockMarkup(templateSource)
      ? 'body-only block JSON'
      : 'body-only markup';
    const summaryLines = ['## Extracted source scope'];
    summaryLines.push(`Mode: ${mode}`);
    summaryLines.push(
      `Shared Header/Footer partials in overall plan: ${hasSharedLayoutPartials ? 'yes' : 'no'}`,
    );
    summaryLines.push(
      `Component body source narrowed to route-owned content: ${componentPlan.type === 'page' ? 'yes' : 'partial/full-source'}`,
    );
    if (hints.length > 0) {
      summaryLines.push(...hints.map((hint) => `- ${hint}`));
    }
    const customClassNames =
      this.extractCustomClassNamesFromSource(fallbackSource);
    const sourceBackedAuxiliaryLabels = extractSourceBackedAuxiliaryLabels({
      source: fallbackSource,
    });
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
    const interactiveWidgets = this.detectInteractiveWidgetsFromSource(
      fallbackSource,
    );
    if (interactiveWidgets.length > 0) {
      summaryLines.push(
        `Interactive/widget hints detected from source: ${interactiveWidgets
          .map((item) => `\`${item}\``)
          .join(', ')}. Preserve them as interactive UI where the source shows real behavior; do not flatten them into static sections by default.`,
      );
    }

    return {
      source: fallbackSource,
      sourceAnalysis: summaryLines.join('\n'),
      sourceBackedAuxiliaryLabels,
    };
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

    if (
      normalized.includes('"block":"uagb/') ||
      normalized.includes('wp:uagb/') ||
      normalized.includes('uagb-') ||
      normalized.includes('spectra')
    ) {
      hints.add('spectra/uagb');
    }
    if (/\b(modal|popup|dialog)\b/.test(normalized)) {
      hints.add('modal');
    }
    if (/\b(slider|swiper)\b/.test(normalized)) {
      hints.add('slider');
    }
    if (/\bcarousel\b/.test(normalized)) {
      hints.add('carousel');
    }
    if (/\baccordion\b/.test(normalized)) {
      hints.add('accordion');
    }
    if (/\btabs?\b/.test(normalized)) {
      hints.add('tabs');
    }
    if (/\blightbox\b/.test(normalized)) {
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
    ];
    const mapped = new Set<DataNeed>();

    for (const need of dataNeeds) {
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
