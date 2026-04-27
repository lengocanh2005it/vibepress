import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import { findPlainTextPostMetaArchiveSnippets as findSharedPlainTextPostMetaArchiveSnippets } from '../../../common/utils/post-meta-link.util.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type { CardGridSection, SectionPlan } from './visual-plan.schema.js';
import {
  extractAuxiliaryLabelsFromSections,
  getExactInventedAuxiliaryLabel,
  mergeAuxiliaryLabels,
} from './auxiliary-section.guard.js';

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
  private readonly tokenTracker = new TokenTracker();

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
        plan,
        resolvedModel,
        logPath,
      );
      const effectiveReview = this.applyDeterministicIssues(
        review,
        component,
        contract,
      );

      const blockingIssues = this.getBlockingIssues(
        effectiveReview,
        component,
        contract,
      );

      const issuesMessage = effectiveReview.issues.length
        ? effectiveReview.issues
            .map((issue) => `[${issue.severity}] ${issue.message}`)
            .join(' | ')
        : effectiveReview.summary ||
          (effectiveReview.pass
            ? 'Passed'
            : 'AI reviewer rejected the component');

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

      if (!effectiveReview.pass || effectiveReview.issues.length > 0) {
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
        this.logger.log(
          `[AI Generated Code Review] "${component.name}" passed`,
        );
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
    plan: PlanResult,
    modelName: string,
    logPath?: string,
  ): Promise<CodeReviewResult> {
    const reviewPrompt = this.buildReviewPrompt(component, contract, plan);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text, inputTokens, outputTokens } = await this.llmFactory.chat({
        model: modelName,
        systemPrompt:
          'You are a strict senior React reviewer. Review generated TSX against the approved contract. Return ONLY valid JSON.',
        userPrompt: reviewPrompt,
        maxTokens: 2000,
      });
      const tokenLogPath = TokenTracker.getTokenLogPath(logPath);
      if (tokenLogPath) {
        await this.tokenTracker.init(tokenLogPath);
        await this.tokenTracker.track(
          modelName,
          inputTokens,
          outputTokens,
          `${component.name}:generated-review:${attempt}`,
        );
      }

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
    plan: PlanResult,
  ): string {
    const dataNeeds = contract?.dataNeeds ?? component.dataNeeds ?? [];
    const route = contract?.route ?? component.route ?? null;
    const type = contract?.type ?? component.type ?? 'page';
    const isDetail = contract?.isDetail ?? component.isDetail ?? false;
    const fixedSlug = contract?.fixedSlug ?? component.fixedSlug ?? null;
    const description = contract?.description ?? '(none)';
    const visualSectionTypes =
      contract?.visualPlan?.sections.map((section) => section.type) ?? [];
    const visualSections =
      visualSectionTypes.length > 0 ? visualSectionTypes.join(', ') : '(none)';
    const knownRoutes = this.buildKnownRoutesLines(plan);
    const isArchive = component.name === 'Archive';

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
  6. component materially redesigns the approved WordPress layout instead of preserving it
- For partial components, be much more lenient:
  - do NOT fail only because they fetch optional helper data
  - do NOT fail only because approved data is fetched but not heavily used
  - do NOT fail on minor layout/section interpretation differences
- Do NOT fail on component/function/export naming differences if the file still clearly implements the approved component.
- If the approved visual sections include \`comments\`, comments fetching/rendering is justified.
- If the approved visual sections include \`modal\`, \`tabs\`, \`accordion\`, or \`carousel\`, keep real interactive wiring plus the expected Spectra/UAGB-compatible structural markers. Do NOT flatten them into static cards/columns.
- Do NOT fail only because fetched data is unused unless it clearly indicates a wrong endpoint or broken logic.
 - Do NOT flag subjective styling preferences, but DO flag material layout rewrites such as invented hero/promo sections, centered redesigns, missing sidebars, obviously different wrapper structure from the approved plan, or typography that is materially inflated beyond the approved/source visual weight (for example giant display headings or oversized menu/body text in an otherwise modest WordPress template).
 - If the template/source clearly includes an important screenshot, product composite, UI mockup, or other full illustrative image, DO flag fixed-height \`object-cover\` cropping when it visibly cuts off meaningful content that should remain visible.
 - If a media-text/photo section in the approved/source layout clearly uses rounded image corners or strong heading/list emphasis, DO flag generated code that flattens those into sharp-corner images or weak muted regular-weight text.
- Do NOT require exact text/copy matching unless the code is clearly unrelated.
- Known app routes are authoritative. Do NOT flag a route/link as risky if it matches one of the known routes below.
- Treat concrete links like \`/post/\${slug}\` or \`/category/\${slug}\` as valid when they correspond to approved patterns such as \`/post/:slug\` or \`/category/:slug\`.
- If \`fixedSlug\` is present in the approved contract, this component is bound to one exact record. In that case, do flag any use of \`useParams()\`, \`/api/pages/\${slug}\`, or \`/api/posts/\${slug}\` for the main record fetch. The component should use the exact bound endpoint instead.
- A generic backend detail endpoint such as \`/api/posts/:slug\` or \`/api/pages/:slug\` is acceptable for route flavors like \`/single-with-sidebar/:slug\` unless the approved contract explicitly requires a distinct payload shape or a fixed bound slug.
- Do flag visible text links that should behave like WordPress navigation/content links but stay plain text or omit hover underline when the route/data already exists, especially for post titles, author/category archive links inside meta rows, menu/footer/sidebar links, breadcrumbs, and social/footer text links. CTA buttons are exempt.
- Do NOT flag \`{condition && (<JSX />)}\` or \`{a && b && (<JSX />)}\` as broken JSX — these are standard React conditional rendering patterns. Only flag JSX as broken when there is an actual syntax error, unclosed tag, or raw object literal returned inside JSX.
- If the component is acceptable, return pass=true with issues=[].
- Severity must be one of: "high", "medium", "low".

Approved contract:
- componentName: ${component.name}
- type: ${type}
- route: ${route ?? 'null'}
- isDetail: ${String(isDetail)}
- fixedSlug: ${fixedSlug ?? 'null'}
- dataNeeds: ${dataNeeds.length > 0 ? dataNeeds.join(', ') : '(none)'}
- description: ${description}
- approved visual sections: ${visualSections}
- approved visual section details:
${this.buildVisualSectionDetailLines(contract)}
- known app routes:
${knownRoutes}
- allowed API expectations:
${this.buildApiContractLines(
  dataNeeds,
  isDetail,
  visualSectionTypes,
  isArchive,
  fixedSlug,
)}

Generated TSX:
\`\`\`tsx
${component.code}
\`\`\``;
  }

  private buildApiContractLines(
    dataNeeds: string[],
    isDetail: boolean,
    visualSectionTypes: string[],
    isArchive = false,
    fixedSlug?: string | null,
  ): string {
    const normalized = new Set(
      dataNeeds.map((value) => {
        switch (value) {
          case 'siteInfo':
            return 'site-info';
          case 'footerLinks':
            return 'footer-links';
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
    if (normalized.has('footer-links')) lines.push('- /api/footer-links');
    if (normalized.has('menus')) lines.push('- /api/menus');
    if (normalized.has('posts') || normalized.has('authorDetail'))
      lines.push('- /api/posts');
    if (normalized.has('pages')) lines.push('- /api/pages');
    if (normalized.has('post-detail')) {
      lines.push(
        fixedSlug
          ? `- /api/posts/${fixedSlug} only for this fixed-bound post-detail route`
          : '- /api/posts/${slug} only for post-detail routes',
      );
    }
    if (normalized.has('page-detail')) {
      lines.push(
        fixedSlug
          ? `- /api/pages/${fixedSlug} only for this fixed-bound page-detail route`
          : '- /api/pages/${slug} only for page-detail routes',
      );
    }
    if (normalized.has('categoryDetail') || isArchive) {
      lines.push('- /api/taxonomies/category — list all category terms');
      lines.push(
        '- /api/taxonomies/category/:slug/posts — posts in a category',
      );
    }
    if (normalized.has('tagDetail') || isArchive) {
      lines.push('- /api/taxonomies/post_tag — list all tag terms');
      lines.push('- /api/taxonomies/post_tag/:slug/posts — posts in a tag');
    }
    if (normalized.has('authorDetail') || isArchive) {
      lines.push(
        '- Author archive fetches `/api/posts?author=${slug}` (and may include pagination query params). Use `post.authorSlug`, not `post.author`, for archive matching.',
      );
    }
    const hasComments =
      normalized.has('comments') || visualSectionTypes.includes('comments');
    if (hasComments) {
      lines.push(
        '- /api/comments?slug=${slug} is allowed because comments are in the approved sections',
      );
      lines.push(
        '- POST /api/comments is allowed when the approved comments section renders a reply form, but moderated comments should not be appended directly to the public list',
      );
      lines.push(
        '- /api/comments/submissions?slug=${slug}&clientToken=${token} is allowed for moderation polling after a comment is submitted',
      );
    }
    if (
      isDetail &&
      !normalized.has('post-detail') &&
      !normalized.has('page-detail')
    ) {
      lines.push(
        '- Detail route exists, but only the explicitly declared detail endpoint is allowed',
      );
    }
    if (lines.length === 0)
      lines.push('- No data fetch is required by contract');
    return lines.join('\n');
  }

  private buildKnownRoutesLines(plan: PlanResult): string {
    const lines = plan
      .filter((item) => item.type !== 'partial' && item.route)
      .map((item) => `- ${item.componentName}: ${item.route}`);

    const hasArchive = plan.some((item) => item.componentName === 'Archive');
    if (hasArchive) {
      lines.push('- Archive (category): /category/:slug');
      lines.push('- Archive (author): /author/:slug');
      lines.push('- Archive (tag): /tag/:slug');
    }

    return lines.length > 0 ? lines.join('\n') : '- (none)';
  }

  private buildVisualSectionDetailLines(
    contract: PlanResult[number] | null,
  ): string {
    const sections = contract?.visualPlan?.sections ?? [];
    if (sections.length === 0) return '- (none)';

    return sections
      .map((section) => {
        if (section.type === 'card-grid') {
          const headings = section.cards
            .map((card) => card.heading?.trim())
            .filter(Boolean)
            .slice(0, 8)
            .join(' | ');
          return `- card-grid title="${section.title ?? ''}" cards=${section.cards.length}${headings ? ` headings=${headings}` : ''}`;
        }
        if (section.type === 'hero') {
          return `- hero heading="${section.heading}"`;
        }
        if (section.type === 'cta-strip') {
          const ctaCount =
            Array.isArray(section.ctas) && section.ctas.length > 0
              ? section.ctas.length
              : section.cta
                ? 1
                : 0;
          return `- cta-strip align="${section.align ?? ''}" buttons=${ctaCount}`;
        }
        if (section.type === 'cover') {
          return `- cover heading="${section.heading ?? ''}" image="${section.imageSrc}"`;
        }
        if (section.type === 'media-text') {
          return `- media-text heading="${section.heading ?? ''}" image="${section.imageSrc}"`;
        }
        if (section.type === 'modal') {
          return `- modal trigger="${section.triggerText ?? ''}" heading="${section.heading ?? ''}"`;
        }
        if (section.type === 'tabs') {
          return `- tabs title="${section.title ?? ''}" items=${section.tabs.length}`;
        }
        if (section.type === 'accordion') {
          return `- accordion title="${section.title ?? ''}" items=${section.items.length}`;
        }
        if (section.type === 'post-list') {
          return `- post-list layout=${section.layout}`;
        }
        return `- ${section.type}`;
      })
      .join('\n');
  }

  private applyDeterministicIssues(
    review: CodeReviewResult,
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
  ): CodeReviewResult {
    const deterministicIssues = this.getDeterministicIssues(
      component,
      contract,
    );
    if (deterministicIssues.length === 0) return review;

    return {
      pass: false,
      issues: [...deterministicIssues, ...review.issues],
      summary: review.summary || 'Deterministic contract checks failed.',
    };
  }

  private getDeterministicIssues(
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
  ): CodeReviewIssue[] {
    const issues: CodeReviewIssue[] = [];
    const sections = contract?.visualPlan?.sections ?? [];
    const normalizedCode = this.normalizeForTextMatch(component.code);
    const isPageComponent = (contract?.type ?? component.type) === 'page';
    const fixedSlug = contract?.fixedSlug ?? component.fixedSlug ?? null;
    const normalizedDataNeeds = new Set(
      contract?.dataNeeds ?? component.dataNeeds ?? [],
    );
    const allowedSectionTypes = new Set(
      sections.map((section) => section.type),
    );
    const isFixedPageDetailComponent =
      !!fixedSlug &&
      isPageComponent &&
      (contract?.isDetail ?? component.isDetail) === true &&
      normalizedDataNeeds.has('page-detail');

    if (
      normalizedCode.includes('/page/page/') ||
      normalizedCode.includes('/post/post/')
    ) {
      issues.push({
        severity: 'high',
        message:
          'Generated code contains a duplicated route prefix such as `/page/page/` or `/post/post/`, which will navigate to the wrong URL.',
      });
    }
    if (
      /return\s+`?\/page\$\{path\}/i.test(component.code) ||
      /return\s+`?\/page\$\{url\}/i.test(component.code) ||
      /return\s+`?\/page\/\$\{url/i.test(component.code) ||
      /return\s+['"`]\/page\$\{url/i.test(component.code) ||
      (/return\s+['"`]\/page\//i.test(component.code) &&
        component.code.includes('item.url'))
    ) {
      issues.push({
        severity: 'high',
        message:
          'Menu links must use canonical `item.url` directly for internal navigation. Do not prepend an extra `/page` segment to menu URLs.',
      });
    }
    const missingHoverUnderlineLinks =
      this.findCanonicalTextLinkSnippetsWithoutHoverUnderline(component.code);
    if (missingHoverUnderlineLinks.length > 0) {
      issues.push({
        severity: 'medium',
        message: `Visible navigation/content text links should underline on hover (for example \`hover:underline underline-offset-4\`) to match the approved WordPress-style interaction. Offending snippet(s): ${missingHoverUnderlineLinks.join(' | ')}.`,
      });
    }
    const plainTextPostMetaLinks = this.findPlainTextPostMetaArchiveSnippets(
      component.code,
    );
    if (plainTextPostMetaLinks.length > 0) {
      issues.push({
        severity: 'medium',
        message: `Post meta author/category labels must link to their canonical archive routes when \`authorSlug\` or \`categorySlugs[0]\` is available. Plain-text \`post.author\` is only allowed when it is the actual heading/title content (for example an \`<h1>\` on author/archive/detail views). Do not render \`post.author\` or \`post.categories[0]\` as plain text spans in post listings/meta rows. Offending snippet(s): ${plainTextPostMetaLinks.join(' | ')}.`,
      });
    }
    if (isPageComponent) {
      const allowedAuxiliaryLabels = mergeAuxiliaryLabels(
        contract?.sourceBackedAuxiliaryLabels,
        extractAuxiliaryLabelsFromSections(sections),
      );
      const inventedAuxiliaryHeadings =
        this.findTrailingInventedAuxiliaryHeadingSnippets(
          component.code,
          allowedAuxiliaryLabels,
        );
      if (inventedAuxiliaryHeadings.length > 0) {
        issues.push({
          severity: 'high',
          message: `Component contains invented trailing auxiliary section heading(s) not justified by the approved contract/source: ${inventedAuxiliaryHeadings.join(' | ')}. Auxiliary/footer/sidebar-like page sections are invalid unless source-backed.`,
        });
      }
    }

    if (fixedSlug) {
      if (/\buseParams\s*(?:<[^>]+>)?\s*\(/.test(component.code)) {
        issues.push({
          severity: 'high',
          message: `Component is bound to fixed slug "${fixedSlug}" but still calls useParams(). Fixed-bound detail components must not read slug from the route.`,
        });
      }

      if (
        normalizedDataNeeds.has('pageDetail') &&
        /\/api\/pages\/\$\{slug\}|\/api\/pages\/['"`]\s*\+\s*slug/.test(
          component.code,
        )
      ) {
        issues.push({
          severity: 'high',
          message: `Component is bound to fixed slug "${fixedSlug}" but still fetches dynamic page detail via \`/api/pages/\${slug}\` instead of \`/api/pages/${fixedSlug}\`.`,
        });
      }

      if (
        normalizedDataNeeds.has('postDetail') &&
        /\/api\/posts\/\$\{slug\}|\/api\/posts\/['"`]\s*\+\s*slug/.test(
          component.code,
        )
      ) {
        issues.push({
          severity: 'high',
          message: `Component is bound to fixed slug "${fixedSlug}" but still fetches dynamic post detail via \`/api/posts/\${slug}\` instead of \`/api/posts/${fixedSlug}\`.`,
        });
      }
    }

    if (isFixedPageDetailComponent) {
      if (!this.hasCanonicalPageContentRender(component.code)) {
        issues.push({
          severity: 'high',
          message:
            'Fixed page-detail component does not render the fetched `page.content`/`item.content` body via `dangerouslySetInnerHTML`. The canonical page body must be rendered instead of replacing the page with bespoke static sections.',
        });
      }

      const unexpectedInteractiveUi = this.findUnexpectedInteractiveUiPatterns(
        component.code,
        allowedSectionTypes,
      );
      if (unexpectedInteractiveUi.length > 0) {
        issues.push({
          severity: 'high',
          message: `Fixed page-detail component renders unexpected interactive UI not approved by the visual plan: ${unexpectedInteractiveUi.join(', ')}. Do not invent standalone interactive sections around canonical page content.`,
        });
      }

      if (this.hasUnexpectedNarrowCenteredPageShell(component.code)) {
        issues.push({
          severity: 'high',
          message:
            'Fixed page-detail component wraps the canonical page body in a narrow centered article shell (for example `max-w-[620px] mx-auto` with hero-like centered title treatment) instead of preserving the approved source/template layout shell.',
        });
      }
    }

    const expectsSidebarDetailShell =
      (contract?.isDetail ?? component.isDetail) === true &&
      normalizedDataNeeds.has('postDetail') &&
      allowedSectionTypes.has('sidebar');
    if (expectsSidebarDetailShell) {
      if (!this.hasSidebarArticleLayout(component.code)) {
        issues.push({
          severity: 'high',
          message:
            'Approved detail layout requires a main article + sidebar structure, but the generated component does not preserve a clear article/aside shell and appears to restack or flatten the sidebar layout.',
        });
      }

      const inventedSidebarPlaceholders =
        this.findInventedSidebarPlaceholderSnippets(component.code);
      if (inventedSidebarPlaceholders.length > 0) {
        issues.push({
          severity: 'high',
          message: `Sidebar contains invented placeholder copy instead of source-backed widgets/content: ${inventedSidebarPlaceholders.join(' | ')}.`,
        });
      }

      if (this.hasCommentFilterUi(component.code)) {
        issues.push({
          severity: 'high',
          message:
            'Sidebar/detail implementation introduces comment-filter search UI that is not justified by the approved route/data contract. Preserve sidebar/site widgets instead of repurposing search to filter comments.',
        });
      }
    }

    if (sections.length === 0) return issues;

    const cardGrids = sections.filter(
      (section): section is CardGridSection => section.type === 'card-grid',
    );

    for (const section of cardGrids) {
      const expectedHeadings = section.cards
        .map((card) => card.heading?.trim())
        .filter(Boolean);
      if (expectedHeadings.length < 4) continue;

      const missingHeadings = expectedHeadings.filter(
        (heading) =>
          !normalizedCode.includes(this.normalizeForTextMatch(heading)),
      );
      if (missingHeadings.length === 0) continue;

      const presentCount = expectedHeadings.length - missingHeadings.length;
      issues.push({
        severity: 'high',
        message: `Approved card-grid${section.title ? ` "${section.title}"` : ''} includes ${expectedHeadings.length} cards, but the generated code only contains ${presentCount}/${expectedHeadings.length} expected card headings. Missing: ${missingHeadings.join(', ')}.`,
      });
    }

    issues.push(
      ...this.findMissingApprovedInteractiveMarkers(component.code, sections),
    );

    return issues;
  }

  private normalizeForTextMatch(raw: string): string {
    return raw
      .replace(/&amp;/gi, '&')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private hasCanonicalPageContentRender(code: string): boolean {
    return (
      /dangerouslySetInnerHTML/.test(code) &&
      /\b[A-Za-z_$][\w$]*(?:\?\.)?\.content\b/.test(code)
    );
  }

  private hasUnexpectedNarrowCenteredPageShell(code: string): boolean {
    if (!/dangerouslySetInnerHTML/.test(code)) return false;
    const hasNarrowShell =
      /<(?:article|main|section|div)\b[^>]*className="[^"]*\bmax-w-\[(?:5\d{2}|6\d{2}|7\d{2})px\][^"]*\bmx-auto\b[^"]*"/.test(
        code,
      ) ||
      /<(?:article|main|section|div)\b[^>]*className="[^"]*\bmax-w-(?:2xl|3xl)\b[^"]*\bmx-auto\b[^"]*"/.test(
        code,
      );
    const hasCenteredHeroTitle =
      /<h1\b[^>]*className="[^"]*\btext-center\b[^"]*"/.test(code) ||
      /<h1\b[^>]*className="[^"]*\btext-\[(?:2|3|4)\.\d+rem\][^"]*"/.test(code);
    return hasNarrowShell && hasCenteredHeroTitle;
  }

  private hasSidebarArticleLayout(code: string): boolean {
    const hasAside = /<aside\b/i.test(code);
    const hasArticleOrMain = /<(?:article|main)\b/i.test(code);
    return hasAside && hasArticleOrMain;
  }

  private findInventedSidebarPlaceholderSnippets(
    code: string,
    max = 3,
  ): string[] {
    const snippets: string[] = [];
    const patterns = [
      /Links I found useful and wanted to share\./gi,
      /<h[1-6]\b[^>]*>\s*About the author\s*<\/h[1-6]>/gi,
    ];

    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const snippet = (match[0] ?? '').replace(/\s+/g, ' ').trim();
        if (!snippet || snippets.includes(snippet)) continue;
        snippets.push(
          snippet.length > 180 ? `${snippet.slice(0, 177)}...` : snippet,
        );
        if (snippets.length >= max) return snippets;
      }
    }

    return snippets;
  }

  private hasCommentFilterUi(code: string): boolean {
    return (
      /\bfilteredComments\b/.test(code) ||
      /\bsetFilteredComments\b/.test(code) ||
      /\bcomments\.filter\s*\(/.test(code) ||
      /Search the website/.test(code)
    );
  }

  private findMissingApprovedInteractiveMarkers(
    code: string,
    sections: ReadonlyArray<SectionPlan>,
  ): CodeReviewIssue[] {
    if (sections.length === 0) return [];

    const issues: CodeReviewIssue[] = [];
    const rawCode = code;
    const interactiveConfigs: Array<{
      type: string;
      label: string;
      markers: string[];
      stateHints: string[];
    }> = [
      {
        type: 'modal',
        label: 'modal',
        markers: [
          'uagb-modal-trigger',
          'uagb-modal-popup',
          'uagb-modal-popup-wrap',
          'uagb-modal-popup-content',
        ],
        stateHints: ['openModals', 'setOpenModals'],
      },
      {
        type: 'tabs',
        label: 'tabs',
        markers: [
          'uagb-tabs__wrap',
          'uagb-tabs__panel',
          'uagb-tabs__body-wrap',
        ],
        stateHints: ['activeTabs', 'setActiveTabs'],
      },
      {
        type: 'accordion',
        label: 'accordion',
        markers: [
          'uagb-faq__wrap',
          'uagb-faq-item',
          'uagb-faq-questions-button',
          'uagb-faq-content',
        ],
        stateHints: ['openAccordions', 'setOpenAccordions'],
      },
      {
        type: 'carousel',
        label: 'carousel',
        markers: [
          'uagb-slider-container',
          'swiper-wrapper',
          'swiper-button-prev',
          'swiper-button-next',
        ],
        stateHints: ['activeCarousels', 'setActiveCarousels'],
      },
    ];

    for (const config of interactiveConfigs) {
      const matchingSections = sections.filter(
        (section) => section.type === config.type,
      );
      if (matchingSections.length === 0) continue;

      const missingMarkers = config.markers.filter(
        (marker) => !rawCode.includes(marker),
      );
      if (missingMarkers.length > 0) {
        issues.push({
          severity: 'high',
          message: `Approved ${config.label} section${matchingSections.length > 1 ? 's' : ''} must preserve Spectra/UAGB-compatible markers ${config.markers.map((marker) => `\`${marker}\``).join(', ')}. Missing marker(s): ${missingMarkers.map((marker) => `\`${marker}\``).join(', ')}.`,
        });
      }

      const missingStateHints = config.stateHints.filter(
        (hint) => !rawCode.includes(hint),
      );
      if (missingStateHints.length > 0) {
        issues.push({
          severity: 'high',
          message: `Approved ${config.label} section${matchingSections.length > 1 ? 's' : ''} must keep real interactive state wiring. Missing state hook/helper markers: ${missingStateHints.map((hint) => `\`${hint}\``).join(', ')}.`,
        });
      }

      if (
        config.type === 'carousel' &&
        !/translateX\s*\(/.test(rawCode) &&
        !/transform\s*:\s*['"`][^'"`]*translateX/i.test(rawCode)
      ) {
        issues.push({
          severity: 'high',
          message:
            'Approved carousel section must move the track with a state-driven `translateX(...)` transform instead of rendering a static slide list.',
        });
      }
    }

    if (sections.some((section) => section.type === 'modal')) {
      const hasActiveModalPopup =
        /className\s*=\s*\{?["'`][^"'`]*(?:\buagb-modal-popup\b[^"'`]*\bactive\b|\bactive\b[^"'`]*\buagb-modal-popup\b)/.test(
          rawCode,
        );
      if (!hasActiveModalPopup) {
        issues.push({
          severity: 'high',
          message:
            'Approved modal section renders a Spectra/UAGB popup without an `active` class on the open `.uagb-modal-popup` overlay. The compat CSS keeps `.uagb-modal-popup` hidden until `.active` is present, so the modal opens invisibly.',
        });
      }
    }

    return issues;
  }

  private findUnexpectedInteractiveUiPatterns(
    code: string,
    allowedSectionTypes: ReadonlySet<string>,
  ): string[] {
    const matches: string[] = [];
    const patterns: Array<{
      label: string;
      allowedType: string;
      test: RegExp;
    }> = [
      {
        label: 'tabs',
        allowedType: 'tabs',
        test: /\bactiveTabs\b|role=["']tablist["']|aria-selected=\{/,
      },
      {
        label: 'carousel',
        allowedType: 'carousel',
        test: /\bactiveCarousels\b|swiper-wrapper|swiper-button-prev|swiper-button-next/,
      },
      {
        label: 'modal',
        allowedType: 'modal',
        test: /\bopenModals\b|role=["']dialog["']|aria-modal=["']true["']/,
      },
      {
        label: 'accordion',
        allowedType: 'accordion',
        test: /\bopenAccordion|\bactiveAccordion|aria-expanded=\{/,
      },
    ];

    for (const pattern of patterns) {
      if (allowedSectionTypes.has(pattern.allowedType)) continue;
      if (pattern.test.test(code)) {
        matches.push(pattern.label);
      }
    }

    return matches;
  }

  private findCanonicalTextLinkSnippetsWithoutHoverUnderline(
    code: string,
    max = 3,
  ): string[] {
    const snippets: string[] = [];
    const tagPattern = /<(?:Link|a)\b[\s\S]{0,400}?>/g;

    for (const match of code.matchAll(tagPattern)) {
      const raw = match[0]?.replace(/\s+/g, ' ').trim();
      if (!raw || !/\bclassName=/.test(raw)) continue;
      if (/hover:underline/.test(raw) || /\bno-underline\b/.test(raw)) continue;
      const looksLikeButton =
        /\bbg-\[/.test(raw) ||
        (/\bpx-/.test(raw) && /\bpy-/.test(raw)) ||
        /\bjustify-center\b/.test(raw);
      if (looksLikeButton) continue;
      const isCanonicalTextLink =
        /\/(?:post|page|author|category|tag)\//.test(raw) ||
        /\bitem\.url\b/.test(raw) ||
        /\btoAppPath\(item\.url\)\b/.test(raw) ||
        /\bhref=["']https?:\/\//.test(raw);
      if (!isCanonicalTextLink) continue;
      snippets.push(raw.length > 180 ? `${raw.slice(0, 177)}...` : raw);
      if (snippets.length >= max) break;
    }

    return snippets;
  }

  private findPlainTextPostMetaArchiveSnippets(
    code: string,
    max = 3,
  ): string[] {
    return findSharedPlainTextPostMetaArchiveSnippets(code, max);
  }

  private isWithinSlugTernaryFallback(code: string, offset: number): boolean {
    const before = code.slice(Math.max(0, offset - 600), offset);
    return (
      /\bauthorSlug\s*\?/.test(before) ||
      /\bcategorySlugs(?:\?\.)?[^a-z]\[0\]\s*\?/.test(before) ||
      /\b(?:post|item|postDetail)\.author\s*&&/.test(before) ||
      /\b(?:post|item|postDetail)\.categories(?:\?\.)?(?:\[0\])?\s*&&/.test(
        before,
      )
    );
  }

  private isWithinHeadingTitleContext(code: string, offset: number): boolean {
    const start = Math.max(0, offset - 220);
    const before = code.slice(start, offset);
    const openHeading = before.match(/<h[1-6]\b[^>]*>/gi);
    const closeHeading = before.match(/<\/h[1-6]>/gi);
    // Only skip when literally inside an unclosed <h1>-<h6> element.
    // Do NOT check for word "title"/"heading" — appears in class names
    // like "post-title" and would incorrectly suppress the fix.
    return (openHeading?.length ?? 0) > (closeHeading?.length ?? 0);
  }

  private findTrailingInventedAuxiliaryHeadingSnippets(
    code: string,
    allowedAuxiliaryLabels: readonly string[],
    max = 3,
  ): string[] {
    const allowed = new Set(mergeAuxiliaryLabels(allowedAuxiliaryLabels));
    const matches = [...code.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
    if (matches.length === 0) return [];

    const snippets: string[] = [];
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      const rawHeading = (match[2] ?? '')
        .replace(/\{[^}]+\}/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawHeading) continue;

      const label = getExactInventedAuxiliaryLabel(rawHeading);
      if (!label || allowed.has(label)) continue;

      const position = match.index ?? 0;
      const isTrailing =
        index >= matches.length - 2 ||
        position >= Math.floor(code.length * 0.6);
      if (!isTrailing) continue;

      const snippet = `\`${rawHeading}\``;
      if (!snippets.includes(snippet)) {
        snippets.push(snippet);
      }
      if (snippets.length >= max) break;
    }

    return snippets;
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
      'approved card-grid',
      'expected card headings',
      'missing:',
      'duplicated route prefix',
      'extra `/page` segment',
      'menu links must use canonical `item.url` directly',
      'invented trailing auxiliary section',
      'auxiliary/footer/sidebar-like page sections are invalid unless source-backed',
      'does not render the fetched `page.content`/`item.content` body',
      'renders unexpected interactive ui not approved by the visual plan',
      'narrow centered article shell',
      'main article + sidebar structure',
      'invented placeholder copy',
      'comment-filter search ui',
      'must preserve spectra/uagb-compatible markers',
      'must keep real interactive state wiring',
      'approved carousel section must move the track',
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
    if (!logPath || logPath.endsWith('.json')) return;
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // never crash pipeline because of log failure
    }
  }
}
