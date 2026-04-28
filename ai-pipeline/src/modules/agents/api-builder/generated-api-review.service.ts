import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { ApiBuilderResult } from './api-builder.service.js';

const AI_ROUTE_EXCLUDED_CPTS = new Set(['product']);
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

function shouldIgnoreCustomPostType(
  cpt: DbContentResult['customPostTypes'][number],
) {
  return (
    AI_ROUTE_EXCLUDED_CPTS.has(cpt.postType) ||
    cpt.taxonomies.some((taxonomy) =>
      ['product_cat', 'product_tag', 'product_type'].includes(taxonomy),
    )
  );
}

@Injectable()
export class GeneratedApiReviewService {
  private readonly logger = new Logger(GeneratedApiReviewService.name);
  private readonly tokenTracker = new TokenTracker();

  constructor(private readonly llmFactory: LlmFactoryService) {}

  async review(input: {
    api: ApiBuilderResult;
    plan: PlanResult;
    content: Pick<
      DbContentResult,
      'customPostTypes' | 'pages' | 'posts' | 'menus' | 'taxonomies'
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
    const review = this.filterReviewResult(
      await this.reviewBackend(reviewPrompt, resolvedModel, logPath),
      api,
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
      const { text, inputTokens, outputTokens } = await this.llmFactory.chat({
        model: modelName,
        systemPrompt:
          'You are a strict senior backend reviewer. Review generated Express/TypeScript server code against the approved frontend data contract. Return ONLY valid JSON.',
        userPrompt: reviewPrompt,
        maxTokens: 2200,
      });
      const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
      if (tokenLogPath) {
        await this.tokenTracker.init(tokenLogPath);
        await this.tokenTracker.track(
          modelName,
          inputTokens,
          outputTokens,
          `backend-review:${attempt}`,
        );
      }

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
      'customPostTypes' | 'pages' | 'posts' | 'menus' | 'taxonomies'
    >,
  ): string {
    const requiredDataNeeds = [
      ...new Set(plan.flatMap((item) => item.dataNeeds)),
    ];
    const detailRoutes = plan
      .filter((item) => item.isDetail && item.route)
      .map((item) => `${item.componentName}: ${item.route}`);
    const cptSlugs = content.customPostTypes
      .filter((cpt) => !shouldIgnoreCustomPostType(cpt))
      .map((cpt) => cpt.postType);
    const excludedCptSlugs = content.customPostTypes
      .filter((cpt) => shouldIgnoreCustomPostType(cpt))
      .map((cpt) => cpt.postType);

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
  3. generated custom post type routes that are clearly malformed or disconnected from the contract
  4. server code structure/imports that are likely broken
- Do NOT flag stylistic preferences.
- If the backend is acceptable, return pass=true with issues=[].
- Severity must be one of: "high", "medium", "low".

Approved frontend contract summary:
- required data needs across all components: ${requiredDataNeeds.length > 0 ? requiredDataNeeds.join(', ') : '(none)'}
- detail routes:
${detailRoutes.length > 0 ? detailRoutes.map((route) => `  - ${route}`).join('\n') : '  - (none)'}
- custom post types detected: ${cptSlugs.length > 0 ? cptSlugs.join(', ') : '(none)'}
- intentionally excluded dedicated CPT routes: ${excludedCptSlugs.length > 0 ? excludedCptSlugs.join(', ') : '(none)'}
- These excluded integrations are intentionally served only through the generic static endpoints already present in the template. Do NOT require or suggest dedicated /api/products... routes for them.
- Generic detail endpoints such as \`/api/posts/:slug\` and \`/api/pages/:slug\` are valid for frontend route flavors like \`/single/:slug\` or \`/single-with-sidebar/:slug\` unless the contract explicitly requires a fixed slug or a distinct payload shape.
- content counts:
  - posts: ${content.posts.length}
  - pages: ${content.pages.length}
  - menus: ${content.menus.length}
  - taxonomies: ${content.taxonomies.length}

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

  private filterReviewResult(
    review: ApiReviewResult,
    api: ApiBuilderResult,
  ): ApiReviewResult {
    const hasGenericPostDetailRoute = api.files.some((file) =>
      /app\.get\(\s*['"`]\/api\/posts\/:slug['"`]/.test(file.code),
    );
    const hasGenericPageDetailRoute = api.files.some((file) =>
      /app\.get\(\s*['"`]\/api\/pages\/:slug['"`]/.test(file.code),
    );

    const issues = review.issues.filter((issue) => {
      const message = issue.message.toLowerCase();
      if (
        hasGenericPostDetailRoute &&
        /single-with-sidebar|dedicated post detail route|distinct \/single-with-sidebar\/:slug detail behavior/.test(
          message,
        )
      ) {
        return false;
      }
      if (
        hasGenericPageDetailRoute &&
        /dedicated page detail route|distinct .*\/page\/:slug detail behavior/.test(
          message,
        )
      ) {
        return false;
      }
      return true;
    });

    if (issues.length === review.issues.length) {
      return review;
    }

    return {
      pass: issues.length === 0 ? true : review.pass,
      issues,
      summary: issues.length === 0 ? '' : review.summary,
    };
  }

  private async log(
    logPath: string | undefined,
    message: string,
  ): Promise<void> {
    if (!logPath || logPath.endsWith('.json')) return;
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // never crash pipeline because of a log failure
    }
  }
}
