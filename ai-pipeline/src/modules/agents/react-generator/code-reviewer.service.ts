import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import {
  ValidatorService,
  type CodeValidationContext,
} from '../validator/validator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import {
  buildComponentPrompt,
  buildSectionPrompt,
  type ComponentPromptContext,
} from './prompts/component.prompt.js';
import {
  buildVisualPlanPrompt,
  extractStaticImageSources,
  parseVisualPlanDetailed,
} from './prompts/visual-plan.prompt.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type { ComponentVisualPlan } from './visual-plan.schema.js';

export interface ReviewInput {
  componentName: string;
  templateSource: string;
  modelName: string;
  /** Model for the Fix Agent (R3 repair pass). Defaults to modelName if omitted. */
  fixAgentModel?: string;
  systemPrompt: string;
  content: DbContentResult;
  tokens?: ThemeTokens;
  componentPlan?: PlanResult[number];
  logPath?: string;
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
  systemPrompt?: string;
  content: DbContentResult;
  tokens?: ThemeTokens;
  componentPlan?: PlanResult[number];
  logPath?: string;
}

export interface ReviewResult {
  component: GeneratedComponent;
  /** true when code was sourced from the deterministic plan path */
  fromVisualPlan: boolean;
  /** number of AI generation attempts used */
  attempts: number;
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
  private readonly componentSystemPrompt =
    'You are a senior React + TypeScript + Tailwind engineer. Generate a complete component from the provided migration context and return ONLY raw TSX code.';
  private readonly rawOutputDivider = '\n----- RAW OUTPUT BEGIN -----\n';

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly validator: ValidatorService,
    private readonly codeGenerator: CodeGeneratorService,
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
      systemPrompt: _systemPrompt,
      content,
      tokens,
      componentPlan,
      logPath,
    } = input;

    // MAX_ROUNDS implements R3 → D1 in the pipeline diagram:
    // after Fix Agent fails, restart from D1 (Visual Plan?) for one more round.
    const MAX_ROUNDS = 2;

    let code = '';
    let attempts = 0;
    let lastError: string | undefined;
    let promptContext = this.buildPromptContext(componentPlan);
    let validationContext = this.buildValidationContext(
      promptContext,
      componentName,
    );

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const isRetry = round > 1;

      // ── D1: Reviewed pre-computed visual plan → AI codegen first ────────────
      if (!isRetry && componentPlan?.visualPlan) {
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
          return {
            component: {
              name: componentName,
              filePath: '',
              code,
            },
            fromVisualPlan: true,
            attempts,
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
          return {
            component: {
              name: componentName,
              filePath: '',
              code: deterministic.code,
            },
            fromVisualPlan: true,
            attempts,
          };
        }
        lastError = deterministic.error ?? lastError;
        this.logger.warn(
          `[reviewer] "${componentName}" deterministic pre-computed plan failed: ${deterministic.error} — falling back to AI paths`,
        );
        await this.log(
          logPath,
          `WARN [reviewer] "${componentName}" deterministic pre-computed plan failed: ${deterministic.error} — falling back to AI paths`,
        );
      }

      // ── D2: AI visual plan → AI codegen ─────────────────────────────────────
      // Only used when no reviewed pre-computed plan is available on round 1,
      // or after the R3→D1 retry when we want a fresh visual plan.
      if (isRetry || !componentPlan?.visualPlan) {
        await this.log(
          logPath,
          isRetry
            ? `[reviewer] "${componentName}" R3→D1: restarting with fresh AI visual plan (round ${round}/${MAX_ROUNDS})`
            : `[reviewer] Stage 1: requesting AI visual plan for "${componentName}"`,
        );

        const { systemPrompt: s1System, userPrompt: s1User } =
          buildVisualPlanPrompt({
            componentName,
            templateSource,
            content,
            tokens,
          });

        try {
          const s1Raw = await this.generateWithRetry(
            modelName,
            s1System,
            s1User,
            3,
            logPath,
            `${componentName}:plan`,
          );
          const parsedPlan = parseVisualPlanDetailed(s1Raw, componentName, {
            allowedImageSrcs: extractStaticImageSources(templateSource),
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
              return {
                component: { name: componentName, filePath: '', code },
                fromVisualPlan: true,
                attempts,
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
                attempts,
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
        return {
          component: { name: componentName, filePath: '', code },
          fromVisualPlan: false,
          attempts,
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
          return {
            component: { name: componentName, filePath: '', code },
            fromVisualPlan: false,
            attempts,
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
      systemPrompt = '',
      content,
      tokens,
      componentPlan,
      logPath,
    } = input;

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
      componentPlan,
    });

    let code = '';
    let lastError: string | undefined;
    let isValid = false;
    const validationContext = this.buildValidationContext(
      this.buildPromptContext(componentPlan),
      sectionName,
      true,
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await this.generateWithRetry(
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
      throw new Error(
        `[reviewer] Section "${sectionName}" failed after 3 attempts: ${lastError}`,
      );
    }

    return { name: sectionName, filePath: '', code, isSubComponent: true };
  }

  // ── Self-fix (Fix Agent) ───────────────────────────────────────────────────

  private buildPromptContext(
    componentPlan?: PlanResult[number] | ComponentPromptContext,
    visualPlan?: ComponentVisualPlan,
  ): ComponentPromptContext | undefined {
    if (!componentPlan && !visualPlan) return undefined;

    const resolvedVisualPlan = visualPlan ?? componentPlan?.visualPlan;
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
    return {
      componentName,
      route: componentPlan?.route,
      isDetail: componentPlan?.isDetail,
      dataNeeds: componentPlan?.dataNeeds,
      type: componentPlan?.type,
      isSubComponent,
      allowedRelativeImports: componentPlan?.visualPlan?.layout.includes ?? [],
    };
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
    const validationContext = this.buildValidationContext(
      componentPlan,
      componentName,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const raw = await this.generateWithRetry(
        modelName,
        this.componentSystemPrompt,
        buildComponentPrompt(
          componentName,
          templateSource,
          content.siteInfo,
          content,
          tokens,
          componentPlan,
          attempt > 1
            ? `Previous attempt failed: ${lastError}\n\nYour previous output:\n\`\`\`tsx\n${code}\n\`\`\`\nFix ONLY the error above.`
            : undefined,
        ),
        5,
        logPath,
        `${componentName}:${logLabel}`,
      );

      lastRawOutput = raw;
      code = this.postProcessCode(raw);

      const check = this.validator.checkCodeStructure(code, validationContext);
      if (check.fixedCode) code = check.fixedCode;
      if (check.isValid) {
        return {
          code,
          isValid: true,
          attemptsUsed: attempt,
          lastRawOutput,
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
    }

    return {
      code,
      isValid: false,
      attemptsUsed: maxAttempts,
      lastError,
      lastRawOutput,
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
    const raw = await this.generateWithRetry(
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
  ): Promise<string> {
    let delay = 30_000;
    let maxTokens = this.llmFactory.getMaxTokens();
    let lastTruncatedText = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.llmFactory.chat({
          model,
          systemPrompt,
          userPrompt,
          maxTokens,
        });
        if (result.truncated) {
          lastTruncatedText = result.text;
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
          return lastTruncatedText;
        }
        return result.text;
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
    return '';
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

    const lastExportIdx = result.lastIndexOf('\nexport default ');
    if (lastExportIdx !== -1) {
      const exportSlice = result.slice(lastExportIdx);
      const exportFirstLine = exportSlice.split('\n')[0];
      if (/function|=>|\{/.test(exportFirstLine)) {
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
        const semiIdx = result.indexOf(';', lastExportIdx);
        if (semiIdx !== -1) result = result.slice(0, semiIdx + 1).trimEnd();
      }
    }
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
