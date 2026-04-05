import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { ApiBuilderResult } from './api-builder.service.js';

interface ApiReviewIssue {
  severity: 'high' | 'medium' | 'low';
  message: string;
}

interface ApiReviewResult {
  pass: boolean;
  issues: ApiReviewIssue[];
  summary?: string;
}

export interface GeneratedApiReviewResult {
  success: boolean;
  review: ApiReviewResult;
  blockingMessage?: string;
}

@Injectable()
export class GeneratedApiReviewService {
  private readonly logger = new Logger(GeneratedApiReviewService.name);

  constructor(private readonly llmFactory: LlmFactoryService) {}

  async review(input: {
    api: ApiBuilderResult;
    plan: PlanResult;
    content: Pick<
      DbContentResult,
      | 'customPostTypes'
      | 'detectedPlugins'
      | 'siteInfo'
      | 'pages'
      | 'posts'
      | 'menus'
      | 'taxonomies'
      | 'commerce'
    >;
    modelName?: string;
    mode?: 'warn' | 'blocking';
    logPath?: string;
  }): Promise<GeneratedApiReviewResult> {
    const { api, plan, content, modelName, mode = 'warn', logPath } = input;
    const resolvedModel = modelName ?? this.llmFactory.getModel();

    this.logger.log(
      `[AI Generated Backend Review] Reviewing ${api.files.length} backend file(s) with ${resolvedModel}`,
    );
    await this.log(
      logPath,
      `[AI Generated Backend Review] Reviewing ${api.files.length} backend file(s) with ${resolvedModel}`,
    );

    const reviewPrompt = this.buildReviewPrompt(api, plan, content);
    const review = await this.reviewBackend(
      reviewPrompt,
      resolvedModel,
      logPath,
    );

    const blockingIssues = this.getBlockingIssues(review);
    let blockingMessage: string | undefined;

    if (blockingIssues.length > 0) {
      blockingMessage = review.issues.length
        ? review.issues
            .map((issue) => `[${issue.severity}] ${issue.message}`)
            .join(' | ')
        : review.summary || 'AI reviewer rejected the generated backend';

      if (mode === 'blocking') {
        this.logger.warn(
          `[AI Generated Backend Review] Blocking issues found: ${blockingMessage}`,
        );
      }
    }

    if (!review.pass || review.issues.length > 0 || review.summary) {
      const issues = review.issues.length
        ? review.issues
            .map((issue) => `[${issue.severity}] ${issue.message}`)
            .join(' | ')
        : review.summary || 'AI reviewer reported advisory issues';
      this.logger.warn(`[AI Generated Backend Review] Advisory: ${issues}`);
      await this.log(
        logPath,
        `WARN [AI Generated Backend Review] Advisory: ${issues}`,
      );
    }

    return {
      success: mode === 'blocking' ? blockingIssues.length === 0 : true,
      review,
      blockingMessage,
    };
  }

