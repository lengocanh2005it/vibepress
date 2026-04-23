import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import type { TokenScope } from '../../../common/utils/token-tracker.js';
import type { PipelineEditRequestDto } from '../../orchestrator/orchestrator.dto.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import { BlockParseResult } from '../block-parser/block-parser.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import { buildPlanPrompt } from './prompts/plan.prompt.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import {
  wpBlocksToJsonWithSourceRefs,
  wpJsonToString,
} from '../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../common/utils/wp-block-to-json.js';
import { StyleResolverService } from '../../../common/style-resolver/style-resolver.service.js';
import type {
  ThemeInteractionTarget,
  ThemeTokens,
} from '../block-parser/block-parser.service.js';
import type { ComponentVisualPlan } from './visual-plan.schema.js';
import { getComponentStrategy } from '../component-strategy.registry.js';

// Classic templates can stay on the normal single-component path up to this size.
const CLASSIC_CHUNK_THRESHOLD_CHARS = 40_000;
// FSE templates benefit from direct block-tree prompting, so allow larger inputs
// before splitting into section components.
const FSE_CHUNK_THRESHOLD_CHARS = 80_000;
// Target size per section chunk
const CHUNK_TARGET_CHARS = 15_000;
/**
 * Returns true for top-level block nodes that represent the shared site header
 * or footer (template-part with header/footer slug, or direct header/footer blocks).
 * Page components must not render these — the Layout wrapper already does.
 */
function isSharedLayoutBlock(node: WpNode): boolean {
  if (/^(header|footer|core\/header|core\/footer)$/i.test(node.block))
    return true;
  if (
    node.block === 'template-part' &&
    /^(header|footer)/i.test(String(node.params?.slug ?? ''))
  )
    return true;
  return false;
}

export interface GeneratedComponent {
  name: string;
  filePath: string;
  code: string;
  route?: string | null;
  isDetail?: boolean;
  fixedSlug?: string;
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
  visualPlan?: ComponentVisualPlan;
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

