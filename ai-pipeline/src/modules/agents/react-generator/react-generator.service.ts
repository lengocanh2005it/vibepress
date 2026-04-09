import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import { BlockParseResult } from '../block-parser/block-parser.service.js';
import { buildPlanPrompt } from './prompts/plan.prompt.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import {
  wpBlocksToJson,
  wpJsonToString,
} from '../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../common/utils/wp-block-to-json.js';
import { StyleResolverService } from '../../../common/style-resolver/style-resolver.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import { getComponentStrategy } from '../component-strategy.registry.js';

// Classic templates can stay on the normal single-component path up to this size.
const CLASSIC_CHUNK_THRESHOLD_CHARS = 40_000;
// FSE templates benefit from direct block-tree prompting, so allow larger inputs
// before splitting into section components.
const FSE_CHUNK_THRESHOLD_CHARS = 80_000;
// Target size per section chunk
const CHUNK_TARGET_CHARS = 15_000;
// Component names matching these patterns are placed in src/components (partials), not src/pages
const PARTIAL_PATTERNS =
  /^(Header|Footer|Sidebar|Nav|Breadcrumb|Widget|Part[A-Z])/i;

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

    if (!existingTemplateNames.has('author')) {
      templates.push(
        createFallbackTemplate(
          'author',
          '<div><!-- Author template fallback --></div>',
        ),
      );
    }
    if (!existingTemplateNames.has('category')) {
      templates.push(
        createFallbackTemplate(
          'category',
          '<div><!-- Category template fallback --></div>',
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

    const total = templates.length;
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
      batchStart < templates.length;
      batchStart += concurrency
    ) {
      if (batchStart > 0) {
        await this.logToFile(logPath, `Rate-limit delay: ${delay / 1000}s`);
        await new Promise((res) => setTimeout(res, delay));
      }

      const batch = templates.slice(batchStart, batchStart + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (tpl, batchIdx) => {
          const i = batchStart + batchIdx;
          const componentName = this.toComponentName(tpl.name);
          const rawSource = (tpl.markup ?? tpl.html ?? '') as string;
          const counter = `[${i + 1}/${total}]`;
          const rawComponentPlan = plan?.find(
            (p) =>
              p.templateName === tpl.name || p.componentName === componentName,
          );
          const componentPlan = this.stripSharedLayoutSectionsFromPlan(
            rawComponentPlan,
            hasSharedHeader,
            hasSharedFooter,
          );
          const folder =
            componentPlan?.type === 'partial'
              ? 'src/components'
              : componentPlan?.type === 'page'
                ? 'src/pages'
                : PARTIAL_PATTERNS.test(componentName)
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
      repoManifest,
      logPath,
      jobId,
    } = input;

    const templateSource = rawSource;
    const templateNodes =
      themeType === 'fse' && this.looksLikeBlockMarkup(templateSource)
        ? this.styleResolver.resolve(wpBlocksToJson(templateSource), tokens)
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
    // (siteInfo, menus) from the plan — otherwise CodeGeneratorService will
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
            (n) => n !== 'siteInfo' && n !== 'menus',
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
  }): Promise<GeneratedComponent> {
    const { component, plan, feedback, modelConfig, logPath } = input;
    const componentPlan = plan.find((p) => p.componentName === component.name);
    const fixAgentModel = modelConfig?.fixAgent ?? this.llmFactory.getModel();

    this.logger.log(
      `[fixer] Auto-fixing component "${component.name}" based on review feedback`,
    );
    await this.logToFile(
      logPath,
      `[fixer] Auto-fixing component "${component.name}" based on review feedback: ${feedback}`,
    );

    const fixedCode = await this.codeReviewer.selfFix(
      fixAgentModel,
      component.code,
      feedback,
      logPath,
      component.name,
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
      dataNeeds: componentPlan?.dataNeeds
        ? [...componentPlan.dataNeeds]
        : component.dataNeeds,
      type: componentPlan?.type ?? component.type,
      ...overrides,
    };
  }

  private shouldUseBlockFaithfulSharedPartial(
    componentName: string,
    componentPlan: PlanResult[number] | undefined,
    nodes: WpNode[] | undefined,
  ): boolean {
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
        needs.add('menus');
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of nodes) visit(node);
    if (/^(header|footer)/i.test(componentName)) {
      needs.add('siteInfo');
    }
    return Array.from(needs);
  }

  // ── File logger ────────────────────────────────────────────────────────────

  private async logToFile(
    logPath: string | undefined,
    message: string,
  ): Promise<void> {
    if (!logPath) return;
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
          PARTIAL_PATTERNS.test(component.name);
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
