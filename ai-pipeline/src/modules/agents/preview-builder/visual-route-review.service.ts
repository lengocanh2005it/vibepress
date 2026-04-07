import { OPENAI_CLIENT } from '../../../common/providers/openai/openai.provider.js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import puppeteer from 'puppeteer';
import { mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { GeneratedComponent } from '../react-generator/react-generator.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import type {
  PreviewBuilderResult,
  PreviewRouteEntry,
} from './preview-builder.service.js';

interface RouteSnapshotMetrics {
  textLength: number;
  imageCount: number;
  linkCount: number;
  sectionCount: number;
  scrollHeight: number;
  headings: string[];
}

export interface VisualReviewIssue {
  componentName: string;
  severity: 'low' | 'medium' | 'high';
  feedback: string;
}

export interface VisualReviewTarget {
  route: string;
  routePattern: string;
  componentName: string;
}

export interface VisualReviewResult {
  route: string;
  routePattern: string;
  componentName: string;
  cheapDiffScore: number;
  skipped: boolean;
  summary?: string;
  issues: VisualReviewIssue[];
  artifacts: {
    wpScreenshotPath: string;
    previewScreenshotPath: string;
  };
}

interface SnapshotCapture {
  screenshotPath: string;
  metrics: RouteSnapshotMetrics;
}

@Injectable()
export class VisualRouteReviewService {
  private readonly logger = new Logger(VisualRouteReviewService.name);

  constructor(
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
    private readonly configService: ConfigService,
  ) {}

  async reviewRoutes(input: {
    jobId: string;
    preview: PreviewBuilderResult;
    wpBaseUrl: string;
    plan: PlanResult;
    components: GeneratedComponent[];
    content: DbContentResult;
    logPath?: string;
    modelName?: string;
  }): Promise<VisualReviewResult[]> {
    const { jobId, preview, wpBaseUrl, plan, components, content, modelName } =
      input;
    const targets = await this.resolveTargets({
      preview,
      content,
      maxRoutes: this.configService.get<number>('visualReview.maxRoutes') ?? 4,
    });
    if (targets.length === 0) {
      return [];
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox'],
    });
    const results: VisualReviewResult[] = [];
    const artifactRoot = join(preview.previewDir, 'artifacts', 'visual');
    await mkdir(artifactRoot, { recursive: true });

    try {
      for (const target of targets) {
        const routeKey = this.routeToArtifactKey(target.route);
        const routeDir = join(artifactRoot, routeKey);
        await mkdir(routeDir, { recursive: true });

        const wpUrl = new URL(
          target.route,
          this.ensureTrailingSlash(wpBaseUrl),
        ).toString();
        const previewUrl = new URL(target.route, preview.previewUrl).toString();
        const wpScreenshotPath = join(routeDir, 'wp.png');
        const previewScreenshotPath = join(routeDir, 'preview.png');

        const [wpSnapshot, previewSnapshot] = await Promise.all([
          this.captureRoute(browser, wpUrl, wpScreenshotPath),
          this.captureRoute(browser, previewUrl, previewScreenshotPath),
        ]);

        const cheapDiffScore = this.computeCheapDiffScore(
          wpSnapshot.metrics,
          previewSnapshot.metrics,
        );
        const threshold =
          this.configService.get<number>('visualReview.minCheapDiffScore') ??
          0.35;

        if (cheapDiffScore < threshold) {
          results.push({
            route: target.route,
            routePattern: target.routePattern,
            componentName: target.componentName,
            cheapDiffScore,
            skipped: true,
            issues: [],
            summary:
              'Cheap route diff is below threshold; skipped vision review.',
            artifacts: { wpScreenshotPath, previewScreenshotPath },
          });
          continue;
        }

        const candidateComponents = this.buildCandidateComponents(
          target.componentName,
          components,
        );
        const issues = await this.reviewWithVision({
          route: target.route,
          routePattern: target.routePattern,
          componentName: target.componentName,
          plan,
          wpScreenshotPath,
          previewScreenshotPath,
          wpMetrics: wpSnapshot.metrics,
          previewMetrics: previewSnapshot.metrics,
          components,
          candidateComponents,
          modelName:
            modelName ??
            this.configService.get<string>('visualReview.model') ??
            'gpt-4o',
        });

        results.push({
          route: target.route,
          routePattern: target.routePattern,
          componentName: target.componentName,
          cheapDiffScore,
          skipped: false,
          issues,
          summary:
            issues.length > 0
              ? `Vision review found ${issues.length} issue(s).`
              : 'Vision review did not find actionable component-level issues.',
          artifacts: { wpScreenshotPath, previewScreenshotPath },
        });
      }
    } finally {
      await browser.close();
    }