  private async reviewBackend(
    reviewPrompt: string,
    modelName: string,
    logPath?: string,
  ): Promise<ApiReviewResult> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text } = await this.llmFactory.chat({
        model: modelName,
        systemPrompt:
          'You are a strict senior backend reviewer. Review generated Express/TypeScript server code against the approved frontend data contract. Return ONLY valid JSON.',
        userPrompt: reviewPrompt,
        maxTokens: 2200,
      });

      const parsed = this.parseReviewResult(text);
      if (parsed) {
        if (parsed.pass) {
          this.logger.log(
            `[AI Generated Backend Review] Passed (attempt ${attempt})`,
          );
          await this.log(
            logPath,
            `[AI Generated Backend Review] Passed (attempt ${attempt})`,
          );
        } else {
          this.logger.warn(
            `[AI Generated Backend Review] Failed: ${parsed.issues.map((issue) => issue.message).join(' | ') || parsed.summary || 'unknown issue'}`,
          );
          await this.log(
            logPath,
            `WARN [AI Generated Backend Review] Failed: ${parsed.issues.map((issue) => issue.message).join(' | ') || parsed.summary || 'unknown issue'}`,
          );
        }
        return parsed;
      }

      this.logger.warn(
        `[AI Generated Backend Review] Invalid JSON on attempt ${attempt}/2`,
      );
      await this.log(
        logPath,
        `WARN [AI Generated Backend Review] Invalid JSON on attempt ${attempt}/2`,
      );
    }

    return {
      pass: false,
      issues: [
        {
          severity: 'high',
          message:
            'AI backend reviewer did not return valid JSON after 2 attempts, so backend review could not be completed safely.',
        },
      ],
      summary: 'AI backend reviewer output was not parseable.',
    };
  }

  private buildReviewPrompt(
    api: ApiBuilderResult,
    plan: PlanResult,
    content: Pick<
      DbContentResult,
      | 'customPostTypes'
      | 'detectedPlugins'
      | 'siteInfo'
      | 'pages'
      | 'posts'
      | 'menus'
      | 'taxonomies'
      | 'commerce'
    >,
  ): string {
    const requiredDataNeeds = [
      ...new Set(plan.flatMap((item) => item.dataNeeds)),
    ];
    const detailRoutes = plan
      .filter((item) => item.isDetail && item.route)
      .map((item) => `${item.componentName}: ${item.route}`);
    const pluginSlugs = content.detectedPlugins.map((plugin) => plugin.slug);
    const cptSlugs = content.customPostTypes.map((cpt) => cpt.postType);

    return `Review this generated backend/API code against the approved frontend contract.

Return ONLY a JSON object in this exact shape:
{
  "pass": true,
  "issues": [],
  "summary": "short summary"
}

Rules:
- Set "pass" to false ONLY for real blocking issues.
- Only flag concrete problems:
  1. obvious missing API coverage required by the frontend contract
  2. clearly wrong detail route behavior for post/page slug endpoints
  3. generated custom post type or plugin routes that are clearly malformed or disconnected from the contract
  4. server code structure/imports that are likely broken
- Do NOT flag stylistic preferences.
- If the backend is acceptable, return pass=true with issues=[].
- Severity must be one of: "high", "medium", "low".

Approved frontend contract summary:
- required data needs across all components: ${requiredDataNeeds.length > 0 ? requiredDataNeeds.join(', ') : '(none)'}
- detail routes:
${detailRoutes.length > 0 ? detailRoutes.map((route) => `  - ${route}`).join('\n') : '  - (none)'}
- custom post types detected: ${cptSlugs.length > 0 ? cptSlugs.join(', ') : '(none)'}
- plugin slugs detected: ${pluginSlugs.length > 0 ? pluginSlugs.join(', ') : '(none)'}
- content counts:
  - posts: ${content.posts.length}
  - pages: ${content.pages.length}
  - menus: ${content.menus.length}
  - taxonomies: ${content.taxonomies.length}
  - commerce products: ${content.commerce.productsCount}

Generated backend files:
${api.files
  .map((file) => `\n### ${file.name}\n\`\`\`ts\n${file.code}\n\`\`\``)
  .join('\n')}`;
  }

  private parseReviewResult(raw: string): ApiReviewResult | null {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;

    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      const issues = Array.isArray(parsed?.issues)
        ? parsed.issues
            .map((issue: any) => ({
              severity:
                issue?.severity === 'high' ||
                issue?.severity === 'medium' ||
                issue?.severity === 'low'
                  ? issue.severity
                  : 'medium',
              message:
                typeof issue?.message === 'string' ? issue.message.trim() : '',
            }))
            .filter((issue: ApiReviewIssue) => issue.message)
        : [];

      return {
        pass: parsed?.pass === true,
        issues,
        summary:
          typeof parsed?.summary === 'string' ? parsed.summary.trim() : '',
      };
    } catch {
      return null;
    }
  }

  private getBlockingIssues(review: ApiReviewResult): ApiReviewIssue[] {
    const blockingPatterns = [
      'missing api coverage',
      'wrong detail route behavior',
      'clearly malformed',
      'server code structure',
      'missing route',
      'broken',
      'syntax',
    ];

    return review.issues.filter(
      (issue) =>
        issue.severity === 'high' &&
        blockingPatterns.some((pattern) =>
          issue.message.toLowerCase().includes(pattern),
        ),
    );
  }

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
