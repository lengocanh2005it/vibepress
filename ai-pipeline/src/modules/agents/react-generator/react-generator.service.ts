import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import type { TokenScope } from '../../../common/utils/token-tracker.js';
import type { PipelineEditRequestDto } from '../../orchestrator/orchestrator.dto.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import { BlockParseResult } from '../block-parser/block-parser.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import { buildPlanPrompt } from './prompts/plan.prompt.js';
import { buildSurfacePlanRepairContextNote } from './prompts/component.prompt.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import {
  collectSurfacePlanRequiredLiterals,
  resolvePlannerSectionBlueprint,
} from '../planner/planner-surface-plan.util.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import {
  wpBlocksToJsonWithSourceRefs,
  wpJsonToString,
  inferTargetFromBlockName,
} from '../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../common/utils/wp-block-to-json.js';
import { StyleResolverService } from '../../../common/style-resolver/style-resolver.service.js';
import type {
  ThemeInteractionTarget,
  ThemeTokens,
} from '../block-parser/block-parser.service.js';
import type {
  BlockNode,
  ComponentVisualPlan,
  DataNeed,
  SectionPlan,
} from './visual-plan.schema.js';
import { shouldBypassAiGenerationForVisualPlan } from './visual-plan.schema.js';
import { getComponentStrategy } from '../component-strategy.registry.js';
import {
  shouldBlockAiStructuralRewriteForRenderContract,
  type ComponentRenderContract,
} from '../planner/render-contract.schema.js';
import type { PlannerSurfacePlan } from '../planner/planner-surface-plan.schema.js';
import { summarizeSharedLayoutSubtree } from '../planner/shared-layout-subtree.util.js';
import { shouldPreferThemeSourceFaithfulDeterministicPage } from './source-faithful-deterministic.util.js';
import {
  shouldForceStrictThemeSourceFaithfulDeterministicPage,
  shouldPreferSectionAssemblyForFrontPage,
  shouldRegenerateThemeSourceFaithfulDeterministicPage,
} from './source-faithful-deterministic.util.js';
import { synchronizeVisualPlanContract } from '../shared/visual-data-needs.util.js';

// Classic templates can stay on the normal single-component path up to this size.
const CLASSIC_CHUNK_THRESHOLD_CHARS = 40_000;
// FSE templates benefit from direct block-tree prompting, so allow larger inputs
// before splitting into section components.
const FSE_CHUNK_THRESHOLD_CHARS = 80_000;
// Target size per section chunk
const CHUNK_TARGET_CHARS = 15_000;
const BUILTIN_RUNTIME_PAGE_PATH = resolve(
  'templates/react-preview/src/pages/RuntimePage.tsx',
);

type SourceClusterComponent = {
  name: string;
  label: string;
  node: BlockNode;
  sections: SectionPlan[];
  dataNeeds: DataNeed[];
};

/**
 * Returns true for top-level block nodes that represent the shared site header
 * or footer (template-part with header/footer slug, or direct header/footer blocks).
 * Page components must not render these — the Layout wrapper already does.
 */
function isSharedLayoutBlock(node: WpNode): boolean {
  if (/^(header|footer|core\/header|core\/footer)$/i.test(node.block))
    return true;
  if (
    /^(?:core\/)?template-part$/i.test(node.block) &&
    /^(header|footer)/i.test(String(node.params?.slug ?? ''))
  )
    return true;
  return false;
}

function isSharedLayoutSubtree(node: WpNode): boolean {
  if (isSharedLayoutBlock(node)) return true;

  const summary = summarizeSharedLayoutSubtree(node);
  if (summary.hasRouteOwnedContent) return false;

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

  return hasIdentity && (hasNavigation || summary.headingCount > 0);
}

function filterSharedLayoutNodes(nodes: WpNode[]): WpNode[] {
  const visit = (node: WpNode): WpNode | null => {
    if (isSharedLayoutSubtree(node)) return null;
    const children = (node.children ?? [])
      .map((child) => visit(child))
      .filter((child): child is WpNode => child !== null);
    if (children.length === (node.children?.length ?? 0)) return node;
    const { children: _children, ...rest } = node;
    return children.length > 0 ? { ...rest, children } : rest;
  };

  return nodes.map((node) => visit(node)).filter((node): node is WpNode => !!node);
}

export interface GeneratedComponent {
  name: string;
  filePath: string;
  code: string;
  route?: string | null;
  isDetail?: boolean;
  fixedSlug?: string;
  runtimeRenderer?: 'runtime-page';
  dataNeeds?: string[];
  type?: 'page' | 'partial';
  // When true, preview-builder must NOT create a route for this component.
  // Sub-components are assembled into their parent; they are not standalone pages.
  isSubComponent?: boolean;
  /**
   * 'deterministic' = code came from CodeGeneratorService (no AI TSX gen).
   * 'ai'            = code was produced (fully or partially) by an LLM.
   * Orchestrator uses this to skip Stage 5 AI review for deterministic components.
   */
  generationMode?: 'deterministic' | 'ai';
  requiredCustomClassNames?: string[];
  requiredCustomClassTargets?: Record<string, ThemeInteractionTarget>;
  requiredSourceStyleFiles?: string[];
  visualPlan?: ComponentVisualPlan;
  surfacePlan?: PlannerSurfacePlan;
  renderContract?: ComponentRenderContract;
}

export interface ReactGenerateResult {
  jobId?: string;
  components: GeneratedComponent[];
  outDir: string;
}

