import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import ts from 'typescript';
import puppeteer, { type Page } from 'puppeteer';
import type { GeneratedComponent } from '../react-generator/react-generator.service.js';

const PARTIAL_PATTERNS =
  /^(header|footer|sidebar|nav|navigation|searchform|comments|comment|postmeta|post-meta|widget|breadcrumb|pagination|loop|content-none|no-results|functions)/i;
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
}

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  /**
   * Post-process all generated components:
   * - Remove unused imports from each .tsx file
   * - Fail fast on structural/semantic issues before preview build
   */
  validate(components: GeneratedComponent[]): GeneratedComponent[] {
    const generatedComponentNames = components.map((comp) => comp.name);

    const normalized = components.map((comp) => {
      let code = this.removeUnusedImports(comp.code);
      const sanitized = this.sanitizeTailwindClasses(code);
      if (sanitized !== code) code = sanitized;
      return { ...comp, code };
    });

    const componentErrors: string[] = [];
    for (const comp of normalized) {
      const check = this.checkCodeStructure(comp.code, {
        componentName: comp.name,
        route: comp.route,
        isDetail: comp.isDetail,
        dataNeeds: comp.dataNeeds,
        type: comp.type,
        isSubComponent: comp.isSubComponent,
        allowedRelativeImports: generatedComponentNames.filter(
          (name) => name !== comp.name,
        ),
      });
      if (!check.isValid) {
        componentErrors.push(`Component "${comp.name}": ${check.error}`);
      }
    }

    if (componentErrors.length > 0) {
      throw new Error(
        `[validator] Generated component validation failed:\n${componentErrors.join('\n')}`,
      );
    }

    return normalized;
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
    await this.waitForPreviewServer(previewUrl, 30_000);

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
        await new Promise((resolve) => setTimeout(resolve, 1500));
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

  /**
   * Basic structural validation to detect obvious layout-breaking code
   */
  checkCodeStructure(
    rawCode: string,
    context: CodeValidationContext = {},
  ): { isValid: boolean; error?: string; fixedCode?: string } {
    if (!rawCode.trim()) return { isValid: false, error: 'Empty code' };
    let code = this.sanitizeTailwindClasses(rawCode);

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
      'product-detail': 'productDetail',
      'site-info': 'siteInfo',
    };
    const violations: string[] = [];
    const dataNeeds = new Set(
      (context.dataNeeds ?? []).map((n) => DATA_NEED_ALIASES[n] ?? n),
    );
    const expectsPostDetail = dataNeeds.has('postDetail');
    const expectsPageDetail = dataNeeds.has('pageDetail');
    const expectsProductDetail = dataNeeds.has('productDetail');
    const expectsAnyDetail =
      context.isDetail === true ||
      expectsPostDetail ||
      expectsPageDetail ||
      expectsProductDetail;
    const routeHasParams = /:[A-Za-z_]/.test(context.route ?? '');

    // Pre-processing: deterministically strip post-only fields from `interface Page`
    // so the AI does not need a retry attempt just for a bad type declaration.
    // Runtime usage violations (page.author etc.) are still caught below.
    if (expectsPageDetail) {
      const ifaceStart = code.search(/\binterface\s+Page\s*\{/);
      if (ifaceStart !== -1) {
        const openBrace = code.indexOf('{', ifaceStart);
        let depth = 0;
        let closeBrace = -1;
        for (let i = openBrace; i < code.length; i++) {
          if (code[i] === '{') depth++;
          else if (code[i] === '}') {
            depth--;
            if (depth === 0) { closeBrace = i; break; }
          }
        }
        if (closeBrace !== -1) {
          const BAD_PAGE_FIELDS =
            /\b(author|categories|featuredImage|excerpt|date|comment_count|comments)\b/;
          const body = code.slice(openBrace + 1, closeBrace);
          const cleanedBody = body
            .split('\n')
            .filter((line) => !BAD_PAGE_FIELDS.test(line))
            .join('\n');
          code =
            code.slice(0, openBrace + 1) + cleanedBody + code.slice(closeBrace);
        }
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
        `\`siteInfo.${siteInfoMatch[1]}\` does not exist. Use \`siteInfo.siteName\` / \`siteInfo.siteUrl\` / \`siteInfo.blogDescription\`.`,
      );
    }

    // 11. Wrong post field names
    const postFieldMatch = code.match(/\bpost\.(tags|title\.rendered)\b/);
    if (postFieldMatch) {
      violations.push(
        `\`post.${postFieldMatch[1]}\` does not exist. Use \`post.title\` (string) or \`post.categories\` (string[]).`,
      );
    }
    if (expectsPageDetail) {
      // Note: `item` is intentionally excluded — it is commonly used as a loop
      // variable over Posts (e.g. sidebar recent-posts), not over Page objects.
      // Only flag unambiguous page variable names.
      const pageFieldMatch = code.match(
        /\b(?:pageDetail|page)\.(author|categories|featuredImage|excerpt|date|comment_count|comments)\b/,
      );
      if (pageFieldMatch) {
        violations.push(
          `Page detail contract violated: \`Page.${pageFieldMatch[1]}\` does not exist. A page only exposes \`id, title, content, slug\` in this pipeline.`,
        );
      }
      const pageInterfaceMatch = code.match(
        /interface\s+Page\s*\{[\s\S]*?\b(author|categories|featuredImage|excerpt|date|comment_count|comments)\b[\s\S]*?\}/,
      );
      if (pageInterfaceMatch) {
        violations.push(
          `Page detail contract violated: \`interface Page\` declares post-only field \`${pageInterfaceMatch[1]}\`. Keep Page limited to \`id, title, content, slug\`.`,
        );
      }
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
    const isPartialComponent = PARTIAL_PATTERNS.test(
      context.componentName ?? '',
    );
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
      if (!routeHasParams && /\buseParams\s*</.test(code)) {
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
      if (expectsProductDetail && !this.matchesDetailFetch(code, 'products')) {
        violations.push(
          'WooCommerce product detail component must fetch the record via `/api/products/${productId}` (or equivalent string concatenation).',
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
      if (
        !dataNeeds.has('productDetail') &&
        this.matchesDetailFetch(code, 'products')
      ) {
        violations.push(
          'Component fetches `/api/products/...` even though its plan does not require product detail data.',
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

    return {
      isValid: true,
      ...(code !== rawCode ? { fixedCode: code } : {}),
    };
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
    // Use word-boundary regex so "useState" doesn't match "useStateExtra"
    const sanitizedBody = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/.*$/gm, ' ')
      .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
    const re = new RegExp(`\\b${ident}\\b`);
    return re.test(sanitizedBody);
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
      PARTIAL_PATTERNS.test(componentName ?? '')
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
      new RegExp(
        String.raw`fetch\(\s*\`/api/${resource}/\$\{(?:slug|productId)\}\``,
      ),
      new RegExp(
        String.raw`fetch\(\s*['"]/api/${resource}/['"]\s*\+\s*(?:slug|productId)`,
      ),
      new RegExp(
        String.raw`fetch\(\s*['"]/api/${resource}/\$\{(?:slug|productId)\}['"]`,
      ),
    ];
    return patterns.some((pattern) => pattern.test(code));
  }

  private getVirtualComponentFilePath(comp: GeneratedComponent): string {
    const folder =
      PARTIAL_PATTERNS.test(comp.name) || comp.isSubComponent
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
      /favicon\.ico|WebSocket connection to|Failed to load resource: the server responded with a status of 40[04]/.test(text) ||
      // React duplicate-key warning — code quality issue caught by review loop, not a crash
      /Encountered two children with the same key/.test(text)
    );
  }

  private shouldIgnoreRequestFailure(url: string): boolean {
    return /favicon\.ico|\/@vite\/|\.map($|\?)/.test(url);
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
