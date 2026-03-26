import { Injectable, Logger } from '@nestjs/common';
import { LlmFactoryService } from '../../../common/llm/llm-factory.service.js';
import { DbContentResult } from '../db-content/db-content.service.js';
import { PhpParseResult } from '../php-parser/php-parser.service.js';
import { BlockParseResult } from '../block-parser/block-parser.service.js';

export interface ComponentPlan {
  templateName: string;
  componentName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  isDetail: boolean;
  description: string;
}

export type PlanResult = ComponentPlan[];

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(private readonly llmFactory: LlmFactoryService) {}

  async plan(
    theme: PhpParseResult | BlockParseResult,
    content: DbContentResult,
  ): Promise<PlanResult> {
    // Build source map: templateName → raw source (used in layer 2 enrichment)
    const sourceMap = new Map<string, string>();
    const allTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];
    for (const t of allTemplates) {
      sourceMap.set(t.name, 'markup' in t ? t.markup : t.html);
    }
    const modelName = this.llmFactory.getModel();

    const templateNames =
      theme.type === 'classic'
        ? theme.templates.map((t) => t.name)
        : [...theme.templates, ...theme.parts].map((t) => t.name);

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(theme, content, templateNames);

    this.logger.log(
      `Planning ${templateNames.length} components for "${content.siteInfo.siteName}"`,
    );

    const { text: raw } = await this.llmFactory.chat({
      model: modelName,
      systemPrompt,
      userPrompt,
      maxTokens: 4096,
    });
    const plan = this.parseResponse(raw, templateNames);
    return this.enrichPlan(plan, sourceMap);
  }

  // ── Layer 2: enrich dataNeeds by scanning template source ─────────────────

  private enrichPlan(
    plan: PlanResult,
    sourceMap: Map<string, string>,
  ): PlanResult {
    return plan.map((item) => {
      const source = sourceMap.get(item.templateName) ?? '';
      const needs = new Set(item.dataNeeds);

      // FSE block theme: detect by block comment patterns
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

      // Classic PHP theme: detect by WP hint comments
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

      return { ...item, dataNeeds: Array.from(needs) };
    });
  }

  private buildSystemPrompt(): string {
    return `You are a WordPress-to-React architecture planner.
Given a list of WordPress theme templates and the site's database content, you output a JSON plan describing how each template maps to a React component.

For each template, decide:
1. Is it a page (has its own route) or a partial (used inside pages — header, footer, sidebar, navigation, etc.)?
2. What route should it have? Use React Router v6 path syntax.
3. What data does it need from the API? (posts, pages, menus, site-info, post-detail, page-detail)
4. Is it a detail view that needs useParams() to fetch by slug?
5. Write a one-line description of what the component renders.

ROUTING RULES:
- index / home / front-page → route "/"
- blog / archive → route "/blog"
- single / single-post → route "/post/:slug" (isDetail: true, dataNeeds includes "post-detail")
- page → route "/page/:slug" (isDetail: true, dataNeeds includes "page-detail")
- Custom page templates → route "/<template-slug>" or "/<page-slug>" based on pages in DB
- 404 → route "*"
- header / footer / sidebar / nav / navigation / searchform / comments / widget / breadcrumb / pagination / loop / content-none / no-results / functions → type "partial", route null

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

  private parseResponse(raw: string, templateNames: string[]): PlanResult {
    // Strip markdown fences if present
    const cleaned = raw
      .replace(/^```[\w]*\n?/m, '')
      .replace(/```$/m, '')
      .trim();

    let parsed: ComponentPlan[];
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      this.logger.warn(
        'Failed to parse planner JSON response, using fallback plan',
      );
      return this.buildFallbackPlan(templateNames);
    }

    if (!Array.isArray(parsed)) {
      this.logger.warn('Planner response is not an array, using fallback plan');
      return this.buildFallbackPlan(templateNames);
    }

    this.logger.log(`Plan received: ${parsed.length} components`);
    return parsed;
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
      .split(/[-_]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    return /^\d/.test(name) ? `Page${name}` : name;
  }
}
