import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendFile } from 'fs/promises';
import { AiLoggerService } from '../../ai-logger/ai-logger.service.js';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import { BlockParseResult } from '../block-parser/block-parser.service.js';
import { buildPlanPrompt } from './prompts/plan.prompt.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import {
  wpBlocksToJson,
  wpJsonToString,
} from '../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../common/utils/wp-block-to-json.js';
import { StyleResolverService } from '../../../common/style-resolver/style-resolver.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';

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
}

export interface ReactGenerateResult {
  jobId?: string;
  components: GeneratedComponent[];
  outDir: string;
}

@Injectable()
export class ReactGeneratorService {
  private readonly logger = new Logger(ReactGeneratorService.name);
  private readonly tokenTracker = new TokenTracker();

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    private readonly styleResolver: StyleResolverService,
    private readonly codeReviewer: CodeReviewerService,
    private readonly aiLogger: AiLoggerService,
  ) {}

  // ── Public entry point ─────────────────────────────────────────────────────

  async generate(input: {
    theme: PhpParseResult | BlockParseResult;
    content: DbContentResult;
    plan?: PlanResult;
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
      jobId = 'unknown',
      logPath,
      modelConfig,
    } = input;

    this.logger.log(`Generating React components for job: ${jobId}`);

    if (logPath) {
      const tokenLogPath = logPath.replace(/\.log$/, '.tokens.log');
      await this.tokenTracker.init(tokenLogPath);
    }

    const defaultModel = this.llmFactory.getModel();
    const codeGeneratorModel = modelConfig?.codeGenerator ?? defaultModel;
    const reviewCodeModel = modelConfig?.reviewCode ?? codeGeneratorModel;
    const fixAgentModel = modelConfig?.fixAgent ?? reviewCodeModel;

    const systemPrompt = buildPlanPrompt(theme, content);
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

    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i];
      const componentName = this.toComponentName(tpl.name);
      const rawSource = (tpl.markup ?? tpl.html ?? '') as string;
      const counter = `[${i + 1}/${total}]`;
      const rawComponentPlan = plan?.find(
        (p) => p.templateName === tpl.name || p.componentName === componentName,
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

      components.push(...produced);

      if (i < templates.length - 1) {
        const delay =
          this.configService.get<number>(
            'reactGenerator.delayBetweenComponents',
          ) ?? 5000;
        await this.logToFile(logPath, `Rate-limit delay: ${delay / 1000}s`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    const breakdown =
      partialsCount > 0
        ? `${pagesCount} pages, ${partialsCount} partials`
        : `${pagesCount} templates`;
    const summary = `All ${total} done — ${components.length} components (${breakdown})`;
    this.logger.log(summary);
    await this.logToFile(logPath, summary);

    await this.tokenTracker.writeSummary();

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
      logPath,
      jobId,
    } = input;

    const templateSource = rawSource;
    const templateNodes =
      themeType === 'fse'
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

    const promptTemplateSource = filteredNodes
      ? wpJsonToString(filteredNodes)
      : templateSource;
    const promptSourceLength = promptTemplateSource.length;
    const chunkThreshold =
      themeType === 'fse'
        ? FSE_CHUNK_THRESHOLD_CHARS
        : CLASSIC_CHUNK_THRESHOLD_CHARS;
    const preferDirectAi = themeType === 'fse';

    if (themeType === 'classic' || promptSourceLength <= chunkThreshold) {
      const result = await this.codeReviewer.reviewComponent({
        componentName,
        templateSource: promptTemplateSource,
        modelName: codeGeneratorModel,
        fixAgentModel,
        preferDirectAi,
        systemPrompt,
        content,
        tokens,
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

      return [this.attachPlanContext(result.component, componentPlan)];
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

    const subComponents: GeneratedComponent[] = [];
    const delay =
      this.configService.get<number>('reactGenerator.delayBetweenComponents') ??
      5000;

    for (let i = 0; i < chunks.length; i++) {
      const sectionName = `${componentName}Section${i + 1}`;
      const nodesJson = wpJsonToString(chunks[i]);

      // ── Delegate section review to CodeReviewerService ────────────────────
      const section = await this.codeReviewer.reviewSection({
        sectionName,
        parentName: componentName,
        sectionIndex: i,
        totalSections: chunks.length,
        nodesJson,
        modelName: codeGeneratorModel,
        fixAgentModel,
        preferDirectAi,
        systemPrompt,
        content,
        tokens,
        componentPlan,
        logPath,
        jobId,
      });

      subComponents.push(section);

      if (i < chunks.length - 1) {
        await new Promise((res) => setTimeout(res, delay));
      }
    }

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

    const sections = componentPlan.visualPlan.sections.filter((section) => {
      if (hasSharedHeader && section.type === 'navbar') return false;
      if (hasSharedFooter && section.type === 'footer') return false;
      return true;
    });

    if (sections.length === componentPlan.visualPlan.sections.length) {
      return componentPlan;
    }

    return {
      ...componentPlan,
      visualPlan: {
        ...componentPlan.visualPlan,
        sections,
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
}