@Injectable()
export class ReactGeneratorService {
  private readonly logger = new Logger(ReactGeneratorService.name);

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    private readonly styleResolver: StyleResolverService,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly codeReviewer: CodeReviewerService,
    private readonly aiLogger: AiLoggerService,
  ) {}

  // ── Public entry point ─────────────────────────────────────────────────────

  async generate(input: {
    theme: PhpParseResult | BlockParseResult;
    content: DbContentResult;
    plan?: PlanResult;
    repoManifest?: RepoThemeManifest;
    editRequest?: PipelineEditRequestDto;
    jobId?: string;
    logPath?: string;
    /** Per-step model overrides. undefined fields fall back to llmFactory.getModel(). */
    modelConfig?: {
      codeGenerator?: string;
      reviewCode?: string;
      fixAgent?: string;
    };
  }): Promise<ReactGenerateResult> {
    const {
      theme,
      content,
      plan,
      repoManifest,
      editRequest,
      jobId = 'unknown',
      logPath,
      modelConfig,
    } = input;

    this.logger.log(`Generating React components for job: ${jobId}`);

    const defaultModel = this.llmFactory.getModel();
    const codeGeneratorModel = modelConfig?.codeGenerator ?? defaultModel;
    const reviewCodeModel = modelConfig?.reviewCode ?? codeGeneratorModel;
    const fixAgentModel = modelConfig?.fixAgent ?? reviewCodeModel;

    const systemPrompt = buildPlanPrompt(theme, content, repoManifest);
    const tokens = 'tokens' in theme ? theme.tokens : undefined;

    const pagesCount = theme.templates.length;
    const partialsCount = theme.type === 'fse' ? theme.parts.length : 0;

    const templates: Array<{ name: string; html?: string; markup?: string }> =
      theme.type === 'classic'
        ? [...theme.templates]
        : [...theme.templates, ...theme.parts];

    const existingTemplateNames = new Set(
      templates.map((t) => t.name.toLowerCase()),
    );

    // Ensure standard routes are generated even when not present in theme templates.
    const createFallbackTemplate = (name: string, body: string) =>
      theme.type === 'classic' ? { name, html: body } : { name, markup: body };

    // Per WordPress template hierarchy: author/category/tag fall back to archive.php.
    // Inject a single 'archive' fallback instead of separate author/category templates.
    const hasArchiveVariant =
      existingTemplateNames.has('archive') ||
      existingTemplateNames.has('author') ||
      existingTemplateNames.has('category');

    if (!hasArchiveVariant) {
      templates.push(
        createFallbackTemplate(
          'archive',
          '<div><!-- Archive fallback: lists posts filtered by category, author, or tag --></div>',
        ),
      );
    }
    if (!existingTemplateNames.has('page')) {
      templates.push(
        createFallbackTemplate(
          'page',
          '<div><!-- Page template fallback --></div>',
        ),
      );
    }

    const templateByName = new Map(
      templates.map((template) => [template.name, template] as const),
    );
    const generationTargets = plan
      ? plan
          .map((componentPlan) => {
            const template = templateByName.get(componentPlan.templateName);
            if (!template) return null;
            return {
              template,
              componentPlan,
              componentName: componentPlan.componentName,
            };
          })
          .filter(
            (
              target,
            ): target is {
              template: { name: string; html?: string; markup?: string };
              componentPlan: PlanResult[number];
              componentName: string;
            } => !!target,
          )
      : templates.map((template) => ({
          template,
          componentPlan: undefined,
          componentName: this.toComponentName(template.name),
        }));

    const total = generationTargets.length;
    const components: GeneratedComponent[] = [];
    const hasSharedHeader = !!plan?.some(
      (item) => item.type === 'partial' && /^header/i.test(item.componentName),
    );
    const hasSharedFooter = !!plan?.some(
      (item) => item.type === 'partial' && /^footer/i.test(item.componentName),
    );

    const delay =
      this.configService.get<number>('reactGenerator.delayBetweenComponents') ??
      10000;
    const concurrency =
      this.configService.get<number>('reactGenerator.generationConcurrency') ??
      1;

    for (
      let batchStart = 0;
      batchStart < generationTargets.length;
      batchStart += concurrency
    ) {
      if (batchStart > 0) {
        await this.logToFile(logPath, `Rate-limit delay: ${delay / 1000}s`);
        await new Promise((res) => setTimeout(res, delay));
      }

      const batch = generationTargets.slice(
        batchStart,
        batchStart + concurrency,
      );
      const batchResults = await Promise.all(
        batch.map(async (target, batchIdx) => {
          const i = batchStart + batchIdx;
          const componentName = target.componentName;
          const rawSource = (target.template.markup ??
            target.template.html ??
            '') as string;
          const counter = `[${i + 1}/${total}]`;
          const componentPlan = this.stripSharedLayoutSectionsFromPlan(
            target.componentPlan,
            hasSharedHeader,
            hasSharedFooter,
          );
          const folder =
            componentPlan?.type === 'partial'
              ? 'src/components'
              : componentPlan?.type === 'page'
                ? 'src/pages'
                : isPartialComponentName(componentName)
                  ? 'src/components'
                  : 'src/pages';

          this.logger.log(
            `${counter} Generating "${componentName}.tsx" → ${folder}/`,
          );
          await this.logToFile(
            logPath,
            `${counter} Generating "${componentName}.tsx" → ${folder}/`,
          );

          const t0 = process.hrtime.bigint();
          const produced = await this.generateForTemplate({
            componentName,
            rawSource,
            codeGeneratorModel,
            fixAgentModel,
            systemPrompt,
            content,
            tokens,
            themeType: theme.type,
            componentPlan,
            editRequest,
            repoManifest,
            logPath,
            jobId,
          });
          const codeChars = produced.reduce((s, c) => s + c.code.length, 0);
          if (jobId) {
            await this.persistDraftComponents(jobId, produced);
          }
          const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
          const elapsed = this.formatElapsedMs(elapsedMs);
          this.logger.log(
            `${counter} Done "${componentName}.tsx" — ${codeChars} chars, ${elapsed}`,
          );
          await this.logToFile(
            logPath,
            `${counter} Done "${componentName}.tsx" — ${codeChars} chars, ${elapsed}`,
          );

          return { i, produced };
        }),
      );

      // Preserve original template order when merging batch results
      batchResults.sort((a, b) => a.i - b.i);
      for (const { produced } of batchResults) {
        components.push(...produced);
      }
    }

    const breakdown =
      partialsCount > 0
        ? `${pagesCount} pages, ${partialsCount} partials`
        : `${pagesCount} templates`;
    const summary = `All ${total} done — ${components.length} components (${breakdown})`;
    this.logger.log(summary);
    await this.logToFile(logPath, summary);

    return { jobId, components, outDir: '' };
  }

  private formatElapsedMs(ms: number): string {
    if (ms < 1000) {
      return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
    }
    const seconds = ms / 1000;
    return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
  }

  // ── Per-template routing: single vs chunked ────────────────────────────────

  private async generateForTemplate(input: {
    componentName: string;
    rawSource: string;
    codeGeneratorModel: string;
    fixAgentModel: string;
    systemPrompt: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    themeType: 'classic' | 'fse';
    componentPlan?: PlanResult[number];
    editRequest?: PipelineEditRequestDto;
    repoManifest?: RepoThemeManifest;
    logPath?: string;
    jobId?: string;
  }): Promise<GeneratedComponent[]> {
    const {
      componentName,
      rawSource,
      codeGeneratorModel,
      fixAgentModel,
      systemPrompt,
      content,
      tokens,
      themeType,
      componentPlan,
      editRequest,
      repoManifest,
      logPath,
      jobId,
    } = input;

    if (componentPlan?.runtimeRenderer === 'runtime-page') {
      const code = await readFile(BUILTIN_RUNTIME_PAGE_PATH, 'utf-8');
      await this.logToFile(
        logPath,
        `[runtime-page] "${componentName}": using built-in RuntimePage renderer scaffold`,
      );
      return [
        this.attachPlanContext(
          { name: componentName, filePath: '', code },
          componentPlan,
          { generationMode: 'ai' },
        ),
      ];
    }

    const templateSource = rawSource;
    const templateNodes =
      themeType === 'fse' && this.looksLikeBlockMarkup(templateSource)
        ? this.styleResolver.resolve(
            wpBlocksToJsonWithSourceRefs({
              markup: templateSource,
              templateName: componentPlan?.templateName ?? componentName,
              sourceFile: inferFseSourceFile(
                componentPlan?.templateName ?? componentName,
                componentPlan?.type,
              ),
            }),
            tokens,
          )
        : undefined;

    // For FSE page components, strip top-level header/footer blocks before
    // building the prompt — the shared Layout wrapper (Header + Footer partials)
    // already renders those elements; letting the AI see them causes duplication.
    const isHeaderOrFooterPartial =
      componentPlan?.type === 'partial' &&
      /^(header|footer)/i.test(componentName);
    const filteredNodes =
      templateNodes && !isHeaderOrFooterPartial
        ? filterSharedLayoutNodes(templateNodes)
        : templateNodes;
    const requiredCustomClassNames = this.collectCustomClassNamesFromNodes(
      filteredNodes ?? [],
    );
    const nodeTargets = this.collectCustomClassTargetsFromNodes(
      filteredNodes ?? [],
    );
    const requiredCustomClassTargets = this.resolveRequiredCustomClassTargets(
      requiredCustomClassNames,
      tokens,
      nodeTargets,
    );

    const prefersStrictThemeSourceFaithfulDeterministicPage =
      shouldForceStrictThemeSourceFaithfulDeterministicPage({
        componentPlan,
        componentName,
      });
    if (
      prefersStrictThemeSourceFaithfulDeterministicPage ||
      shouldPreferThemeSourceFaithfulDeterministicPage({
        componentPlan,
        componentName,
        repoManifest,
      })
    ) {
      const deterministicPlan = componentPlan;
      if (!deterministicPlan?.visualPlan) {
        throw new Error(
          `Missing visual plan for source-faithful deterministic page "${componentName}"`,
        );
      }
      const code = this.codeGenerator.generate({
        ...deterministicPlan.visualPlan,
        runtimeRenderer: deterministicPlan.runtimeRenderer,
      });
      await this.logToFile(
        logPath,
        prefersStrictThemeSourceFaithfulDeterministicPage
          ? `[theme-source-faithful] "${componentName}": generated strict deterministic full-file code from canonical block-tree plan`
          : `[theme-source-faithful] "${componentName}": generated deterministic full-file code from reviewed visual plan`,
      );
      return [
        this.attachPlanContext(
          { name: componentName, filePath: '', code },
          deterministicPlan,
          {
            generationMode: 'deterministic',
            requiredCustomClassNames,
            requiredCustomClassTargets,
          },
        ),
      ];
    }

    if (
      this.shouldUseBlockFaithfulSharedPartial(
        componentName,
        componentPlan,
        filteredNodes,
      )
    ) {
      const blockFaithfulDataNeeds = this.inferBlockFaithfulDataNeeds(
        componentName,
        componentPlan,
        filteredNodes ?? [],
      );
      const code = this.codeGenerator.generateBlockFaithfulPartial({
        componentName,
        nodes: filteredNodes ?? [],
        dataNeeds: blockFaithfulDataNeeds,
        palette: componentPlan?.visualPlan?.palette,
        typography: componentPlan?.visualPlan?.typography,
        layout: componentPlan?.visualPlan?.layout,
        blockStyles: tokens?.blockStyles,
      });
      await this.logToFile(
        logPath,
        `[block-faithful] "${componentName}": generated directly from WordPress block tree (${(filteredNodes ?? []).length} top-level nodes)`,
      );
      return [
        this.attachPlanContext(
          { name: componentName, filePath: '', code },
          componentPlan,
          {
            generationMode: 'deterministic',
            dataNeeds: blockFaithfulDataNeeds,
            requiredCustomClassNames,
            requiredCustomClassTargets,
          },
        ),
      ];
    }

    if (
      this.shouldUseProfolioSourceClusterChildComposition({
        themeType,
        componentName,
        componentPlan,
        repoManifest,
      })
    ) {
      const produced = await this.generateProfolioSourceClusterChildComposition({
        componentName,
        codeGeneratorModel,
        fixAgentModel,
        systemPrompt,
        content,
        tokens,
        repoManifest,
        componentPlan: componentPlan!,
        requiredCustomClassNames,
        requiredCustomClassTargets: requiredCustomClassTargets ?? {},
        logPath,
        jobId,
      });
      if (produced) {
        return produced;
      }
    }

    const promptTemplateSource = filteredNodes
      ? wpJsonToString(filteredNodes)
      : templateSource;
    const promptSourceLength = promptTemplateSource.length;
    const chunkThreshold =
      themeType === 'fse'
        ? FSE_CHUNK_THRESHOLD_CHARS
        : CLASSIC_CHUNK_THRESHOLD_CHARS;
    const canSplitIntoSections =
      themeType === 'fse' && !!filteredNodes && filteredNodes.length > 0;
    const preferDirectAi = this.shouldPreferDirectBlockSourceAi(
      themeType,
      componentName,
      componentPlan,
    );
    if (!canSplitIntoSections || promptSourceLength <= chunkThreshold) {
      const result = await this.codeReviewer.reviewComponent({
        componentName,
        templateSource: promptTemplateSource,
        modelName: codeGeneratorModel,
        fixAgentModel,
        preferDirectAi,
        systemPrompt,
        content,
        tokens,
        repoManifest,
        componentPlan,
        logPath,
        jobId,
      });

      if (this.aiLogger && jobId) {
        await this.aiLogger.logAiActivity(
          jobId,
          'code-generation',
          result.rawResponse,
          0,
          codeGeneratorModel,
          true,
        );
      }

      return [
        this.attachPlanContext(result.component, componentPlan, {
          generationMode: result.generationMode,
          requiredCustomClassTargets: this.resolveRequiredCustomClassTargets(
            result.component.requiredCustomClassNames,
            tokens,
            this.collectCustomClassTargetsFromNodes(filteredNodes ?? []),
          ),
        }),
      ];
    }

    // Too large → split into sections (FSE only)
    this.logger.warn(
      `Template ${componentName}: ${promptSourceLength} chars > ${chunkThreshold} → splitting into sections`,
    );
    const resolvedNodes = filteredNodes ?? [];
    const chunks = this.splitTemplateSections(
      resolvedNodes,
      CHUNK_TARGET_CHARS,
    );
    await this.logToFile(
      logPath,
      `WARN "${componentName}" too large (${promptSourceLength} chars > ${chunkThreshold}) → splitting into ${chunks.length} sections`,
    );

    this.logger.log(`Template ${componentName}: ${chunks.length} sections`);

    const sectionResults: GeneratedComponent[] = new Array(chunks.length);
    const delay =
      this.configService.get<number>('reactGenerator.delayBetweenComponents') ??
      10000;
    const sectionConcurrency =
      this.configService.get<number>('reactGenerator.sectionConcurrency') ?? 1;

    for (
      let batchStart = 0;
      batchStart < chunks.length;
      batchStart += sectionConcurrency
    ) {
      if (batchStart > 0) {
        await new Promise((res) => setTimeout(res, delay));
      }
      const batchIndices = Array.from(
        { length: Math.min(sectionConcurrency, chunks.length - batchStart) },
        (_, j) => batchStart + j,
      );
      await Promise.all(
        batchIndices.map(async (i) => {
          sectionResults[i] = await this.codeReviewer.reviewSection({
            sectionName: `${componentName}Section${i + 1}`,
            parentName: componentName,
            sectionIndex: i,
            totalSections: chunks.length,
            nodesJson: wpJsonToString(chunks[i]),
            modelName: codeGeneratorModel,
            fixAgentModel,
            preferDirectAi,
            systemPrompt,
            content,
            tokens,
            repoManifest,
            componentPlan,
            logPath,
            jobId,
          });
        }),
      );
    }
    const subComponents = sectionResults;

    const assemblyCode = this.buildAssemblyCode(componentName, subComponents);
    return [
      this.attachPlanContext(
        { name: componentName, filePath: '', code: assemblyCode },
        componentPlan,
      ),
      ...subComponents,
    ];
  }

  private shouldPreferDirectBlockSourceAi(
    themeType: 'classic' | 'fse',
    componentName: string,
    componentPlan: PlanResult[number] | undefined,
  ): boolean {
    return (
      themeType === 'fse' &&
      componentPlan?.type === 'partial' &&
      !getComponentStrategy(componentName).deterministicFirst
    );
  }

  private shouldUseProfolioSourceClusterChildComposition(input: {
    themeType: 'classic' | 'fse';
    componentName: string;
    componentPlan?: PlanResult[number];
    repoManifest?: RepoThemeManifest;
  }): boolean {
    const { themeType, componentName, componentPlan, repoManifest } = input;
    if (themeType !== 'fse') return false;
    if (componentPlan?.type !== 'page' || !componentPlan.visualPlan) {
      return false;
    }
    const themeSlug = repoManifest?.themeTypeHints?.themeSlug?.trim();
    if (themeSlug !== 'profolio-fse') return false;

    if (componentPlan.isDetail) {
      return false;
    }

    return (
      (componentPlan.visualPlan.blockTree?.length ?? 0) > 0 &&
      (componentPlan.visualPlan.sections.length >= 1 ||
        (componentPlan.visualPlan.blockTree?.length ?? 0) >= 2)
    );
  }

  private async generateProfolioSourceClusterChildComposition(input: {
    componentName: string;
    codeGeneratorModel: string;
    fixAgentModel: string;
    systemPrompt: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    repoManifest?: RepoThemeManifest;
    componentPlan: PlanResult[number];
    requiredCustomClassNames: string[];
    requiredCustomClassTargets: Record<string, ThemeInteractionTarget>;
    logPath?: string;
    jobId?: string;
  }): Promise<GeneratedComponent[] | null> {
    const {
      componentName,
      codeGeneratorModel,
      fixAgentModel,
      systemPrompt,
      content,
      tokens,
      repoManifest,
      componentPlan,
      requiredCustomClassNames,
      requiredCustomClassTargets,
      logPath,
      jobId,
    } = input;

    const visualPlan = componentPlan.visualPlan;
    if (!visualPlan?.blockTree?.length) return null;

    const clusters = this.buildProfolioSourceClusters(
      visualPlan,
      componentName,
      componentPlan.templateName,
    );
    if (clusters.length < 2) return null;

    this.logger.log(
      `[source-cluster] "${componentName}": generating ${clusters.length} source-bound child component(s)`,
    );
    await this.logToFile(
      logPath,
      `[source-cluster] "${componentName}": generating child components: ${clusters
        .map((cluster) => cluster.name)
        .join(', ')}`,
    );

    const children: GeneratedComponent[] = [];
    for (const [index, cluster] of clusters.entries()) {
      const childPlan = this.buildSourceClusterChildPlan({
        parentPlan: componentPlan,
        cluster,
      });
      const child = await this.codeReviewer.reviewSection({
        sectionName: cluster.name,
        parentName: componentName,
        sectionIndex: index,
        totalSections: clusters.length,
        nodesJson: JSON.stringify([cluster.node], null, 2),
        modelName: codeGeneratorModel,
        fixAgentModel,
        preferDirectAi: false,
        systemPrompt,
        content,
        tokens,
        repoManifest,
        componentPlan: childPlan,
        logPath,
        jobId,
      });
      children.push(
        this.attachPlanContext(child, childPlan, {
          generationMode: 'ai',
          type: 'partial',
          isSubComponent: true,
        }),
      );
    }

    const parentCode = this.buildChildComponentAssemblyCode(
      componentName,
      children,
      clusters,
    );
    const parent = this.attachPlanContext(
      { name: componentName, filePath: '', code: parentCode },
      componentPlan,
      {
        generationMode: 'deterministic',
        requiredCustomClassNames,
        requiredCustomClassTargets,
      },
    );

    return [parent, ...children];
  }

  private buildProfolioSourceClusters(
    visualPlan: ComponentVisualPlan,
    componentName: string,
    templateName?: string,
  ): SourceClusterComponent[] {
    if (
      /^frontpage$/i.test(componentName) ||
      templateName?.toLowerCase() === 'front-page'
    ) {
      return this.buildProfolioFrontPageSourceClusters(visualPlan);
    }
    return this.buildGenericProfolioSourceClusters(visualPlan, componentName);
  }

  private buildProfolioFrontPageSourceClusters(
    visualPlan: ComponentVisualPlan,
  ): SourceClusterComponent[] {
    const nodes = visualPlan.blockTree ?? [];
    const result: SourceClusterComponent[] = [];
    const used = new Set<string>();
    const addCluster = (label: string, node: BlockNode | undefined) => {
      if (!node) return;
      const sourceNodeId = node.sourceRef?.sourceNodeId ?? label;
      if (used.has(sourceNodeId)) return;
      used.add(sourceNodeId);
      result.push({
        name: `FrontPage${this.toPascalIdentifier(label)}`,
        label,
        node,
        sections: this.filterSectionsForSourceCluster(
          visualPlan.sections,
          node.sourceRef?.sourceNodeId,
        ),
        dataNeeds: [],
      });
    };

    addCluster(
      'Banner',
      this.findFirstBlockNode(nodes, (node) => {
        const id = node.sourceRef?.sourceNodeId ?? '';
        return (
          this.sourceNodePath(id) === '0' ||
          /front-page::group::0$/i.test(id)
        );
      }) ?? nodes[0],
    );

    for (const label of ['Projects', 'Services', 'Experience', 'Skills']) {
      addCluster(
        label,
        this.findFirstBlockNode(
          nodes,
          (node) =>
            this.normalizeClusterLabel(this.readBlockMetadataName(node)) ===
            this.normalizeClusterLabel(label),
        ),
      );
    }

    return result.map((cluster) => ({
      ...cluster,
      dataNeeds: this.inferDataNeedsForSourceCluster(cluster.sections),
    }));
  }

  private buildGenericProfolioSourceClusters(
    visualPlan: ComponentVisualPlan,
    componentName: string,
  ): SourceClusterComponent[] {
    const nodes = visualPlan.blockTree ?? [];
    if (nodes.length === 0) return [];

    const clusters: SourceClusterComponent[] = [];
    const byKey = new Map<string, SourceClusterComponent>();

    for (const [index, section] of visualPlan.sections.entries()) {
      const sourceId = this.getSectionClusterSourceNodeId(section);
      const node =
        this.findSemanticClusterNodeForSection(nodes, section) ??
        (sourceId && this.findBestClusterNodeForSourceId(nodes, sourceId));
      if (!node) continue;

      const key =
        node.sourceRef?.sourceNodeId ??
        sourceId ??
        `${componentName.toLowerCase()}::section::${index}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.sections.push(section);
        continue;
      }

      const label = this.buildGenericClusterLabel(section, node, index);
      const cluster: SourceClusterComponent = {
        name: `${componentName}${this.toPascalIdentifier(label)}`,
        label,
        node,
        sections: [section],
        dataNeeds: [],
      };
      byKey.set(key, cluster);
      clusters.push(cluster);
    }

    for (const [index, node] of nodes.entries()) {
      const nodePath = this.sourceNodePath(node.sourceRef?.sourceNodeId ?? '');
      if (!nodePath) continue;
      const alreadyCovered = clusters.some((cluster) => {
        const clusterPath = this.sourceNodePath(
          cluster.node.sourceRef?.sourceNodeId ?? '',
        );
        return (
          clusterPath &&
          this.isSourcePathWithinCluster(clusterPath, nodePath)
        );
      });
      if (alreadyCovered) continue;

      const label = this.readBlockMetadataName(node) || `Block-${index + 1}`;
      clusters.push({
        name: `${componentName}${this.toPascalIdentifier(label)}`,
        label,
        node,
        sections: [],
        dataNeeds: [],
      });
    }

    return clusters.map((cluster) => ({
      ...cluster,
      dataNeeds: this.inferDataNeedsForSourceCluster(cluster.sections),
    }));
  }

  private getSectionClusterSourceNodeId(section: SectionPlan): string | undefined {
    const loose = section as SectionPlan & {
      sourceRef?: {
        sourceNodeId?: string;
        parentSourceNodeId?: string;
      };
    };
    return (
      loose.sourceRef?.sourceNodeId?.trim() ||
      loose.sourceRef?.parentSourceNodeId?.trim() ||
      section.obligation?.sourceEvidence?.sourceNodeIds?.[0]?.trim()
    );
  }

  private buildGenericClusterLabel(
    section: SectionPlan,
    node: BlockNode,
    index: number,
  ): string {
    const loose = section as SectionPlan & {
      debugKey?: string;
      title?: string;
      heading?: string;
      subtitle?: string;
    };
    return (
      this.readBlockMetadataName(node) ||
      loose.debugKey ||
      loose.title ||
      loose.heading ||
      loose.subtitle ||
      `${section.type}-${index + 1}`
    );
  }

  private buildSourceClusterChildPlan(input: {
    parentPlan: PlanResult[number];
    cluster: SourceClusterComponent;
  }): PlanResult[number] {
    const { parentPlan, cluster } = input;
    const parentVisualPlan = parentPlan.visualPlan!;
    const childVisualPlan: ComponentVisualPlan = {
      ...parentVisualPlan,
      componentName: cluster.name,
      renderMode: parentVisualPlan.renderMode ?? 'hybrid',
      sections: cluster.sections,
      blockTree: [cluster.node],
      dataNeeds: cluster.dataNeeds,
    };

    return {
      ...parentPlan,
      componentName: cluster.name,
      templateName: `${parentPlan.templateName}::${cluster.label}`,
      type: 'partial',
      route: null,
      dataNeeds: cluster.dataNeeds,
      isDetail: false,
      description: `Source-bound ${cluster.label} child component for ${parentPlan.componentName}`,
      surfacePlan: undefined,
      renderContract: undefined,
      visualPlan: childVisualPlan,
    };
  }

  private buildChildComponentAssemblyCode(
    componentName: string,
    children: GeneratedComponent[],
    clusters: SourceClusterComponent[],
  ): string {
    const needs = this.mergeDataNeeds(
      clusters.flatMap((cluster) => cluster.dataNeeds),
    );
    const needsRuntimeData = needs.length > 0;
    const imports = children
      .map((child) => `import ${child.name} from '../components/${child.name}';`)
      .join('\n');
    const clusterByName = new Map(
      clusters.map((cluster) => [cluster.name, cluster]),
    );
    const renders = children
      .map((child) => {
        const props = this.buildChildPropsExpression(
          clusterByName.get(child.name)?.dataNeeds ?? [],
        );
        return `      <${child.name}${props} />`;
      })
      .join('\n');
    const runtime = needsRuntimeData
      ? `${this.buildSourceClusterParentTypes(needs)}

${this.buildSourceClusterParentState(needs)}
`
      : '';

    return `import React${needsRuntimeData ? ', { useEffect, useState }' : ''} from 'react';
${imports}

export default function ${componentName}() {
${runtime}  return (
    <main className="wp-site-blocks">
${renders}
    </main>
  );
}
`;
  }

  private inferDataNeedsForSourceCluster(sections: SectionPlan[]): DataNeed[] {
    const needs = new Set<DataNeed>();
    const add = (need: DataNeed) => needs.add(need);

    for (const section of sections) {
      const loose = section as SectionPlan & {
        resource?: string;
        dataNeeds?: string[];
      };
      for (const need of loose.dataNeeds ?? []) {
        this.addKnownDataNeed(needs, need);
      }

      switch (section.type) {
        case 'post-list':
          add(loose.resource === 'products' ? 'products' : 'posts');
          break;
        case 'post-content':
        case 'post-title':
        case 'post-meta':
        case 'post-featured-image':
        case 'post-terms':
          add('postDetail');
          break;
        case 'post-navigation':
          add('postDetail');
          add('posts');
          break;
        case 'page-content':
          add('pageDetail');
          break;
        case 'comments':
          add('comments');
          break;
        case 'navbar':
          add('menus');
          add('siteInfo');
          break;
        case 'footer':
          add('footerLinks');
          add('siteInfo');
          break;
      }

      for (const capability of section.obligation?.required ?? []) {
        switch (capability) {
          case 'posts':
            add('posts');
            break;
          case 'products':
            add('products');
            break;
          case 'pages':
            add('pages');
            break;
          case 'menus':
            add('menus');
            break;
          case 'site-info':
            add('siteInfo');
            break;
          case 'comments-list':
          case 'comment-form':
            add('comments');
            break;
          case 'post-content':
            add('postDetail');
            break;
          case 'page-content':
            add('pageDetail');
            break;
        }
      }
    }

    return this.mergeDataNeeds([...needs]);
  }

  private addKnownDataNeed(target: Set<DataNeed>, need: string): void {
    const normalized = need.trim();
    const aliases: Record<string, DataNeed> = {
      'post-detail': 'postDetail',
      'product-detail': 'productDetail',
      'page-detail': 'pageDetail',
      'site-info': 'siteInfo',
      'footer-links': 'footerLinks',
    };
    const value = aliases[normalized] ?? normalized;
    if (
      [
        'siteInfo',
        'footerLinks',
        'posts',
        'products',
        'pages',
        'menus',
        'postDetail',
        'productDetail',
        'pageDetail',
        'comments',
      ].includes(value)
    ) {
      target.add(value as DataNeed);
    }
  }

  private mergeDataNeeds(needs: DataNeed[]): DataNeed[] {
    const order: DataNeed[] = [
      'siteInfo',
      'footerLinks',
      'posts',
      'products',
      'pages',
      'menus',
      'postDetail',
      'productDetail',
      'pageDetail',
      'comments',
    ];
    const set = new Set(needs);
    return order.filter((need) => set.has(need));
  }

  private buildChildPropsExpression(dataNeeds: DataNeed[]): string {
    const props = this.dataNeedsToPropNames(dataNeeds);
    if (props.length === 0) return '';
    return ` ${[
      ...props.map((prop) => `${prop}={${prop}}`),
      'loading={loading}',
      'error={error}',
    ].join(' ')}`;
  }

  private dataNeedsToPropNames(dataNeeds: DataNeed[]): string[] {
    const props: string[] = [];
    const add = (name: string) => {
      if (!props.includes(name)) props.push(name);
    };
    for (const need of dataNeeds) {
      switch (need) {
        case 'posts':
          add('posts');
          break;
        case 'products':
          add('products');
          break;
        case 'pages':
          add('pages');
          break;
        case 'menus':
          add('menus');
          break;
        case 'siteInfo':
          add('siteInfo');
          break;
        case 'footerLinks':
          add('footerColumns');
          break;
      }
    }
    return props;
  }

  private buildSourceClusterParentTypes(dataNeeds: DataNeed[]): string {
    const lines: string[] = [];
    if (dataNeeds.includes('posts')) {
      lines.push(
        'type Post = { id?: number | string; title?: string; slug?: string; excerpt?: string; content?: string; featuredImage?: string; date?: string; author?: string; authorSlug?: string; categories?: string[]; categorySlugs?: string[]; tags?: string[]; };',
      );
    }
    if (dataNeeds.includes('products')) {
      lines.push(
        'type Product = { id?: number | string; title?: string; slug?: string; excerpt?: string; content?: string; featuredImage?: string; price?: string; buttonText?: string; buttonUrl?: string; categories?: string[]; tags?: string[]; };',
      );
    }
    if (dataNeeds.includes('pages')) {
      lines.push(
        'type Page = { id?: number | string; title?: string; slug?: string; excerpt?: string; content?: string; featuredImage?: string; };',
      );
    }
    if (dataNeeds.includes('menus')) {
      lines.push(
        'type MenuItem = { id?: number | string; label?: string; title?: string; url?: string; path?: string; target?: string; children?: MenuItem[]; };',
      );
    }
    if (dataNeeds.includes('siteInfo')) {
      lines.push(
        'type SiteInfo = { siteName?: string; blogDescription?: string; logoUrl?: string; siteUrl?: string; };',
      );
    }
    if (dataNeeds.includes('footerLinks')) {
      lines.push(
        'type FooterColumn = { heading?: string; title?: string; links?: Array<{ label?: string; title?: string; url?: string; path?: string; target?: string; }>; };',
      );
    }
    return lines.join('\n');
  }

  private buildSourceClusterParentState(dataNeeds: DataNeed[]): string {
    const stateLines: string[] = [];
    const fetches: string[] = [];
    const assignments: string[] = [];
    let index = 0;
    const addFetch = (endpoint: string, assignment: string) => {
      fetches.push(`        fetch('${endpoint}')`);
      assignments.push(assignment.replaceAll('__RES__', `res${index}`));
      index += 1;
    };

    if (dataNeeds.includes('posts')) {
      stateLines.push('  const [posts, setPosts] = useState<Post[]>([]);');
      addFetch(
        '/api/posts',
        '      const postsData = await __RES__.json(); setPosts(Array.isArray(postsData) ? postsData : []);',
      );
    }
    if (dataNeeds.includes('products')) {
      stateLines.push('  const [products, setProducts] = useState<Product[]>([]);');
      addFetch(
        '/api/post-types/product/posts',
        '      const productsData = await __RES__.json(); setProducts(Array.isArray(productsData) ? productsData : []);',
      );
    }
    if (dataNeeds.includes('pages')) {
      stateLines.push('  const [pages, setPages] = useState<Page[]>([]);');
      addFetch(
        '/api/pages',
        '      const pagesData = await __RES__.json(); setPages(Array.isArray(pagesData) ? pagesData : []);',
      );
    }
    if (dataNeeds.includes('menus')) {
      stateLines.push('  const [menus, setMenus] = useState<MenuItem[]>([]);');
      addFetch(
        '/api/menus',
        '      const menusData = await __RES__.json(); setMenus(Array.isArray(menusData) ? menusData : []);',
      );
    }
    if (dataNeeds.includes('siteInfo')) {
      stateLines.push('  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);');
      addFetch(
        '/api/site-info',
        '      const siteInfoData = await __RES__.json(); setSiteInfo(siteInfoData && typeof siteInfoData === "object" ? siteInfoData : null);',
      );
    }
    if (dataNeeds.includes('footerLinks')) {
      stateLines.push('  const [footerColumns, setFooterColumns] = useState<FooterColumn[]>([]);');
      addFetch(
        '/api/footer-links',
        '      const footerLinksData = await __RES__.json(); setFooterColumns(Array.isArray(footerLinksData) ? footerLinksData : []);',
      );
    }
    stateLines.push('  const [loading, setLoading] = useState(true);');
    stateLines.push('  const [error, setError] = useState<string | null>(null);');

    const responseVars = fetches.map((_, i) => `res${i}`).join(', ');
    return `${stateLines.join('\n')}

  useEffect(() => {
    let cancelled = false;
    const loadData = async () => {
      try {
        const [${responseVars}] = await Promise.all([
${fetches.join(',\n')}
        ]);
        if (cancelled) return;
${assignments.join('\n')}
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load page data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadData();
    return () => {
      cancelled = true;
    };
  }, []);
`;
  }

  private filterSectionsForSourceCluster(
    sections: SectionPlan[],
    clusterSourceNodeId?: string,
  ): SectionPlan[] {
    if (!clusterSourceNodeId) return [];
    const clusterPath = this.sourceNodePath(clusterSourceNodeId);
    if (!clusterPath) return [];

    return sections.filter((section) => {
      const sectionSourceIds = [
        section.sourceRef?.sourceNodeId,
        ...(section.obligation?.sourceEvidence?.sourceNodeIds ?? []),
      ].filter((value): value is string => !!value?.trim());

      return sectionSourceIds.some((sourceNodeId) =>
        this.isSourcePathWithinCluster(
          this.sourceNodePath(sourceNodeId),
          clusterPath,
        ),
      );
    });
  }

  private isSourcePathWithinCluster(
    sectionPath: string,
    clusterPath: string,
  ): boolean {
    return sectionPath === clusterPath || sectionPath.startsWith(`${clusterPath}.`);
  }

  private sourceNodePath(sourceNodeId: string): string {
    const normalized = sourceNodeId.trim();
    const marker = normalized.lastIndexOf('::');
    return marker >= 0 ? normalized.slice(marker + 2) : '';
  }

  private findFirstBlockNode(
    nodes: BlockNode[],
    predicate: (node: BlockNode) => boolean,
  ): BlockNode | undefined {
    for (const node of nodes) {
      if (predicate(node)) return node;
      const found = this.findFirstBlockNode(node.children ?? [], predicate);
      if (found) return found;
    }
    return undefined;
  }

  private findSemanticClusterNodeForSection(
    nodes: BlockNode[],
    section: SectionPlan,
  ): BlockNode | undefined {
    if (section.type === 'accordion') {
      return (
        this.findFirstBlockNode(
          nodes,
          (node) =>
            this.normalizeClusterLabel(this.readBlockMetadataName(node)) ===
              'faq' ||
            this.nodeContainsBlockKind(node, /^(?:core\/)?details$|details/i),
        ) ?? undefined
      );
    }
    return undefined;
  }

  private nodeContainsBlockKind(
    node: BlockNode,
    pattern: RegExp,
  ): boolean {
    if (pattern.test(node.blockName ?? '') || pattern.test(node.kind ?? '')) {
      return true;
    }
    return (node.children ?? []).some((child) =>
      this.nodeContainsBlockKind(child, pattern),
    );
  }

  private findBestClusterNodeForSourceId(
    nodes: BlockNode[],
    sourceNodeId: string,
  ): BlockNode | undefined {
    const sourcePath = this.sourceNodePath(sourceNodeId);
    if (!sourcePath) return undefined;

    let best: BlockNode | undefined;
    let bestDepth = -1;

    const visit = (items: BlockNode[], depth = 0) => {
      for (const node of items) {
        const nodePath = this.sourceNodePath(node.sourceRef?.sourceNodeId ?? '');
        if (
          nodePath &&
          this.isSourcePathWithinCluster(sourcePath, nodePath) &&
          depth > bestDepth
        ) {
          best = node;
          bestDepth = depth;
        }
        if (node.children?.length) visit(node.children, depth + 1);
      }
    };

    visit(nodes);
    return best;
  }

  private readBlockMetadataName(node: BlockNode): string | undefined {
    const metadata = node.attrs?.metadata;
    if (metadata && typeof metadata === 'object') {
      const name = (metadata as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
    return undefined;
  }

  private normalizeClusterLabel(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  private toPascalIdentifier(value: string): string {
    const normalized = value
      .trim()
      .replace(/['’]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
    return normalized || 'Section';
  }

  private stripSharedLayoutSectionsFromPlan(
    componentPlan: PlanResult[number] | undefined,
    hasSharedHeader: boolean,
    hasSharedFooter: boolean,
  ): PlanResult[number] | undefined {
    if (!componentPlan?.visualPlan || componentPlan.type !== 'page') {
      return componentPlan;
    }

    const removedTypes = new Set<string>();
    const sections = componentPlan.visualPlan.sections.filter((section) => {
      if (hasSharedHeader && section.type === 'navbar') {
        removedTypes.add('navbar');
        return false;
      }
      if (hasSharedFooter && section.type === 'footer') {
        removedTypes.add('footer');
        return false;
      }
      return true;
    });
    const blockTree = this.stripSharedLayoutBlockTreeNodes(
      componentPlan.visualPlan.blockTree,
      hasSharedHeader,
      hasSharedFooter,
    );
    const blockTreeChanged =
      (blockTree?.length ?? 0) !==
        (componentPlan.visualPlan.blockTree?.length ?? 0) ||
      JSON.stringify(blockTree ?? []) !==
        JSON.stringify(componentPlan.visualPlan.blockTree ?? []);

    if (
      sections.length === componentPlan.visualPlan.sections.length &&
      !blockTreeChanged
    ) {
      return componentPlan;
    }

    // When navbar/footer are removed, also strip their exclusive data needs
    // (siteInfo, menus, footerLinks) from the plan — otherwise CodeGeneratorService will
    // still emit fetches for them and the validator will reject the component.
    const chromeRemoved =
      removedTypes.has('navbar') || removedTypes.has('footer') || blockTreeChanged;
    const remainingSectionTypes = new Set(sections.map((s) => s.type));
    const stillNeedsChrome =
      remainingSectionTypes.has('navbar') ||
      remainingSectionTypes.has('footer');
    const dataNeeds =
      chromeRemoved && !stillNeedsChrome
        ? componentPlan.visualPlan.dataNeeds.filter(
            (n) => n !== 'siteInfo' && n !== 'menus' && n !== 'footerLinks',
          )
        : componentPlan.visualPlan.dataNeeds;

    return {
      ...componentPlan,
      visualPlan: {
        ...componentPlan.visualPlan,
        runtimeRenderer: componentPlan.runtimeRenderer,
        sections,
        blockTree,
        dataNeeds,
      },
    };
  }

  private stripSharedLayoutBlockTreeNodes(
    blockTree: BlockNode[] | undefined,
    hasSharedHeader: boolean,
    hasSharedFooter: boolean,
  ): BlockNode[] | undefined {
    if (!blockTree?.length) return blockTree;
    const shouldRemove = (node: BlockNode): boolean => {
      const kind = String(node.kind ?? '').toLowerCase();
      const blockName = String(node.blockName ?? '').toLowerCase();
      const templatePartSlug = String(node.templatePartSlug ?? '').toLowerCase();
      const refName = String(node.refName ?? '').toLowerCase();
      const slug = templatePartSlug || refName;
      if (hasSharedHeader) {
        if (kind === 'header' || blockName === 'core/header') return true;
        if (
          kind === 'template-part' &&
          (slug === 'header' || slug.startsWith('header'))
        ) {
          return true;
        }
      }
      if (hasSharedFooter) {
        if (kind === 'footer' || blockName === 'core/footer') return true;
        if (
          kind === 'template-part' &&
          (slug === 'footer' || slug.startsWith('footer'))
        ) {
          return true;
        }
      }
      return false;
    };

    const visit = (node: BlockNode): BlockNode | null => {
      if (shouldRemove(node)) return null;
      const children = (node.children ?? [])
        .map(visit)
        .filter((child): child is BlockNode => child !== null);
      return {
        ...node,
        ...(children.length > 0 ? { children } : { children: undefined }),
      };
    };

    return blockTree
      .map(visit)
      .filter((node): node is BlockNode => node !== null);
  }

  // ── Automated Repair ────────────────────────────────────────────────────────

  async fixComponent(input: {
    component: GeneratedComponent;
    plan: PlanResult;
    feedback: string;
    modelConfig?: { fixAgent?: string };
    logPath?: string;
    fixMode?:
      | 'full'
      | 'syntax-only'
      | 'visual-metrics-safe'
      | 'edit-request-safe';
    visionImageUrls?: string[];
    visionContextNote?: string;
    tokenScope?: TokenScope;
  }): Promise<GeneratedComponent> {
    const {
      component,
      plan,
      feedback,
      modelConfig,
      logPath,
      fixMode = 'full',
      visionImageUrls,
      visionContextNote,
      tokenScope = 'base',
    } = input;
    const componentPlan = plan.find((p) => p.componentName === component.name);
    const fixAgentModel = modelConfig?.fixAgent ?? this.llmFactory.getModel();
    const effectiveRenderContract =
      component.renderContract ?? componentPlan?.renderContract;
    const isStrictSourceFaithfulProtection =
      shouldRegenerateThemeSourceFaithfulDeterministicPage({
        componentPlan,
        componentName: component.name,
      });
    const prefersFrontPageSectionAssembly =
      shouldPreferSectionAssemblyForFrontPage({
        componentPlan,
        componentName: component.name,
      });
    const isProtectedDeterministicAuthority =
      !prefersFrontPageSectionAssembly &&
      component.generationMode === 'deterministic' &&
      shouldBypassAiGenerationForVisualPlan(component.visualPlan);
    const isSourceClusterComposition =
      component.generationMode === 'deterministic' &&
      this.isSourceClusterCompositionCode(component);
    const isStrictRenderContractProtection =
      isStrictSourceFaithfulProtection &&
      shouldBlockAiStructuralRewriteForRenderContract(effectiveRenderContract);

    if (
      (isProtectedDeterministicAuthority ||
        isStrictRenderContractProtection ||
        isSourceClusterComposition) &&
      fixMode !== 'syntax-only'
    ) {
      if (fixMode === 'full' && isStrictSourceFaithfulProtection) {
        const hasSharedHeader = !!plan.some(
          (item) =>
            item.type === 'partial' && /^header/i.test(item.componentName),
        );
        const hasSharedFooter = !!plan.some(
          (item) =>
            item.type === 'partial' && /^footer/i.test(item.componentName),
        );
        const regenerated = this.generateDeterministicFallbackComponent({
          component,
          plan,
          hasSharedHeader,
          hasSharedFooter,
        });
        if (regenerated) {
          this.logger.log(
            `[fixer] Rebuilt protected source-faithful component "${component.name}" from its canonical deterministic plan`,
          );
          await this.logToFile(
            logPath,
            `[fixer] Rebuilt protected source-faithful component "${component.name}" from its canonical deterministic plan. Feedback: ${feedback}`,
          );
          return regenerated;
        }
      }
      this.logger.log(
        `[fixer] Skipping AI auto-fix for protected component "${component.name}" to preserve planner-owned/source-backed structure`,
      );
      await this.logToFile(
        logPath,
        `[fixer] Skipping AI auto-fix for protected component "${component.name}" to preserve planner-owned/source-backed structure. Feedback: ${feedback}`,
      );
      return this.attachPlanContext(component, componentPlan);
    }

    const effectiveFeedback =
      fixMode === 'syntax-only'
        ? `Syntax-only repair for deterministic-authority component "${component.name}". Preserve the existing planner-owned structure, layout, data flow, and markup intent. Fix only syntax / TSX structure / parser issues needed to satisfy the validator.\n\n${feedback}`
        : feedback;
    const approvedPlanRepairNote =
      fixMode === 'full'
        ? this.buildApprovedPlanRepairNote(componentPlan)
        : undefined;
    const visualMetricsSafeRepairNote =
      fixMode === 'visual-metrics-safe'
        ? this.buildVisualMetricsSafeRepairNote(componentPlan)
        : undefined;
    const editRequestSafeRepairNote =
      fixMode === 'edit-request-safe'
        ? this.buildEditRequestSafeRepairNote(componentPlan)
        : undefined;
    const hardRegenerationNote =
      fixMode === 'full'
        ? this.buildHardRegenerationRepairNote(feedback, componentPlan)
        : undefined;
    const repairFeedback = [
      effectiveFeedback,
      visualMetricsSafeRepairNote,
      editRequestSafeRepairNote,
      approvedPlanRepairNote,
      this.buildComponentContractRepairNote(componentPlan),
      hardRegenerationNote,
    ]
      .filter(Boolean)
      .join('\n\n');

    this.logger.log(
      fixMode === 'syntax-only'
        ? `[fixer] Auto-fixing syntax for protected deterministic shared partial "${component.name}"`
        : fixMode === 'visual-metrics-safe'
          ? `[fixer] Auto-fixing visual metrics for component "${component.name}" with contract-safe mode`
          : fixMode === 'edit-request-safe'
            ? `[fixer] Auto-fixing approved user edit for component "${component.name}" with scoped safe mode`
            : `[fixer] Auto-fixing component "${component.name}" based on review feedback`,
    );
    await this.logToFile(
      logPath,
      fixMode === 'syntax-only'
        ? `[fixer] Auto-fixing syntax for protected deterministic-authority component "${component.name}": ${repairFeedback}`
        : fixMode === 'visual-metrics-safe'
          ? `[fixer] Auto-fixing visual metrics for component "${component.name}" with contract-safe mode: ${repairFeedback}`
          : fixMode === 'edit-request-safe'
            ? `[fixer] Auto-fixing approved user edit for component "${component.name}" with scoped safe mode: ${repairFeedback}`
            : `[fixer] Auto-fixing component "${component.name}" based on review feedback: ${repairFeedback}`,
    );

    const fixedCode = await this.codeReviewer.selfFix(
      fixAgentModel,
      component.code,
      visionContextNote
        ? `${repairFeedback}\n\n${visionContextNote}`
        : repairFeedback,
      logPath,
      component.name,
      visionImageUrls,
      tokenScope,
    );
    return this.attachPlanContext(
      { ...component, code: fixedCode },
      componentPlan,
    );
  }

  private isSourceClusterCompositionCode(component: GeneratedComponent): boolean {
    return (
      /^FrontPage$/i.test(component.name) &&
      /from\s+['"]\.\.\/components\/FrontPage[A-Z][A-Za-z0-9]*['"]/.test(
        component.code,
      )
    );
  }

  generateDeterministicFallbackComponent(input: {
    component: GeneratedComponent;
    plan: PlanResult;
    hasSharedHeader?: boolean;
    hasSharedFooter?: boolean;
  }): GeneratedComponent | null {
    const {
      component,
      plan,
      hasSharedHeader = false,
      hasSharedFooter = false,
    } = input;
    const componentPlan = plan.find(
      (item) => item.componentName === component.name,
    );
    const effectivePlan = this.stripSharedLayoutSectionsFromPlan(
      componentPlan,
      hasSharedHeader,
      hasSharedFooter,
    );
    if (!effectivePlan?.visualPlan) {
      return null;
    }

    const synchronizedVisualPlan = synchronizeVisualPlanContract(
      effectivePlan.visualPlan,
      effectivePlan,
    );
    if (!synchronizedVisualPlan) {
      return null;
    }

    const code = this.codeGenerator.generate(synchronizedVisualPlan);
    const requiredCustomClassNames = this.collectCustomClassNamesFromBlockTree(
      synchronizedVisualPlan.blockTree ?? [],
    );
    return this.attachPlanContext(
      {
        ...component,
        code,
        visualPlan: synchronizedVisualPlan,
      },
      effectivePlan,
      {
        generationMode: 'deterministic',
        requiredCustomClassNames,
      },
    );
  }

  // ── Section splitting ──────────────────────────────────────────────────────

  /**
   * Split top-level WpNode[] into chunks of approximately targetChars each.
   * Splits only at top-level node boundaries — never mid-node.
   */
  private splitTemplateSections(
    nodes: WpNode[],
    targetChars: number,
  ): WpNode[][] {
    const chunks: WpNode[][] = [];
    let current: WpNode[] = [];
    let currentLen = 0;

    for (const node of nodes) {
      const nodeLen = JSON.stringify(node).length;

      if (current.length > 0 && currentLen + nodeLen > targetChars) {
        chunks.push(current);
        current = [];
        currentLen = 0;
      }

      current.push(node);
      currentLen += nodeLen;
    }

    if (current.length > 0) chunks.push(current);

    // Defensive: if everything fits in one chunk, force split in half
    if (chunks.length === 1) {
      const half = Math.ceil(nodes.length / 2);
      return [nodes.slice(0, half), nodes.slice(half)];
    }

    return chunks;
  }

  // ── Assembly code builder (pure, no AI) ────────────────────────────────────

  private buildAssemblyCode(
    componentName: string,
    subComponents: GeneratedComponent[],
  ): string {
    const imports = subComponents
      .map((s) => `import ${s.name} from './${s.name}';`)
      .join('\n');

    const renders = subComponents
      .map((s) => `        <${s.name} />`)
      .join('\n');

    return `import React from 'react';
${imports}

export default function ${componentName}() {
  return (
    <>
${renders}
    </>
  );
}
`;
  }

  private attachPlanContext(
    component: GeneratedComponent,
    componentPlan?: PlanResult[number],
    overrides?: Partial<GeneratedComponent>,
  ): GeneratedComponent {
    const resolvedVisualPlan = synchronizeVisualPlanContract(
      component.visualPlan ?? componentPlan?.visualPlan,
      componentPlan,
    );
    return {
      ...component,
      route: componentPlan?.route ?? component.route,
      isDetail: componentPlan?.isDetail ?? component.isDetail,
      fixedSlug: componentPlan?.fixedSlug ?? component.fixedSlug,
      runtimeRenderer:
        componentPlan?.runtimeRenderer ?? component.runtimeRenderer,
      dataNeeds: componentPlan?.dataNeeds
        ? [...componentPlan.dataNeeds]
        : component.dataNeeds,
      type: componentPlan?.type ?? component.type,
      visualPlan: resolvedVisualPlan,
      surfacePlan: component.surfacePlan ?? componentPlan?.surfacePlan,
      renderContract: component.renderContract ?? componentPlan?.renderContract,
      ...overrides,
    };
  }

  private collectCustomClassNamesFromNodes(nodes: WpNode[]): string[] {
    const result = new Set<string>();
    const visit = (node: WpNode) => {
      for (const className of node.customClassNames ?? []) {
        const normalized = className.trim();
        if (normalized) result.add(normalized);
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    return [...result];
  }

  private collectCustomClassNamesFromBlockTree(nodes: BlockNode[]): string[] {
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

  private collectCustomClassTargetsFromNodes(
    nodes: WpNode[],
  ): Record<string, ThemeInteractionTarget> {
    const targets: Record<string, ThemeInteractionTarget> = {};
    const visit = (node: WpNode) => {
      const target = inferTargetFromBlockName(node.block);
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
    for (const node of nodes) visit(node);
    return targets;
  }

  private buildApprovedPlanRepairNote(
    componentPlan?: PlanResult[number],
  ): string | undefined {
    const sections = resolvePlannerSectionBlueprint({
      visualPlan: componentPlan?.visualPlan,
      surfacePlan: componentPlan?.surfacePlan,
    });
    const blockTree =
      componentPlan?.visualPlan?.blockTree ??
      componentPlan?.surfacePlan?.sourceEvidence.blockTree ??
      [];
    const palette = componentPlan?.visualPlan?.palette;
    const typography = componentPlan?.visualPlan?.typography;
    const surfacePlan = componentPlan?.surfacePlan;
    const requiredLiterals = surfacePlan
      ? collectSurfacePlanRequiredLiterals(surfacePlan)
      : [];
    if (
      sections.length === 0 &&
      blockTree.length === 0 &&
      !surfacePlan &&
      !palette &&
      !typography
    )
      return undefined;

    const lines = sections.map((section, index) => {
      const parts = [
        `${index + 1}. ${section.type}`,
        (section.debugKey ?? section.sectionKey)
          ? `debugKey=${section.debugKey ?? section.sectionKey}`
          : null,
        section.sourceRef?.sourceNodeId
          ? `sourceNodeId=${section.sourceRef.sourceNodeId}`
          : null,
      ];

      if ('heading' in section && section.heading) {
        parts.push(`heading="${section.heading}"`);
      }
      if ('subheading' in section && section.subheading) {
        parts.push(`subheading="${section.subheading}"`);
      }
      if ('align' in section && section.align) {
        parts.push(`align="${section.align}"`);
      }
      const ctas =
        'ctas' in section &&
        Array.isArray(section.ctas) &&
        section.ctas.length > 0
          ? section.ctas
          : 'cta' in section && section.cta
            ? [section.cta]
            : [];
      if (ctas.length > 0) {
        parts.push(
          ...ctas
            .map((cta) => cta?.text?.trim())
            .filter((value): value is string => !!value)
            .map((value, ctaIndex) =>
              ctaIndex === 0
                ? `cta="${value}"`
                : `cta${ctaIndex + 1}="${value}"`,
            ),
        );
      }
      if ('image' in section && section.image?.src) {
        parts.push(`image="${section.image.src}"`);
      }
      if ('imageSrc' in section && section.imageSrc) {
        parts.push(`image="${section.imageSrc}"`);
      }
      if (
        'cards' in section &&
        Array.isArray(section.cards) &&
        section.cards.length > 0
      ) {
        parts.push(
          `cards=${section.cards
            .map((card) => card.heading || card.body)
            .filter(Boolean)
            .slice(0, 6)
            .join(' | ')}`,
        );
      }

      return parts.filter(Boolean).join(' | ');
    });

    const blocks: string[] = [];

    if (sections.length > 0) {
      blocks.push(
        'Approved planner sections that must remain present in the repaired code:',
        ...lines,
        'Do not drop sections, CTA labels, images, or card bodies from this contract.',
      );

      const interactiveTypes = new Set([
        'carousel',
        'modal',
        'tabs',
        'accordion',
      ]);
      const interactiveSections = sections.filter((s) =>
        interactiveTypes.has(s.type),
      );
      if (interactiveSections.length > 0) {
        blocks.push(
          '',
          'CRITICAL — interactive widget sections (do NOT drop, simplify, or replace with static UI):',
          ...interactiveSections.map(
            (s) =>
              `  - ${s.type}${(s.debugKey ?? s.sectionKey) ? ` (debugKey=${s.debugKey ?? s.sectionKey})` : ''} — must remain as an interactive ${s.type} component`,
          ),
        );
      }
    }

    if (surfacePlan) {
      blocks.unshift(buildSurfacePlanRepairContextNote(surfacePlan));
      if (requiredLiterals.length > 0) {
        blocks.push(
          '',
          `Restore or retain these source-backed literals when they belong to the component shell/content: ${requiredLiterals
            .slice(0, 10)
            .map((literal) => JSON.stringify(literal))
            .join(' | ')}`,
        );
      }
    }

    if (blockTree.length > 0) {
      blocks.push(
        '',
        'Preserved WordPress block tree — structural contract:',
        'Treat this block tree as the source of truth for wrapper order, group nesting, column ownership, sidebar shell placement, and template-part boundaries.',
        'Do NOT flatten it into a simpler section stack during repair.',
        ...this.summarizeBlockTreeForRepair(blockTree),
      );
    }

    if (palette) {
      const paletteLines = Object.entries(palette)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      blocks.push(
        '',
        'Visual plan palette — authoritative colors (must not be changed or hallucinated):',
        paletteLines,
      );
    }

    if (typography) {
      const typographyLines = Object.entries(typography)
        .map(([k, v]) =>
          typeof v === 'object' && v !== null
            ? `  ${k}: ${Object.entries(v)
                .map(([tk, tv]) => `${tk}=${tv}`)
                .join(' ')}`
            : `  ${k}: ${v}`,
        )
        .join('\n');
      blocks.push(
        '',
        'Visual plan typography — authoritative type scale (must not be changed):',
        typographyLines,
      );
    }

    return blocks.join('\n');
  }

  private buildVisualMetricsSafeRepairNote(
    componentPlan?: PlanResult[number],
  ): string {
    const surfacePlan = componentPlan?.surfacePlan;
    const approvedSections = resolvePlannerSectionBlueprint({
      visualPlan: componentPlan?.visualPlan,
      surfacePlan,
    });
    const lines = [
      'VISUAL METRICS SAFE MODE:',
      'This repair is ONLY for visual/UI alignment after screenshot metric diagnosis.',
      'You may adjust className, inline style, spacing, wrappers, DOM nesting for presentational fidelity, and approved interactive behavior wiring.',
      'Do NOT rewrite the component architecture from scratch.',
      'Do NOT change route binding, fetch endpoints, main data source selection, or the component data contract.',
      'Do NOT add or remove `useParams()`.',
      'Do NOT change a fixed-slug component into a dynamic-slug component, and do NOT change a dynamic-slug component into a fixed-slug component.',
      'Do NOT replace exact detail fetches with collection fetch + lookup.',
      'Do NOT add or remove primary state variables such as `page`, `post`, `pages`, `posts`, `comments`, `menus`, `footerColumns`, or `siteInfo` unless the validator feedback explicitly says one is missing.',
      'Do NOT introduce or remove top-level shared chrome such as `<header>`, `<footer>`, or global navigation in page components.',
      'Keep the existing approved data/rendering mode intact. Focus the repair on styling, layout fidelity, wrapper structure, and UI behavior only.',
    ];
    if (surfacePlan) {
      lines.push(
        `Locked planner authority: ${surfacePlan.authority.level} (${surfacePlan.kind}; pageIntent=${surfacePlan.pageIntent.kind}).`,
      );
      if (surfacePlan.acceptance.mustKeep.length > 0) {
        lines.push(
          `Keep these source-backed anchors intact: ${surfacePlan.acceptance.mustKeep
            .slice(0, 5)
            .join(' | ')}`,
        );
      }
      if (surfacePlan.acceptance.mustNotInvent.length > 0) {
        lines.push(
          `Do not invent: ${surfacePlan.acceptance.mustNotInvent
            .slice(0, 5)
            .join(' | ')}`,
        );
      }
    }
    const normalizedNeeds = new Set(componentPlan?.dataNeeds ?? []);
    const isDetailSourceBackedRoute =
      normalizedNeeds.has('pageDetail') || normalizedNeeds.has('postDetail');

    if (isDetailSourceBackedRoute) {
      const approvedSectionCount = approvedSections.length;
      lines.push(
        'DETAIL ROUTE GUARDRAIL: this is a source-backed detail route. Preserve the approved/source-backed section structure instead of improvising new page composition.',
      );
      lines.push(
        'Do NOT add, remove, merge, split, or reorder major sections unless the feedback explicitly identifies a missing approved/source-backed section that must be restored.',
      );
      lines.push(
        'Do NOT rewrite source-backed body copy into new summaries, marketing prose, or synthetic filler. Keep section content bound to the approved source-backed content.',
      );
      if (componentPlan?.visualPlan?.blockTree?.length) {
        lines.push(
          'Do NOT alter preserved block-tree shell hierarchy on this detail route. Metrics repair may adjust spacing, sizing, and styling, but must not rewrite wrapper order, columns, or sidebar ownership.',
        );
      }
      if (approvedSectionCount > 0) {
        lines.push(
          `Expected section coverage remains locked to the approved plan (${approvedSectionCount} section(s)). Visual repair must refine the existing section shells rather than collapsing the page into a different structure.`,
        );
      }
    }

    if (componentPlan?.route) {
      lines.push(`Locked route contract: ${componentPlan.route}`);
    }
    if (componentPlan?.fixedSlug) {
      lines.push(`Locked fixed slug: ${componentPlan.fixedSlug}`);
    }
    if (componentPlan?.dataNeeds?.length) {
      lines.push(`Locked data needs: ${componentPlan.dataNeeds.join(', ')}`);
    }

    return lines.join('\n');
  }

  private summarizeBlockTreeForRepair(
    nodes: ReadonlyArray<BlockNode>,
    depth = 0,
    lines: string[] = [],
    limit = 12,
  ): string[] {
    for (const node of nodes) {
      if (lines.length >= limit) break;
      lines.push(
        [
          `${'  '.repeat(depth)}- ${node.kind}`,
          node.sourceRef?.sourceNodeId
            ? `sourceNodeId=${node.sourceRef.sourceNodeId}`
            : null,
          node.templatePartSlug
            ? `templatePart=${node.templatePartSlug}`
            : null,
          node.columnWidth ? `columnWidth=${node.columnWidth}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      );
      if (node.children?.length && lines.length < limit) {
        this.summarizeBlockTreeForRepair(
          node.children,
          depth + 1,
          lines,
          limit,
        );
      }
    }
    if (depth === 0 && lines.length >= limit) {
      lines.push('- ...');
    }
    return lines;
  }

  private buildEditRequestSafeRepairNote(
    componentPlan?: PlanResult[number],
  ): string {
    const lines = [
      'EDIT REQUEST SAFE MODE:',
      'This repair is applying an approved user edit or a follow-up refinement for that approved edit.',
      'The user-requested local change is PRIMARY. Modify the exact target region or matched local section first.',
      'Preserve unrelated sections, sibling regions, and surrounding component structure unless the request explicitly says to expand the change.',
      'Do NOT rewrite the entire component from scratch unless the feedback explicitly allows a broader rewrite.',
      'Do NOT change route binding, fetch endpoints, main data source selection, or the component data contract.',
      'Do NOT add or remove `useParams()` unless the validator feedback explicitly requires it.',
      'Do NOT replace exact detail fetches with collection fetch + lookup.',
      'Do NOT add or remove top-level shared chrome such as `<header>`, `<footer>`, or global navigation in page components.',
      'Do NOT move a local style/content change up to the outer section/container when the target evidence points to a child element like a button, heading, paragraph, card, or media node.',
      'Prefer targeted presentation/content edits over broad restructuring.',
    ];

    if (componentPlan?.route) {
      lines.push(`Locked route contract: ${componentPlan.route}`);
    }
    if (componentPlan?.fixedSlug) {
      lines.push(`Locked fixed slug: ${componentPlan.fixedSlug}`);
    }
    if (componentPlan?.dataNeeds?.length) {
      lines.push(`Locked data needs: ${componentPlan.dataNeeds.join(', ')}`);
    }

    return lines.join('\n');
  }

  private buildHardRegenerationRepairNote(
    feedback: string,
    componentPlan?: PlanResult[number],
  ): string | undefined {
    if (!this.shouldForceFullRegenerationFromFeedback(feedback)) {
      return undefined;
    }

    const sectionCount = resolvePlannerSectionBlueprint({
      visualPlan: componentPlan?.visualPlan,
      surfacePlan: componentPlan?.surfacePlan,
    }).length;
    const surfacePlan = componentPlan?.surfacePlan;
    const requiredLiterals = surfacePlan
      ? collectSurfacePlanRequiredLiterals(surfacePlan)
      : [];
    const lines = [
      'HARD REGENERATION MODE:',
      'The current component failed section coverage or planner-contract fidelity.',
      'The current component failed its surface-plan / visual-plan obligations or contract fidelity.',
      'Do NOT patch only a small fragment of the broken code.',
      'Rewrite the full component from scratch so it matches the approved planner contract again.',
      'Render every planned section in the original order.',
      'Do not keep a shortened skeleton that only preserves the first few sections.',
    ];
    if (surfacePlan) {
      lines.push(
        `Planner authority remains locked to ${surfacePlan.authority.level} (${surfacePlan.kind}; pageIntent=${surfacePlan.pageIntent.kind}).`,
      );
    }
    if (sectionCount > 0) {
      lines.push(
        `Minimum expectation: restore all ${sectionCount} approved planned section(s), unless a section is explicitly untracked canonical body content in the contract.`,
      );
    }
    if (requiredLiterals.length > 0) {
      lines.push(
        `Restore these source-backed literals where applicable: ${requiredLiterals
          .slice(0, 8)
          .map((literal) => JSON.stringify(literal))
          .join(' | ')}`,
      );
    }
    lines.push(
      'If the existing code conflicts with the approved plan, prefer the planner-owned surface plan first, then the execution-level visual plan, and rewrite the structure accordingly.',
    );

    return lines.join('\n');
  }

  private shouldForceFullRegenerationFromFeedback(feedback: string): boolean {
    const normalized = feedback.toLowerCase();
    return (
      normalized.includes('visual plan obligations violated') ||
      normalized.includes('surface-plan source evidence violated') ||
      normalized.includes('required capability') ||
      normalized.includes('obligation "') ||
      normalized.includes('sectionaudit:') ||
      normalized.includes('rootcause=route-mapping-error') ||
      normalized.includes('rootcause=data-binding-error') ||
      normalized.includes('exact bound record via') ||
      normalized.includes('must not include their own <header> tag') ||
      normalized.includes(
        'must not render their own shared site `<header>` chrome',
      ) ||
      normalized.includes(
        'must not render their own shared site `<footer>` chrome',
      )
    );
  }

  private buildComponentContractRepairNote(
    componentPlan?: PlanResult[number],
  ): string | undefined {
    if (!componentPlan) return undefined;

    const surfacePlan = componentPlan.surfacePlan;
    const lines: string[] = [
      'Approved component contract — MUST remain true after the repair:',
      `- componentType=${componentPlan.type}`,
      `- route=${componentPlan.route ?? 'unknown'}`,
      `- isDetail=${componentPlan.isDetail === true ? 'yes' : 'no'}`,
    ];

    if (componentPlan.fixedSlug) {
      lines.push(`- fixedSlug=${componentPlan.fixedSlug}`);
    }
    if (componentPlan.dataNeeds?.length) {
      lines.push(`- dataNeeds=${componentPlan.dataNeeds.join(', ')}`);
    }
    if (surfacePlan) {
      lines.push(`- plannerKind=${surfacePlan.kind}`);
      lines.push(`- plannerAuthority=${surfacePlan.authority.level}`);
      lines.push(`- pageIntent=${surfacePlan.pageIntent.kind}`);
      lines.push(
        `- sharedChromeOwnership=${surfacePlan.contract.sharedChromeOwnership}`,
      );
      if (surfacePlan.acceptance.mustNotInvent.length > 0) {
        lines.push(
          `- mustNotInvent=${surfacePlan.acceptance.mustNotInvent
            .slice(0, 6)
            .join(' | ')}`,
        );
      }
    }

    if (componentPlan.type === 'page') {
      lines.push(
        '- This is a PAGE component. Do NOT render your own top-level `<header>`, `<footer>`, or site navigation chrome. The shared Layout wrapper already provides global navigation and footer.',
      );
    }

    const normalizedNeeds = new Set(componentPlan.dataNeeds ?? []);
    const fixedSlug = componentPlan.fixedSlug?.trim();

    if (normalizedNeeds.has('pageDetail')) {
      if (fixedSlug) {
        lines.push(
          `- Fetch the main record ONLY from \`/api/pages/${fixedSlug}\`. Do NOT use \`useParams()\` for the main record, do NOT use \`/api/pages/\${slug}\`, and do NOT fetch \`/api/pages\` for a lookup.`,
        );
      } else {
        lines.push(
          componentPlan.runtimeRenderer === 'runtime-page'
            ? '- Fetch the main record from `/api/runtime/pages/${slug}`. Do NOT replace it with `/api/pages/${slug}` and do NOT replace it with `/api/pages` + lookup.'
            : '- Fetch the main record from `/api/pages/${slug}` (or equivalent string concatenation with `slug`). Do NOT replace it with `/api/pages` + lookup.',
        );
      }
    }

    if (normalizedNeeds.has('postDetail')) {
      if (fixedSlug) {
        lines.push(
          `- Fetch the main record ONLY from \`/api/posts/${fixedSlug}\`. Do NOT use \`useParams()\` for the main record, do NOT use \`/api/posts/\${slug}\`, and do NOT fetch \`/api/posts\` for a lookup.`,
        );
      } else {
        lines.push(
          '- Fetch the main record from `/api/posts/${slug}` (or equivalent string concatenation with `slug`). Do NOT replace it with `/api/posts` + lookup.',
        );
      }
    }

    if (normalizedNeeds.has('comments')) {
      if (fixedSlug) {
        lines.push(
          `- If comments are rendered for this fixed-bound detail view, use the bound slug \`${fixedSlug}\` consistently for comment fetch/submission endpoints as well.`,
        );
      } else if (componentPlan.isDetail) {
        lines.push(
          '- If comments are rendered for this detail view, keep the comments slug binding consistent with the main detail slug.',
        );
      }
    }

    lines.push(
      '- If JSX references a collection/state variable such as `posts`, `pages`, `comments`, or `footerColumns`, ensure the matching `useState(...)` declaration and fetch assignment exist in the component before returning code.',
    );

    return lines.join('\n');
  }

  private restoreTrackedSectionMarkers(
    code: string,
    _componentName: string,
    _componentPlan?: PlanResult[number],
  ): { code: string; restoredSectionKeys: string[] } {
    return { code, restoredSectionKeys: [] };
  }

  private findTopLevelSectionAnchors(
    code: string,
    expectedCount: number,
  ): Array<{ start: number; end: number; raw: string }> {
    const returnMatch = /return\s*\(/m.exec(code);
    if (!returnMatch) return [];

    const openParenIndex = returnMatch.index + returnMatch[0].length - 1;
    const closeParenIndex = this.findMatchingParen(code, openParenIndex);
    if (closeParenIndex === -1) return [];

    const bodyStart = openParenIndex + 1;
    const body = code.slice(bodyStart, closeParenIndex);
    const tagPattern =
      /<>|<\/>|<\/([A-Za-z][\w.:-]*)\s*>|<([A-Za-z][\w.:-]*)\b[^>]*\/?>/g;
    const stack: Array<{ name: string; kind: 'fragment' | 'element' }> = [];
    const anchors: Array<{ start: number; end: number; raw: string }> = [];
    let rootKind: 'fragment' | 'element' | null = null;

    for (const match of body.matchAll(tagPattern)) {
      const raw = match[0];
      const localStart = match.index ?? -1;
      if (localStart < 0) continue;
      const absoluteStart = bodyStart + localStart;
      const absoluteEnd = absoluteStart + raw.length;

      if (raw === '<>') {
        if (!rootKind) rootKind = 'fragment';
        stack.push({ name: '', kind: 'fragment' });
        continue;
      }

      if (raw === '</>') {
        while (stack.length > 0) {
          const last = stack.pop();
          if (last?.kind === 'fragment') break;
        }
        continue;
      }

      if (raw.startsWith('</')) {
        const closingName = match[1] ?? '';
        while (stack.length > 0) {
          const last = stack.pop();
          if (last?.kind === 'element' && last.name === closingName) break;
        }
        continue;
      }

      const tagName = match[2] ?? '';
      const isSelfClosing = /\/>\s*$/.test(raw);
      const isSectionCandidate =
        /^(section|header|footer|main|article|aside|nav|div)$/i.test(tagName);
      const parentDepth = stack.length;

      if (!rootKind) {
        rootKind = 'element';
        if (expectedCount === 1 && isSectionCandidate) {
          anchors.push({ start: absoluteStart, end: absoluteEnd, raw });
        }
      } else if (
        isSectionCandidate &&
        ((rootKind === 'fragment' && parentDepth === 1) ||
          (rootKind === 'element' && parentDepth === 1))
      ) {
        anchors.push({ start: absoluteStart, end: absoluteEnd, raw });
      }

      if (!isSelfClosing) {
        stack.push({ name: tagName, kind: 'element' });
      }
      if (anchors.length >= expectedCount) break;
    }

    return anchors;
  }

  private findMatchingParen(source: string, openParenIndex: number): number {
    let depth = 0;
    let quote: "'" | '"' | '`' | null = null;
    let escaped = false;

    for (let index = openParenIndex; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "'" || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }

    return -1;
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

  private shouldUseBlockFaithfulSharedPartial(
    componentName: string,
    componentPlan: PlanResult[number] | undefined,
    nodes: WpNode[] | undefined,
  ): boolean {
    const isSharedPartial = componentPlan?.type === 'partial';
    const isHeaderPartial = isSharedPartial && /^header/i.test(componentName);
    const isFooterPartial = isSharedPartial && /^footer/i.test(componentName);
    if (
      componentPlan?.visualPlan?.deterministicAuthority &&
      !isHeaderPartial &&
      !isFooterPartial
    ) {
      return false;
    }
    // Shared chrome is more stable when we preserve the original WordPress
    // wrapper/column/navigation tree directly instead of letting AI restyle it.
    // Header/Footer specifically benefit from block-faithful rendering because
    // theme-specific spacing, wrapper hierarchy, CTA groups, and auxiliary
    // assets/hooks are highly dependent on the original block structure.
    return !!(
      (isHeaderPartial || isFooterPartial) &&
      nodes &&
      nodes.length > 0
    );
  }

  private inferBlockFaithfulDataNeeds(
    componentName: string,
    componentPlan: PlanResult[number] | undefined,
    nodes: WpNode[],
  ): string[] {
    const needs = new Set(componentPlan?.dataNeeds ?? []);
    let hasSiteInfoEvidence = false;
    let hasFooterLinkEvidence = false;
    const visit = (node: WpNode) => {
      const block = node.block.replace(/^core\//, '');
      if (['site-title', 'site-tagline', 'site-logo'].includes(block)) {
        hasSiteInfoEvidence = true;
        needs.add('siteInfo');
      }
      if (block === 'navigation') {
        if (/^footer/i.test(componentName)) hasFooterLinkEvidence = true;
        else needs.add('menus');
      }
      if (
        /^footer/i.test(componentName) &&
        ['page-list', 'pages', 'latest-posts'].includes(block)
      ) {
        hasFooterLinkEvidence = true;
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    if (/^header/i.test(componentName) || hasSiteInfoEvidence) {
      needs.add('siteInfo');
    }
    if (/^footer/i.test(componentName)) {
      if (hasFooterLinkEvidence) needs.add('footerLinks');
      else needs.delete('footerLinks');
      if (!hasSiteInfoEvidence) needs.delete('siteInfo');
      needs.delete('menus');
    }
    return Array.from(needs);
  }

  // ── File logger ────────────────────────────────────────────────────────────

  private async logToFile(
    logPath: string | undefined,
    message: string,
  ): Promise<void> {
    if (!logPath || logPath.endsWith('.json')) return;
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // don't crash pipeline if logging fails
    }
  }

  private toComponentName(templateName: string): string {
    const name = templateName
      .replace(/\.(php|html)$/, '')
      .split(/[\\/_-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    return /^\d/.test(name) ? `Page${name}` : name;
  }

  private looksLikeBlockMarkup(source: string): boolean {
    return source.includes('<!-- wp:');
  }

  async persistDraftComponents(
    jobId: string,
    components: GeneratedComponent[],
  ): Promise<void> {
    const draftRoot = join('temp', 'generated', jobId, 'draft', 'src');
    const pagesDir = join(draftRoot, 'pages');
    const componentsDir = join(draftRoot, 'components');

    await mkdir(pagesDir, { recursive: true });
    await mkdir(componentsDir, { recursive: true });

    await Promise.all(
      components.map(async (component) => {
        const isPartial =
          component.type === 'partial' ||
          component.isSubComponent === true ||
          isPartialComponentName(component.name);
        const targetDir = isPartial ? componentsDir : pagesDir;
        await writeFile(
          join(targetDir, `${component.name}.tsx`),
          component.code,
          'utf-8',
        );
      }),
    );
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
