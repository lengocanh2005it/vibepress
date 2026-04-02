import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { GeneratedComponent } from './react-generator.service.js';

interface CodeReviewIssue {
  severity: 'high' | 'medium' | 'low';
  message: string;
}

interface CodeReviewResult {
  pass: boolean;
  issues: CodeReviewIssue[];
  summary?: string;
}

export interface GeneratedCodeReviewResult {
  success: boolean;
  failures: {
    componentName: string;
    message: string;
  }[];
}

@Injectable()
export class GeneratedCodeReviewService {
  private readonly logger = new Logger(GeneratedCodeReviewService.name);

  constructor(private readonly llmFactory: LlmFactoryService) {}

  async review(input: {
    components: GeneratedComponent[];
    plan: PlanResult;
    modelName?: string;
    mode?: 'warn' | 'blocking';
    logPath?: string;
  }): Promise<GeneratedCodeReviewResult> {
    const { components, plan, modelName, mode = 'warn', logPath } = input;
    const resolvedModel = modelName ?? this.llmFactory.getModel();
    const topLevelComponents = components.filter(
      (comp) => !comp.isSubComponent,
    );
    const failures: { componentName: string; message: string }[] = [];

    this.logger.log(
      `[AI Generated Code Review] Reviewing ${topLevelComponents.length} top-level components with ${resolvedModel}`,
    );
    await this.log(
      logPath,
      `[AI Generated Code Review] Reviewing ${topLevelComponents.length} top-level components with ${resolvedModel}`,
    );

    for (const component of topLevelComponents) {
      const contract =
        plan.find((item) => item.componentName === component.name) ?? null;
      const review = await this.reviewComponent(
        component,
        contract,
        resolvedModel,
        logPath,
      );

      const blockingIssues = this.getBlockingIssues(
        review,
        component,
        contract,
      );
      
      const issuesMessage = review.issues.length
        ? review.issues
            .map((issue) => `[${issue.severity}] ${issue.message}`)
            .join(' | ')
        : review.summary || (review.pass ? 'Passed' : 'AI reviewer rejected the component');

      if (blockingIssues.length > 0) {
        failures.push({
          componentName: component.name,
          message: issuesMessage,
        });

        if (mode === 'blocking') {
          this.logger.warn(
            `[AI Generated Code Review] "${component.name}" blocking: ${issuesMessage}`,
          );
          await this.log(
            logPath,
            `WARN [AI Generated Code Review] "${component.name}" blocking: ${issuesMessage}`,
          );
        }
      }

      if (!review.pass || review.issues.length > 0) {
        if (blockingIssues.length === 0) {
           this.logger.warn(
            `[AI Generated Code Review] "${component.name}" advisory: ${issuesMessage}`,
          );
          await this.log(
            logPath,
            `WARN [AI Generated Code Review] "${component.name}" advisory: ${issuesMessage}`,
          );
        }
      } else {
        this.logger.log(`[AI Generated Code Review] "${component.name}" passed`);
      }
    }

    return {
      success: mode === 'blocking' ? failures.length === 0 : true,
      failures: mode === 'blocking' ? failures : [],
    };
  }

  private async reviewComponent(
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
    modelName: string,
    logPath?: string,
  ): Promise<CodeReviewResult> {
    const reviewPrompt = this.buildReviewPrompt(component, contract);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text } = await this.llmFactory.chat({
        model: modelName,
        systemPrompt:
          'You are a strict senior React reviewer. Review generated TSX against the approved contract. Return ONLY valid JSON.',
        userPrompt: reviewPrompt,
        maxTokens: 2000,
      });

      const parsed = this.parseReviewResult(text);
      if (parsed) {
        if (parsed.pass) {
          this.logger.log(
            `[AI Generated Code Review] "${component.name}" passed (attempt ${attempt})`,
          );
          await this.log(
            logPath,
            `[AI Generated Code Review] "${component.name}" passed (attempt ${attempt})`,
          );
        } else {
          this.logger.warn(
            `[AI Generated Code Review] "${component.name}" failed: ${parsed.issues.map((issue) => issue.message).join(' | ') || parsed.summary || 'unknown issue'}`,
          );
          await this.log(
            logPath,
            `WARN [AI Generated Code Review] "${component.name}" failed: ${parsed.issues.map((issue) => issue.message).join(' | ') || parsed.summary || 'unknown issue'}`,
          );
        }
        return parsed;
      }

