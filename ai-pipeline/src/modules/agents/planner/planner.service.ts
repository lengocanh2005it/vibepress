import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import type {
  BlockParseResult,
  ThemeTokens,
  ThemeDefaults,
} from '../block-parser/block-parser.service.js';
import {
  buildVisualPlanPrompt,
  extractStaticImageSources,
  parseVisualPlanDetailed,
} from '../react-generator/prompts/visual-plan.prompt.js';
import type {
  ComponentVisualPlan,
  ColorPalette,
  TypographyTokens,
  LayoutTokens,
} from '../react-generator/visual-plan.schema.js';

export interface ComponentPlan {
  templateName: string;
  componentName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  isDetail: boolean;
  description: string;
  /** Pre-computed visual plan from Phase B — generator skips Stage 1 if present */
  visualPlan?: ComponentVisualPlan;
}

export type PlanResult = ComponentPlan[];

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly rawOutputDivider = '\n----- RAW OUTPUT BEGIN -----\n';

  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
  ) {}

  async plan(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    modelName?: string,
  ): Promise<PlanResult> {
    // Build source map for layer 2 enrichment and Phase B
    const sourceMap = new Map<string, string>();
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    for (const t of allTemplates) {
      sourceMap.set(t.name, 'markup' in t ? t.markup : t.html);
    }

    const resolvedModel = modelName ?? this.llmFactory.getModel();

    const templateNames =
      theme.type === 'classic'
        ? theme.templates.map((t) => t.name)
        : [...theme.templates, ...theme.parts].map((t) => t.name);

    // ── Phase A: architecture plan ─────────────────────────────────────────
    this.logger.log(
      `[Phase A] Planning architecture for ${templateNames.length} components in "${content.siteInfo.siteName}"`,
    );

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(theme, content, templateNames);

    let plan: PlanResult | null = null;
    let lastError = 'unknown parse failure';
    let lastRaw = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const prompt =
        attempt === 1
          ? userPrompt
          : this.buildRetryPrompt(lastRaw, templateNames);

      const { text: raw } = await this.llmFactory.chat({
        model: resolvedModel,
        systemPrompt,
        userPrompt: prompt,
        maxTokens: 4096,
      });

      lastRaw = raw;
      const parsed = this.tryParseResponseDetailed(raw, templateNames);
      plan = parsed.plan;
      if (!parsed.plan) lastError = parsed.reason;

      if (plan) {
        this.logger.log(
          `[Phase A] Received on attempt ${attempt}: ${plan.length} components`,
        );
        break;
      }

      this.logger.warn(
        `[Phase A] Attempt ${attempt}/3 failed: ${lastError}${this.formatRawOutput(raw)}`,
      );
    }

    if (!plan) {
      this.logger.warn(
        `[Phase A] All attempts failed, using fallback plan. Last error: ${lastError}${this.formatRawOutput(lastRaw)}`,
      );
      plan = this.buildFallbackPlan(templateNames);
    }

    // ── Phase B (C2): Component Graph Builder — deterministic, no AI ────────
    // Scans each template's source for navigation blocks, query blocks, etc.
    // to enrich component routes, data needs, and layout flags.
    this.logger.log(
      `[Phase B: Component Graph Builder] Enriching plan for ${plan.length} components`,
    );
    const enriched = this.enrichPlan(plan, sourceMap);
    this.logger.log(
      `[Phase B: Component Graph Builder] Done — ${enriched.filter((c) => c.route).length} routable, ` +
        `${enriched.filter((c) => c.dataNeeds?.includes('menus')).length} with menus`,
    );

    // ── Phase C (C3): AI Visual Sections ────────────────────────────────
    // AI generates a visual section plan (navbar/hero/footer/etc.) per component.
    // palette, typography, layout are injected deterministically from theme tokens.
    const tokens = theme.type === 'fse' ? theme.tokens : undefined;
    const globalPalette = this.deriveGlobalPalette(tokens);
    const globalTypography = this.deriveGlobalTypography(tokens);

    this.logger.log(
      `[Phase C: AI Visual Sections] Generating visual plans for ${enriched.length} components (palette + typography from theme tokens)`,
    );

    return this.buildVisualPlans(
      enriched,
      sourceMap,
      content,
      tokens,
      globalPalette,
      globalTypography,
      resolvedModel,
    );
  }

  // ── Phase C: AI visual plan per component ───────────────────────────

  private async buildVisualPlans(
    plan: PlanResult,
    sourceMap: Map<string, string>,
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
    globalPalette: ColorPalette,
    globalTypography: TypographyTokens,
    modelName: string,
  ): Promise<PlanResult> {
    const concurrency =
      this.configService.get<number>('planner.visualPlanConcurrency') ?? 3;
    const batchDelay =
      this.configService.get<number>('reactGenerator.delayBetweenComponents') ??
      3000;

    const result: PlanResult = new Array(plan.length);

    for (let batchStart = 0; batchStart < plan.length; batchStart += concurrency) {
      if (batchStart > 0) {
        await new Promise((res) => setTimeout(res, batchDelay));
      }

      const batch = plan.slice(batchStart, batchStart + concurrency);
      const batchResults = await Promise.all(
        batch.map((componentPlan) =>
          this.generateVisualPlanForComponent(
            componentPlan,
            sourceMap.get(componentPlan.templateName) ?? '',
            content,
            tokens,
            globalPalette,
            globalTypography,
            plan,
            modelName,
          ),
        ),
      );

      for (let j = 0; j < batchResults.length; j++) {
        result[batchStart + j] = batchResults[j];
      }

      this.logger.log(
        `[Phase C: AI Visual Sections] Batch ${Math.floor(batchStart / concurrency) + 1}/${Math.ceil(plan.length / concurrency)} done`,
      );
    }

    const withPlan = result.filter((c) => c.visualPlan).length;
    this.logger.log(
      `[Phase C: AI Visual Sections] Done: ${withPlan}/${result.length} components have pre-computed visual plans`,
    );

    return result;
  }

  private async generateVisualPlanForComponent(
    componentPlan: PlanResult[number],
    templateSource: string,
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
    globalPalette: ColorPalette,
    globalTypography: TypographyTokens,
    fullPlan: PlanResult,
    modelName: string,
  ): Promise<PlanResult[number]> {
    let visualPlan: ComponentVisualPlan | undefined;
    try {
      const { systemPrompt, userPrompt } = buildVisualPlanPrompt({
        componentName: componentPlan.componentName,
        templateSource,
        content,
        tokens,
      });

      const { text: raw } = await this.llmFactory.chat({
        model: modelName,
        systemPrompt,
        userPrompt,
        maxTokens: 4096,
      });

      const parsedResult = parseVisualPlanDetailed(
        raw,
        componentPlan.componentName,
        { allowedImageSrcs: extractStaticImageSources(templateSource) },
      );
      const parsed = parsedResult.plan;
      if (parsed) {
        const layout = this.deriveComponentLayout(
          tokens,
          componentPlan.componentName,
          fullPlan,
        );
        visualPlan = {
          ...parsed,
          palette: globalPalette,
          typography: globalTypography,
          layout,
        };
        this.logger.log(
          `[Phase C: AI Visual Sections] "${componentPlan.componentName}": ${parsed.sections.length} sections ✓`,
        );
      } else {
        const reason =
          parsedResult.diagnostic?.reason ?? 'unknown visual plan parse failure';
        const dropped = parsedResult.diagnostic?.droppedSections?.length
          ? ` | droppedSections: ${parsedResult.diagnostic.droppedSections.join('; ')}`
          : '';
        this.logger.warn(
          `[Phase C: AI Visual Sections] "${componentPlan.componentName}" plan parse failed: ${reason}${dropped} — generator will fallback to D3${this.formatRawOutput(raw)}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[Phase C: AI Visual Sections] "${componentPlan.componentName}" error: ${err?.message} — generator will fallback to D3`,
      );
    }

    return { ...componentPlan, visualPlan };
  }

  // ── Global typography: deterministic from theme tokens, no AI ────────────

  private deriveGlobalTypography(tokens?: ThemeTokens): TypographyTokens {
    const d: ThemeDefaults = tokens?.defaults ?? {};
    const fontSizeMap = new Map<string, string>(
      tokens?.fontSizes.map((f) => [f.slug, f.size]) ?? [],
    );
    const fontMap = new Map<string, string>(
      tokens?.fonts.map((f) => [f.slug, f.family]) ?? [],
    );

    const pickSize = (...slugs: string[]): string | undefined => {
      for (const s of slugs) {
        const v = fontSizeMap.get(s);
        if (v) return v;
      }
      return undefined;
    };

    const headingFamily =
      d.headingFontFamily ??
      fontMap.get('heading') ??
      fontMap.get('headings') ??
      d.fontFamily ??
      'inherit';

    const bodyFamily =
      d.fontFamily ?? fontMap.get('body') ?? fontMap.get('base') ?? 'inherit';

    const h1Size =
      d.headings?.h1?.fontSize ??
      pickSize('xx-large', 'x-large', 'huge') ??
      '2.5rem';
    const h2Size =
      d.headings?.h2?.fontSize ?? pickSize('x-large', 'large') ?? '2rem';
    const h3Size =
      d.headings?.h3?.fontSize ?? pickSize('large', 'medium') ?? '1.5rem';
    const bodySize =
      d.fontSize ?? pickSize('medium', 'normal', 'base') ?? '1rem';

    return {
      headingFamily,
      bodyFamily,
      h1: `text-[${h1Size}] leading-tight`,
      h2: `text-[${h2Size}] leading-snug`,
      h3: `text-[${h3Size}] leading-snug`,
      body: `text-[${bodySize}]`,
      small: 'text-sm',
      buttonRadius: this.radiusToClass(d.buttonBorderRadius),
    };
  }

  private radiusToClass(radius?: string): string {
    if (!radius) return 'rounded';
    const normalized = radius.trim();
    if (normalized === '0' || normalized === '0px') return 'rounded-none';
    if (normalized.includes('9999')) return 'rounded-full';
    const n = parseFloat(radius);
    if (!Number.isNaN(n) && n >= 9999) return 'rounded-full';
    return `rounded-[${normalized}]`;
  }

  // ── Layout tokens: container + includes per component ─────────────────────

  private deriveComponentLayout(
    tokens: ThemeTokens | undefined,
    componentName: string,
    allComponents: PlanResult,
  ): LayoutTokens {
    const d: ThemeDefaults = tokens?.defaults ?? {};
    const imageRadius =
      tokens?.blockStyles?.image?.border?.radius ??
      tokens?.blockStyles?.gallery?.border?.radius;
    const cardRadius =
      tokens?.blockStyles?.group?.border?.radius ??
      tokens?.blockStyles?.column?.border?.radius ??
      tokens?.blockStyles?.cover?.border?.radius;
    const cardPadding =
      tokens?.blockStyles?.group?.spacing?.padding ??
      tokens?.blockStyles?.column?.spacing?.padding;

    const maxW = d.contentWidth
      ? `max-w-[${d.contentWidth}]`
      : 'max-w-[1280px]';
    const containerClass = `${maxW} mx-auto w-full`;

    const blockGap = d.blockGap ? `gap-[${d.blockGap}]` : 'gap-16';

    // Pages import Header/Footer partials if they exist in the plan
    const current = allComponents.find(
      (c) => c.componentName === componentName,
    );
    const includes: string[] = [];
    if (current?.type === 'page') {
      const partials = allComponents.filter((c) => c.type === 'partial');
      const header = partials.find((c) => /^header$/i.test(c.componentName));
      const footer = partials.find((c) => /^footer$/i.test(c.componentName));
      if (header) includes.push(header.componentName);
      if (footer) includes.push(footer.componentName);
    }

    return {
      containerClass,
      blockGap,
      rootPadding: d.rootPadding,
      buttonPadding: d.buttonPadding,
      imageRadius,
      cardRadius,
      cardPadding,
      includes,
    };
  }

  // ── Global palette: deterministic from theme tokens, no AI ───────────────

  private deriveGlobalPalette(tokens?: ThemeTokens): ColorPalette {
    const d: ThemeDefaults = tokens?.defaults ?? {};
    const colorMap = new Map<string, string>(
      tokens?.colors.map((c) => [c.slug, c.value]) ?? [],
    );

    const pick = (...slugs: string[]): string | undefined => {
      for (const s of slugs) {
        const v = colorMap.get(s);
        if (v) return v;
      }
      return undefined;
    };

    return {
      background: d.bgColor ?? pick('background', 'base', 'white') ?? '#ffffff',
      surface: pick('surface', 'secondary', 'light') ?? '#f5f5f5',
      text: d.textColor ?? pick('foreground', 'contrast', 'dark') ?? '#111111',
      textMuted: d.captionColor ?? pick('secondary-text', 'muted') ?? '#666666',
      accent:
        d.linkColor ??
        d.buttonBgColor ??
        pick('primary', 'accent', 'contrast-3') ??
        '#0066cc',
      accentText: d.buttonTextColor ?? pick('base', 'white') ?? '#ffffff',
      dark: pick('dark', 'contrast') ?? d.textColor,
      darkText: pick('light', 'base', 'white') ?? d.bgColor,
    };
  }

  // ── Layer 2: enrich dataNeeds by scanning template source ─────────────────

  private enrichPlan(
    plan: PlanResult,
    sourceMap: Map<string, string>,
  ): PlanResult {
    return plan.map((item) => {
      const source = sourceMap.get(item.templateName) ?? '';
      const needs = new Set(item.dataNeeds);

      // FSE block theme
      if (
        source.includes('wp:navigation') ||
        source.includes('block:"navigation"') ||
        source.includes('"navigation"')
      )
        needs.add('menus');
      if (source.includes('wp:query') || source.includes('"query"'))
        needs.add('posts');
      if (
        source.includes('wp:post-content') ||
        source.includes('"post-content"')
      )
        needs.add('post-detail');
      if (
        source.includes('wp:site-title') ||
        source.includes('"site-title"') ||
        source.includes('wp:site-tagline')
      )
        needs.add('site-info');

      // Classic PHP theme
      if (
        source.includes('{/* WP: <Header />') ||
        source.includes('{/* WP: <Navigation />') ||
        source.includes('{/* WP: <Footer />')
      )
        needs.add('menus');
      if (source.includes('{/* WP: loop start */}')) needs.add('posts');
      if (
        source.includes('{/* WP: post.content') ||
        source.includes('{/* WP: post.title')
      )
        needs.add('post-detail');
      if (
        source.includes('{/* WP: comments') ||
        source.includes('comments_template')
      )
        needs.add('comments');

      // FSE block: comments block inside single post template
      if (
        source.includes('wp:comments') ||
        source.includes('"comments"') ||
        source.includes('"comment-template"')
      )
        needs.add('comments');

      return { ...item, dataNeeds: Array.from(needs) };
    });
  }

  private buildSystemPrompt(): string {
    return `You are a WordPress-to-React architecture planner.
Given a list of WordPress theme templates and the site's database content, you output a JSON plan describing how each template maps to a React component.

For each template, decide:
1. Is it a page (has its own route) or a partial (used inside pages — header, footer, sidebar, navigation, etc.)?
2. What route should it have? Use React Router v6 path syntax.
3. What data does it need from the API? (posts, pages, menus, site-info, post-detail, page-detail, comments)
4. Is it a detail view that needs useParams() to fetch by slug?
5. Write a one-line description of what the component renders.

ROUTING RULES:
- index / home / front-page → route "/"
- blog / archive → route "/blog"
- single / single-post → route "/post/:slug" (isDetail: true, dataNeeds includes "post-detail")
- page (DEFAULT page template only) → route "/page/:slug" (isDetail: true, dataNeeds includes "page-detail")
- page-wide / page-no-title / page-with-sidebar / custom page templates → use their OWN unique route derived from the template name, e.g. "/page-wide/:slug", "/page-no-title/:slug" (isDetail: true, dataNeeds includes "page-detail")
- Custom page templates → route "/<template-slug>" or "/<page-slug>" based on pages in DB
- 404 → route "*"
- header / footer / sidebar / nav / navigation / searchform / comments / widget / breadcrumb / pagination / loop / content-none / no-results / functions → type "partial", route null

IMPORTANT — ROUTES MUST BE UNIQUE:
Every page component MUST have a different route. If multiple templates would normally share the same WordPress URL pattern (e.g. all page templates share /page/:slug), assign each one a unique React route derived from its template name. Never assign the same route to two components.

OUTPUT FORMAT — respond with ONLY a valid JSON array, no markdown fences, no explanation:
[
  {
    "templateName": "index.php",
    "componentName": "Index",
    "type": "page",
    "route": "/",
    "dataNeeds": ["posts", "menus", "site-info"],
    "isDetail": false,
    "description": "Main blog index showing a list of posts"
  },
  ...
]`;
  }

  private buildUserPrompt(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
    _templateNames: string[],
  ): string {
    const lines: string[] = [];
    const templates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];

    lines.push(`## Theme`);
    lines.push(
      `Type: ${theme.type === 'fse' ? 'Full Site Editing (Block)' : 'Classic PHP'}`,
    );
    lines.push('');

    lines.push('## Templates to plan (name → key block types found inside):');
    for (const t of templates) {
      const source = 'markup' in t ? t.markup : t.html;
      const hints = this.extractTemplateHints(source);
      lines.push(`- ${t.name}${hints ? ` [${hints}]` : ''}`);
    }
    lines.push('');

    lines.push('## Site info');
    lines.push(`Site name: ${content.siteInfo.siteName}`);
    lines.push(`Site URL: ${content.siteInfo.siteUrl}`);
    lines.push('');

    lines.push('## Runtime capabilities');
    lines.push(
      `Active plugins: ${content.capabilities.activePluginSlugs.join(', ') || '(none detected)'}`,
    );
    lines.push(`WooCommerce detected: ${content.capabilities.wooCommerce ? 'yes' : 'no'}`);
    if (content.capabilities.wooCommerce) {
      lines.push(`Published products: ${content.commerce.productsCount}`);
      lines.push(`Product categories: ${content.commerce.productCategoriesCount}`);
      lines.push(
        `Core commerce pages: ${content.commerce.corePages.join(', ') || '(not found in DB)'}`,
      );
    }
    lines.push('');

    if (content.detectedPlugins.length > 0) {
      lines.push('## Detected plugins');
      for (const plugin of content.detectedPlugins) {
        const evidence = plugin.evidence
          .slice(0, 4)
          .map((item) => `${item.source}:${item.match}`)
          .join(', ');
        lines.push(
          `- ${plugin.slug} (${plugin.confidence}) capabilities: ${plugin.capabilities.join(', ') || '(none)'} | evidence: ${evidence}`,
        );
      }
      lines.push('');
    }

    if (content.discovery.elementorWidgetTypes.length > 0) {
      lines.push('## Elementor widget types in use');
      lines.push(content.discovery.elementorWidgetTypes.join(', '));
      lines.push(
        'npm package hints: slides/carousel → swiper, form → react-hook-form, ' +
        'popup → @radix-ui/react-dialog, accordion → @radix-ui/react-accordion, ' +
        'tabs → @radix-ui/react-tabs, video → react-player, countdown → react-countdown, ' +
        'google-maps → @react-google-maps/api',
      );
      lines.push('');
    }

    if (content.discovery.topBlockTypes.length > 0) {
      lines.push('## Gutenberg block types in use');
      lines.push(content.discovery.topBlockTypes.join(', '));
      lines.push('');
    }

    if (content.discovery.topShortcodes.length > 0) {
      lines.push('## Shortcodes found in content');
      lines.push(content.discovery.topShortcodes.join(', '));
      lines.push('');
    }

    lines.push(`## Pages in database (${content.pages.length} total):`);
    for (const p of content.pages.slice(0, 20)) {
      lines.push(
        `- slug: "${p.slug}" title: "${p.title}" template: "${p.template || 'default'}"`,
      );
    }
    lines.push('');

    lines.push(`## Menus in database (${content.menus.length} total):`);
    for (const m of content.menus) {
      lines.push(`- "${m.name}" (slug: ${m.slug}) — ${m.items.length} items`);
    }
    lines.push('');

    lines.push(`## Posts: ${content.posts.length} total`);

    return lines.join('\n');
  }

  private tryParseResponseDetailed(
    raw: string,
    expectedTemplateNames: string[],
  ): {
    plan: PlanResult | null;
    reason: string;
  } {
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, '')
      .replace(/^```$/gm, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err: any) {
      return {
        plan: null,
        reason: `invalid JSON: ${err?.message ?? 'unknown parse error'}`,
      };
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        plan: null,
        reason: 'parsed output is not a non-empty array',
      };
    }

    const valid = (parsed as any[]).filter(
      (item) =>
        item &&
        typeof item.templateName === 'string' &&
        typeof item.componentName === 'string' &&
        (item.type === 'page' || item.type === 'partial'),
    );

    if (valid.length === 0) {
      return {
        plan: null,
        reason:
          'array parsed but no valid component objects were found (need templateName, componentName, type)',
      };
    }

    if (valid.length !== (parsed as any[]).length) {
      return {
        plan: null,
        reason: `response contained invalid items: kept ${valid.length}/${(parsed as any[]).length} valid objects`,
      };
    }

    const expected = new Set(expectedTemplateNames);
    const seen = new Set<string>();
    const missing: string[] = [];
    const unexpected: string[] = [];
    const duplicates: string[] = [];

    for (const item of valid as PlanResult) {
      if (!expected.has(item.templateName)) {
        unexpected.push(item.templateName);
      }
      if (seen.has(item.templateName)) {
        duplicates.push(item.templateName);
      }
      seen.add(item.templateName);
    }

    for (const templateName of expectedTemplateNames) {
      if (!seen.has(templateName)) {
        missing.push(templateName);
      }
    }

    if (missing.length > 0 || unexpected.length > 0 || duplicates.length > 0) {
      const reasons: string[] = [];
      if (missing.length > 0) {
        reasons.push(`missing templates: ${missing.join(', ')}`);
      }
      if (unexpected.length > 0) {
        reasons.push(`unexpected templates: ${unexpected.join(', ')}`);
      }
      if (duplicates.length > 0) {
        reasons.push(`duplicate templates: ${duplicates.join(', ')}`);
      }
      return {
        plan: null,
        reason: reasons.join(' | '),
      };
    }

    return {
      plan: valid as PlanResult,
      reason: 'ok',
    };
  }

  private formatRawOutput(raw: string): string {
    return `${this.rawOutputDivider}${raw || '(empty)'}\n----- RAW OUTPUT END -----`;
  }

  private buildRetryPrompt(badRaw: string, templateNames: string[]): string {
    const preview = badRaw.slice(0, 500);
    return `Your previous response could not be parsed as a valid JSON array.

Here is the start of what you returned:
\`\`\`
${preview}${badRaw.length > 500 ? '\n... (truncated)' : ''}
\`\`\`

Templates that MUST be planned: ${templateNames.join(', ')}

Return ONLY a valid JSON array — no markdown fences, no explanation, no text before or after the array.
Each object must have: templateName, componentName, type ("page"|"partial"), route (string|null), dataNeeds (string[]), isDetail (boolean), description (string).`;
  }

  private buildFallbackPlan(templateNames: string[]): PlanResult {
    const PARTIAL_PATTERNS =
      /^(header|footer|sidebar|nav|navigation|searchform|comments|comment|postmeta|post-meta|widget|breadcrumb|pagination|loop|content-none|no-results|functions)/i;

    return templateNames.map((name) => {
      const componentName = this.toComponentName(name);
      const isPartial = PARTIAL_PATTERNS.test(componentName);
      return {
        templateName: name,
        componentName,
        type: isPartial ? 'partial' : 'page',
        route: isPartial ? null : `/${componentName.toLowerCase()}`,
        dataNeeds: ['posts', 'menus', 'site-info'],
        isDetail: false,
        description: `Component generated from ${name}`,
      };
    });
  }

  private extractTemplateHints(source: string): string {
    const hints: string[] = [];
    if (source.includes('wp:navigation') || source.includes('wp_nav_menu'))
      hints.push('navigation');
    if (source.includes('wp:query') || source.includes('have_posts'))
      hints.push('query/posts');
    if (source.includes('wp:post-content') || source.includes('the_content'))
      hints.push('post-content');
    if (source.includes('wp:site-title') || source.includes('bloginfo'))
      hints.push('site-title');
    if (source.includes('wp:site-tagline')) hints.push('site-tagline');
    if (source.includes('wp:cover')) hints.push('cover');
    if (source.includes('wp:columns')) hints.push('columns');
    if (source.includes('wp:template-part')) hints.push('template-part');
    if (source.includes('wp:search')) hints.push('search');
    if (source.includes('wp:comments')) hints.push('comments');
    return hints.join(', ');
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
