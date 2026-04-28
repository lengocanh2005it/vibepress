import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import ts from 'typescript';
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer';
import type { GeneratedComponent } from '../react-generator/react-generator.service.js';
import type {
  BreadcrumbSection,
  CardGridSection,
  CarouselSection,
  CommentsSection,
  ComponentVisualPlan,
  FooterSection,
  MediaTextSection,
  NavbarSection,
  PageContentSection,
  PostContentSection,
  PostListSection,
  PostMetaSection,
  SearchSection,
  SectionObligation,
  SectionPlan,
  SidebarSection,
  TabsSection,
  AccordionSection,
} from '../react-generator/visual-plan.schema.js';
import type { ThemeInteractionTarget } from '../block-parser/block-parser.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import {
  findPlainTextPostMetaArchiveSnippets as findSharedPlainTextPostMetaArchiveSnippets,
  normalizePlainTextPostMetaArchiveLinks as normalizeSharedPlainTextPostMetaArchiveLinks,
  promotePlainTextPostMetaLinks as promoteSharedPlainTextPostMetaLinks,
} from '../../../common/utils/post-meta-link.util.js';
const VIRTUAL_ROOT = '/virtual-preview';
const VIRTUAL_MAIN_FILE = `${VIRTUAL_ROOT}/src/main.tsx`;
const VIRTUAL_APP_FILE = `${VIRTUAL_ROOT}/src/App.tsx`;
const VIRTUAL_REACT_SHIM_FILE = `${VIRTUAL_ROOT}/src/react-shim.d.ts`;
const PREVIEW_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  isolatedModules: true,
  noEmit: true,
  jsx: ts.JsxEmit.ReactJSX,
  strict: false,
  noImplicitAny: false,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
};

export interface CodeValidationContext {
  componentName?: string;
  route?: string | null;
  isDetail?: boolean;
  fixedSlug?: string;
  dataNeeds?: string[];
  type?: 'page' | 'partial';
  isSubComponent?: boolean;
  allowedRelativeImports?: string[];
  requireCommentForm?: boolean;
  requiredCustomClassNames?: string[];
  requiredCustomClassTargets?: Record<string, ThemeInteractionTarget>;
  visualPlan?: ComponentVisualPlan;
}

export interface ComponentValidationFailure {
  component: GeneratedComponent;
  error: string;
}

export interface ComponentValidationResult {
  components: GeneratedComponent[];
  failures: ComponentValidationFailure[];
}

type SectionBindingKind =
  | 'posts'
  | 'pages'
  | 'menus'
  | 'footer-links'
  | 'site-info'
  | 'comments-list'
  | 'comment-form'
  | 'search-input'
  | 'post-content'
  | 'page-content';

type SectionInteractionKind =
  | 'modal'
  | 'tabs'
  | 'accordion'
  | 'carousel'
  | 'comment-form';

interface SectionContractLiteral {
  value?: string;
  message: string;
}

interface SectionContractBindingRequirement {
  kind: SectionBindingKind;
  message: string;
  fields?: Array<{ name: string; message: string }>;
}

interface SectionContractInteractionRequirement {
  kind: SectionInteractionKind;
  message: string;
  options?: Record<string, boolean | string | number | undefined>;
}

interface SectionContractCollectionItem {
  anchors: string[];
  requirements: SectionContractLiteral[];
  primaryLiterals?: string[];
}

interface SectionContractCollectionRequirement {
  kind: 'cards' | 'slides' | 'tabs' | 'accordion-items';
  minItems: number;
  message: string;
  items: SectionContractCollectionItem[];
}

