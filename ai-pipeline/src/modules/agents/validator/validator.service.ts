import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import ts from 'typescript';
import puppeteer, { type Page } from 'puppeteer';
import type { GeneratedComponent } from '../react-generator/react-generator.service.js';
import type {
  CardGridSection,
  ComponentVisualPlan,
  CoverSection,
  HeroSection,
  MediaTextSection,
  NewsletterSection,
  PostListSection,
  SectionPlan,
  TestimonialSection,
} from '../react-generator/visual-plan.schema.js';
import type { ThemeInteractionTarget } from '../block-parser/block-parser.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
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
        const url = request.url();
        if (this.shouldIgnoreRequestFailure(url)) return;
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
    code = this.stripDebugStatements(code);
    code = this.normalizePlainTextPostMetaArchiveLinks(code);
    code = this.promotePlainTextPostMetaLinks(code);
    code = this.ensureHoverUnderlineOnCanonicalTextLinks(code);
    code = this.ensureReactRouterLinkImport(code);
    return code;
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

    const visualPlanIssue = this.checkVisualPlanFidelity(
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
    };
    const violations: string[] = [];
    const dataNeeds = new Set(
      (context.dataNeeds ?? []).map((n) => DATA_NEED_ALIASES[n] ?? n),
    );
    const expectsPostDetail = dataNeeds.has('postDetail');
    const expectsPageDetail = dataNeeds.has('pageDetail');
    const expectsAnyDetail =
      context.isDetail === true || expectsPostDetail || expectsPageDetail;
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
          'Layout data contract violated: page components must NOT fetch `/api/site-info` or `/api/menus` for shared site chrome. Move that logic into dedicated Header/Footer/Navigation partials.',
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
        dataNeeds.has('menus') &&
        !/\bmenus(?:\??\.)?(?:find|map|filter|some)\s*\(/.test(code) &&
        !/\bmenu\.items\b/.test(code)
      ) {
        violations.push(
          'Shared chrome contract violated: Header/Footer/Navigation partials that declare `menus` must render menu data from `/api/menus`, not hardcoded link columns.',
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
          'Shared chrome contract violated: Footer must fetch `/api/footer-links` and use those columns as the fallback when `/api/menus` has no footer/social groups.',
        );
      }
      if (
        isFooterPartial &&
        dataNeeds.has('menus') &&
        !/location\s*!==\s*['"]primary['"]/.test(code) &&
        !/slug\s*!==\s*['"]primary['"]/.test(code)
      ) {
        violations.push(
          'Shared chrome contract violated: Footer must exclude the primary navigation menu (`location !== "primary"` and slug fallback) and render only footer/social menu groups.',
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
    const dataVars = ['menus', 'posts', 'pages', 'siteInfo'];
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
      if (expectsAnyDetail && !/\buseParams\s*</.test(code)) {
        violations.push(
          'Detail component is missing `useParams<{ slug: string }>()` for slug-based routing.',
        );
      }
      if (!effectiveRouteHasParams && /\buseParams\s*</.test(code)) {
        violations.push(
          'Component uses `useParams()` even though its planned route has no URL params.',
        );
      }
      if (expectsPostDetail && !this.matchesDetailFetch(code, 'posts')) {
        violations.push(
          'Post detail component must fetch the record via `/api/posts/${slug}` (or equivalent string concatenation with `slug`).',
        );
      }
      if (expectsPageDetail && !this.matchesDetailFetch(code, 'pages')) {
        violations.push(
          'Page detail component must fetch the record via `/api/pages/${slug}` (or equivalent string concatenation with `slug`).',
        );
      }
      if (
        !dataNeeds.has('postDetail') &&
        this.matchesDetailFetch(code, 'posts')
      ) {
        violations.push(
          'Component fetches `/api/posts/${slug}` even though its plan does not require post detail data.',
        );
      }
      if (
        !dataNeeds.has('pageDetail') &&
        this.matchesDetailFetch(code, 'pages')
      ) {
        violations.push(
          'Component fetches `/api/pages/${slug}` even though its plan does not require page detail data.',
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

  private checkVisualPlanFidelity(
    code: string,
    visualPlan?: ComponentVisualPlan,
    componentName?: string,
  ): string | null {
    if (!visualPlan?.sections?.length) return null;

    const issues: string[] = [];
    const sectionKeyMatches = [
      ...code.matchAll(/data-vp-section-key=["']([^"']+)["']/g),
    ].map((match) => match[1]);
    const renderedSectionKeys = new Set(sectionKeyMatches);

    for (const [index, section] of visualPlan.sections.entries()) {
      const label = `"${componentName ?? visualPlan.componentName}" section ${index + 1}`;
      if (section.sectionKey && !renderedSectionKeys.has(section.sectionKey)) {
        issues.push(
          `${label} is missing rendered sectionKey "${section.sectionKey}" from the visual plan`,
        );
      }

      if (section.sourceRef?.sourceNodeId && !code.includes(section.sourceRef.sourceNodeId)) {
        issues.push(
          `${label} is missing sourceNodeId "${section.sourceRef.sourceNodeId}" from the visual plan`,
        );
      }

      issues.push(...this.checkSectionPayloadFidelity(code, section, label));
    }

    if (issues.length === 0) return null;
    return `Visual plan fidelity violated:\n${issues.slice(0, 12).join('\n')}`;
  }

  private checkSectionPayloadFidelity(
    code: string,
    section: SectionPlan,
    label: string,
  ): string[] {
    switch (section.type) {
      case 'hero':
        return this.checkHeroPayload(code, section, label);
      case 'cover':
        return this.checkCoverPayload(code, section, label);
      case 'media-text':
        return this.checkMediaTextPayload(code, section, label);
      case 'card-grid':
        return this.checkCardGridPayload(code, section, label);
      case 'testimonial':
        return this.checkTestimonialPayload(code, section, label);
      case 'newsletter':
        return this.checkNewsletterPayload(code, section, label);
      case 'post-list':
        return this.checkPostListPayload(code, section, label);
      default:
        return [];
    }
  }

  private checkHeroPayload(
    code: string,
    section: HeroSection,
    label: string,
  ): string[] {
    const issues: string[] = [];
    issues.push(...this.requireLiteralIfPresent(code, section.heading, `${label} lost hero heading`));
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.subheading,
        `${label} lost hero subheading`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.cta?.text,
        `${label} lost hero CTA text`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.image?.src,
        `${label} lost hero image src`,
      ),
    );
    return issues;
  }

  private checkCoverPayload(
    code: string,
    section: CoverSection,
    label: string,
  ): string[] {
    const issues: string[] = [];
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.imageSrc,
        `${label} lost cover image src`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(code, section.heading, `${label} lost cover heading`),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.subheading,
        `${label} lost cover subheading`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.cta?.text,
        `${label} lost cover CTA text`,
      ),
    );
    return issues;
  }

  private checkMediaTextPayload(
    code: string,
    section: MediaTextSection,
    label: string,
  ): string[] {
    const issues: string[] = [];
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.imageSrc,
        `${label} lost media-text image src`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.heading,
        `${label} lost media-text heading`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(code, section.body, `${label} lost media-text body`),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.cta?.text,
        `${label} lost media-text CTA text`,
      ),
    );
    for (const item of section.listItems ?? []) {
      issues.push(...this.requireLiteralIfPresent(code, item, `${label} lost media-text list item`));
    }
    return issues;
  }

  private checkCardGridPayload(
    code: string,
    section: CardGridSection,
    label: string,
  ): string[] {
    const issues: string[] = [];
    issues.push(
      ...this.requireLiteralIfPresent(code, section.title, `${label} lost card-grid title`),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.subtitle,
        `${label} lost card-grid subtitle`,
      ),
    );

    for (const card of section.cards ?? []) {
      issues.push(...this.requireLiteralIfPresent(code, card.heading, `${label} lost card heading`));
      issues.push(...this.requireLiteralIfPresent(code, card.body, `${label} lost card body`));
    }
    return issues;
  }

  private checkTestimonialPayload(
    code: string,
    section: TestimonialSection,
    label: string,
  ): string[] {
    const issues: string[] = [];
    issues.push(...this.requireLiteralIfPresent(code, section.quote, `${label} lost testimonial quote`));
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.authorName,
        `${label} lost testimonial author`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.authorTitle,
        `${label} lost testimonial author title`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.authorAvatar,
        `${label} lost testimonial avatar`,
      ),
    );
    return issues;
  }

  private checkNewsletterPayload(
    code: string,
    section: NewsletterSection,
    label: string,
  ): string[] {
    const issues: string[] = [];
    issues.push(...this.requireLiteralIfPresent(code, section.heading, `${label} lost newsletter heading`));
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.subheading,
        `${label} lost newsletter subheading`,
      ),
    );
    issues.push(
      ...this.requireLiteralIfPresent(
        code,
        section.buttonText,
        `${label} lost newsletter button text`,
      ),
    );
    return issues;
  }

  private checkPostListPayload(
    code: string,
    section: PostListSection,
    label: string,
  ): string[] {
    if (this.isDynamicPlanBinding(section.title)) {
      return [];
    }
    return this.requireLiteralIfPresent(
      code,
      section.title,
      `${label} lost post-list title`,
    );
  }

  private isDynamicPlanBinding(value?: string): boolean {
    const normalized = value?.trim();
    return Boolean(normalized && /^\{[a-zA-Z0-9_.]+\}$/.test(normalized));
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
    const preview =
      normalized.length > 120
        ? `${normalized.slice(0, 117).trimEnd()}...`
        : normalized;
    return [`${error}: ${JSON.stringify(preview)}`];
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
      /\{\s*menus\b/.test(code)
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
        // Skip spans that are already inside an authorSlug/categorySlugs ternary
        // — they are the safe no-slug fallback emitted by promotePlainTextPostMetaLinks.
        if (this.isWithinSlugTernaryFallback(code, offset)) continue;
        snippets.push(raw.length > 180 ? `${raw.slice(0, 177)}...` : raw);
        if (snippets.length >= max) return snippets;
      }
      if (snippets.length >= max) break;
    }

    return snippets;
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
      /\bcategorySlugs(?:\?\.)?[^a-z]\[0\]\s*\?/.test(before) ||
      /\b(?:post|item|postDetail)\.author\s*&&/.test(before) ||
      /\b(?:post|item|postDetail)\.categories(?:\?\.)?(?:\[0\])?\s*&&/.test(
        before,
      )
    );
  }

  private promotePlainTextPostMetaLinks(code: string): string {
    const isCanonicalMetaLink = (raw: string): boolean =>
      /(?:to=|href=)[^>]*\/author\//.test(raw) ||
      /(?:to=|href=)[^>]*\/category\//.test(raw);

    const decorateQuoted = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${before}className=${quote}${this.appendUniqueClasses(
            className,
            'hover:underline underline-offset-4',
          )}${quote}`;
        },
      );

    const decorateTemplateLiteral = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${before}className={\`${this.appendUniqueClasses(
            className,
            'hover:underline underline-offset-4',
          )}\`}`;
        },
      );

    const decorateWithoutClass = (source: string) =>
      source.replace(
        /<(Link|a)\b((?:(?!className=)[^>])*)(?=>)/g,
        (match, tag: string, attrs: string) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${attrs} className="hover:underline underline-offset-4"`;
        },
      );

    return decorateWithoutClass(decorateTemplateLiteral(decorateQuoted(code)));
  }

  private normalizePlainTextPostMetaArchiveLinks(code: string): string {
    let next = code;

    next = next.replace(
      /\{\s*(post|item|postDetail)\.author\s*&&\s*<(span|p)\b([^>]*)>\s*\{\1\.author\}\s*<\/\2>\s*\}/g,
      (_match, record: string, tag: string, attrs: string) =>
        `{${record}.author && (${record}.authorSlug ? <Link to={'/author/' + ${record}.authorSlug}${attrs}>{${record}.author}</Link> : <${tag}${attrs}>{${record}.author}</${tag}>)}`,
    );

    next = next.replace(
      /<(span|p)\b([^>]*)>\s*\{(post|item|postDetail)\.author\}\s*<\/\1>/g,
      (match, tag: string, attrs: string, record: string, offset: number) => {
        if (this.isWithinHeadingTitleContext(next, offset)) return match;
        if (this.isWithinSlugTernaryFallback(next, offset)) return match;
        return `{${record}.authorSlug ? <Link to={'/author/' + ${record}.authorSlug}${attrs}>{${record}.author}</Link> : <${tag}${attrs}>{${record}.author}</${tag}>}`;
      },
    );

    next = next.replace(
      /\{\s*(post|item|postDetail)\.categories(?:\?\.)?\[0\]\s*&&\s*<span\b([^>]*)>\s*\{\1\.categories(?:\?\.)?\[0\](?:\s*\?\?\s*'')?\}\s*<\/span>\s*\}/g,
      (_match, record: string, attrs: string) =>
        `{${record}.categories?.[0] && (${record}.categorySlugs?.[0] ? <Link to={'/category/' + ${record}.categorySlugs[0]}${attrs}>{${record}.categories[0]}</Link> : <span${attrs}>{${record}.categories[0]}</span>)}`,
    );

    next = next.replace(
      /<span\b([^>]*)>\s*\{(post|item|postDetail)\.categories(?:\?\.)?\[0\](?:\s*\?\?\s*'')?\}\s*<\/span>/g,
      (match, attrs: string, record: string, offset: number) => {
        if (this.isWithinSlugTernaryFallback(next, offset)) return match;
        return `{${record}.categorySlugs?.[0] ? <Link to={'/category/' + ${record}.categorySlugs[0]}${attrs}>{${record}.categories[0]}</Link> : <span${attrs}>{${record}.categories[0]}</span>}`;
      },
    );

    next = next.replace(
      /\{(post|item|postDetail)\.categories\?\.map\(\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\(\s*<span\b([^>]*)>\s*\{\2\}\s*<\/span>\s*\)\)\}/g,
      (
        _match,
        record: string,
        categoryVar: string,
        indexVar: string,
        attrs: string,
      ) =>
        `{${record}.categories?.map((${categoryVar}, ${indexVar}) => (${record}.categorySlugs?.[${indexVar}] ? <Link to={'/category/' + ${record}.categorySlugs[${indexVar}]}${attrs}>{${categoryVar}}</Link> : <span${attrs}>{${categoryVar}}</span>}))}`,
    );

    return next;
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

  private shouldIgnoreRequestFailure(url: string): boolean {
    return (
      /favicon\.ico|\/@vite\/|\.map($|\?)/.test(url) ||
      // External resources (fonts, analytics, CDN) may be blocked by ORB or network restrictions
      /^https?:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.|analytics\.|gtm\.|gravatar\.com)/.test(url)
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
      // Skip single- and double-quoted string contents
      if (ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < code.length) {
          if (code[i] === '\\') {
            i += 2;
            continue;
          }
          if (code[i] === q) break;
          i++;
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
