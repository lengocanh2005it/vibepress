import { Inject, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { appendFile } from 'fs/promises';
import { MISTRAL_CLIENT } from '../../../common/providers/mistral/mistral.provider.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import { BlockParseResult } from '../block-parser/block-parser.service.js';
import {
  buildComponentPrompt,
  buildSectionPrompt,
} from './prompts/component.prompt.js';
import { buildPlanPrompt } from './prompts/plan.prompt.js';
import {
  wpBlocksToJson,
  wpJsonToString,
} from '../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../common/utils/wp-block-to-json.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';

export interface GeneratedComponent {
  name: string;
  filePath: string;
  code: string;
  // When true, preview-builder must NOT create a route for this component.
  // Sub-components are assembled into their parent; they are not standalone pages.
  isSubComponent?: boolean;
}

export interface ReactGenerateResult {
  jobId?: string;
  components: GeneratedComponent[];
  outDir: string;
}

// Keep in sync with PARTIAL_PATTERNS in preview-builder.service.ts
const PARTIAL_PATTERNS =
  /^(header|footer|sidebar|nav|navigation|searchform|comments|comment|postmeta|post-meta|widget|breadcrumb|pagination|loop|content-none|no-results|functions)/i;

// Threshold: if serialised template JSON exceeds this, use section chunking.
const CHUNK_THRESHOLD_CHARS = 12_000;

// Target size per chunk in chars (serialised JSON of WpNode[]).
const CHUNK_TARGET_CHARS = 6_000;

@Injectable()
export class ReactGeneratorService {
  private readonly logger = new Logger(ReactGeneratorService.name);

  private readonly tokenTracker = new TokenTracker();

  constructor(
    @Inject(MISTRAL_CLIENT) private readonly mistral: OpenAI,
    private readonly configService: ConfigService,
  ) {}

  // ── Public entry point ─────────────────────────────────────────────────────

  async generate(input: {
    theme: PhpParseResult | BlockParseResult;
    content: DbContentResult;
    jobId?: string;
    logPath?: string;
  }): Promise<ReactGenerateResult> {
    const { theme, content, jobId = 'unknown', logPath } = input;

    this.logger.log(`Generating React components for job: ${jobId}`);

    if (logPath) {
      const tokenLogPath = logPath.replace(/\.log$/, '.tokens.log');
      await this.tokenTracker.init(tokenLogPath);
    }

    const modelName = this.configService.get<string>(
      'mistral.model',
      'mistral-small-latest',
    );

    const systemPrompt = buildPlanPrompt(theme, content);
    const tokens = theme.type === 'fse' ? theme.tokens : undefined;

    const pagesCount = theme.templates.length;
    const partialsCount = theme.type === 'fse' ? theme.parts.length : 0;

    const templates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];

    const total = templates.length;
    const components: GeneratedComponent[] = [];

    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i];
      const componentName = this.toComponentName(tpl.name);
      const rawSource = 'markup' in tpl ? tpl.markup : tpl.html;
      const counter = `[${i + 1}/${total}]`;
      const folder = PARTIAL_PATTERNS.test(componentName)
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
        modelName,
        systemPrompt,
        content,
        tokens,
        themeType: theme.type,
        logPath,
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
    modelName: string;
    systemPrompt: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    themeType: 'classic' | 'fse';
    logPath?: string;
  }): Promise<GeneratedComponent[]> {
    const {
      componentName,
      rawSource,
      modelName,
      systemPrompt,
      content,
      tokens,
      themeType,
      logPath,
    } = input;

    // Classic PHP themes: use raw stripped HTML — wpBlocksToJson only understands wp: block comments
    const isClassic = themeType === 'classic';
    const nodes = isClassic ? [] : wpBlocksToJson(rawSource);
    const templateSource = isClassic ? rawSource : wpJsonToString(nodes);

    if (isClassic || templateSource.length <= CHUNK_THRESHOLD_CHARS) {
      const comp = await this.generateSingle({
        componentName,
        templateSource,
        modelName,
        systemPrompt,
        content,
        tokens,
        logPath,
      });
      return [comp];
    }

    // Too large → split into sections (FSE only)
    this.logger.warn(
      `Template ${componentName}: ${templateSource.length} chars > ${CHUNK_THRESHOLD_CHARS} → splitting into sections`,
    );
    await this.logToFile(
      logPath,
      `WARN "${componentName}" too large (${templateSource.length} chars) → splitting into ${this.splitTemplateSections(nodes, CHUNK_TARGET_CHARS).length} sections`,
    );

    const chunks = this.splitTemplateSections(nodes, CHUNK_TARGET_CHARS);
    this.logger.log(`Template ${componentName}: ${chunks.length} sections`);

    const subComponents: GeneratedComponent[] = [];
    const delay =
      this.configService.get<number>('reactGenerator.delayBetweenComponents') ??
      5000;

    for (let i = 0; i < chunks.length; i++) {
      const sectionName = `${componentName}Section${i + 1}`;
      const nodesJson = wpJsonToString(chunks[i]);

      const section = await this.generateSection({
        sectionName,
        parentName: componentName,
        sectionIndex: i,
        totalSections: chunks.length,
        nodesJson,
        modelName,
        siteInfo: content.siteInfo,
        menus: content.menus,
        tokens,
        content,
        logPath,
      });

      subComponents.push(section);

      if (i < chunks.length - 1) {
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    const assemblyCode = this.buildAssemblyCode(componentName, subComponents);
    return [
      { name: componentName, filePath: '', code: assemblyCode },
      ...subComponents,
    ];
  }

  // ── Single-component generation ────────────────────────────────────────────

  private async generateSingle(input: {
    componentName: string;
    templateSource: string;
    modelName: string;
    systemPrompt: string;
    content: DbContentResult;
    tokens?: ThemeTokens;
    logPath?: string;
  }): Promise<GeneratedComponent> {
    const {
      componentName,
      templateSource,
      modelName,
      systemPrompt,
      content,
      tokens,
      logPath,
    } = input;

    let code = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await this.generateWithRetry(
        modelName,
        systemPrompt,
        buildComponentPrompt(
          componentName,
          templateSource,
          content.siteInfo,
          content,
          tokens,
        ),
        5,
        logPath,
        componentName,
      );
      code = this.stripMarkdownFences(raw);
      if (this.isBraceBalanced(code)) break;
      this.logger.warn(
        `Component ${componentName} has unbalanced braces (attempt ${attempt}/3), retrying...`,
      );
      await this.logToFile(
        logPath,
        `WARN "${componentName}" unbalanced braces — retry ${attempt}/3`,
      );
    }

    return { name: componentName, filePath: '', code };
  }

  // ── Section generation — one AI call per chunk ────────────────────────────

  private async generateSection(input: {
    sectionName: string;
    parentName: string;
    sectionIndex: number;
    totalSections: number;
    nodesJson: string;
    modelName: string;
    siteInfo: DbContentResult['siteInfo'];
    menus: DbContentResult['menus'];
    tokens?: ThemeTokens;
    content?: DbContentResult;
    logPath?: string;
  }): Promise<GeneratedComponent> {
    const {
      sectionName,
      parentName,
      sectionIndex,
      totalSections,
      nodesJson,
      modelName,
      siteInfo,
      menus,
      tokens,
      content,
      logPath,
    } = input;

    const userPrompt = buildSectionPrompt({
      sectionName,
      parentName,
      sectionIndex,
      totalSections,
      nodesJson,
      siteInfo,
      menus,
      tokens,
      content,
    });

    let code = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      // No system prompt for sections — the user prompt is fully self-contained
      const raw = await this.generateWithRetry(
        modelName,
        '',
        userPrompt,
        5,
        logPath,
        sectionName,
      );
      code = this.stripMarkdownFences(raw);
      if (this.isBraceBalanced(code)) break;
      this.logger.warn(
        `Section ${sectionName} has unbalanced braces (attempt ${attempt}/3), retrying...`,
      );
      await this.logToFile(
        logPath,
        `WARN "${sectionName}" unbalanced braces — retry ${attempt}/3`,
      );
    }

    return { name: sectionName, filePath: '', code, isSubComponent: true };
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

  // ── Shared helpers ─────────────────────────────────────────────────────────

  private async generateWithRetry(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxRetries = 5,
    logPath?: string,
    label?: string,
  ): Promise<string> {
    let delay = 30000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        if (systemPrompt)
          messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: userPrompt });

        const response = await this.mistral.chat.completions.create({
          model,
          max_tokens: 8192,
          temperature: 0.3,
          messages,
        });

        const usage = response.usage;
        await this.tokenTracker.track(
          model,
          usage?.prompt_tokens ?? 0,
          usage?.completion_tokens ?? 0,
          label,
        );

        return response.choices[0]?.message?.content ?? '';
      } catch (err: any) {
        const isRateLimit = err?.status === 429;
        const isTimeout =
          err?.name === 'APIConnectionTimeoutError' ||
          err?.name === 'APIConnectionError';
        if ((isRateLimit || isTimeout) && attempt < maxRetries) {
          const reason = isTimeout ? 'Timeout' : 'Rate limit';
          const msg = `${reason}, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`;
          this.logger.warn(msg);
          await this.logToFile(logPath, `WARN ${msg}`);
          await new Promise((res) => setTimeout(res, delay));
          delay = Math.min(delay * 2, 120000);
        } else {
          throw err;
        }
      }
    }
    return '';
  }

  private isBraceBalanced(code: string): boolean {
    let depth = 0;
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    return depth === 0;
  }

  private stripMarkdownFences(code: string): string {
    let result = code
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();

    // Strip preamble: everything before the first real code line
    const codeStart = result.search(
      /^(import |export |const |function |\/\/|\/\*)/m,
    );
    if (codeStart > 0) {
      result = result.slice(codeStart).trim();
    }

    // Strip postamble: use brace depth to find the real end of the component.
    // Walk from the last `export default` forward, track { } depth.
    // Everything after the closing `}` (depth back to 0) is explanation text.
    const lastExportIdx = result.lastIndexOf('\nexport default ');
    if (lastExportIdx !== -1) {
      const exportSlice = result.slice(lastExportIdx);

      if (/function|=>|\{/.test(exportSlice)) {
        // Function/arrow component: find closing brace via depth tracking
        let depth = 0;
        let opened = false;
        let endIdx = result.length;

        for (let i = lastExportIdx; i < result.length; i++) {
          const ch = result[i];
          if (ch === '{') {
            depth++;
            opened = true;
          } else if (ch === '}') {
            depth--;
            if (opened && depth === 0) {
              endIdx = i + 1;
              break;
            }
          }
        }

        result = result.slice(0, endIdx).trimEnd();
      } else {
        // Simple identifier re-export: cut at semicolon
        const semiIdx = result.indexOf(';', lastExportIdx);
        if (semiIdx !== -1) {
          result = result.slice(0, semiIdx + 1).trimEnd();
        }
      }
    }

    return result;
  }

  private toComponentName(templateName: string): string {
    const name = templateName
      .replace(/\.(php|html)$/, '')
      .split(/[-_]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    return /^\d/.test(name) ? `Page${name}` : name;
  }
}