interface SectionRenderContract {
  role: string;
  literals: SectionContractLiteral[];
  bindings: SectionContractBindingRequirement[];
  interactions: SectionContractInteractionRequirement[];
  collections: SectionContractCollectionRequirement[];
}

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Post-process all generated components:
   * - Remove unused imports from each .tsx file
   * - Fail fast on structural/semantic issues before preview build
   */
  validate(components: GeneratedComponent[]): GeneratedComponent[] {
    const result = this.collectValidationIssues(components);
    if (result.failures.length > 0) {
      throw new Error(
        `[validator] Generated component validation failed:\n${result.failures
          .map(
            (failure) =>
              `Component "${failure.component.name}": ${failure.error}`,
          )
          .join('\n')}`,
      );
    }

    return result.components;
  }

  collectValidationIssues(
    components: GeneratedComponent[],
  ): ComponentValidationResult {
    const generatedComponentNames = components.map((comp) => comp.name);
    const normalized = components.map((comp) => {
      const code = this.sanitizeGeneratedCode(comp.code);
      return { ...comp, code };
    });
    const failures: ComponentValidationFailure[] = [];

    for (const comp of normalized) {
      const check = this.checkCodeStructure(comp.code, {
        componentName: comp.name,
        route: comp.route,
        isDetail: comp.isDetail,
        fixedSlug: comp.fixedSlug,
        dataNeeds: comp.dataNeeds,
        type: comp.type,
        isSubComponent: comp.isSubComponent,
        requiredCustomClassNames: comp.requiredCustomClassNames,
        requiredCustomClassTargets: comp.requiredCustomClassTargets,
        visualPlan: comp.visualPlan,
        allowedRelativeImports: generatedComponentNames.filter(
          (name) => name !== comp.name,
        ),
      });
      if (!check.isValid) {
        failures.push({
          component: comp,
          error: check.error ?? 'Unknown validation error',
        });
        continue;
      }
      if (check.fixedCode) {
        comp.code = check.fixedCode;
      }
    }

    return { components: normalized, failures };
  }

  async assertPreviewBuild(frontendDir: string): Promise<void> {
    const result = await this.runCommand(frontendDir, 'npm', ['run', 'build']);
    if (result.exitCode === 0) return;

    const output = (result.stderr || result.stdout || 'Unknown build failure')
      .trim()
      .slice(-4000);
    throw new Error(`[validator] Preview build failed:\n${output}`);
  }

  async assertPreviewRuntime(
    previewUrl: string,
    routes: string[] = ['/'],
  ): Promise<void> {
    const readyTimeoutMs =
      this.configService.get<number>('preview.runtimeServerReadyTimeoutMs') ??
      30_000;
    const routeDelayMs =
      this.configService.get<number>('preview.runtimeRouteDelayMs') ?? 400;

    await this.waitForPreviewServer(previewUrl, readyTimeoutMs);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox'],
    });

    try {
      const uniqueRoutes = [...new Set(routes.length > 0 ? routes : ['/'])];
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });

      const runtimeErrors: string[] = [];
      page.on('pageerror', (err) => {
        runtimeErrors.push(
          `pageerror: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (this.shouldIgnoreConsoleError(text)) return;
        runtimeErrors.push(`console error: ${text}`);
      });
      page.on('requestfailed', (request) => {
        if (this.shouldIgnoreRequestFailure(request)) return;
        const url = request.url();
        runtimeErrors.push(
          `request failed: ${request.method()} ${url} (${request.failure()?.errorText ?? 'unknown'})`,
        );
      });

      for (const route of uniqueRoutes) {
        const url = new URL(route, previewUrl).toString();
        await this.gotoWithRetry(page, url);
        if (routeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, routeDelayMs));
        }
      }

      if (runtimeErrors.length > 0) {
        throw new Error(
          `[validator] Preview runtime smoke test failed:\n${[...new Set(runtimeErrors)].slice(0, 20).join('\n')}`,
        );
      }
    } finally {
      await browser.close();
    }
  }

  /**
   * Fix common AI Tailwind mistakes before validation so we do not burn retries.
   * - Spaces after commas in `min()`/`max()`/`clamp()` inside arbitrary `[...]` classes
   * - `gap-10px`-style classes → `gap-[10px]`
   */
  sanitizeTailwindClasses(raw: string): string {
    let out = raw;
    out = out.replace(/\[(min|max|clamp)\(([^[\]]*)\)\]/g, (_m, fn, inner) => {
      const compact = String(inner).replace(/,\s+/g, ',');
      return `[${fn}(${compact})]`;
    });
    out = out.replace(
      /\b(gap|mt|mb|ml|mr|pt|pb|pl|pr|mx|my|px|py|m|p|w|h|text|leading|tracking|rounded(?:-[a-z]+)?|font|min-[wh]|max-[wh])-(\d[\d.]*)(px|rem|em|vh|vw|%)\b/g,
      (_m, prefix, num, unit) => `${prefix}-[${num}${unit}]`,
    );
    return out;
  }

  stripDebugStatements(raw: string): string {
    return raw
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !/^console\.(log|warn|error|info|debug)\s*\(/.test(trimmed);
      })
      .join('\n');
  }

  sanitizeGeneratedCode(raw: string): string {
    let code = this.removeUnusedImports(raw);
    code = this.sanitizeTailwindClasses(code);
    code = this.repairBrokenArbitraryValueClasses(code);
    code = this.stripDebugStatements(code);
    code = this.normalizePlainTextPostMetaArchiveLinks(code);
    code = this.promotePlainTextPostMetaLinks(code);
    code = this.ensureHoverUnderlineOnCanonicalTextLinks(code);
    code = this.ensureReactRouterLinkImport(code);
    return code;
  }

  private repairBrokenArbitraryValueClasses(raw: string): string {
    const repairClassList = (classList: string) =>
      classList
        .split(/(\s+)/)
        .map((token) => {
          if (!token || /^\s+$/.test(token)) return token;
          if (!token.includes('[') || token.includes(']')) return token;
          if (!/-\[[^\]]+$/.test(token)) return token;
          return `${token}]`;
        })
        .join('');

    return raw
      .replace(
        /className="([^"]*)"/g,
        (_match, classList: string) =>
          `className="${repairClassList(classList)}"`,
      )
      .replace(
        /className='([^']*)'/g,
        (_match, classList: string) =>
          `className='${repairClassList(classList)}'`,
      )
      .replace(
        /className=\{`([^`]+)`\}/g,
        (_match, classList: string) =>
          `className={\`${repairClassList(classList)}\`}`,
      );
  }

  /**
   * Basic structural validation to detect obvious layout-breaking code
   */
  checkCodeStructure(
    rawCode: string,
    context: CodeValidationContext = {},
  ): { isValid: boolean; error?: string; fixedCode?: string } {
    if (!rawCode.trim()) return { isValid: false, error: 'Empty code' };
    let code = this.sanitizeGeneratedCode(rawCode);

    // ── Hard failures (return immediately — no point collecting more) ─────────

    // 1. Output is JSON instead of a React component (AI gave up and returned planner JSON)
    const trimmed = code.trimStart();
    if (
      trimmed.startsWith('{') &&
      /"(?:componentName|templateName|type|route|components|description)"\s*:/.test(
        trimmed,
      )
    ) {
      return {
        isValid: false,
        error:
          'Output is JSON, not a React component. Re-generate as a TSX file.',
      };
    }

    // 2. No export default — file is truncated or fundamentally wrong
    if (!/export\s+default\s+/.test(code)) {
      return {
        isValid: false,
        error:
          'Missing `export default` — component is truncated or incomplete.',
      };
    }

    const visualPlanIssue = this.checkVisualPlanObligations(
      code,
      context.visualPlan,
      context.componentName,
    );
    if (visualPlanIssue) {
      return {
        isValid: false,
        error: visualPlanIssue,
      };
    }

    // 3. No JSX return — component renders nothing
    if (!/return\s*[\s\S]*?</.test(code)) {
      return {
        isValid: false,
        error: 'No JSX return found — component has no rendered output.',
      };
    }

    // 4. External CSS / inline <style>
    if (
      /import\s+(?:.+?\s+from\s+)?['"][^'"]+\.s?css['"];?/s.test(code) ||
      /<style[\s>]/i.test(code)
    ) {
      return {
        isValid: false,
        error: 'External CSS or inline <style> tags are not allowed.',
      };
    }

    // 4b. Sub-component imports that don't exist in the generated project
    // @/components/Foo, @/pages/Foo, or ./UpperCaseName are hallucinated — not generated
    const badImport = this.findInvalidRelativeImport(code, context);
    if (badImport) {
      return {
        isValid: false,
        error:
          `Importing a file that does not exist or is not allowed: \`${badImport}\`. ` +
          `Only import generated sibling components that are explicitly available to this file, and use extensionless relative paths like \`./Header\` instead of \`./Header.js\`.`,
      };
    }

    // 5. Duplicate className on same tag
    if (
      /(<[a-zA-Z0-9]+[^>]*?className=["'][^"']*["'][^>]*?className=["'][^"']*["'][^>]*?>)/s.test(
        code,
      )
    ) {
      return { isValid: false, error: 'Duplicate className attributes found.' };
    }

    const jsxTagError = this.checkJsxTagBalance(code);
    if (jsxTagError) {
      return { isValid: false, error: jsxTagError };
    }

    const tsxSyntaxError = this.checkTsxSyntax(code);
    if (tsxSyntaxError) {
      return { isValid: false, error: tsxSyntaxError };
    }

    // 6. Unbalanced braces — truncated output
    let depth = 0;
    for (const char of code) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth !== 0) {
      return { isValid: false, error: `Unbalanced braces (depth: ${depth})` };
    }

    // 6b. Unbalanced parentheses — truncated return() or missing closing paren
    const parenDepth = this.balanceCount(code, '(', ')');
    if (parenDepth !== 0) {
      return {
        isValid: false,
        error: `Unbalanced parentheses (depth: ${parenDepth}) — likely a truncated \`return (\` block or missing closing paren.`,
      };
    }

    // 6c. Unbalanced square brackets — truncated array or destructuring
    const bracketDepth = this.balanceCount(code, '[', ']');
    if (bracketDepth !== 0) {
      return {
        isValid: false,
        error: `Unbalanced square brackets (depth: ${bracketDepth}) — likely a truncated array literal or destructuring expression.`,
      };
    }

    // 6d. Multiple export default — AI sometimes duplicates the component
    const exportDefaultCount = (code.match(/\bexport\s+default\b/g) ?? [])
      .length;
    if (exportDefaultCount > 1) {
      return {
        isValid: false,
        error: `Multiple \`export default\` found (${exportDefaultCount}). A component file must have exactly one default export.`,
      };
    }

    // 6e. HTML attributes instead of JSX equivalents (class=, onclick=, etc.)
    const htmlAttrMatch = code.match(
      /\bclass\s*=\s*["'{]|\b(?:onclick|ondblclick|onchange|oninput|onsubmit|onkeyup|onkeydown|onkeypress|onfocus|onblur|onmouseenter|onmouseleave|onmousedown|onmouseup)\s*=\s*["'{]/,
    );
    if (htmlAttrMatch) {
      const attr = htmlAttrMatch[0].replace(/\s*=.*$/, '').trim();
      const jsxMap: Record<string, string> = {
        class: 'className',
        onclick: 'onClick',
        ondblclick: 'onDoubleClick',
        onchange: 'onChange',
        oninput: 'onInput',
        onsubmit: 'onSubmit',
        onkeyup: 'onKeyUp',
        onkeydown: 'onKeyDown',
        onkeypress: 'onKeyPress',
        onfocus: 'onFocus',
        onblur: 'onBlur',
        onmouseenter: 'onMouseEnter',
        onmouseleave: 'onMouseLeave',
        onmousedown: 'onMouseDown',
        onmouseup: 'onMouseUp',
      };
      const fix = jsxMap[attr] ? ` → use \`${jsxMap[attr]}\`` : '';
      return {
        isValid: false,
        error: `HTML attribute \`${attr}=\` found in JSX${fix}. JSX requires camelCase event handlers and \`className\` instead of \`class\`.`,
      };
    }

    // 6f. <label for= instead of htmlFor=
    if (/<label\b[^>]*\bfor\s*=/.test(code)) {
      return {
        isValid: false,
        error:
          '`<label for=>` found — use `htmlFor=` in JSX instead of `for=`.',
      };
    }

    // ── Content violations — collect ALL before returning ─────────────────────

    const DATA_NEED_ALIASES: Record<string, string> = {
      'post-detail': 'postDetail',
      'page-detail': 'pageDetail',
      'site-info': 'siteInfo',
      'footer-links': 'footerLinks',
    };
    const violations: string[] = [];
    const dataNeeds = new Set(
      (context.dataNeeds ?? []).map((n) => DATA_NEED_ALIASES[n] ?? n),
    );
    const expectsPostDetail = dataNeeds.has('postDetail');
    const expectsPageDetail = dataNeeds.has('pageDetail');
    const expectsAnyDetail =
      context.isDetail === true || expectsPostDetail || expectsPageDetail;
    const fixedSlug = context.fixedSlug?.trim();
    const hasFixedSlug = Boolean(fixedSlug);
    const routeHasParams = /:[A-Za-z_]/.test(context.route ?? '');
    const allowsArchiveAliasParams =
      /^Archive$/i.test(context.componentName ?? '') &&
      context.route === '/archive';
    const effectiveRouteHasParams = routeHasParams || allowsArchiveAliasParams;
    const isPartialComponent = isPartialComponentName(
      context.componentName ?? '',
    );
    const isSharedChromePartial =
      context.type === 'partial' &&
      /^(Header|Footer|Navigation|Nav)$/i.test(context.componentName ?? '');
    const isPageComponent =
      context.type === 'page' &&
      context.isSubComponent !== true &&
      !isPartialComponent;

    // Pre-processing: deterministically strip post-only fields from `interface Page`
    // so the AI does not need a retry attempt just for a bad type declaration.
    // Runtime usage violations (page.author etc.) are still caught below.
    if (expectsPageDetail) {
      const pageType = this.findTypeBody(code, 'Page');
      if (pageType) {
        const BAD_FIELDS =
          /\b(author|categories|tags|excerpt|date|comment_count|comments)\b(\??\s*:[^;}\n]+[;,\n]?)?/g;
        const cleanedBody = pageType.body.replace(BAD_FIELDS, '');
        code =
          code.slice(0, pageType.openBrace + 1) +
          cleanedBody +
          code.slice(pageType.closeBrace);
      }
    }

    // 7. <a href> used for internal React Router paths — breaks SPA navigation
    const internalAHref = code.match(
      /<a\s[^>]*href=["']\/(post|page|archive|category|tag)[/?"]/,
    );
    if (internalAHref) {
      violations.push(
        `Internal link uses \`<a href>\` for route "${internalAHref[0].match(/href=["']([^"']+)["']/)?.[1]}" — use \`<Link to="...">\` from react-router-dom instead.`,
      );
    }
    const missingHoverUnderlineSnippets =
      this.findCanonicalTextLinkSnippetsWithoutHoverUnderline(code);
    if (missingHoverUnderlineSnippets.length > 0) {
      violations.push(
        `Visible navigation/content text links must underline on hover to match the WordPress-style interaction contract. Add \`hover:underline underline-offset-4\` to canonical text links. Offending snippet(s): ${missingHoverUnderlineSnippets.join(' | ')}`,
      );
    }
    const plainTextPostMetaLinks =
      this.findPlainTextPostMetaArchiveSnippets(code);
    if (plainTextPostMetaLinks.length > 0) {
      violations.push(
        `Post meta author/category labels must link to canonical archive routes when \`authorSlug\` or \`categorySlugs[0]\` already exists. Plain-text \`post.author\` is only allowed when it is the actual heading/title content (for example an \`<h1>\` on author/archive/detail views). Do not render \`post.author\` or \`post.categories[0]\` as plain text spans in post listings/meta rows. Offending snippet(s): ${plainTextPostMetaLinks.join(' | ')}`,
      );
    }

    // 8. CSS variable inside Tailwind arbitrary value — never works
    if (/className=["'][^"']*\[var\(--/.test(code)) {
      violations.push(
        '`[var(--...]` inside className breaks Tailwind — resolve to actual px/rem (e.g. `rounded-[8px]`, `gap-[24px]`); if the value is unresolvable, omit the class entirely.',
      );
    }

    // 8b. Space inside CSS function in Tailwind arbitrary value — class silently ignored
    // e.g. py-[min(6.5rem, 8vw)] → Tailwind drops the class entirely
    if (/className=["'][^"']*\[(min|max|clamp)\([^)]*,\s/.test(code)) {
      violations.push(
        'Space inside CSS function in Tailwind arbitrary value: `py-[min(6.5rem, 8vw)]` is silently ignored. Remove the space: `py-[min(6.5rem,8vw)]`.',
      );
    }

    // 9. Bare numeric+unit Tailwind class (no brackets) — e.g. gap-1rem, mt-2rem
    const classStrings = [
      ...[...code.matchAll(/className=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...code.matchAll(/className=\{`([^`]+)`\}/g)].map((m) => m[1]),
    ].join(' ');
    const bareNumericUnit =
      /\b(?:gap|mt|mb|ml|mr|pt|pb|pl|pr|mx|my|px|py|m|p|w|h|text|leading|tracking|rounded(?:-[a-z]+)?|font|min-[wh]|max-[wh])-\d[\d.]*(?:px|rem|em|vh|vw|%)\b/;
    const numericMatch = classStrings.match(bareNumericUnit);
    if (numericMatch) {
      violations.push(
        `Invalid Tailwind class \`${numericMatch[0]}\`: numeric values need brackets — write \`gap-[1rem]\` not \`gap-1rem\`.`,
      );
    }
    if (
      context.visualPlan?.sections.some(
        (section) => section.type === 'carousel',
      )
    ) {
      if (this.rendersStaticCarouselTrack(code)) {
        violations.push(
          'Carousel section renders a static `.swiper-wrapper` without any active-slide transform. Bind the track to `activeCarousels[...]` (or equivalent state) so prev/next/dots move the carousel instead of stacking all slides.',
        );
      }
      if (this.hasEmptySwiperControlButton(code)) {
        violations.push(
          'Carousel control button is empty. `swiper-button-prev` and `swiper-button-next` must render a visible icon/text child because the preview does not load default Swiper arrow glyphs.',
        );
      }
      const carouselStateIssue = this.findInteractiveStateKeyMismatch(
        code,
        'activeCarousels',
      );
      if (carouselStateIssue) {
        violations.push(
          `Carousel state key mismatch: ${carouselStateIssue}. Reuse one exact carousel key consistently across autoplay effects, track transform, arrows, dots, and swipe handlers.`,
        );
      }
    }

    if (
      context.visualPlan?.sections.some((section) => section.type === 'modal')
    ) {
      const modalStateIssue = this.findInteractiveStateKeyMismatch(
        code,
        'openModals',
      );
      if (modalStateIssue) {
        violations.push(
          `Modal state key mismatch: ${modalStateIssue}. Reuse one exact modal key consistently for trigger, conditional popup render, overlay close, and ESC close behavior.`,
        );
      }
    }

    // 10. Wrong siteInfo field names
    const siteInfoMatch = code.match(/\bsiteInfo\.(name|url|description)\b/);
    if (siteInfoMatch) {
      violations.push(
        `\`siteInfo.${siteInfoMatch[1]}\` does not exist. Use \`siteInfo.siteName\` / \`siteInfo.siteUrl\` / \`siteInfo.blogDescription\` / \`siteInfo.logoUrl\`.`,
      );
    }

    // 11. Wrong post field names
    const postFieldMatch = code.match(/\bpost\.(title\.rendered)\b/);
    if (postFieldMatch) {
      violations.push(
        `\`post.${postFieldMatch[1]}\` does not exist. Use \`post.title\` (string), \`post.categories\` (string[]), or \`post.tags\` (string[]).`,
      );
    }
    if (expectsPageDetail) {
      // Note: `item` is intentionally excluded — it is commonly used as a loop
      // variable over Posts (e.g. sidebar recent-posts), not over Page objects.
      // Only flag unambiguous page variable names.
      const pageFieldMatch = code.match(
        /\b(?:pageDetail|page)\.(author|categories|tags|excerpt|date|comment_count|comments)\b/,
      );
      if (pageFieldMatch) {
        violations.push(
          `Page detail contract violated: \`Page.${pageFieldMatch[1]}\` does not exist. Use only the canonical Page fields for this pipeline.`,
        );
      }
      const pageType = this.findTypeBody(code, 'Page');
      const pageInterfaceMatch = pageType?.body.match(
        /\b(author|categories|tags|excerpt|date|comment_count|comments)\b/,
      );
      if (pageInterfaceMatch) {
        violations.push(
          `Page detail contract violated: \`interface Page\` (or \`type Page\`) declares post-only field \`${pageInterfaceMatch[1]}\`. Keep Page aligned with the canonical Page contract.`,
        );
      }
    }

    if (isPageComponent) {
      const redundantTagMatch = code.match(/<(header|footer)\b/i);
      if (redundantTagMatch) {
        violations.push(
          `Layout contract violated: page components must NOT include their own \`<${redundantTagMatch[1]}>\` tag. Global navigation and footer are provided by the shared Layout wrapper.`,
        );
      }
      if (this.fetchesSharedChromeData(code)) {
        violations.push(
          'Layout data contract violated: page components must NOT fetch `/api/site-info`, `/api/menus`, or `/api/footer-links` for shared site chrome. Move that logic into dedicated Header/Footer/Navigation partials.',
        );
      }
      if (this.usesSharedChromeData(code)) {
        violations.push(
          'Layout data contract violated: page components must NOT render shared chrome data such as `siteInfo.siteName` or `menus.find(...)/menus.map(...)`. Shared Header/Footer/Navigation partials own that UI.',
        );
      }
      if (/No menus available/i.test(code)) {
        violations.push(
          'Layout contract violated: page components must not render shared navigation placeholders such as `No menus available`. Shared Header/Navigation partials own global menus.',
        );
      }
      if (/All rights reserved|©|&copy;/i.test(code)) {
        violations.push(
          'Layout contract violated: page components must not render copyright/footer copy. Shared Footer partial owns that content.',
        );
      }
    }

    if (isSharedChromePartial) {
      const isHeaderLikePartial = /^(Header|Navigation|Nav)$/i.test(
        context.componentName ?? '',
      );
      const isFooterPartial = /^Footer$/i.test(context.componentName ?? '');
      const usesSiteTitle =
        /\bsiteInfo\??\.siteName\b/.test(code) ||
        /\{siteInfo\??\.siteName\}/.test(code);
      const usesSiteLogo =
        /\bsiteInfo\??\.logoUrl\b/.test(code) ||
        /\{siteInfo\??\.logoUrl\}/.test(code);
      const hasHomeLinkForBrand =
        /<Link\b[^>]*\bto=["']\/["'][^>]*>[\s\S]*siteInfo\??\.siteName[\s\S]*<\/Link>/.test(
          code,
        ) ||
        /<Link\b[^>]*\bto=\{["']\/["']\}[^>]*>[\s\S]*siteInfo\??\.siteName[\s\S]*<\/Link>/.test(
          code,
        );
      const hasHomeLinkForLogo =
        /<Link\b[^>]*\bto=["']\/["'][^>]*>[\s\S]*siteInfo\??\.logoUrl[\s\S]*<\/Link>/.test(
          code,
        ) ||
        /<Link\b[^>]*\bto=\{["']\/["']\}[^>]*>[\s\S]*siteInfo\??\.logoUrl[\s\S]*<\/Link>/.test(
          code,
        );
      if (
        isHeaderLikePartial &&
        dataNeeds.has('menus') &&
        !/\bmenus(?:\??\.)?(?:find|map|filter|some)\s*\(/.test(code) &&
        !/\bmenu\.items\b/.test(code)
      ) {
        violations.push(
          'Shared chrome contract violated: Header/Navigation partials that declare `menus` must render menu data from `/api/menus`, not hardcoded link columns.',
        );
      }
      if (usesSiteTitle && !hasHomeLinkForBrand) {
        violations.push(
          'Shared chrome contract violated: when Header/Footer/Navigation renders `siteInfo.siteName`, it must wrap the site title in `<Link to=\"/\">...</Link>` so the brand navigates home.',
        );
      }
      if (usesSiteLogo && !hasHomeLinkForLogo) {
        violations.push(
          'Shared chrome contract violated: when Header/Footer/Navigation renders `siteInfo.logoUrl`, the logo must also be inside a home `<Link to=\"/\">...</Link>` so the visible brand cluster is clickable.',
        );
      }
      if (/No menus available/i.test(code)) {
        violations.push(
          'Shared chrome contract violated: do not emit `No menus available` placeholders in Header/Footer/Navigation partials. Render the API menus or a structurally empty nav.',
        );
      }
      if (
        isHeaderLikePartial &&
        dataNeeds.has('menus') &&
        !/location\s*===\s*['"]primary['"]/.test(code) &&
        !/slug\s*===\s*['"]primary['"]/.test(code)
      ) {
        violations.push(
          'Shared chrome contract violated: Header/Navigation partials must source their links from the primary menu (`location === "primary"` with `slug === "primary"` fallback), not by raw menu index.',
        );
      }
      if (
        isFooterPartial &&
        !/fetch\(\s*['"`]\/api\/footer-links\b/.test(code)
      ) {
        violations.push(
          'Shared chrome contract violated: Footer must fetch `/api/footer-links` and render its footer columns from that API, not from `/api/menus`.',
        );
      }
      if (
        isFooterPartial &&
        /\b(staticSections|fallbackSections|defaultFooterColumns)\b/.test(code)
      ) {
        violations.push(
          'Shared chrome contract violated: Footer must not keep hardcoded fallback footer column arrays such as `staticSections` or `defaultFooterColumns`. Render approved footer columns from `/api/footer-links` only.',
        );
      }
      if (isFooterPartial && dataNeeds.has('menus')) {
        violations.push(
          'Shared chrome contract violated: Footer must not declare `menus`. Use `footerLinks` for footer columns instead.',
        );
      }
    }

    if (context.requireCommentForm) {
      const hasCommentPost =
        /fetch\(\s*['"`]\/api\/comments['"`]\s*,/.test(code) &&
        /\bmethod\s*:\s*['"`]POST['"`]/.test(code);
      const hasCommentForm =
        /<form\b[\s\S]*?>[\s\S]*?(?:<textarea\b|type=["']email["']|type=["']text["'])/.test(
          code,
        ) && /onSubmit=\{[^}]+\}/.test(code);
      if (!hasCommentPost || !hasCommentForm) {
        violations.push(
          'Comments contract violated: the approved comments section requires a reply form, but the component does not implement a working comment submission form that POSTs to `/api/comments`.',
        );
      }
    }

    const commentFieldMatch = code.match(
      /\bcomment\.(author_name|author_avatar)\b/,
    );
    if (commentFieldMatch) {
      violations.push(
        `Comment contract violated: \`comment.${commentFieldMatch[1]}\` does not exist. Use \`comment.author\` and derive any avatar UI from initials instead.`,
      );
    }

    // 11b. React Router API used without importing from react-router-dom
    if (
      /<Link\b/.test(code) &&
      !/\bimport\s*\{[^}]*\bLink\b[^}]*\}\s*from\s*['"]react-router-dom['"]/.test(
        code,
      )
    ) {
      violations.push(
        '`<Link>` is used but `Link` is not imported from `react-router-dom`.',
      );
    }
    if (
      /\buseParams\s*</.test(code) &&
      !/\bimport\s*\{[^}]*\buseParams\b[^}]*\}\s*from\s*['"]react-router-dom['"]/.test(
        code,
      )
    ) {
      violations.push(
        '`useParams` is used but not imported from `react-router-dom`.',
      );
    }

    // 12. Data variables used in JSX without a corresponding useState declaration
    //
    // We intentionally use a NARROW match — only flag when the identifier appears
    // in a JavaScript expression context:
    //   {pages        ← JSX expression opening
    //   pages.method  ← property / optional-chain access (requires \w after dot)
    //   pages[        ← array index access
    //
    // This avoids false positives when static text content in section headings or
    // body copy happens to contain the word (e.g. "Browse all pages and posts.").
    // "all pages." → `pages.` is followed by a space, not \w → no match.
    const dataVars = ['menus', 'posts', 'pages', 'siteInfo', 'footerColumns'];
    const missingState: string[] = [];
    for (const varName of dataVars) {
      const jsUsage = new RegExp(
        `\\{\\s*${varName}\\b|\\b${varName}\\??\\.[a-zA-Z_$]|\\b${varName}\\[`,
      );
      if (!jsUsage.test(code)) continue;
      const hasDeclared = new RegExp(`const\\s+\\[\\s*${varName}\\b`).test(
        code,
      );
      if (!hasDeclared) missingState.push(varName);
    }
    if (missingState.length > 0) {
      violations.push(
        `Variables used in JSX but missing useState declaration: ${missingState.join(', ')}. ` +
          `For each missing variable: add \`const [${missingState[0]}, set${missingState[0].charAt(0).toUpperCase() + missingState[0].slice(1)}] = useState(...)\` ` +
          `AND add its fetch inside the Promise.all in useEffect.`,
      );
    }

    // 12b. Route/data contract checks from component plan
    // Partials (header, footer, postmeta, sidebar, …) receive data via props from their
    // parent page — they do not own a route or fetch detail data themselves.
    // Skip routing/fetching enforcement for them to avoid contradictory violations.
    const skipRouteDataContractChecks =
      context.type === 'partial' ||
      context.isSubComponent === true ||
      isPartialComponent;
    if (!skipRouteDataContractChecks) {
      if (expectsAnyDetail && !hasFixedSlug && !/\buseParams\s*</.test(code)) {
        violations.push(
          'Detail component is missing `useParams<{ slug: string }>()` for slug-based routing.',
        );
      }
      if (hasFixedSlug && /\buseParams\s*</.test(code)) {
        violations.push(
          `Component is bound to the fixed slug \`${fixedSlug}\` and must not import or call \`useParams()\`. Use \`const slug = "${fixedSlug}"\` or fetch the exact endpoint directly.`,
        );
      }
      if (!effectiveRouteHasParams && /\buseParams\s*</.test(code)) {
        violations.push(
          'Component uses `useParams()` even though its planned route has no URL params.',
        );
      }
      if (
        expectsPostDetail &&
        !(hasFixedSlug
          ? this.matchesExactDetailFetch(code, 'posts', fixedSlug!)
          : this.matchesDetailFetch(code, 'posts'))
      ) {
        violations.push(
          hasFixedSlug
            ? `Post detail component must fetch the exact bound record via \`/api/posts/${fixedSlug}\`.`
            : 'Post detail component must fetch the record via `/api/posts/${slug}` (or equivalent string concatenation with `slug`).',
        );
      }
      if (
        expectsPageDetail &&
        !(hasFixedSlug
          ? this.matchesExactDetailFetch(code, 'pages', fixedSlug!)
          : this.matchesDetailFetch(code, 'pages'))
      ) {
        violations.push(
          hasFixedSlug
            ? `Page detail component must fetch the exact bound record via \`/api/pages/${fixedSlug}\`.`
            : 'Page detail component must fetch the record via `/api/pages/${slug}` (or equivalent string concatenation with `slug`).',
        );
      }
      if (
        !dataNeeds.has('postDetail') &&
        this.matchesAnyDetailFetch(code, 'posts')
      ) {
        violations.push(
          'Component fetches a post detail endpoint even though its plan does not require post detail data.',
        );
      }
      if (
        !dataNeeds.has('pageDetail') &&
        this.matchesAnyDetailFetch(code, 'pages')
      ) {
        violations.push(
          'Component fetches a page detail endpoint even though its plan does not require page detail data.',
        );
      }
      if (hasFixedSlug && this.matchesDynamicDetailFetch(code, 'posts')) {
        violations.push(
          `Fixed-slug component must not fetch dynamic post detail via \`/api/posts/\${slug}\`. Fetch only \`/api/posts/${fixedSlug}\`.`,
        );
      }
      if (hasFixedSlug && this.matchesDynamicDetailFetch(code, 'pages')) {
        violations.push(
          `Fixed-slug component must not fetch dynamic page detail via \`/api/pages/\${slug}\`. Fetch only \`/api/pages/${fixedSlug}\`.`,
        );
      }
    }

    // 13. <img> without alt attribute — accessibility + common AI mistake
    if (/<img\b(?![^>]*\balt\s*=)[^>]*>/s.test(code)) {
      violations.push(
        '`<img>` tag missing `alt` attribute — required for accessibility. Add `alt=""` for decorative images or a descriptive string.',
      );
    }

    // 14. .map() rendering JSX without a key prop anywhere in the component
    if (
      /\.map\s*\([^]*?=>\s*(?:\([\s\n]*)?\s*<[A-Za-z]/s.test(code) &&
      !/\bkey\s*=/.test(code)
    ) {
      violations.push(
        '`.map()` used to render a list but no `key=` prop found — add `key={item.id}` or `key={index}` to the outermost JSX element in each `.map()` callback.',
      );
    }

    // 15. console.* debug statements left in component
    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(code)) {
      violations.push(
        'Debug statement `console.*()` left in component — remove before production.',
      );
    }

    // 16. Common hallucinated placeholder image hosts
    const placeholderImage = code.match(
      /https?:\/\/(?:images\.unsplash\.com|picsum\.photos|placehold\.co|via\.placeholder\.com)[^"'`\s)]*/i,
    );
    if (placeholderImage) {
      violations.push(
        `Hallucinated placeholder image detected: \`${placeholderImage[0]}\`. Use only image sources present in the template or real API data.`,
      );
    }

    if (violations.length > 0) {
      return { isValid: false, error: violations.join('\n') };
    }

    code = this.repairMissingRequiredCustomClasses(
      code,
      context.requiredCustomClassNames ?? [],
      context.requiredCustomClassTargets,
    );

    const missingRequiredCustomClasses = this.findMissingRequiredCustomClasses(
      code,
      context.requiredCustomClassNames ?? [],
      context.requiredCustomClassTargets,
    );
    if (missingRequiredCustomClasses.length > 0) {
      return {
        isValid: false,
        error: `Source custom class contract violated: the generated JSX dropped or misplaced required WordPress custom class(es): ${missingRequiredCustomClasses
          .map((className) => `\`${className}\``)
          .join(
            ', ',
          )}. Preserve these exact classes in \`className\` on the corresponding source-backed element(s).`,
      };
    }

    return {
      isValid: true,
      ...(code !== rawCode ? { fixedCode: code } : {}),
    };
  }

  checkInlineSectionFidelity(
    code: string,
    section: SectionPlan,
    componentName?: string,
    sectionNumber?: number,
  ): string | null {
    const sectionLabel = `"${componentName ?? 'Component'}" section ${sectionNumber ?? 1}`;
    const issues = this.auditSectionContractFidelity(
      code,
      section,
      sectionLabel,
      true,
    );
    if (issues.length === 0) return null;
    const sectionAuditLine = this.buildSectionAuditLine({
      label: sectionLabel,
      section,
      issues,
      sectionIndex: (sectionNumber ?? 1) - 1,
    });
    const detailLines = issues.slice(0, 8).map((issue) => `detail: ${issue}`);
    return `Visual section contract violated:\n${[sectionAuditLine, ...detailLines].join('\n')}`;
  }

  private auditSectionContractFidelity(
    code: string,
    section: SectionPlan,
    label: string,
    isInlineSection = false,
  ): string[] {
    const contract = this.buildSectionRenderContract(section, label);
    return this.auditRenderedSectionAgainstContract(
      code,
      contract,
      isInlineSection,
    );
  }

  private buildSectionRenderContract(
    section: SectionPlan,
    label: string,
  ): SectionRenderContract {
    const role = section.obligation?.role ?? section.type;
    const contract: SectionRenderContract = {
      role,
      literals: [],
      bindings: [],
      interactions: [],
      collections: [],
    };

    const addLiteral = (value: string | undefined, message: string) => {
      const normalized = value?.trim();
      if (!normalized || this.isDynamicPlanBinding(normalized)) return;
      if (contract.literals.some((literal) => literal.value === normalized))
        return;
      contract.literals.push({ value: normalized, message });
    };

    const addBinding = (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => {
      const existing = contract.bindings.find(
        (binding) => binding.kind === kind,
      );
      if (existing) {
        for (const field of fields ?? []) {
          if (existing.fields?.some((entry) => entry.name === field.name))
            continue;
          existing.fields = [...(existing.fields ?? []), field];
        }
        return;
      }
      contract.bindings.push({ kind, message, fields });
    };

    const addInteraction = (
      kind: SectionInteractionKind,
      message: string,
      options?: Record<string, boolean | string | number | undefined>,
    ) => {
      if (
        contract.interactions.some((interaction) => interaction.kind === kind)
      ) {
        return;
      }
      contract.interactions.push({ kind, message, options });
    };

    const addCollection = (
      kind: SectionContractCollectionRequirement['kind'],
      minItems: number,
      message: string,
      items: SectionContractCollectionItem[],
    ) => {
      if (minItems <= 0 && items.length === 0) return;
      contract.collections.push({ kind, minItems, message, items });
    };

    const addCtaLiterals = (
      payload: { cta?: { text?: string }; ctas?: Array<{ text?: string }> },
      prefix: string,
    ) => {
      const raw =
        Array.isArray(payload.ctas) && payload.ctas.length > 0
          ? payload.ctas
          : payload.cta
            ? [payload.cta]
            : [];
      const seen = new Set<string>();
      for (const cta of raw) {
        const text = cta?.text?.trim();
        if (!text || seen.has(text) || this.isDynamicPlanBinding(text))
          continue;
        seen.add(text);
        addLiteral(text, `${label} lost ${prefix} CTA text`);
      }
    };

    switch (section.type) {
      case 'navbar':
        this.populateNavbarContract(section, label, addLiteral, addBinding);
        break;
      case 'hero':
        addLiteral(section.heading, `${label} lost hero heading`);
        addLiteral(section.subheading, `${label} lost hero subheading`);
        addLiteral(section.image?.src, `${label} lost hero image src`);
        addCtaLiterals(section, 'hero');
        break;
      case 'cta-strip':
        addCtaLiterals(section, 'cta-strip');
        break;
      case 'cover':
        addLiteral(section.imageSrc, `${label} lost cover image src`);
        addLiteral(section.heading, `${label} lost cover heading`);
        addLiteral(section.subheading, `${label} lost cover subheading`);
        addCtaLiterals(section, 'cover');
        break;
      case 'post-list':
        this.populatePostListContract(section, label, addLiteral, addBinding);
        break;
      case 'card-grid':
        this.populateCardGridContract(
          section,
          label,
          addLiteral,
          addCollection,
        );
        break;
      case 'media-text':
        this.populateMediaTextContract(section, label, addLiteral);
        addCtaLiterals(section, 'media-text');
        break;
      case 'testimonial':
        addLiteral(section.quote, `${label} lost testimonial quote`);
        addLiteral(section.authorName, `${label} lost testimonial author`);
        addLiteral(
          section.authorTitle,
          `${label} lost testimonial author title`,
        );
        addLiteral(section.authorAvatar, `${label} lost testimonial avatar`);
        break;
      case 'newsletter':
        addLiteral(section.heading, `${label} lost newsletter heading`);
        addLiteral(section.subheading, `${label} lost newsletter subheading`);
        addLiteral(section.buttonText, `${label} lost newsletter button text`);
        break;
      case 'footer':
        this.populateFooterContract(section, label, addLiteral, addBinding);
        break;
      case 'post-content':
        this.populatePostContentContract(section, label, addBinding);
        break;
      case 'post-meta':
        this.populatePostMetaContract(section, label, addBinding);
        break;
      case 'page-content':
        this.populatePageContentContract(section, label, addBinding);
        break;
      case 'prose-block':
        for (const segment of section.sourceSegments) {
          switch (segment.type) {
            case 'heading':
              addLiteral(segment.text, `${label} lost prose heading`);
              break;
            case 'paragraph':
              addLiteral(
                segment.text ?? segment.html,
                `${label} lost prose paragraph`,
              );
              break;
            case 'image':
              addLiteral(segment.src, `${label} lost prose image src`);
              break;
            case 'list':
              segment.items.forEach((item) =>
                addLiteral(item, `${label} lost prose list item`),
              );
              break;
            case 'html':
              break;
          }
        }
        break;
      case 'search':
        this.populateSearchContract(section, label, addLiteral, addBinding);
        break;
      case 'comments':
        this.populateCommentsContract(
          section,
          label,
          addBinding,
          addInteraction,
        );
        break;
      case 'sidebar':
        this.populateSidebarContract(section, label, addLiteral, addBinding);
        break;
      case 'modal':
        addLiteral(section.triggerText, `${label} lost modal trigger text`);
        addLiteral(section.heading, `${label} lost modal heading`);
        addLiteral(section.body, `${label} lost modal body`);
        addLiteral(section.imageSrc, `${label} lost modal image src`);
        addCtaLiterals(section, 'modal');
        addInteraction(
          'modal',
          `${label} modal must render a trigger button and conditional popup overlay`,
        );
        break;
      case 'tabs':
        this.populateTabsContract(
          section,
          label,
          addLiteral,
          addCollection,
          addInteraction,
        );
        break;
      case 'accordion':
        this.populateAccordionContract(
          section,
          label,
          addLiteral,
          addCollection,
          addInteraction,
        );
        break;
      case 'carousel':
        this.populateCarouselContract(
          section,
          label,
          addCollection,
          addInteraction,
        );
        break;
      case 'breadcrumb':
        this.populateBreadcrumbContract(section, label, addBinding);
        break;
    }

    for (const capability of section.obligation?.required ?? []) {
      switch (capability) {
        case 'posts':
          addBinding(
            'posts',
            `${label} ${role} must render from the posts collection`,
          );
          break;
        case 'pages':
          addBinding(
            'pages',
            `${label} ${role} must render from the pages collection`,
          );
          break;
        case 'menus':
          addBinding('menus', `${label} ${role} is missing menus rendering`);
          break;
        case 'site-info':
          addBinding(
            'site-info',
            `${label} ${role} is missing site info rendering`,
          );
          break;
        case 'comments-list':
          addBinding(
            'comments-list',
            `${label} comments list is missing source-backed comment rendering`,
          );
          break;
        case 'comment-form':
          addBinding(
            'comment-form',
            `${label} comment form is missing required reply form structure`,
          );
          addInteraction(
            'comment-form',
            `${label} comment form is missing required reply form structure`,
          );
          break;
        case 'search-input':
          addBinding(
            'search-input',
            `${label} search UI is missing the search input`,
          );
          break;
        case 'post-content':
          addBinding(
            'post-content',
            `${label} post-content must render post detail content`,
          );
          break;
        case 'page-content':
          addBinding(
            'page-content',
            `${label} page-content must render page detail content`,
          );
          break;
        default:
          break;
      }
    }

    return contract;
  }

  private populateNavbarContract(
    section: NavbarSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    addBinding('menus', `${label} navbar is missing menus rendering`, [
      {
        name: 'items',
        message: `${label} navbar is missing menu item rendering`,
      },
    ]);
    if (section.showSiteLogo || section.showSiteTitle) {
      const fields: Array<{ name: string; message: string }> = [];
      if (section.showSiteTitle) {
        fields.push({
          name: 'siteName',
          message: `${label} navbar is missing the site title`,
        });
      }
      if (section.showSiteLogo) {
        fields.push({
          name: 'logoUrl',
          message: `${label} navbar is missing the site logo`,
        });
      }
      addBinding(
        'site-info',
        `${label} navbar is missing site info rendering`,
        fields,
      );
    }
    addLiteral(section.cta?.text, `${label} lost navbar CTA text`);
  }

  private populatePostListContract(
    section: PostListSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    if (this.shouldRequireTitleLiteral(section.obligation)) {
      addLiteral(section.title, `${label} lost post-list title`);
    }
    const fields: Array<{ name: string; message: string }> = [
      {
        name: 'title',
        message: `${label} post-list is missing post title rendering`,
      },
      {
        name: 'slug',
        message: `${label} post-list is missing post link rendering`,
      },
    ];
    if (section.showFeaturedImage) {
      fields.push({
        name: 'featuredImage',
        message: `${label} post-list is missing featured-image rendering`,
      });
    }
    if (section.showExcerpt) {
      fields.push({
        name: 'excerpt',
        message: `${label} post-list is missing excerpt rendering`,
      });
    }
    if (section.showAuthor) {
      fields.push({
        name: 'author',
        message: `${label} post-list is missing author rendering`,
      });
    }
    if (section.showDate) {
      fields.push({
        name: 'date',
        message: `${label} post-list is missing date rendering`,
      });
    }
    if (section.showCategory) {
      fields.push({
        name: 'categories',
        message: `${label} post-list is missing category rendering`,
      });
    }
    addBinding(
      'posts',
      `${label} post-list must render from the posts collection`,
      fields,
    );
  }

  private populateCardGridContract(
    section: CardGridSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addCollection: (
      kind: SectionContractCollectionRequirement['kind'],
      minItems: number,
      message: string,
      items: SectionContractCollectionItem[],
    ) => void,
  ): void {
    addLiteral(section.title, `${label} lost card-grid title`);
    addLiteral(section.subtitle, `${label} lost card-grid subtitle`);
    addCollection(
      'cards',
      section.cards.length,
      `${label} card-grid must render all approved cards`,
      section.cards.map((card) => {
        const heading = card.heading?.trim();
        const body = card.body?.trim();
        const imageSrc = card.imageSrc?.trim();
        return {
          anchors: [heading, imageSrc, !heading ? body : undefined].filter(
            (value): value is string =>
              typeof value === 'string' && value.trim().length > 0,
          ),
          primaryLiterals: [heading, body, imageSrc].filter(
            (value): value is string =>
              typeof value === 'string' && value.trim().length > 0,
          ),
          requirements: [
            { value: card.heading, message: `${label} lost card heading` },
            { value: card.body, message: `${label} lost card body` },
            { value: card.imageSrc, message: `${label} lost card image src` },
          ],
        };
      }),
    );
  }

  private populateMediaTextContract(
    section: MediaTextSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
  ): void {
    addLiteral(section.imageSrc, `${label} lost media-text image src`);
    addLiteral(section.heading, `${label} lost media-text heading`);
    addLiteral(section.body, `${label} lost media-text body`);
    for (const item of section.listItems ?? []) {
      addLiteral(item, `${label} lost media-text list item`);
    }
  }

  private populateFooterContract(
    section: FooterSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    addLiteral(
      section.brandDescription,
      `${label} lost footer brand description`,
    );
    addLiteral(section.copyright, `${label} lost footer copyright`);
    for (const column of section.menuColumns ?? []) {
      addLiteral(column.title, `${label} lost footer menu column title`);
    }
    if (section.menuColumns?.length) {
      addBinding(
        'footer-links',
        `${label} footer is missing footer-links rendering`,
        [
          {
            name: 'heading',
            message: `${label} footer is missing footer column heading rendering`,
          },
          {
            name: 'links',
            message: `${label} footer is missing footer column link rendering`,
          },
        ],
      );
    }
    if (section.showSiteLogo || section.showSiteTitle || section.showTagline) {
      const fields: Array<{ name: string; message: string }> = [];
      if (section.showSiteLogo) {
        fields.push({
          name: 'logoUrl',
          message: `${label} footer is missing the site logo`,
        });
      }
      if (section.showSiteTitle) {
        fields.push({
          name: 'siteName',
          message: `${label} footer is missing the site title`,
        });
      }
      if (section.showTagline && !section.brandDescription?.trim()) {
        fields.push({
          name: 'blogDescription',
          message: `${label} footer is missing the site tagline`,
        });
      }
      addBinding(
        'site-info',
        `${label} footer is missing site info rendering`,
        fields,
      );
    }
  }

  private populatePostContentContract(
    section: PostContentSection,
    label: string,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    const fields: Array<{ name: string; message: string }> = [
      {
        name: 'content',
        message: `${label} post-content must render post body HTML`,
      },
    ];
    if (section.showTitle) {
      fields.push({
        name: 'title',
        message: `${label} post-content is missing the post title`,
      });
    }
    if (section.showAuthor) {
      fields.push({
        name: 'author',
        message: `${label} post-content is missing the post author`,
      });
    }
    if (section.showDate) {
      fields.push({
        name: 'date',
        message: `${label} post-content is missing the post date`,
      });
    }
    if (section.showCategories) {
      fields.push({
        name: 'categories',
        message: `${label} post-content is missing post categories`,
      });
    }
    addBinding(
      'post-content',
      `${label} post-content must render post detail content`,
      fields,
    );
  }

  private populatePostMetaContract(
    section: PostMetaSection,
    label: string,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    const fields: Array<{ name: string; message: string }> = [];
    if (section.showAuthor) {
      fields.push({
        name: 'author',
        message: `${label} post-meta is missing author rendering`,
      });
    }
    if (section.showDate) {
      fields.push({
        name: 'date',
        message: `${label} post-meta is missing date rendering`,
      });
    }
    if (section.showCategories) {
      fields.push({
        name: 'categories',
        message: `${label} post-meta is missing category rendering`,
      });
    }
    if (fields.length > 0) {
      addBinding(
        'post-content',
        `${label} post-meta must render from post detail data`,
        fields,
      );
    }
  }

  private populatePageContentContract(
    section: PageContentSection,
    label: string,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    const fields: Array<{ name: string; message: string }> = [
      {
        name: 'content',
        message: `${label} page-content must render page body HTML`,
      },
    ];
    if (section.showTitle) {
      fields.push({
        name: 'title',
        message: `${label} page-content is missing the page title`,
      });
    }
    addBinding(
      'page-content',
      `${label} page-content must render page detail content`,
      fields,
    );
  }

  private populateSearchContract(
    section: SearchSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    addLiteral(section.title, `${label} lost search title`);
    addBinding(
      'search-input',
      `${label} search UI is missing the search input`,
    );
    const requiresPostResults = section.obligation?.required?.includes('posts');
    if (!requiresPostResults) return;
    addBinding(
      'posts',
      `${label} search results must render from the posts collection`,
      [
        {
          name: 'title',
          message: `${label} search results are missing post title rendering`,
        },
      ],
    );
  }

  private populateCommentsContract(
    section: CommentsSection,
    label: string,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
    addInteraction: (
      kind: SectionInteractionKind,
      message: string,
      options?: Record<string, boolean | string | number | undefined>,
    ) => void,
  ): void {
    addBinding(
      'comments-list',
      `${label} comments list is missing source-backed comment rendering`,
      [
        {
          name: 'content',
          message: `${label} comments list is missing comment body rendering`,
        },
      ],
    );
    if (!section.showForm) return;
    const fields: Array<{ name: string; message: string }> = [
      {
        name: 'content',
        message: `${label} comment form is missing the comment textarea`,
      },
      {
        name: 'submit',
        message: `${label} comment form is missing the submit action`,
      },
    ];
    if (section.requireName) {
      fields.push({
        name: 'author',
        message: `${label} comment form is missing the required author field`,
      });
    }
    if (section.requireEmail) {
      fields.push({
        name: 'email',
        message: `${label} comment form is missing the required email field`,
      });
    }
    addBinding(
      'comment-form',
      `${label} comment form is missing required reply form structure`,
      fields,
    );
    addInteraction(
      'comment-form',
      `${label} comment form is missing required reply form structure`,
    );
  }

  private populateSidebarContract(
    section: SidebarSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {
    addLiteral(section.title, `${label} lost sidebar title`);
    if (section.showSiteInfo) {
      addBinding(
        'site-info',
        `${label} sidebar is missing site info rendering`,
      );
    }
    if (section.menuSlug) {
      addBinding('menus', `${label} sidebar is missing menus rendering`, [
        {
          name: 'items',
          message: `${label} sidebar is missing menu item rendering`,
        },
      ]);
    }
    if (section.showPages) {
      addBinding('pages', `${label} sidebar is missing pages rendering`, [
        {
          name: 'title',
          message: `${label} sidebar is missing page title rendering`,
        },
      ]);
    }
    if (section.showPosts) {
      addBinding('posts', `${label} sidebar is missing posts rendering`, [
        {
          name: 'title',
          message: `${label} sidebar is missing post title rendering`,
        },
      ]);
    }
  }

  private populateTabsContract(
    section: TabsSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addCollection: (
      kind: SectionContractCollectionRequirement['kind'],
      minItems: number,
      message: string,
      items: SectionContractCollectionItem[],
    ) => void,
    addInteraction: (
      kind: SectionInteractionKind,
      message: string,
      options?: Record<string, boolean | string | number | undefined>,
    ) => void,
  ): void {
    addLiteral(section.title, `${label} lost tabs title`);
    addCollection(
      'tabs',
      section.tabs.length,
      `${label} tabs must render all approved tab panels`,
      section.tabs.map((tab) => ({
        anchors: [tab.label, tab.heading, tab.imageSrc].filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        ),
        requirements: [
          { value: tab.label, message: `${label} lost tab label` },
          { value: tab.heading, message: `${label} lost tab heading` },
          { value: tab.body, message: `${label} lost tab body` },
          { value: tab.imageSrc, message: `${label} lost tab image src` },
          { value: tab.cta?.text, message: `${label} lost tab CTA text` },
        ],
      })),
    );
    addInteraction('tabs', `${label} tabs must render interactive tab state`, {
      minItems: section.tabs.length,
    });
  }

  private populateAccordionContract(
    section: AccordionSection,
    label: string,
    addLiteral: (value: string | undefined, message: string) => void,
    addCollection: (
      kind: SectionContractCollectionRequirement['kind'],
      minItems: number,
      message: string,
      items: SectionContractCollectionItem[],
    ) => void,
    addInteraction: (
      kind: SectionInteractionKind,
      message: string,
      options?: Record<string, boolean | string | number | undefined>,
    ) => void,
  ): void {
    addLiteral(section.title, `${label} lost accordion title`);
    addCollection(
      'accordion-items',
      section.items.length,
      `${label} accordion must render all approved accordion items`,
      section.items.map((item) => ({
        anchors: [item.heading].filter(Boolean) as string[],
        requirements: [
          { value: item.heading, message: `${label} lost accordion heading` },
          { value: item.body, message: `${label} lost accordion body` },
        ],
      })),
    );
    addInteraction(
      'accordion',
      `${label} accordion must render interactive expand/collapse state`,
      { minItems: section.items.length },
    );
  }

  private populateCarouselContract(
    section: CarouselSection,
    label: string,
    addCollection: (
      kind: SectionContractCollectionRequirement['kind'],
      minItems: number,
      message: string,
      items: SectionContractCollectionItem[],
    ) => void,
    addInteraction: (
      kind: SectionInteractionKind,
      message: string,
      options?: Record<string, boolean | string | number | undefined>,
    ) => void,
  ): void {
    addCollection(
      'slides',
      section.slides.length,
      `${label} carousel must render all approved slides`,
      section.slides.map((slide, index) => ({
        anchors: [
          slide.heading,
          slide.subheading,
          slide.imageSrc,
          slide.cta?.text,
        ].filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        ),
        requirements: [
          {
            value: slide.heading,
            message: `${label} lost carousel slide ${index + 1} heading`,
          },
          {
            value: slide.subheading,
            message: `${label} lost carousel slide ${index + 1} subheading`,
          },
          {
            value: slide.imageSrc,
            message: `${label} lost carousel slide ${index + 1} image src`,
          },
          {
            value: slide.cta?.text,
            message: `${label} lost carousel slide ${index + 1} CTA text`,
          },
        ],
      })),
    );
    if (section.slides.length > 1) {
      addInteraction(
        'carousel',
        `${label} carousel must render interactive slide state for multiple slides`,
        { minItems: section.slides.length },
      );
    }
  }

  private populateBreadcrumbContract(
    _section: BreadcrumbSection,
    _label: string,
    _addBinding: (
      kind: SectionBindingKind,
      message: string,
      fields?: Array<{ name: string; message: string }>,
    ) => void,
  ): void {}

  private auditRenderedSectionAgainstContract(
    code: string,
    contract: SectionRenderContract,
    isInlineSection = false,
  ): string[] {
    const issues: string[] = [];
    const satisfiesCanonicalPageContentBinding =
      contract.role === 'prose-block' &&
      this.codeSatisfiesBindingRequirement(code, 'page-content');

    if (!satisfiesCanonicalPageContentBinding) {
      for (const literal of contract.literals) {
        issues.push(
          ...this.requireLiteralIfPresent(code, literal.value, literal.message),
        );
      }
    }

    for (const binding of contract.bindings) {
      if (!this.codeSatisfiesBindingRequirement(code, binding.kind)) {
        issues.push(binding.message);
        continue;
      }
      for (const field of binding.fields ?? []) {
        if (this.codeSatisfiesBindingField(code, binding.kind, field.name))
          continue;
        issues.push(field.message);
      }
    }

    for (const interaction of contract.interactions) {
      if (
        this.codeSatisfiesInteractionRequirement(
          code,
          interaction,
          isInlineSection,
        )
      ) {
        continue;
      }
      issues.push(interaction.message);
    }

    for (const collection of contract.collections) {
      const renderedCount = collection.items.filter((item) =>
        this.codeSatisfiesCollectionItem(code, item),
      ).length;
      if (renderedCount < collection.minItems) {
        issues.push(
          `${collection.message}, but only ${renderedCount} item(s) were detected`,
        );
      }
      for (const item of collection.items) {
        for (const requirement of item.requirements) {
          issues.push(
            ...this.requireLiteralIfPresent(
              code,
              requirement.value,
              requirement.message,
            ),
          );
        }
      }
    }

    return [...new Set(issues)];
  }

  private codeSatisfiesCollectionItem(
    code: string,
    item: SectionContractCollectionItem,
  ): boolean {
    const primaryCandidates = this.uniqueCollectionItemCandidates([
      ...(item.primaryLiterals ?? []),
      ...item.anchors,
    ]);
    if (primaryCandidates.length > 0) {
      return primaryCandidates.some((candidate) =>
        this.codeContainsLiteral(code, candidate),
      );
    }

    const fallbackCandidates = this.uniqueCollectionItemCandidates(
      item.requirements.map((requirement) => requirement.value),
    );
    return fallbackCandidates.some((candidate) =>
      this.codeContainsLiteral(code, candidate),
    );
  }

  private uniqueCollectionItemCandidates(
    values: Array<string | undefined>,
  ): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const value of values) {
      const normalized = value?.trim();
      if (!normalized || this.isDynamicPlanBinding(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push(normalized);
    }

    return candidates;
  }

  private codeSatisfiesBindingRequirement(
    code: string,
    kind: SectionBindingKind,
  ): boolean {
    switch (kind) {
      case 'posts':
        return this.codeMatchesAnyPattern(code, [
          /\bposts(?:\??\.)?(?:map|slice|filter|find)\s*\(/,
          /\b(?:post|item)\.(?:title|slug|excerpt|content|date|author(?:Name)?|featuredImage|image|thumbnail|categories?|categorySlugs?)\b/,
        ]);
      case 'pages':
        return this.codeMatchesAnyPattern(code, [
          /\bpages(?:\??\.)?(?:map|slice|filter|find)\s*\(/,
          /\b(?:page|item)\.(?:title|slug|content)\b/,
        ]);
      case 'menus':
        return this.codeMatchesAnyPattern(code, [
          /\bmenus(?:\??\.)?(?:find|map|filter|some)\s*\(/,
          /\bmenu(?:s)?\.(?:items|links)\b/,
        ]);
      case 'footer-links':
        return this.codeMatchesAnyPattern(code, [
          /\bfooter(?:Columns|Links)(?:\??\.)?(?:map|filter|slice|find|some)\s*\(/,
          /\b[A-Za-z_$][\w$]*\.(?:heading|links)\b/,
          /fetch\(\s*['"`]\/api\/footer-links['"`]/,
        ]);
      case 'site-info':
        return /\bsiteInfo\??\.(?:siteName|blogDescription|logoUrl)\b/.test(
          code,
        );
      case 'comments-list':
        return this.codeMatchesAnyPattern(code, [
          /\btopLevelComments(?:\??\.)?\.map\s*\(/,
          /\bcomments(?:\??\.)?(?:map|slice|filter)\s*\(/,
          /\bcomment-list\b|\bcomment-template\b/i,
          /\bcomment\.(?:content|author(?:Name)?|date)\b/,
        ]);
      case 'comment-form':
        return this.codeMatchesAnyPattern(code, [
          /\bcomment-form\b/i,
          /<form\b[\s\S]*<textarea\b/i,
          /\bhandleCommentSubmit\b/,
        ]);
      case 'search-input':
        return this.codeMatchesAnyPattern(code, [
          /<input\b[^>]*type=["']search["']/i,
          /\bsearchQuery\b|\bsetSearchQuery\b/,
          /<form\b[\s\S]*search/i,
        ]);
      case 'post-content':
        return this.codeMatchesAnyPattern(code, [
          /dangerouslySetInnerHTML=\{\{\s*__html:\s*[A-Za-z_$][\w$]*\.content\s*\}\}/,
          /\b[A-Za-z_$][\w$]*\.(?:content|title|date|author(?:Name)?|categories?|categorySlugs?)\b/,
        ]);
      case 'page-content':
        return this.codeMatchesAnyPattern(code, [
          /dangerouslySetInnerHTML=\{\{\s*__html:\s*[A-Za-z_$][\w$]*\.content\s*\}\}/,
          /\b[A-Za-z_$][\w$]*\.(?:content|title)\b/,
        ]);
    }
  }

  private codeSatisfiesBindingField(
    code: string,
    kind: SectionBindingKind,
    field: string,
  ): boolean {
    switch (kind) {
      case 'posts':
        switch (field) {
          case 'title':
            return /\b(?:post|item)\.title\b/.test(code);
          case 'slug':
            return /\b(?:post|item)\.slug\b|<(?:Link|a)\b/i.test(code);
          case 'excerpt':
            return /\b(?:post|item)\.excerpt\b|excerpt/i.test(code);
          case 'author':
            return /\b(?:post|item)\.author(?:Name)?\b/i.test(code);
          case 'date':
            return /\b(?:post|item)\.date\b|<time\b/i.test(code);
          case 'categories':
            return /\b(?:post|item)\.(?:categories|category|categorySlugs?)\b/i.test(
              code,
            );
          case 'featuredImage':
            return /\b(?:post|item)\.(?:featuredImage|image|thumbnail)\b|<img\b/i.test(
              code,
            );
          case 'content':
            return /\b(?:post|item)\.content\b/.test(code);
          default:
            return true;
        }
      case 'pages':
        switch (field) {
          case 'title':
            return /\b(?:page|item)\.title\b/.test(code);
          case 'slug':
            return /\b(?:page|item)\.slug\b|<(?:Link|a)\b/i.test(code);
          case 'content':
            return /\b(?:page|item)\.content\b|dangerouslySetInnerHTML/.test(
              code,
            );
          default:
            return true;
        }
      case 'menus':
        if (field === 'items') {
          return /\bmenu(?:s)?\.items\b|\bmenus(?:\??\.)?(?:find|map|filter|some)\s*\(/.test(
            code,
          );
        }
        return true;
      case 'footer-links':
        switch (field) {
          case 'heading':
            return /\b[A-Za-z_$][\w$]*\.heading\b/.test(code);
          case 'links':
            return /\b[A-Za-z_$][\w$]*\.links\b|\bfooter(?:Columns|Links)(?:\??\.)?(?:map|filter|slice|find|some)\s*\(/.test(
              code,
            );
          default:
            return true;
        }
      case 'site-info':
        return new RegExp(
          `\\bsiteInfo\\??\\.${this.escapeRegExp(field)}\\b`,
          'i',
        ).test(code);
      case 'comments-list':
        switch (field) {
          case 'content':
            return /\bcomment\.content\b|dangerouslySetInnerHTML/.test(code);
          case 'author':
            return /\bcomment\.author(?:Name)?\b/i.test(code);
          case 'date':
            return /\bcomment\.date\b|<time\b/i.test(code);
          default:
            return true;
        }
      case 'comment-form':
        switch (field) {
          case 'author':
            return /\bid=["']author["']|\bname=["']author["']/.test(code);
          case 'email':
            return /\bid=["']email["']|\bname=["']email["']/.test(code);
          case 'content':
            return /<textarea\b/i.test(code);
          case 'submit':
            return /\bhandleCommentSubmit\b|type=["']submit["']/.test(code);
          default:
            return true;
        }
      case 'search-input':
        return /<input\b[^>]*type=["']search["']/i.test(code);
      case 'post-content':
        switch (field) {
          case 'title':
            return /\b[A-Za-z_$][\w$]*\.title\b/.test(code);
          case 'content':
            return /dangerouslySetInnerHTML=\{\{\s*__html:\s*[A-Za-z_$][\w$]*\.content\s*\}\}/.test(
              code,
            );
          case 'author':
            return /\b[A-Za-z_$][\w$]*\.author(?:Name)?\b/i.test(code);
          case 'date':
            return /\b[A-Za-z_$][\w$]*\.date\b|<time\b/i.test(code);
          case 'categories':
            return /\b[A-Za-z_$][\w$]*\.(?:categories|category|categorySlugs?)\b/i.test(
              code,
            );
          default:
            return true;
        }
      case 'page-content':
        switch (field) {
          case 'title':
            return /\b[A-Za-z_$][\w$]*\.title\b/.test(code);
          case 'content':
            return /dangerouslySetInnerHTML=\{\{\s*__html:\s*[A-Za-z_$][\w$]*\.content\s*\}\}/.test(
              code,
            );
          default:
            return true;
        }
    }
  }

  private codeSatisfiesInteractionRequirement(
    code: string,
    interaction: SectionContractInteractionRequirement,
    isInlineSection: boolean,
  ): boolean {
    switch (interaction.kind) {
      case 'modal': {
        const hasTrigger = /\buagb-modal-trigger\b|<(?:button|a|Link)\b/i.test(
          code,
        );
        const hasDialog =
          /\buagb-modal-popup\b|\buagb-modal-popup-content\b|\brole\s*=\s*["']dialog["']|\baria-modal\s*=\s*(?:{?true}?|["']true["'])/i.test(
            code,
          );
        const hasState =
          /\bopenModal\b|\bopenModals\b|\bsetOpenModal\b|\bsetOpenModals\b|\bisModalOpen\b|\bsetIsModalOpen\b/.test(
            code,
          );
        if (isInlineSection) {
          return hasTrigger && hasDialog;
        }
        return hasTrigger && hasDialog && hasState;
      }
      case 'tabs':
        return /(activeTab|setActiveTab|role=["']tab["']|tablist|tabs?\.map)/i.test(
          code,
        );
      case 'accordion':
        return /(aria-expanded|accordion|setOpen|openItems|items\.map)/i.test(
          code,
        );
      case 'carousel': {
        const minItems = Number(interaction.options?.minItems ?? 0);
        if (minItems <= 1) return true;
        return /(activeCarousels|setActiveCarousels|swiper-slide|keen-slider|embla|currentSlide|setCurrentSlide)/i.test(
          code,
        );
      }
      case 'comment-form':
        return /\bcomment-form\b/i.test(code) && /<textarea\b/i.test(code);
    }
  }

  private codeMatchesAnyPattern(code: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(code));
  }

  private codeContainsLiteral(code: string, value: string): boolean {
    const normalized = value.trim();
    if (!normalized) return false;
    if (code.includes(normalized)) return true;
    return this.codeSemanticallyContainsLiteral(code, normalized);
  }

  private checkVisualPlanObligations(
    code: string,
    visualPlan?: ComponentVisualPlan,
    componentName?: string,
  ): string | null {
    if (!visualPlan?.sections?.length) return null;

    const issues: string[] = [];
    const sectionAuditLines: string[] = [];

    for (const [index, section] of visualPlan.sections.entries()) {
      const label = `"${componentName ?? visualPlan.componentName}" section ${index + 1}`;
      const sectionIssues = this.auditSectionContractFidelity(
        code,
        section,
        label,
      );
      sectionIssues.push(
        ...this.checkSectionStylingFidelity(code, section, label),
      );
      if (sectionIssues.length > 0) {
        issues.push(...sectionIssues);
        sectionAuditLines.push(
          this.buildSectionAuditLine({
            label,
            section,
            issues: sectionIssues,
            sectionIndex: index,
          }),
        );
      }
    }

    if (issues.length === 0) return null;
    const detailLines = issues.slice(0, 8).map((issue) => `detail: ${issue}`);
    return `Visual section contracts violated:\n${[
      `plannedSections=${visualPlan.sections.length}`,
      ...sectionAuditLines.slice(0, 6),
      ...detailLines,
    ].join('\n')}`;
  }

  private buildSectionAuditLine(input: {
    label: string;
    section: SectionPlan;
    issues: string[];
    sectionIndex: number;
  }): string {
    const { label, section, issues, sectionIndex } = input;
    const debugKey =
      section.debugKey?.trim() ||
      section.sectionKey?.trim() ||
      `${section.type}-${sectionIndex + 1}`;
    const issueKinds = this.summarizeContractIssueKinds(issues);
    return [
      `sectionContractAudit: ${label}`,
      `debugKey=${debugKey}`,
      `type=${section.type}`,
      `role=${section.obligation?.role ?? section.type}`,
      `issueKinds=${issueKinds.join(', ') || 'unknown'}`,
      `details=${issues.length}`,
    ].join(' | ');
  }

  private summarizeContractIssueKinds(issues: string[]): string[] {
    const kinds = new Set<string>();
    for (const issue of issues) {
      const normalized = issue.toLowerCase();
      if (normalized.includes('cta text')) {
        kinds.add('cta');
      }
      if (normalized.includes('button text')) {
        kinds.add('button');
      }
      if (normalized.includes('image src') || normalized.includes('avatar')) {
        kinds.add('image');
      }
      if (normalized.includes('subheading')) {
        kinds.add('subheading');
      }
      if (normalized.includes('heading')) {
        kinds.add('heading');
      }
      if (normalized.includes('subtitle')) {
        kinds.add('subtitle');
      }
      if (normalized.includes('title')) {
        kinds.add('title');
      }
      if (normalized.includes('body')) {
        kinds.add('body');
      }
      if (normalized.includes('list item')) {
        kinds.add('list-item');
      }
      if (normalized.includes('slide')) {
        kinds.add('slide');
      }
      if (normalized.includes('tab label')) {
        kinds.add('tab-label');
      }
      if (normalized.includes('comments list')) {
        kinds.add('comments-list');
      }
      if (normalized.includes('comment form')) {
        kinds.add('comment-form');
      }
      if (normalized.includes('site info')) {
        kinds.add('site-info');
      }
      if (normalized.includes('menus')) {
        kinds.add('menus');
      }
      if (normalized.includes('pages')) {
        kinds.add('pages');
      }
      if (normalized.includes('posts')) {
        kinds.add('posts');
      }
      if (normalized.includes('quote')) {
        kinds.add('quote');
      }
      if (normalized.includes('author')) {
        kinds.add('author');
      }
      if (
        normalized.includes('popup overlay') ||
        normalized.includes('appears inline instead of interactive') ||
        normalized.includes('missing the `active` class')
      ) {
        kinds.add('interaction');
      }
      if (normalized.includes('styling:')) {
        kinds.add('styling');
      }
    }
    return [...kinds];
  }

  tryAutoFixTrackingAttributes(
    code: string,
    _visualPlan?: ComponentVisualPlan,
  ): string {
    return code;
  }

  private checkSectionStylingFidelity(
    code: string,
    section: SectionPlan,
    label: string,
  ): string[] {
    const issues: string[] = [];
    // Only validate specific color values extracted from WordPress (hex / rgb).
    // Skip generic white/black/transparent — too common to signal a real miss.
    const SKIP_GENERIC =
      /^(#fff(fff)?|#000(000)?|transparent|inherit|initial|unset|white|black)$/i;

    const checkColor = (value: string | undefined, fieldName: string) => {
      if (!value) return;
      const v = value.trim();
      if (!/^#[0-9a-f]{3,8}$/i.test(v) && !/^rgb/i.test(v)) return;
      if (SKIP_GENERIC.test(v)) return;
      if (code.includes(v)) return;
      issues.push(
        `${label} styling: ${fieldName} value ${JSON.stringify(v)} missing from generated code`,
      );
    };

    checkColor(section.background, 'background');
    checkColor(section.textColor, 'textColor');
    return issues;
  }

  private isDynamicPlanBinding(value?: string): boolean {
    const normalized = value?.trim();
    return Boolean(
      normalized &&
      (/^\{[a-zA-Z0-9_.]+\}$/.test(normalized) ||
        /\{[a-zA-Z0-9_.]+\}/.test(normalized)),
    );
  }

  private shouldRequireTitleLiteral(obligation?: SectionObligation): boolean {
    const explicit = obligation?.contentRequirements?.requireTitle;
    if (typeof explicit === 'boolean') return explicit;
    return true;
  }

  private requireLiteralIfPresent(
    code: string,
    value: string | undefined,
    error: string,
  ): string[] {
    const normalized = value?.trim();
    if (!normalized) return [];
    if (this.isDynamicPlanBinding(normalized)) return [];
    if (code.includes(normalized)) return [];
    if (this.codeSemanticallyContainsLiteral(code, normalized)) return [];
    const preview =
      normalized.length > 120
        ? `${normalized.slice(0, 117).trimEnd()}...`
        : normalized;
    return [`${error}: ${JSON.stringify(preview)}`];
  }

  private codeSemanticallyContainsLiteral(
    code: string,
    literal: string,
  ): boolean {
    const normalizedLiteral = this.normalizeLiteralSearchText(literal);
    if (!normalizedLiteral) return true;

    const normalizedCode = this.normalizeLiteralSearchText(code);
    if (normalizedCode.includes(normalizedLiteral)) return true;
    if (this.codeContainsEquivalentAssetLiteral(code, literal)) return true;

    const paragraphParts = normalizedLiteral
      .split(/\n\s*\n/)
      .map((part) => this.normalizeLiteralSearchText(part))
      .filter(Boolean);
    if (paragraphParts.length > 1) {
      return paragraphParts.every((part) => normalizedCode.includes(part));
    }

    return false;
  }

  private codeContainsEquivalentAssetLiteral(
    code: string,
    literal: string,
  ): boolean {
    if (!/\/wp-content\/uploads\//i.test(literal)) return false;

    const fileName = this.extractLiteralFileName(literal);
    if (!fileName) return false;

    const escapedFileName = this.escapeRegExp(fileName);
    const localAssetPatterns = [
      new RegExp(`/assets/images/[^"'\\s)\\]}]*${escapedFileName}`, 'i'),
      new RegExp(`/assets/[^"'\\s)\\]}]*${escapedFileName}`, 'i'),
    ];

    return localAssetPatterns.some((pattern) => pattern.test(code));
  }

  private extractLiteralFileName(literal: string): string | null {
    const trimmed = literal.trim();
    if (!trimmed) return null;

    try {
      const pathname = new URL(trimmed).pathname;
      const fileName = pathname.split('/').pop()?.trim();
      return fileName || null;
    } catch {
      const normalized = trimmed.split(/[?#]/)[0] ?? trimmed;
      const fileName = normalized.split('/').pop()?.trim();
      return fileName || null;
    }
  }

  private normalizeLiteralSearchText(input: string): string {
    return input
      .replace(
        /\{\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1\s*\}/g,
        (_match, _quote: string, content: string) =>
          this.normalizeJsxStringLiteralContent(content),
      )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\\n/g, ' ')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`')
      .replace(/\\\\/g, '\\')
      .replace(/\{['"`]\s*['"`]\}/g, ' ')
      .replace(/\{`\s*`\}/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;|&#34;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeJsxStringLiteralContent(content: string): string {
    return content
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, ' ')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`')
      .replace(/\\\\/g, '\\');
  }

  private findMissingRequiredCustomClasses(
    code: string,
    requiredCustomClassNames: string[],
    requiredCustomClassTargets?: Record<string, ThemeInteractionTarget>,
  ): string[] {
    const normalized = [
      ...new Set(
        requiredCustomClassNames
          .map((className) => className.trim())
          .filter(Boolean),
      ),
    ];
    return normalized.filter(
      (className) =>
        !this.hasRequiredCustomClassOnExpectedTarget(
          code,
          className,
          requiredCustomClassTargets?.[className],
        ),
    );
  }

  private repairMissingRequiredCustomClasses(
    code: string,
    requiredCustomClassNames: string[],
    requiredCustomClassTargets?: Record<string, ThemeInteractionTarget>,
  ): string {
    const missing = this.findMissingRequiredCustomClasses(
      code,
      requiredCustomClassNames,
      requiredCustomClassTargets,
    );
    if (missing.length === 0) return code;

    let next = code;
    for (const className of missing) {
      next = this.injectCustomClassIntoBestTarget(
        next,
        className,
        requiredCustomClassTargets?.[className],
      );
    }
    return next;
  }

  private injectCustomClassIntoBestTarget(
    code: string,
    className: string,
    target?: ThemeInteractionTarget,
  ): string {
    const normalized = className.trim();
    if (!normalized) return code;

    if (target === 'image') {
      return this.injectCustomClassIntoFirstMatchingTag(
        code,
        /<img\b[^>]*\/?>/g,
        normalized,
      );
    }

    if (target === 'link') {
      return this.injectCustomClassIntoFirstMatchingTag(
        code,
        /<(?:Link|a)\b[^>]*>/g,
        normalized,
        (openTag) => !this.isButtonLikeInteractiveTag(openTag),
      );
    }

    if (target === 'button') {
      return this.injectCustomClassIntoFirstMatchingTag(
        code,
        /<(?:button|Link|a)\b[^>]*>/g,
        normalized,
        (openTag) =>
          /<button\b/i.test(openTag) ||
          this.isButtonLikeInteractiveTag(openTag),
      );
    }

    if (target === 'card') {
      return this.injectCustomClassIntoFirstMatchingTag(
        code,
        /<(?:div|section|article|aside|nav|li|figure)\b[^>]*>/g,
        normalized,
      );
    }

    const commentAnchor =
      /\{\/\*\s*Comments\s*\*\/\}[\s\S]*?(<(?:section|div|article)\b[^>]*>)/;
    if (/comment/i.test(normalized) && commentAnchor.test(code)) {
      return code.replace(commentAnchor, (match, openTag: string) =>
        match.replace(
          openTag,
          this.appendClassToOpeningTag(openTag, normalized),
        ),
      );
    }

    const sidebarAnchor =
      /\{\/\*\s*Sidebar\s*\*\/\}[\s\S]*?(<(?:aside|section|div)\b[^>]*>)/;
    if (/sidebar/i.test(normalized) && sidebarAnchor.test(code)) {
      return code.replace(sidebarAnchor, (match, openTag: string) =>
        match.replace(
          openTag,
          this.appendClassToOpeningTag(openTag, normalized),
        ),
      );
    }

    return code.replace(
      /<(?:div|section|main|article|aside|nav)\b[^>]*>/,
      (openTag) => this.appendClassToOpeningTag(openTag, normalized),
    );
  }

  private hasRequiredCustomClassOnExpectedTarget(
    code: string,
    className: string,
    target?: ThemeInteractionTarget,
  ): boolean {
    const normalized = className.trim();
    if (!normalized) return true;

    if (!target) {
      return new RegExp(
        `(^|[^A-Za-z0-9_-])${this.escapeRegex(normalized)}([^A-Za-z0-9_-]|$)`,
      ).test(code);
    }

    if (target === 'image') {
      return this.tagWithClassExists(code, /<img\b[^>]*\/?>/g, normalized);
    }

    if (target === 'link') {
      return this.tagWithClassExists(
        code,
        /<(?:Link|a)\b[^>]*>/g,
        normalized,
        (openTag) => !this.isButtonLikeInteractiveTag(openTag),
      );
    }

    if (target === 'button') {
      return this.tagWithClassExists(
        code,
        /<(?:button|Link|a)\b[^>]*>/g,
        normalized,
        (openTag) =>
          /<button\b/i.test(openTag) ||
          this.isButtonLikeInteractiveTag(openTag),
      );
    }

    if (target === 'card') {
      return this.tagWithClassExists(
        code,
        /<(?:div|section|article|aside|nav|li|figure)\b[^>]*>/g,
        normalized,
      );
    }

    return false;
  }

  private tagWithClassExists(
    code: string,
    pattern: RegExp,
    className: string,
    predicate?: (openTag: string) => boolean,
  ): boolean {
    const classPattern = new RegExp(
      `(^|[^A-Za-z0-9_-])${this.escapeRegex(className)}([^A-Za-z0-9_-]|$)`,
    );

    for (const match of code.matchAll(pattern)) {
      const openTag = match[0];
      if (predicate && !predicate(openTag)) continue;
      if (classPattern.test(openTag)) return true;
    }

    return false;
  }

  private injectCustomClassIntoFirstMatchingTag(
    code: string,
    pattern: RegExp,
    className: string,
    predicate?: (openTag: string) => boolean,
  ): string {
    let applied = false;
    return code.replace(pattern, (openTag) => {
      if (applied) return openTag;
      if (predicate && !predicate(openTag)) return openTag;
      applied = true;
      return this.appendClassToOpeningTag(openTag, className);
    });
  }

  private isButtonLikeInteractiveTag(openTag: string): boolean {
    return (
      /\bvp-generated-button\b/.test(openTag) ||
      /\bwp-element-button\b/.test(openTag) ||
      /\bwp-block-button__link\b/.test(openTag) ||
      /\binline-flex\b/.test(openTag) ||
      /\bjustify-center\b/.test(openTag) ||
      /\bbg-\[/.test(openTag) ||
      (/\bpx-/.test(openTag) && /\bpy-/.test(openTag))
    );
  }

  private appendClassToOpeningTag(openTag: string, className: string): string {
    if (/\bclassName="[^"]*"/.test(openTag)) {
      return openTag.replace(
        /\bclassName="([^"]*)"/,
        (_match, existingClasses: string) =>
          `className="${this.appendUniqueClasses(existingClasses, className)}"`,
      );
    }

    return openTag.replace(/<([A-Za-z0-9]+)/, `<$1 className="${className}"`);
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Run the TypeScript compiler against a single generated component file and
   * return up to 10 human-readable error strings (e.g. "src/Archive.tsx:12:5
   * TS17002: Expected corresponding JSX closing tag for 'div'").
   *
   * These errors are fed back to the AI as the retry signal so it knows the
   * exact line/column/code to fix instead of a generic "validation failed".
   *
   * Returns an empty array when the file has no TypeScript errors.
   */
  extractTypeScriptErrors(code: string, componentName: string): string[] {
    const filePath = `${VIRTUAL_ROOT}/src/${componentName}.tsx`;
    const files = new Map<string, string>();
    files.set(this.normalizeVirtualPath(filePath), code);
    files.set(
      this.normalizeVirtualPath(VIRTUAL_REACT_SHIM_FILE),
      this.buildReactShim(),
    );

    const host = this.createVirtualCompilerHost(files);
    const program = ts.createProgram({
      rootNames: [this.normalizeVirtualPath(filePath)],
      options: PREVIEW_COMPILER_OPTIONS,
      host,
    });

    return ts
      .getPreEmitDiagnostics(program)
      .filter((diag) => !this.shouldIgnoreProjectDiagnostic(diag))
      .map((diag) => this.formatDiagnostic(diag))
      .filter(Boolean)
      .slice(0, 10) as string[];
  }

  private checkProjectCompilation(components: GeneratedComponent[]): string[] {
    const files = new Map<string, string>();
    const componentImports: string[] = [];
    const componentRenders: string[] = [];
    const targetPaths = new Set<string>();
    const setVirtualFile = (filePath: string, content: string) => {
      files.set(this.normalizeVirtualPath(filePath), content);
    };

    for (let idx = 0; idx < components.length; idx++) {
      const comp = components[idx];
      const filePath = this.getVirtualComponentFilePath(comp);
      if (targetPaths.has(filePath)) {
        return [
          `Duplicate generated file path for component "${comp.name}": ${filePath.replace(VIRTUAL_ROOT, '')}`,
        ];
      }
      targetPaths.add(filePath);
      setVirtualFile(filePath, comp.code);
      componentImports.push(
        `import Component${idx} from '${this.toImportPath(VIRTUAL_APP_FILE, filePath)}';`,
      );
      componentRenders.push(`      <Component${idx} />`);
    }

    setVirtualFile(
      VIRTUAL_APP_FILE,
      `import React from 'react';
${componentImports.join('\n')}

export default function App() {
  return (
    <>
${componentRenders.join('\n')}
    </>
  );
}
`,
    );
    setVirtualFile(
      VIRTUAL_MAIN_FILE,
      `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    );
    setVirtualFile(`${VIRTUAL_ROOT}/src/index.css`, '');
    setVirtualFile(VIRTUAL_REACT_SHIM_FILE, this.buildReactShim());

    const host = this.createVirtualCompilerHost(files);
    const program = ts.createProgram({
      rootNames: [...files.keys()].filter((filePath) =>
        /\.(?:tsx?|d\.ts)$/i.test(filePath),
      ),
      options: PREVIEW_COMPILER_OPTIONS,
      host,
    });

    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diag) => !this.shouldIgnoreProjectDiagnostic(diag));

    return diagnostics
      .map((diag) => this.formatDiagnostic(diag))
      .filter(Boolean)
      .slice(0, 50);
  }

  // ── Core: strip unused imports ──────────────────────────────────────────────

  removeUnusedImports(code: string): string {
    const lines = code.split('\n');

    // Collect all import line indices + their parsed identifiers
    const importBlocks: Array<{
      lineIdx: number;
      raw: string;
      identifiers: string[]; // named/default identifiers that can be checked
      alwaysKeep: boolean; // e.g. side-effect imports, React, type-only
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trimStart().startsWith('import ')) continue;

      // Side-effect import: import './foo.css'
      if (/^import\s+['"]/.test(line.trim())) {
        importBlocks.push({
          lineIdx: i,
          raw: line,
          identifiers: [],
          alwaysKeep: true,
        });
        continue;
      }

      // Type-only import: import type { ... }
      if (/^import\s+type\s/.test(line.trim())) {
        importBlocks.push({
          lineIdx: i,
          raw: line,
          identifiers: [],
          alwaysKeep: true,
        });
        continue;
      }

      const identifiers: string[] = [];

      // Default import: import Foo from '...'  OR  import React from '...'
      const defaultMatch = line.match(
        /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\s+from)/,
      );
      if (defaultMatch) {
        identifiers.push(defaultMatch[1]);
      }

      // Named imports: import { A, B as C } from '...'
      const namedMatch = line.match(/\{([^}]+)\}/);
      if (namedMatch) {
        const names = namedMatch[1]
          .split(',')
          .map((s) => {
            // Handle "Foo as Bar" → use Bar (the local alias)
            const alias = s.trim().match(/(?:.*\s+as\s+)?(\S+)$/);
            return alias ? alias[1] : s.trim();
          })
          .filter(Boolean);
        identifiers.push(...names);
      }

      // Namespace import: import * as Foo from '...'
      const nsMatch = line.match(
        /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      if (nsMatch) {
        identifiers.push(nsMatch[1]);
      }

      // Always keep React — JSX transforms still reference it in some setups
      const isReact =
        /from\s+['"]react['"]/.test(line) && identifiers.includes('React');

      importBlocks.push({
        lineIdx: i,
        raw: line,
        identifiers,
        alwaysKeep: isReact || identifiers.length === 0,
      });
    }

    if (importBlocks.length === 0) return code;

    // Build the non-import portion of the code to check usage
    const importLineIndices = new Set(importBlocks.map((b) => b.lineIdx));
    const bodyLines = lines.filter((_, i) => !importLineIndices.has(i));
    const body = bodyLines.join('\n');

    // Decide which import lines to keep
    const linesToRemove = new Set<number>();

    for (const block of importBlocks) {
      if (block.alwaysKeep) continue;

      const unusedIdents = block.identifiers.filter(
        (ident) => !this.isIdentifierUsed(ident, body),
      );

      if (unusedIdents.length === 0) continue; // all used — keep as-is

      if (unusedIdents.length === block.identifiers.length) {
        // Nothing used → drop the whole line
        linesToRemove.add(block.lineIdx);
        this.logger.debug(`Removing unused import: ${block.raw.trim()}`);
      } else {
        // Partial removal — rebuild the import line without the unused named imports
        lines[block.lineIdx] = this.stripUnusedNamed(block.raw, unusedIdents);
        this.logger.debug(
          `Partial removal on import line ${block.lineIdx}: removed ${unusedIdents.join(', ')}`,
        );
      }
    }

    const result = lines.filter((_, i) => !linesToRemove.has(i)).join('\n');

    // Clean up any double blank lines that removal may have introduced
    return result.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private isIdentifierUsed(ident: string, body: string): boolean {
    const escapedIdent = this.escapeRegExp(ident);

    if (
      /^[A-Z]/.test(ident) &&
      new RegExp(`<${escapedIdent}(?=[\\s>/])`).test(body)
    ) {
      return true;
    }

    if (
      /^use[A-Z]/.test(ident) &&
      new RegExp(`\\b${escapedIdent}\\s*(?:<[^>]+>)?\\s*\\(`).test(body)
    ) {
      return true;
    }

    if (ident === 'Link' && /<Link(?=[\s>/])/.test(body)) return true;
    if (ident === 'NavLink' && /<NavLink(?=[\s>/])/.test(body)) return true;
    if (ident === 'useParams' && /\buseParams\s*(?:<[^>]+>)?\s*\(/.test(body)) {
      return true;
    }

    // Use word-boundary regex so "useState" doesn't match "useStateExtra"
    const sanitizedBody = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ')
      .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
    const re = new RegExp(`\\b${escapedIdent}\\b`);
    return re.test(sanitizedBody);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private findInvalidRelativeImport(
    code: string,
    context: CodeValidationContext,
  ): string | null {
    const allowed = new Set(context.allowedRelativeImports ?? []);
    const currentFolder = this.getComponentFolder(
      context.componentName,
      context.type,
      context.isSubComponent,
    );
    const matches = [
      ...code.matchAll(/import\s+[^'"]+from\s+['"]([^'"]+)['"]/g),
    ];

    for (const match of matches) {
      const importPath = match[1];
      if (/^@\/(?:components|pages)\//.test(importPath)) {
        return importPath;
      }
      if (!importPath.startsWith('./') && !importPath.startsWith('../'))
        continue;

      if (/\.(?:js|jsx)$/.test(importPath)) {
        return importPath;
      }

      const basename = importPath
        .replace(/^\.\/|^\.\.\//, '')
        .split('/')
        .pop()
        ?.replace(/\.(?:js|jsx|ts|tsx)$/, '');
      if (!basename) return importPath;
      if (
        importPath.startsWith('./') &&
        /^(?:components|pages)\//.test(importPath.replace(/^\.\//, ''))
      ) {
        return importPath;
      }
      if (
        importPath.startsWith('../') &&
        !/^\.\.\/(?:components|pages)\//.test(importPath)
      ) {
        return importPath;
      }
      if (!/^[A-Z][A-Za-z0-9]+$/.test(basename)) continue;

      if (!allowed.has(basename)) {
        return importPath;
      }

      const targetFolder = this.getComponentFolder(basename);
      const expectedPath =
        currentFolder === targetFolder
          ? `./${basename}`
          : `../${targetFolder}/${basename}`;
      if (importPath !== expectedPath) {
        return importPath;
      }
    }

    return null;
  }

  private getComponentFolder(
    componentName?: string,
    type?: 'page' | 'partial',
    isSubComponent?: boolean,
  ): 'pages' | 'components' {
    if (
      type === 'partial' ||
      isSubComponent === true ||
      isPartialComponentName(componentName ?? '')
    ) {
      return 'components';
    }
    return 'pages';
  }

  private matchesDetailFetch(
    code: string,
    resource: 'posts' | 'pages' | 'products',
  ): boolean {
    return this.matchesDynamicDetailFetch(code, resource);
  }

  private matchesAnyDetailFetch(
    code: string,
    resource: 'posts' | 'pages' | 'products',
  ): boolean {
    const escapedResource = this.escapeRegExp(resource);
    const exactPattern = new RegExp(
      `fetch\\(\\s*['"\`]/api/${escapedResource}/[^'"\`\\s)]+['"\`]`,
    );
    return (
      this.matchesDynamicDetailFetch(code, resource) || exactPattern.test(code)
    );
  }

  private matchesDynamicDetailFetch(
    code: string,
    resource: 'posts' | 'pages' | 'products',
  ): boolean {
    const patterns = [
      // Template literal: `/api/posts/${slug}` or `/api/posts/${encodeURIComponent(slug)}`
      new RegExp(
        String.raw`fetch\(\s*\`/api/${resource}/\$\{[^}]*(?:slug|productId)[^}]*\}\``,
      ),
      // String concat: '/api/posts/' + slug or '/api/posts/' + encodeURIComponent(slug)
      new RegExp(String.raw`fetch\(\s*['"]/api/${resource}/['"]\s*\+`),
      // Unusual single/double-quoted string with ${…}: '/api/posts/${slug}'
      new RegExp(
        String.raw`fetch\(\s*['"]/api/${resource}/\$\{[^}]*(?:slug|productId)[^}]*\}['"]`,
      ),
    ];
    return patterns.some((pattern) => pattern.test(code));
  }

  private matchesExactDetailFetch(
    code: string,
    resource: 'posts' | 'pages' | 'products',
    slug: string,
  ): boolean {
    const escapedResource = this.escapeRegExp(resource);
    const escapedSlug = this.escapeRegExp(slug);
    const patterns = [
      new RegExp(
        `fetch\\(\\s*['"\`]/api/${escapedResource}/${escapedSlug}['"\`]`,
      ),
      new RegExp(
        String.raw`fetch\(\s*\`/api/${escapedResource}/${escapedSlug}\``,
      ),
    ];
    return patterns.some((pattern) => pattern.test(code));
  }

  private rendersStaticCarouselTrack(code: string): boolean {
    return /\bswiper-wrapper\b/.test(code) && !/translateX\(/.test(code);
  }

  private hasEmptySwiperControlButton(code: string): boolean {
    return (
      /<button\b[^>]*\bswiper-button-(?:prev|next)\b[^>]*\/>/s.test(code) ||
      /<button\b[^>]*\bswiper-button-(?:prev|next)\b[^>]*>\s*<\/button>/s.test(
        code,
      )
    );
  }

  private findInteractiveStateKeyMismatch(
    code: string,
    stateObjectName: 'activeCarousels' | 'openModals',
  ): string | null {
    const keyMatches = [
      ...code.matchAll(
        new RegExp(`${stateObjectName}\\[("[^"]+"|'[^']+')\\]`, 'g'),
      ),
    ];
    const normalizedKeys = Array.from(
      new Set(
        keyMatches
          .map((match) => match[1]?.slice(1, -1))
          .filter((value): value is string => !!value),
      ),
    );

    if (normalizedKeys.length <= 1) return null;
    return `found multiple ${stateObjectName} keys: ${normalizedKeys
      .map((key) => JSON.stringify(key))
      .join(', ')}`;
  }

  private fetchesSharedChromeData(code: string): boolean {
    return /fetch\(\s*['"`]\/api\/(?:site-info|menus|footer-links)\b/.test(
      code,
    );
  }

  private usesSharedChromeData(code: string): boolean {
    return (
      /\bsiteInfo\??\.(?:siteName|siteUrl|blogDescription|logoUrl)\b/.test(
        code,
      ) ||
      /\bmenus(?:\??\.)?(?:find|map|filter|some)\s*\(/.test(code) ||
      /\{\s*menus\b/.test(code) ||
      /\bfooterColumns(?:\??\.)?(?:map|filter|some)\s*\(/.test(code) ||
      /\{\s*footerColumns\b/.test(code)
    );
  }

  private findPlaceholderLinkSnippets(code: string, max = 3): string[] {
    const snippets: string[] = [];
    const tagPattern =
      /<(?:Link|a)\b[^>]*(?:to|href)\s*=\s*(?:["']#["']|\{["']#["']\})[^>]*>[\s\S]*?<\/(?:Link|a)>/g;

    for (const match of code.matchAll(tagPattern)) {
      const raw = match[0]?.replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      snippets.push(raw.length > 160 ? `${raw.slice(0, 157)}...` : raw);
      if (snippets.length >= max) return snippets;
    }

    for (const line of code.split('\n')) {
      const trimmed = line.trim();
      if (/(?:\bto=|\bhref=)\s*(?:["']#["']|\{["']#["']\})/.test(trimmed)) {
        snippets.push(
          trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed,
        );
        if (snippets.length >= max) break;
      }
    }

    return snippets;
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

  private ensureHoverUnderlineOnCanonicalTextLinks(code: string): string {
    return code.replace(/<(Link|a)\b[\s\S]{0,400}?>/g, (rawTag) => {
      if (!/\bclassName="[^"]*"/.test(rawTag)) return rawTag;
      if (/hover:underline/.test(rawTag) || /\bno-underline\b/.test(rawTag)) {
        return rawTag;
      }

      const looksLikeButton =
        /\bbg-\[/.test(rawTag) ||
        (/\bpx-/.test(rawTag) && /\bpy-/.test(rawTag)) ||
        /\bjustify-center\b/.test(rawTag);
      if (looksLikeButton) return rawTag;

      const isCanonicalTextLink =
        /\/(?:post|page|author|category|tag)\//.test(rawTag) ||
        /\bitem\.url\b/.test(rawTag) ||
        /\btoAppPath\(item\.url\)\b/.test(rawTag) ||
        /\bhref=["']https?:\/\//.test(rawTag);
      if (!isCanonicalTextLink) return rawTag;

      return rawTag.replace(
        /\bclassName="([^"]*)"/,
        (_match, classes: string) =>
          `className="${this.appendUniqueClasses(
            classes,
            'hover:underline underline-offset-4',
          )}"`,
      );
    });
  }

  private findPlainTextPostMetaArchiveSnippets(
    code: string,
    max = 3,
  ): string[] {
    return findSharedPlainTextPostMetaArchiveSnippets(code, max);
  }

  /**
   * Returns true when the JSX at `offset` is inside the `:` (else) branch of
   * an `authorSlug ?` or `categorySlugs[0] ?` ternary — meaning the span is
   * the safe no-slug fallback already emitted by promotePlainTextPostMetaLinks
   * and should NOT be flagged as a violation.
   */
  private isWithinSlugTernaryFallback(code: string, offset: number): boolean {
    // Look at up to 300 chars before the match for a slug ternary guard.
    const before = code.slice(Math.max(0, offset - 600), offset);
    return (
      /\bauthorSlug\s*\?/.test(before) ||
      /\bcategorySlugs(?:\?\.)?\s*\[\s*0\s*\]\s*\?/.test(before) ||
      /\b(?:post|item|postDetail)\.author\s*&&/.test(before) ||
      /\b(?:post|item|postDetail)\.categories(?:\?\.)?(?:\[0\])?\s*&&/.test(
        before,
      )
    );
  }

  private promotePlainTextPostMetaLinks(code: string): string {
    return promoteSharedPlainTextPostMetaLinks(code);
  }

  private normalizePlainTextPostMetaArchiveLinks(code: string): string {
    return normalizeSharedPlainTextPostMetaArchiveLinks(code);
  }

  private isWithinHeadingTitleContext(code: string, offset: number): boolean {
    const start = Math.max(0, offset - 220);
    const end = Math.min(code.length, offset + 220);
    const window = code.slice(start, end);
    const before = code.slice(start, offset);
    const openHeading = before.match(/<h[1-6]\b[^>]*>/gi);
    const closeHeading = before.match(/<\/h[1-6]>/gi);
    if ((openHeading?.length ?? 0) > (closeHeading?.length ?? 0)) {
      return true;
    }

    return /\b(?:title|heading)\b/i.test(window);
  }

  private ensureReactRouterLinkImport(code: string): string {
    if (!/<Link\b/.test(code)) return code;

    const namedImportPattern =
      /import\s*\{([^}]*)\}\s*from\s*['"]react-router-dom['"];?/;
    if (namedImportPattern.test(code)) {
      return code.replace(namedImportPattern, (_match, imported: string) => {
        const next = this.appendUniqueClasses(
          imported.replace(/\s+/g, ' '),
          'Link',
        )
          .split(' ')
          .filter(Boolean)
          .join(', ');
        return `import { ${next} } from 'react-router-dom';`;
      });
    }

    const lines = code.split('\n');
    const reactImportIndex = lines.findIndex((line) =>
      /from\s*['"]react['"]/.test(line),
    );
    const importLine = `import { Link } from 'react-router-dom';`;
    if (reactImportIndex !== -1) {
      lines.splice(reactImportIndex + 1, 0, importLine);
      return lines.join('\n');
    }

    lines.unshift(importLine);
    return lines.join('\n');
  }

  private appendUniqueClasses(existing: string, addition: string): string {
    return [
      ...new Set(`${existing} ${addition}`.split(/[\s,]+/).filter(Boolean)),
    ]
      .join(' ')
      .trim();
  }

  private findTypeBody(
    code: string,
    typeName: string,
  ): {
    startIdx: number;
    openBrace: number;
    closeBrace: number;
    body: string;
  } | null {
    const typeRegex = new RegExp(
      `\\b(?:interface|type)\\s+${typeName}\\b[^\\{]*\\{`,
    );
    const match = code.match(typeRegex);
    if (!match || match.index == null) return null;

    const startIdx = match.index;
    const openBrace = code.indexOf('{', startIdx);
    if (openBrace === -1) return null;

    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }

    if (closeBrace === -1) return null;

    return {
      startIdx,
      openBrace,
      closeBrace,
      body: code.slice(openBrace + 1, closeBrace),
    };
  }

  private getVirtualComponentFilePath(comp: GeneratedComponent): string {
    const folder =
      isPartialComponentName(comp.name) || comp.isSubComponent
        ? 'components'
        : 'pages';
    return `${VIRTUAL_ROOT}/src/${folder}/${comp.name}.tsx`;
  }

  private toImportPath(fromFile: string, toFile: string): string {
    const fromDir = fromFile.replace(/\/[^/]+$/, '');
    const fromParts = fromDir.split('/').filter(Boolean);
    const toParts = toFile.split('/').filter(Boolean);

    while (
      fromParts.length > 0 &&
      toParts.length > 0 &&
      fromParts[0] === toParts[0]
    ) {
      fromParts.shift();
      toParts.shift();
    }

    const relative = `${'../'.repeat(fromParts.length)}${toParts.join('/')}`;
    return relative.startsWith('.')
      ? relative.replace(/\.tsx$/, '')
      : `./${relative.replace(/\.tsx$/, '')}`;
  }

  private createVirtualCompilerHost(
    files: Map<string, string>,
  ): ts.CompilerHost {
    const defaultHost = ts.createCompilerHost(PREVIEW_COMPILER_OPTIONS, true);
    const normalize = (fileName: string) => this.normalizeVirtualPath(fileName);
    const normalizedFiles = new Map<string, string>();
    const virtualDirs = new Set<string>([
      this.normalizeVirtualPath(VIRTUAL_ROOT),
    ]);

    for (const [filePath, content] of files.entries()) {
      normalizedFiles.set(normalize(filePath), content);
    }

    for (const filePath of files.keys()) {
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (dir) virtualDirs.add(this.normalizeVirtualPath(dir));
      }
    }

    return {
      ...defaultHost,
      getCurrentDirectory: () => VIRTUAL_ROOT,
      getCanonicalFileName: (fileName) => fileName,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => ts.sys.newLine,
      fileExists: (fileName) => {
        const normalized = normalize(fileName);
        return (
          normalizedFiles.has(normalized) || defaultHost.fileExists(fileName)
        );
      },
      directoryExists: (dirName) => {
        const normalized = normalize(dirName);
        return (
          virtualDirs.has(normalized) ||
          defaultHost.directoryExists?.(dirName) ||
          false
        );
      },
      getDirectories: (dirName) => {
        const normalizedDir = normalize(dirName).replace(/\/+$/, '');
        const result = new Set<string>(
          defaultHost.getDirectories?.(dirName) ?? [],
        );

        for (const virtualDir of virtualDirs) {
          if (!virtualDir.startsWith(`${normalizedDir}/`)) continue;
          const rest = virtualDir.slice(normalizedDir.length + 1);
          if (!rest || rest.includes('/')) continue;
          result.add(rest);
        }

        return [...result];
      },
      readFile: (fileName) => {
        const normalized = normalize(fileName);
        return (
          normalizedFiles.get(normalized) ?? defaultHost.readFile(fileName)
        );
      },
      getSourceFile: (fileName, languageVersion, onError) => {
        const normalized = normalize(fileName);
        const virtualContent = normalizedFiles.get(normalized);
        if (virtualContent != null) {
          return ts.createSourceFile(
            fileName,
            virtualContent,
            languageVersion,
            true,
            this.getScriptKind(fileName),
          );
        }
        return defaultHost.getSourceFile(fileName, languageVersion, onError);
      },
      writeFile: () => undefined,
      resolveModuleNames: (moduleNames, containingFile) => {
        return moduleNames.map((name) => {
          // 1. Resolve shims (React, etc.)
          if (
            [
              'react',
              'react/jsx-runtime',
              'react-dom/client',
              'react-router-dom',
            ].includes(name)
          ) {
            return {
              resolvedFileName: this.normalizeVirtualPath(
                VIRTUAL_REACT_SHIM_FILE,
              ),
              isExternalLibraryImport: true,
            };
          }

          // 2. Resolve local components
          if (name.startsWith('./') || name.startsWith('../')) {
            const currentDir = containingFile.replace(/\/[^/]+$/, '');
            let resolvedPath = ts.sys.useCaseSensitiveFileNames
              ? `${currentDir}/${name}`
              : `${currentDir}/${name}`.toLowerCase();

            // Try variants (.tsx, .ts)
            const extensions = ['.tsx', '.ts', ''];
            for (const ext of extensions) {
              const fullPath = this.normalizeVirtualPath(
                `${resolvedPath}${ext}`,
              );
              if (files.has(fullPath)) {
                return { resolvedFileName: fullPath };
              }
            }
          }

          return undefined;
        });
      },
    };
  }

  private normalizeVirtualPath(fileName: string): string {
    const normalized = fileName.replace(/\\/g, '/');
    return ts.sys.useCaseSensitiveFileNames
      ? normalized
      : normalized.toLowerCase();
  }

  private getScriptKind(fileName: string): ts.ScriptKind {
    if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (fileName.endsWith('.ts') || fileName.endsWith('.d.ts')) {
      return ts.ScriptKind.TS;
    }
    if (fileName.endsWith('.js')) return ts.ScriptKind.JS;
    return ts.ScriptKind.Unknown;
  }

  private buildReactShim(): string {
    return `declare module '*.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module 'react' {
  export type ReactNode = any;
  export type CSSProperties = Record<string, any>;
  export const Fragment: any;
  export const StrictMode: any;
  export const Suspense: any;
  export function memo<T = any>(component: T): T;
  export function lazy<T = any>(loader: () => Promise<T>): T;
  export function createContext<T = any>(value: T): any;
  export function useState<T = any>(initialState?: T | (() => T)): [T, (value: any) => void];
  export function useEffect(effect: (...args: any[]) => any, deps?: readonly any[]): void;
  export function useLayoutEffect(effect: (...args: any[]) => any, deps?: readonly any[]): void;
  export function useMemo<T = any>(factory: () => T, deps?: readonly any[]): T;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps?: readonly any[]): T;
  export function useRef<T = any>(initialValue?: T): { current: T };
  export function useId(): string;
  export function useReducer<R = any, I = any>(reducer: any, initialArg: I, init?: any): [R, (value: any) => void];
  export function useContext<T = any>(context: any): T;
  export function useDeferredValue<T = any>(value: T): T;
  export function useEffectEvent<T extends (...args: any[]) => any>(callback: T): T;
  export function startTransition(scope: () => void): void;
  const React: {
    Fragment: typeof Fragment;
    StrictMode: typeof StrictMode;
    Suspense: typeof Suspense;
    memo: typeof memo;
    lazy: typeof lazy;
    createContext: typeof createContext;
    useState: typeof useState;
    useEffect: typeof useEffect;
    useLayoutEffect: typeof useLayoutEffect;
    useMemo: typeof useMemo;
    useCallback: typeof useCallback;
    useRef: typeof useRef;
    useId: typeof useId;
    useReducer: typeof useReducer;
    useContext: typeof useContext;
    useDeferredValue: typeof useDeferredValue;
    useEffectEvent: typeof useEffectEvent;
    startTransition: typeof startTransition;
  };
  export default React;
}

declare module 'react/jsx-runtime' {
  export const Fragment: any;
  export function jsx(type: any, props: any, key?: any): any;
  export function jsxs(type: any, props: any, key?: any): any;
}

declare module 'react-dom/client' {
  export function createRoot(container: Element | DocumentFragment): {
    render(element: any): void;
    unmount(): void;
  };
  const ReactDOM: {
    createRoot: typeof createRoot;
  };
  export default ReactDOM;
}

declare module 'react-router-dom' {
  export const BrowserRouter: any;
  export const Routes: any;
  export const Route: any;
  export const Link: any;
  export const NavLink: any;
  export const Outlet: any;
  export function useNavigate(): (...args: any[]) => any;
  export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T;
  export function useLocation(): { pathname: string; search: string; hash: string; state: unknown };
  export function useSearchParams(): [URLSearchParams, (value: any) => void];
}

declare global {
  namespace JSX {
    interface Element {}
    interface ElementClass {
      render?: any;
    }
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

export {};
`;
  }

  private shouldIgnoreProjectDiagnostic(diag: ts.Diagnostic): boolean {
    const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
    return (
      /react\/jsx-runtime/.test(message) ||
      (diag.code === 2307 &&
        /Cannot find module '(react|react\/jsx-runtime|react-dom\/client|react-router-dom)'/.test(
          message,
        )) ||
      (diag.code === 2792 &&
        /Cannot find module '(react|react\/jsx-runtime|react-dom\/client|react-router-dom)'/.test(
          message,
        ))
    );
  }

  private formatDiagnostic(diag: ts.Diagnostic): string {
    const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
    if (!diag.file || typeof diag.start !== 'number') return message;

    const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
    const normalizedFile = diag.file.fileName.replace(/\\/g, '/');
    const relativeFile = normalizedFile.startsWith(VIRTUAL_ROOT)
      ? normalizedFile.slice(VIRTUAL_ROOT.length + 1)
      : normalizedFile;
    return `${relativeFile}:${pos.line + 1}:${pos.character + 1} ${message}`;
  }

  private async runCommand(
    cwd: string,
    command: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd,
        shell: true,
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
      proc.on('error', (err) => {
        stderr += err.message;
        resolve({
          exitCode: 1,
          stdout,
          stderr,
        });
      });
    });
  }

  private shouldIgnoreConsoleError(text: string): boolean {
    return (
      // Network errors expected during smoke test (API not fully ready, 404/400 on optional resources)
      /favicon\.ico|WebSocket connection to|Failed to load resource: the server responded with a status of 40[04]/.test(
        text,
      ) ||
      // React duplicate-key warning — code quality issue caught by review loop, not a crash
      /Encountered two children with the same key/.test(text)
    );
  }

  private shouldIgnoreRequestFailure(request: HTTPRequest): boolean {
    const url = request.url();
    const failureText = request.failure()?.errorText ?? '';
    const isFontRequest =
      request.resourceType() === 'font' ||
      /\.(woff2?|ttf|otf|eot)(?:[?#].*)?$/i.test(url);
    const isLocalPreviewFont =
      /^https?:\/\/localhost:\d+\/preview\/assets\/fonts\//i.test(url) ||
      /\/assets\/fonts\//i.test(url);

    return (
      /favicon\.ico|\/@vite\/|\.map($|\?)/.test(url) ||
      // External resources (fonts, analytics, CDN) may be blocked by ORB or network restrictions
      /^https?:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.|analytics\.|gtm\.|gravatar\.com)/.test(
        url,
      ) ||
      // Preview smoke navigates across routes quickly; local font fetches can be
      // cancelled without indicating a visible runtime failure.
      (isFontRequest &&
        isLocalPreviewFont &&
        /net::ERR_ABORTED/i.test(failureText))
    );
  }

  /**
   * Poll the preview server until it's ready or timeout is reached.
   * Uses HTTP HEAD requests to avoid loading the full page.
   */
  private async waitForPreviewServer(
    previewUrl: string,
    timeoutMs: number,
  ): Promise<void> {
    const startTime = Date.now();
    const interval = 500; // ms between polls
    const maxWaitAttempts = Math.ceil(timeoutMs / interval);

    for (let attempt = 1; attempt <= maxWaitAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(previewUrl, {
            method: 'HEAD',
            signal: controller.signal,
          });
          clearTimeout(timeoutHandle);
          if (response.ok || response.status === 404) {
            // 404 is fine — server is responding
            return;
          }
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch {
        // Server not ready yet or network error — keep polling
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `[validator] Preview server at ${previewUrl} did not respond within ${timeoutMs}ms`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  private async gotoWithRetry(
    page: Page,
    url: string,
    maxAttempts = 5,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 45_000,
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Unable to open preview URL: ${url}`);
  }

  private checkJsxTagBalance(code: string): string | null {
    const sourceFile = ts.createSourceFile(
      'component.tsx',
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const parseDiagnostics =
      (
        sourceFile as ts.SourceFile & {
          parseDiagnostics?: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics ?? [];
    const jsxDiagnostic = parseDiagnostics.find((diag) => {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      return /closing tag|jsx element/i.test(message);
    });

    if (!jsxDiagnostic) return null;

    return `JSX tag error: ${ts.flattenDiagnosticMessageText(jsxDiagnostic.messageText, '\n')}`;
  }

  private checkTsxSyntax(code: string): string | null {
    const sourceFile = ts.createSourceFile(
      'component.tsx',
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const parseDiagnostics =
      (
        sourceFile as ts.SourceFile & {
          parseDiagnostics?: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics ?? [];
    const blockingDiagnostic = parseDiagnostics.find((diag) => {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      return !/closing tag|jsx element/i.test(message);
    });

    if (!blockingDiagnostic) return null;

    return `TSX syntax error: ${ts.flattenDiagnosticMessageText(blockingDiagnostic.messageText, '\n')}`;
  }

  /**
   * String-aware delimiter balance counter.
   * Skips characters inside single-quoted, double-quoted, and template-literal strings
   * so that e.g. `style="min(1rem,2vw)"` does not trigger a false paren imbalance.
   * Returns 0 when balanced, positive when more opens than closes, negative otherwise.
   */
  private balanceCount(code: string, open: string, close: string): number {
    let depth = 0;
    let i = 0;
    while (i < code.length) {
      const ch = code[i];
      // Skip double-quoted string contents always.
      // For single-quote, only treat as a string delimiter when preceded by a
      // JS operator character — not when preceded by a letter/digit (apostrophe
      // in JSX text like "It's" or Vietnamese text would trigger a false skip).
      if (ch === '"') {
        i++;
        while (i < code.length) {
          if (code[i] === '\\') {
            i += 2;
            continue;
          }
          if (code[i] === '"') break;
          i++;
        }
      } else if (ch === "'") {
        const prevNonSpace = code.slice(0, i).trimEnd().slice(-1);
        const isJsStringContext =
          !prevNonSpace || /[=,([:?!&|^~+\-*/;{}\n]/.test(prevNonSpace);
        if (isJsStringContext) {
          i++;
          while (i < code.length) {
            if (code[i] === '\\') {
              i += 2;
              continue;
            }
            if (code[i] === "'") break;
            i++;
          }
        }
        // Skip template literal contents (simplified — does not recurse into ${})
      } else if (ch === '`') {
        i++;
        while (i < code.length) {
          if (code[i] === '\\') {
            i += 2;
            continue;
          }
          if (code[i] === '`') break;
          i++;
        }
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
      }
      i++;
    }
    return depth;
  }

  private stripUnusedNamed(importLine: string, unusedIdents: string[]): string {
    return importLine
      .replace(/\{([^}]+)\}/, (_, inner: string) => {
        const kept = inner
          .split(',')
          .map((s) => s.trim())
          .filter((s) => {
            // "Foo as Bar" → check alias Bar
            const alias = s.match(/(?:.*\s+as\s+)?(\S+)$/)?.[1] ?? s;
            return !unusedIdents.includes(alias);
          });
        return kept.length > 0 ? `{ ${kept.join(', ')} }` : '';
      })
      .replace(/,\s*\{\s*\}/, '')
      .replace(/\{\s*\},?\s*/, '');
  }
}