          const t0 = Date.now();
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
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          const codeChars = produced.reduce((s, c) => s + c.code.length, 0);
          this.logger.log(
            `${counter} Done "${componentName}.tsx" — ${codeChars} chars, ${elapsed}s`,
          );
          await this.logToFile(
            logPath,
            `${counter} Done "${componentName}.tsx" — ${codeChars} chars, ${elapsed}s`,
          );
          if (jobId) {
            await this.persistDraftComponents(jobId, produced);
          }

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
        ? templateNodes.filter((node) => !isSharedLayoutBlock(node))
        : templateNodes;

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
      const requiredCustomClassNames = this.collectCustomClassNamesFromNodes(
        filteredNodes ?? [],
      );
      const requiredCustomClassTargets = this.resolveRequiredCustomClassTargets(
        requiredCustomClassNames,
        tokens,
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
    const preferDirectAi =
      themeType === 'fse' &&
      componentPlan?.type === 'partial' &&
      !getComponentStrategy(componentName).deterministicFirst;
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

    if (sections.length === componentPlan.visualPlan.sections.length) {
      return componentPlan;
    }

    // When navbar/footer are removed, also strip their exclusive data needs
    // (siteInfo, menus, footerLinks) from the plan — otherwise CodeGeneratorService will
    // still emit fetches for them and the validator will reject the component.
    const chromeRemoved =
      removedTypes.has('navbar') || removedTypes.has('footer');
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
        sections,
        dataNeeds,
      },
    };
  }

  // ── Automated Repair ────────────────────────────────────────────────────────

  async fixComponent(input: {
    component: GeneratedComponent;
    plan: PlanResult;
    feedback: string;
    modelConfig?: { fixAgent?: string };
    logPath?: string;
    fixMode?: 'full' | 'syntax-only';
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
    const isProtectedDeterministicSharedPartial =
      component.generationMode === 'deterministic' &&
      /^(Header|Footer|Navigation|Nav)$/i.test(component.name);

    if (isProtectedDeterministicSharedPartial && fixMode !== 'syntax-only') {
      this.logger.log(
        `[fixer] Skipping AI auto-fix for deterministic shared partial "${component.name}" to preserve block-faithful structure`,
      );
      await this.logToFile(
        logPath,
        `[fixer] Skipping AI auto-fix for deterministic shared partial "${component.name}" to preserve block-faithful structure. Feedback: ${feedback}`,
      );
      return this.attachPlanContext(component, componentPlan);
    }

    const effectiveFeedback =
      fixMode === 'syntax-only'
        ? `Syntax-only repair for deterministic shared partial "${component.name}". Preserve the existing block-faithful structure, layout, data flow, and markup intent. Fix only syntax / TSX structure / parser issues needed to satisfy the validator.\n\n${feedback}`
        : feedback;
    const visualPlanRepairNote = this.buildVisualPlanRepairNote(componentPlan);
    const repairFeedback = visualPlanRepairNote
      ? `${effectiveFeedback}\n\n${visualPlanRepairNote}`
      : effectiveFeedback;

    this.logger.log(
      fixMode === 'syntax-only'
        ? `[fixer] Auto-fixing syntax for protected deterministic shared partial "${component.name}"`
        : `[fixer] Auto-fixing component "${component.name}" based on review feedback`,
    );
    await this.logToFile(
      logPath,
      fixMode === 'syntax-only'
        ? `[fixer] Auto-fixing syntax for protected deterministic shared partial "${component.name}": ${repairFeedback}`
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
    return {
      ...component,
      route: componentPlan?.route ?? component.route,
      isDetail: componentPlan?.isDetail ?? component.isDetail,
      fixedSlug: componentPlan?.fixedSlug ?? component.fixedSlug,
      dataNeeds: componentPlan?.dataNeeds
        ? [...componentPlan.dataNeeds]
        : component.dataNeeds,
      type: componentPlan?.type ?? component.type,
      visualPlan: component.visualPlan ?? componentPlan?.visualPlan,
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

  private buildVisualPlanRepairNote(
    componentPlan?: PlanResult[number],
  ): string | undefined {
    const sections = componentPlan?.visualPlan?.sections ?? [];
    if (sections.length === 0) return undefined;

    const lines = sections.map((section, index) => {
      const parts = [
        `${index + 1}. ${section.type}`,
        section.sectionKey ? `sectionKey=${section.sectionKey}` : null,
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
      if ('cta' in section && section.cta?.text) {
        parts.push(`cta="${section.cta.text}"`);
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

    return [
      'Visual plan sections that must remain present in the repaired code:',
      ...lines,
      'Do not drop sections, CTA labels, images, or card bodies from this contract.',
    ].join('\n');
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

  private shouldUseBlockFaithfulSharedPartial(
    componentName: string,
    componentPlan: PlanResult[number] | undefined,
    nodes: WpNode[] | undefined,
  ): boolean {
    // Header/Footer are visually sensitive shared chrome. Let them go through
    // the AI-assisted reviewer path so layout can stay closer to the original
    // WordPress site, while validator rules still enforce the hard data contract.
    if (/^(header|footer)$/i.test(componentName)) {
      return false;
    }

    return !!(
      componentPlan?.type === 'partial' &&
      /^(header|footer)/i.test(componentName) &&
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
    const visit = (node: WpNode) => {
      const block = node.block.replace(/^core\//, '');
      if (['site-title', 'site-tagline', 'site-logo'].includes(block)) {
        needs.add('siteInfo');
      }
      if (block === 'navigation') {
        if (!/^footer/i.test(componentName)) needs.add('menus');
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    if (/^(header|footer)/i.test(componentName)) {
      needs.add('siteInfo');
    }
    if (/^footer/i.test(componentName)) {
      needs.add('footerLinks');
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

  private async persistDraftComponents(
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
