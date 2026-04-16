import { Injectable, Logger } from '@nestjs/common';
import { appendFile } from 'fs/promises';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { TokenTracker } from '../../../common/utils/token-tracker.js';
import type { PlanResult } from '../planner/planner.service.js';
import { ValidatorService } from '../validator/validator.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type { CardGridSection } from './visual-plan.schema.js';
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

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly validator: ValidatorService,
  ) {}

  async review(input: {
    components: GeneratedComponent[];
    plan: PlanResult;
    modelName?: string;
    mode?: 'warn' | 'blocking';
    logPath?: string;
    jobId?: string;
  }): Promise<GeneratedCodeReviewResult> {
    const {
      components,
      plan,
      modelName,
      mode = 'warn',
      logPath,
      jobId,
    } = input;
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
      const sanitizedComponent: GeneratedComponent = {
        ...component,
        code: this.validator.sanitizeGeneratedCode(component.code),
      };
      const contract =
        plan.find((item) => item.componentName === component.name) ?? null;
      const review = await this.reviewComponent(
        sanitizedComponent,
        contract,
        plan,
        resolvedModel,
        logPath,
        jobId,
      );
      const effectiveReview = this.applyDeterministicIssues(
        review,
        sanitizedComponent,
        contract,
      );

      const blockingIssues = this.getBlockingIssues(
        effectiveReview,
        sanitizedComponent,
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
    jobId?: string,
  ): Promise<CodeReviewResult> {
    const reviewPrompt = this.buildReviewPrompt(component, contract, plan);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text, inputTokens, outputTokens } = await this.llmFactory.chat({
        model: modelName,
        systemPrompt:
          'You are a strict senior React reviewer. Review generated TSX against the approved contract. Return ONLY valid JSON.',
        userPrompt: reviewPrompt,
        maxTokens: 2000,
        jobId,
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
- Do NOT fail only because fetched data is unused unless it clearly indicates a wrong endpoint or broken logic.
 - Do NOT flag subjective styling preferences, but DO flag material layout rewrites such as invented hero/promo sections, centered redesigns, missing sidebars, obviously different wrapper structure from the approved plan, or typography that is materially inflated beyond the approved/source visual weight (for example giant display headings or oversized menu/body text in an otherwise modest WordPress template).
 - If the template/source clearly includes an important screenshot, product composite, UI mockup, or other full illustrative image, DO flag fixed-height \`object-cover\` cropping when it visibly cuts off meaningful content that should remain visible.
 - If a media-text/photo section in the approved/source layout clearly uses rounded image corners or strong heading/list emphasis, DO flag generated code that flattens those into sharp-corner images or weak muted regular-weight text.
- Do NOT require exact text/copy matching unless the code is clearly unrelated.
- For runtime-title components, do NOT treat one leaked sample title from the approved plan as a hard literal requirement. Archive/search headings may be dynamic (\`Archive\`, \`Category: ...\`, \`Author: ...\`, \`Tag: ...\`, \`Search\`), and generic detail routes may render the fetched record title (\`item.title\`, \`post.title\`, etc.) instead of a sample label like \`About\`.
- Known app routes are authoritative. Do NOT flag a route/link as risky if it matches one of the known routes below.
- Treat concrete links like \`/post/\${slug}\` or \`/category/\${slug}\` as valid when they correspond to approved patterns such as \`/post/:slug\` or \`/category/:slug\`.
- Do flag visible text links that should behave like WordPress navigation/content links but stay plain text or omit hover underline when the route/data already exists, especially for post titles, author/category archive links inside meta rows, menu/footer/sidebar links, breadcrumbs, and social/footer text links. CTA buttons are exempt.
- If the approved plan or preserved HTML body includes WordPress/Spectra-style tabs, do flag tabs that behave like plain links/text instead of real tabs. Match WordPress interaction cues: if labels are underlined at rest, hover/focus should remove that underline, and keyboard focus should show a visible tab border/outline/ring.
- Do NOT flag \`{condition && (<JSX />)}\` or \`{a && b && (<JSX />)}\` as broken JSX — these are standard React conditional rendering patterns. Only flag JSX as broken when there is an actual syntax error, unclosed tag, or raw object literal returned inside JSX.
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
- approved visual section details:
${this.buildVisualSectionDetailLines(component, contract)}
- known app routes:
${knownRoutes}
- allowed API expectations:
${this.buildApiContractLines(dataNeeds, isDetail, visualSectionTypes, isArchive)}

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
    if (normalized.has('menus')) lines.push('- /api/menus');
    if (normalized.has('footer-links')) lines.push('- /api/footer-links');
    if (normalized.has('posts') || normalized.has('authorDetail'))
      lines.push('- /api/posts');
    if (normalized.has('pages')) lines.push('- /api/pages');
    if (normalized.has('post-detail'))
      lines.push('- /api/posts/${slug} only for post-detail routes');
    if (normalized.has('page-detail'))
      lines.push('- /api/pages/${slug} only for page-detail routes');
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

  private formatSourceLayoutSummary(layout: {
    type?: string;
    contentSize?: string;
    wideSize?: string;
  }): string {
    const parts = [layout.type].filter(Boolean);
    if (layout.contentSize) {
      parts.push(`content=${layout.contentSize}`);
    }
    if (layout.wideSize) {
      parts.push(`wide=${layout.wideSize}`);
    }
    return parts.join(',');
  }

  private buildVisualSectionDetailLines(
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
  ): string {
    const sections = contract?.visualPlan?.sections ?? [];
    if (sections.length === 0) return '- (none)';
    const runtimeHeading = this.usesRuntimeHeadingContract(component, contract);

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
          const parts = [
            runtimeHeading
              ? '- hero heading=(runtime title allowed)'
              : `- hero heading="${section.heading}"`,
            `layout=${section.layout}`,
          ];
          if (section.subheading) {
            parts.push(`subheading="${section.subheading}"`);
          }
          if (section.cta?.text) {
            parts.push(`ctaText="${section.cta.text}"`);
          }
          if (section.contentWidth) {
            parts.push(`contentWidth="${section.contentWidth}"`);
          }
          if (section.paddingStyle) {
            parts.push(`paddingStyle="${section.paddingStyle}"`);
          }
          if (section.gapStyle) {
            parts.push(`gapStyle="${section.gapStyle}"`);
          }
          return parts.join(' ');
        }
        if (section.type === 'cover') {
          return runtimeHeading
            ? `- cover heading=(runtime title allowed) image="${section.imageSrc}"`
            : `- cover heading="${section.heading ?? ''}" image="${section.imageSrc}"`;
        }
        if (section.type === 'media-text') {
          return runtimeHeading
            ? `- media-text heading=(runtime title allowed) image="${section.imageSrc}"`
            : `- media-text heading="${section.heading ?? ''}" image="${section.imageSrc}"`;
        }
        if (section.type === 'post-list') {
          return `- post-list layout=${section.layout}`;
        }
        if (section.type === 'tabs') {
          const labels = section.tabs.map((t) => t.label).join(' | ');
          return `- tabs tabCount=${section.tabs.length}${labels ? ` labels="${labels}"` : ''}`;
        }
        if (section.type === 'slider') {
          const parts = [`- slider slideCount=${section.slides.length}`];
          const headings = section.slides
            .map((s) => s.heading?.trim())
            .filter(Boolean)
            .join(' | ');
          if (headings) {
            parts.push(`headings="${headings}"`);
          }
          if (typeof section.autoplay === 'boolean') {
            parts.push(`autoplay=${section.autoplay}`);
          }
          if (section.contentWidth) {
            parts.push(`contentWidth="${section.contentWidth}"`);
          }
          if (section.paddingStyle) {
            parts.push(`paddingStyle="${section.paddingStyle}"`);
          }
          if (section.gapStyle) {
            parts.push(`gapStyle="${section.gapStyle}"`);
          }
          if (section.sourceLayout) {
            parts.push(
              `sourceLayout=${this.formatSourceLayoutSummary(section.sourceLayout)}`,
            );
          }
          return parts.join(' ');
        }
        if (section.type === 'modal') {
          return `- modal triggerText="${section.triggerText ?? ''}"${section.heading ? ` heading="${section.heading}"` : ''}`;
        }
        if (section.type === 'accordion') {
          return `- accordion itemCount=${section.items.length}`;
        }
        if (section.type === 'button-group') {
          const labels = section.buttons
            .map((button) => button.text)
            .join(' | ');
          return `- button-group buttonCount=${section.buttons.length}${labels ? ` labels="${labels}"` : ''}`;
        }
        return `- ${section.type}`;
      })
      .join('\n');
  }

  private usesRuntimeHeadingContract(
    component: GeneratedComponent,
    contract: PlanResult[number] | null,
  ): boolean {
    const route = contract?.route ?? component.route ?? '';
    const rawDataNeeds = contract?.dataNeeds ?? component.dataNeeds ?? [];
    const normalizedNeeds = new Set(
      rawDataNeeds.map((value) => {
        switch (value) {
          case 'postDetail':
            return 'post-detail';
          case 'pageDetail':
            return 'page-detail';
          default:
            return value;
        }
      }),
    );

    return (
      component.name === 'Archive' ||
      component.name === 'Search' ||
      normalizedNeeds.has('page-detail') ||
      normalizedNeeds.has('post-detail') ||
      route === '/archive' ||
      route === '/search' ||
      /\/:(slug|id)\b/.test(route) ||
      /\/page(?:-[^/]+)?\/:slug$/.test(route) ||
      /\/post\/:slug$/.test(route)
    );
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

    if (sections.length === 0) return issues;

    const trackedSections = sections
      .filter((section) => !!section.sourceRef?.sourceNodeId)
      .map((section, index) => ({
        section,
        sectionKey:
          section.sectionKey ??
          `${section.type}${index === 0 ? '' : `-${index}`}`,
      }));
    if (trackedSections.length > 0) {
      const missingTrackedWrappers = trackedSections.filter(
        ({ sectionKey }) =>
          !component.code.includes(`data-vp-section-key="${sectionKey}"`),
      );

      if (missingTrackedWrappers.length > 0) {
        const missingKeys = missingTrackedWrappers.map(
          ({ sectionKey }) => sectionKey,
        );
        issues.push({
          severity: 'high',
          message: `Generated code is missing required tracked wrapper markers for approved sections: ${missingKeys.join(', ')}. Each approved section with a source node must keep its own top-level wrapper with the exact \`data-vp-*\` attributes, otherwise section boundaries can collapse or merge incorrectly.`,
        });
      }
    }

    for (const { section, sectionKey } of trackedSections) {
      const needsStructuredStackSpacing =
        (section.type === 'hero' &&
          section.layout !== 'split' &&
          !!section.subheading?.trim() &&
          !!section.cta?.text?.trim()) ||
        (section.type === 'newsletter' &&
          !!section.subheading?.trim() &&
          !!section.buttonText?.trim());
      if (!needsStructuredStackSpacing) continue;

      const sectionMarkup = this.findTrackedSectionMarkup(
        component.code,
        sectionKey,
      );
      if (!sectionMarkup) continue;

      if (this.sectionMarkupHasGenericSpacerDivs(sectionMarkup)) {
        issues.push({
          severity: 'high',
          message: `Approved ${section.type} section "${sectionKey}" relies on empty spacer divs instead of preserving the source stack spacing between heading/body/CTA. Replace placeholder blocks like \`<div className="h-[1rem]" />\` with real gap/margin spacing on the content elements.`,
        });
        continue;
      }

      if (!this.sectionMarkupHasStructuredStackSpacing(sectionMarkup)) {
        issues.push({
          severity: 'high',
          message: `Approved ${section.type} section "${sectionKey}" materially compresses the vertical rhythm of its heading/body/CTA stack. Keep visible separation with real \`gap-*\`, \`space-y-*\`, or explicit margins so the CTA does not sit flush against the paragraph.`,
        });
      }
    }

    for (const expectation of component.requiredSectionExpectations ?? []) {
      const normalizedSnippets = [
        ...new Set(
          (expectation.requiredTextSnippets ?? [])
            .map((value) => this.normalizeForTextMatch(value))
            .filter(Boolean),
        ),
      ];
      if (normalizedSnippets.length === 0) continue;
      const matched = normalizedSnippets.filter((snippet) =>
        normalizedCode.includes(snippet),
      );
      const minMatches =
        expectation.minTextMatches ?? normalizedSnippets.length;
      if (matched.length >= minMatches) continue;
      const missing = normalizedSnippets.filter(
        (snippet) => !matched.includes(snippet),
      );
      issues.push({
        severity: 'high',
        message: `Approved ${expectation.sectionType} section "${expectation.sectionKey}" is materially incomplete in generated code: matched ${matched.length}/${minMatches} required source snippet(s). Missing: ${missing.join(', ')}.`,
      });
    }

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

    const requiredMenuSlug =
      component.requiredMenuSlug?.trim() ||
      sections
        .find(
          (
            section,
          ): section is Extract<
            (typeof sections)[number],
            { type: 'navbar' }
          > => section.type === 'navbar' && !!section.menuSlug?.trim(),
        )
        ?.menuSlug?.trim();
    const isHeaderLikePartial = /^(Header|Navigation|Nav)$/i.test(
      contract?.componentName ?? component.name,
    );
    const declaresMenus = (
      contract?.dataNeeds ??
      component.dataNeeds ??
      []
    ).some((need) => /^(menus|menu)$/i.test(need));
    if (isHeaderLikePartial && declaresMenus && requiredMenuSlug) {
      const hasRequiredMenuSelection =
        new RegExp(
          `location\\s*===\\s*['"]${this.escapeRegExp(requiredMenuSlug)}['"]`,
        ).test(component.code) ||
        new RegExp(
          `slug\\s*===\\s*['"]${this.escapeRegExp(requiredMenuSlug)}['"]`,
        ).test(component.code);
      if (!hasRequiredMenuSelection) {
        issues.push({
          severity: 'high',
          message: `Approved header/navigation menu slug is \`${requiredMenuSlug}\`, but the generated code does not prefer that slug before generic fallbacks. Select \`menus.find(m => m.location === "${requiredMenuSlug}") ?? menus.find(m => m.slug === "${requiredMenuSlug}")\` before falling back to \`primary\` or \`menus[0]\`.`,
        });
      }
    }

    const isFooterPartial = /^(Footer)(?:[-_].+)?$/i.test(
      contract?.componentName ?? component.name,
    );
    if (isFooterPartial) {
      if (!/fetch\(\s*['"`]\/api\/footer-links\b/.test(component.code)) {
        issues.push({
          severity: 'high',
          message:
            'Footer partial must fetch `/api/footer-links` and render footer columns from that endpoint instead of hardcoding plain text column items.',
        });
      }

      const hasClickableFooterLinkRender =
        /<Link\b[\s\S]{0,240}?\bto=\{(?:[^}]*\b(?:link|item)\.url[^}]*)\}/.test(
          component.code,
        ) ||
        /<Link\b[\s\S]{0,240}?\bto=\{(?:[^}]*toAppPath\((?:link|item)\.url\)[^}]*)\}/.test(
          component.code,
        ) ||
        /<a\b[\s\S]{0,240}?\bhref=\{(?:[^}]*\b(?:link|item)\.url[^}]*)\}/.test(
          component.code,
        );
      const hasPlainTextFooterItems =
        /<span\b[\s\S]{0,240}?>\s*\{(?:link|item)\.(?:label|title)\}\s*<\/span>/.test(
          component.code,
        );
      if (!hasClickableFooterLinkRender || hasPlainTextFooterItems) {
        issues.push({
          severity: 'high',
          message:
            'Footer link columns must render each `/api/footer-links` item as a clickable `<Link>` or `<a>` using its `url`. Plain text `<span>{link.label}</span>` footer items are not acceptable.',
        });
      }
    }

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

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private findTrackedSectionMarkup(
    code: string,
    sectionKey: string,
  ): string | null {
    const pattern = new RegExp(
      `<section\\b[^>]*data-vp-section-key=["']${this.escapeRegExp(
        sectionKey,
      )}["'][\\s\\S]{0,8000}?<\\/section>`,
      'i',
    );
    return code.match(pattern)?.[0] ?? null;
  }

  private sectionMarkupHasStructuredStackSpacing(markup: string): boolean {
    return (
      /\b(?:gap|space-y)-(?:\[[^\]]+\]|[A-Za-z0-9:/.-]+)/.test(markup) ||
      /\b(?:mt|mb)-(?:\[[^\]]+\]|[A-Za-z0-9:/.-]+)/.test(markup) ||
      /\b(?:gap|rowGap|marginTop|marginBottom)\s*:\s*['"][^'"]+['"]/.test(
        markup,
      )
    );
  }

  private sectionMarkupHasGenericSpacerDivs(markup: string): boolean {
    return /<div\b[^>]*className="[^"]*\b(?:h|min-h)-(?:\[[^\]]+\]|[A-Za-z0-9:/.-]+)[^"]*"[^>]*>\s*<\/div>/i.test(
      markup,
    );
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
    const snippets: string[] = [];
    const patterns = [
      {
        pattern:
          /<(span|p)\b[\s\S]{0,200}?>\s*\{(post|item|postDetail)\.author\}\s*<\/\1>/g,
        allowHeadingContext: true,
      },
      {
        pattern:
          /<span\b[\s\S]{0,200}?>\s*\{(?:post|item|postDetail)\.categories(?:\?\.)?\[0\](?:\s*\?\?\s*'')?\}\s*<\/span>/g,
        allowHeadingContext: false,
      },
      {
        pattern:
          /\{(?:post|item|postDetail)\.categories\?\.map\(\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\(\s*<span\b[\s\S]{0,240}?>\s*\{\w+\}\s*<\/span>\s*\)\)\}/g,
        allowHeadingContext: false,
      },
    ];

    for (const { pattern, allowHeadingContext } of patterns) {
      for (const match of code.matchAll(pattern)) {
        const raw = match[0]?.replace(/\s+/g, ' ').trim();
        if (!raw) continue;
        const offset = match.index ?? 0;
        if (
          allowHeadingContext &&
          this.isWithinHeadingTitleContext(code, offset)
        ) {
          continue;
        }
        if (this.isWithinSlugTernaryFallback(code, offset)) continue;
        snippets.push(raw.length > 180 ? `${raw.slice(0, 177)}...` : raw);
        if (snippets.length >= max) return snippets;
      }
      if (snippets.length >= max) break;
    }

    return snippets;
  }

  private isWithinSlugTernaryFallback(code: string, offset: number): boolean {
    const before = code.slice(Math.max(0, offset - 1400), offset);
    const isFallbackFor = (pattern: RegExp): boolean => {
      const matches = [...before.matchAll(pattern)];
      const last = matches.at(-1);
      if (last?.index == null) return false;
      const tail = before.slice(last.index);
      return /:\s*(?:\(\s*)?(?:\{\s*)?(?:<>\s*)?$/.test(tail);
    };

    return (
      isFallbackFor(/\bauthorSlug\s*\?/g) ||
      isFallbackFor(/\bcategorySlugs(?:\?\.)?\[0\]\s*\?/g)
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
      'missing required tracked wrapper markers',
      'data-vp-*',
      'section boundaries can collapse',
      'duplicated route prefix',
      'extra `/page` segment',
      'menu links must use canonical `item.url` directly',
      'approved header/navigation menu slug',
      'invented trailing auxiliary section',
      'auxiliary/footer/sidebar-like page sections are invalid unless source-backed',
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