    return results;
  }

  private async resolveTargets(input: {
    preview: PreviewBuilderResult;
    content: DbContentResult;
    maxRoutes: number;
  }): Promise<VisualReviewTarget[]> {
    const { preview, content, maxRoutes } = input;
    const preferredPatterns = [
      '/',
      '/page/:slug',
      '/post/:slug',
      '/archive',
      '/category/:slug',
      '/search',
    ];
    const byPattern = new Map<string, PreviewRouteEntry>();
    for (const entry of preview.routeEntries) {
      if (entry.route === '*') continue;
      if (!byPattern.has(entry.route)) {
        byPattern.set(entry.route, entry);
      }
    }

    const orderedPatterns = [
      ...preferredPatterns.filter((route) => byPattern.has(route)),
      ...Array.from(byPattern.keys()).filter(
        (route) => !preferredPatterns.includes(route),
      ),
    ];

    const targets: VisualReviewTarget[] = [];
    for (const pattern of orderedPatterns) {
      const entry = byPattern.get(pattern);
      if (!entry) continue;
      const concreteRoute = await this.resolveConcreteRoute(pattern, content);
      if (!concreteRoute) continue;
      targets.push({
        route: concreteRoute,
        routePattern: pattern,
        componentName: entry.componentName,
      });
      if (targets.length >= maxRoutes) break;
    }

    return targets;
  }

  private async resolveConcreteRoute(
    routePattern: string,
    content: DbContentResult,
  ): Promise<string | null> {
    if (!routePattern.includes(':')) {
      return routePattern;
    }

    if (routePattern === '/page/:slug') {
      return content.pages[0]?.slug ? `/page/${content.pages[0].slug}` : null;
    }
    if (routePattern === '/post/:slug') {
      return content.posts[0]?.slug ? `/post/${content.posts[0].slug}` : null;
    }
    if (routePattern === '/category/:slug') {
      const category = content.taxonomies.find(
        (tax) => tax.taxonomy === 'category',
      );
      const slug = category?.terms[0]?.slug;
      return slug ? `/category/${slug}` : null;
    }
    return null;
  }

  private async captureRoute(
    browser: Awaited<ReturnType<typeof puppeteer.launch>>,
    url: string,
    screenshotPath: string,
  ): Promise<SnapshotCapture> {
    const page = await browser.newPage();
    try {
      await page.setViewport({
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
      });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
      await page.addStyleTag({
        content:
          '#wpadminbar{display:none !important;} html{margin-top:0 !important;} body{margin-top:0 !important;}',
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      // Capture above-the-fold + one scroll (approx 2x viewport) to keep image size manageable
      // while still showing the most visually important part of each route.
      await page.screenshot({
        path: screenshotPath,
        clip: { x: 0, y: 0, width: 1440, height: 1800 },
      });
      const metrics = (await page.evaluate(() => {
        const text = document.body?.innerText ?? '';
        const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
          .map((node) => (node.textContent ?? '').trim())
          .filter(Boolean)
          .slice(0, 8);
        return {
          textLength: text.replace(/\s+/g, ' ').trim().length,
          imageCount: document.querySelectorAll('img').length,
          linkCount: document.querySelectorAll('a').length,
          sectionCount: document.querySelectorAll('main section, main article')
            .length,
          scrollHeight: Math.max(
            document.body?.scrollHeight ?? 0,
            document.documentElement?.scrollHeight ?? 0,
          ),
          headings,
        };
      })) as RouteSnapshotMetrics;
      return { screenshotPath, metrics };
    } finally {
      await page.close();
    }
  }

  private computeCheapDiffScore(
    wp: RouteSnapshotMetrics,
    preview: RouteSnapshotMetrics,
  ): number {
    const ratioGap = (a: number, b: number) => {
      if (a <= 0 && b <= 0) return 0;
      const max = Math.max(a, b, 1);
      return Math.min(1, Math.abs(a - b) / max);
    };
    const headingOverlap = this.jaccardSimilarity(
      wp.headings,
      preview.headings,
    );

    return (
      ratioGap(wp.textLength, preview.textLength) * 0.3 +
      ratioGap(wp.imageCount, preview.imageCount) * 0.2 +
      ratioGap(wp.linkCount, preview.linkCount) * 0.15 +
      ratioGap(wp.sectionCount, preview.sectionCount) * 0.15 +
      ratioGap(wp.scrollHeight, preview.scrollHeight) * 0.1 +
      (1 - headingOverlap) * 0.1
    );
  }

  private async reviewWithVision(input: {
    route: string;
    routePattern: string;
    componentName: string;
    plan: PlanResult;
    wpScreenshotPath: string;
    previewScreenshotPath: string;
    wpMetrics: RouteSnapshotMetrics;
    previewMetrics: RouteSnapshotMetrics;
    components: GeneratedComponent[];
    candidateComponents: string[];
    modelName: string;
  }): Promise<VisualReviewIssue[]> {
    const {
      route,
      routePattern,
      componentName,
      plan,
      wpScreenshotPath,
      previewScreenshotPath,
      wpMetrics,
      previewMetrics,
      components,
      candidateComponents,
      modelName,
    } = input;
    const componentMap = new Map(
      components.map((component) => [component.name, component]),
    );
    const focusComponents = candidateComponents
      .map((name) => componentMap.get(name))
      .filter((component): component is GeneratedComponent => !!component);
    const relevantPlan = plan.filter((entry) =>
      candidateComponents.includes(entry.componentName),
    );

    const systemPrompt =
      'You are a strict visual QA reviewer for a WordPress-to-React migration. ' +
      'The FIRST image is the original WordPress site (source of truth). The SECOND image is the React preview to fix. ' +
      'Compare them and return ONLY JSON. ' +
      'Focus on: missing sections, wrong section order, layout/spacing mismatches, wrong colors, missing images, broken navigation. ' +
      'Ignore pixel-perfect differences that do not affect perceived layout. ' +
      'Every issue must target one componentName from the allowed list. ' +
      'feedback MUST be concrete enough for a code-fix model to act on — include the specific Tailwind classes, ' +
      'CSS values, or structural change needed (e.g. "Change py-16 to py-8 on the hero wrapper", ' +
      '"Add a grid-cols-3 card section below the hero", "Header is missing the site logo — add a <Link to=\\"/\\"> with site name").';
    const userText = [
      `Route under review: ${route} (pattern: ${routePattern})`,
      `Primary page component: ${componentName}`,
      `Allowed component names: ${candidateComponents.join(', ')}`,
      `WordPress metrics: ${JSON.stringify(wpMetrics)}`,
      `Preview metrics: ${JSON.stringify(previewMetrics)}`,
      `Relevant component plan: ${JSON.stringify(
        relevantPlan.map((entry) => ({
          componentName: entry.componentName,
          type: entry.type,
          route: entry.route,
          isDetail: entry.isDetail,
          dataNeeds: entry.dataNeeds,
          visualPlan: entry.visualPlan
            ? {
                dataNeeds: entry.visualPlan.dataNeeds,
                sections: entry.visualPlan.sections.map((section) => ({
                  type: section.type,
                })),
              }
            : null,
        })),
      )}`,
      'Relevant component code:',
      ...focusComponents.map(
        (component) =>
          `\n### ${component.name}\n${component.code.slice(0, 8000)}`,
      ),
      '',
      'Return JSON in this shape:',
      '{"summary":"...","issues":[{"componentName":"Home","severity":"high","feedback":"Concrete instruction for the fixer model"}]}',
      'Rules:',
      '- componentName must be from the allowed list.',
      '- feedback must include specific Tailwind classes or structural changes — vague feedback like "fix the spacing" is not acceptable.',
      '- Prioritize issues by visual impact: missing sections > wrong layout > wrong colors/fonts > minor spacing.',
      '- If there is no actionable issue, return {"summary":"...","issues":[]}.',
    ].join('\n');

    const [wpDataUrl, previewDataUrl] = await Promise.all([
      this.fileToDataUrl(wpScreenshotPath),
      this.fileToDataUrl(previewScreenshotPath),
    ]);

    const resolvedModel = modelName.replace(/^openai\//, '');
    const response = await this.openai.chat.completions.create({
      model: resolvedModel,
      temperature: 0,
      max_completion_tokens: 1600,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            {
              type: 'image_url',
              image_url: { url: wpDataUrl, detail: 'high' },
            },
            {
              type: 'image_url',
              image_url: { url: previewDataUrl, detail: 'high' },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = this.parseVisionJson(raw);
    if (!parsed) {
      this.logger.warn(
        `[visual-review] ${route} returned non-JSON output from ${resolvedModel}; ignoring response`,
      );
    }
    const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];

    return issues
      .filter(
        (issue: any) =>
          typeof issue?.componentName === 'string' &&
          candidateComponents.includes(issue.componentName) &&
          typeof issue?.feedback === 'string' &&
          issue.feedback.trim().length > 0,
      )
      .map((issue: any) => ({
        componentName: issue.componentName,
        severity:
          issue.severity === 'low' ||
          issue.severity === 'medium' ||
          issue.severity === 'high'
            ? issue.severity
            : 'medium',
        feedback: issue.feedback.trim(),
      }));
  }

  private buildCandidateComponents(
    routeComponentName: string,
    components: GeneratedComponent[],
  ): string[] {
    const priorityMatches =
      /^(Header|Footer|Sidebar|Nav|Navigation|Breadcrumb|PostMeta|Comments|Searchform|Layout)$/i;
    const routeSectionPattern = new RegExp(
      `^${routeComponentName}Section\\d+$`,
    );
    const names = new Set<string>([routeComponentName]);
    for (const component of components) {
      if (
        priorityMatches.test(component.name) ||
        routeSectionPattern.test(component.name)
      ) {
        names.add(component.name);
      }
    }
    return [...names];
  }

  private jaccardSimilarity(left: string[], right: string[]): number {
    const a = new Set(left.map((value) => value.toLowerCase()));
    const b = new Set(right.map((value) => value.toLowerCase()));
    if (a.size === 0 && b.size === 0) return 1;
    const intersection = [...a].filter((value) => b.has(value)).length;
    const union = new Set([...a, ...b]).size || 1;
    return intersection / union;
  }

  private async fileToDataUrl(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  }

  private parseVisionJson(raw: string): any {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = fenced?.[1] ?? trimmed;
    for (const candidate of [
      jsonText,
      this.extractLikelyJsonObject(jsonText),
      this.extractLikelyJsonObject(trimmed),
    ]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
    return null;
  }

  private extractLikelyJsonObject(raw: string): string | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return raw.slice(start, end + 1);
  }

  private routeToArtifactKey(route: string): string {
    return (
      route
        .replace(/^\//, '')
        .replace(/[^a-z0-9/_-]+/gi, '-')
        .replace(/\//g, '__') || 'home'
    );
  }

  private ensureTrailingSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
  }
}