      this.logger.warn(
        `[AI Generated Code Review] "${component.name}" returned invalid JSON on attempt ${attempt}/2`,
      );
      await this.log(
        logPath,
        `WARN [AI Generated Code Review] "${component.name}" returned invalid JSON on attempt ${attempt}/2`,
      );
    }

    return {
      pass: false,
      issues: [
        {
          severity: 'high',
          message:
            'AI reviewer did not return valid JSON after 2 attempts, so review could not be completed safely.',
        },
      ],
      summary: 'AI reviewer output was not parseable.',
    };
  }

  private buildReviewPrompt(
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
  ): string {
    const dataNeeds = contract?.dataNeeds ?? component.dataNeeds ?? [];
    const route = contract?.route ?? component.route ?? null;
    const type = contract?.type ?? component.type ?? 'page';
    const isDetail = contract?.isDetail ?? component.isDetail ?? false;
    const description = contract?.description ?? '(none)';
    const visualSectionTypes =
      contract?.visualPlan?.sections.map((section) => section.type) ?? [];
    const visualSections =
      visualSectionTypes.length > 0 ? visualSectionTypes.join(', ') : '(none)';

    return `Review this generated React component against its approved contract.

Return ONLY a JSON object in this exact shape:
{
  "pass": true,
  "issues": [],
  "summary": "short summary"
}

Rules:
- Set "pass" to false ONLY for real blocking issues that would cause materially wrong behavior or an obvious runtime/integration defect.
- Only flag concrete problems:
  1. code clearly violates the route/data contract
  2. component obviously omits an important approved section/layout
  3. component fetches or uses data not justified by the contract
  4. JSX/TSX structure is likely broken
  5. imports/variables/hooks are clearly inconsistent with the code
- For partial components, be much more lenient:
  - do NOT fail only because they fetch optional helper data
  - do NOT fail only because approved data is fetched but not heavily used
  - do NOT fail on minor layout/section interpretation differences
- Do NOT fail on component/function/export naming differences if the file still clearly implements the approved component.
- If the approved visual sections include \`comments\`, comments fetching/rendering is justified.
- Do NOT fail only because fetched data is unused unless it clearly indicates a wrong endpoint or broken logic.
- Do NOT flag subjective styling preferences.
- Do NOT require exact text/copy matching unless the code is clearly unrelated.
- If the component is acceptable, return pass=true with issues=[].
- Severity must be one of: "high", "medium", "low".

Approved contract:
- componentName: ${component.name}
- type: ${type}
- route: ${route ?? 'null'}
- isDetail: ${String(isDetail)}
- dataNeeds: ${dataNeeds.length > 0 ? dataNeeds.join(', ') : '(none)'}
- description: ${description}
- approved visual sections: ${visualSections}
- allowed API expectations:
${this.buildApiContractLines(dataNeeds, isDetail, visualSectionTypes)}

Generated TSX:
\`\`\`tsx
${component.code}
\`\`\``;
  }

  private buildApiContractLines(
    dataNeeds: string[],
    isDetail: boolean,
    visualSectionTypes: string[],
  ): string {
    const normalized = new Set(
      dataNeeds.map((value) => {
        switch (value) {
          case 'siteInfo':
            return 'site-info';
          case 'postDetail':
            return 'post-detail';
          case 'pageDetail':
            return 'page-detail';
          default:
            return value;
        }
      }),
    );
    const lines: string[] = [];
    if (normalized.has('site-info')) lines.push('- /api/site-info');
    if (normalized.has('menus')) lines.push('- /api/menus');
    if (normalized.has('posts')) lines.push('- /api/posts');
    if (normalized.has('pages')) lines.push('- /api/pages');
    if (normalized.has('post-detail'))
      lines.push('- /api/posts/${slug} only for post-detail routes');
    if (normalized.has('page-detail'))
      lines.push('- /api/pages/${slug} only for page-detail routes');
    if (visualSectionTypes.includes('comments'))
      lines.push(
        '- /api/comments?slug=${slug} is allowed because comments are in the approved sections',
      );
    if (isDetail && !normalized.has('post-detail') && !normalized.has('page-detail')) {
      lines.push(
        '- Detail route exists, but only the explicitly declared detail endpoint is allowed',
      );
    }
    if (lines.length === 0)
      lines.push('- No data fetch is required by contract');
    return lines.join('\n');
  }

  private getBlockingIssues(
    review: CodeReviewResult,
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
  ): CodeReviewIssue[] {
    if (review.pass) return [];

    const messages = review.issues.map((issue) => issue.message.toLowerCase());
    const summary = (review.summary ?? '').toLowerCase();
    const combined = [...messages, summary].join(' | ');
    const isPartial =
      (contract?.type ?? component.type) === 'partial' ||
      component.isSubComponent === true;

    if (!combined.trim()) return [];

    const ignorablePatterns = [
      'component name does not match approved contract',
      'fetches menus data but does not use it',
      'violates contract by fetching data from an api endpoint',
      'fetches unauthorized data and includes unauthorized visual sections',
    ];
    if (ignorablePatterns.some((pattern) => combined.includes(pattern))) {
      return [];
    }

    if (
      isPartial &&
      !messages.some((message) =>
        /wrong endpoint|incorrect api endpoint|runtime|broken|missing import|missing variable|jsx|syntax/.test(
          message,
        ),
      )
    ) {
      return [];
    }

    const blockingPatterns = [
      'incorrect api endpoint',
      'wrong endpoint',
      'clearly violates the route/data contract',
      'route/data contract',
      'jsx/tsx structure is likely broken',
      'jsx',
      'syntax',
      'missing import',
      'missing variable',
      'obviously omits an important approved section',
    ];

    return review.issues.filter(
      (issue) =>
        issue.severity === 'high' &&
        blockingPatterns.some((pattern) =>
          issue.message.toLowerCase().includes(pattern),
        ),
    );
  }

  private parseReviewResult(raw: string): CodeReviewResult | null {
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
            .filter((issue: CodeReviewIssue) => issue.message)
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

  private async log(
    logPath: string | undefined,
    message: string,
  ): Promise<void> {
    if (!logPath) return;
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // never crash pipeline because of log failure
    }
  }
}
