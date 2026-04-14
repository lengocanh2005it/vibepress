import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, dirname, join, posix } from 'path';
import type {
  ThemePreciseInteractionBridge,
  ThemeInteractionState,
  ThemeTokens,
} from '../block-parser/block-parser.service.js';
import { extractStyleCssTokens } from '../../../common/style-token-extractor/style-token-extractor.js';
import { collectThemeCssSources } from '../../../common/utils/theme-css-sources.js';

export interface PhpParseDiagnostic {
  warnings: string[];
  resolvedIncludes: string[];
  unresolvedIncludes: string[];
  templateCount: number;
}

export interface PhpParseResult {
  type: 'classic';
  templates: { name: string; html: string }[];
  themeName?: string;
  tokens?: ThemeTokens;
  diagnostics?: PhpParseDiagnostic;
}

type PhpSourceMap = Map<string, string>;

@Injectable()
export class PhpParserService {
  private readonly logger = new Logger(PhpParserService.name);

  async parse(themeDir: string): Promise<PhpParseResult> {
    this.logger.log(`Parsing classic PHP theme: ${themeDir}`);
    const entries = await readdir(themeDir);
    const topLevelPhpFiles = entries
      .filter((f) => f.toLowerCase().endsWith('.php'))
      .sort((a, b) => a.localeCompare(b));

    if (topLevelPhpFiles.length === 0) {
      throw new Error(
        `Classic theme parse failed: no top-level PHP templates found in ${themeDir}`,
      );
    }

    const phpSourceMap = await this.buildPhpSourceMap(themeDir);

    const themeCss = await collectThemeCssSources(themeDir);
    const themeName = themeCss.themeName || 'Unknown';

    const diagnostics: PhpParseDiagnostic = {
      warnings: [],
      resolvedIncludes: [],
      unresolvedIncludes: [],
      templateCount: 0,
    };

    const templates = await Promise.all(
      topLevelPhpFiles.map(async (file) => {
        const normalized = this.normalizeRelativePath(file);
        const resolved = this.resolveClassicTemplate(
          normalized,
          phpSourceMap,
          diagnostics,
          new Set<string>(),
        );

        return {
          name: file,
          html: this.stripPhp(resolved),
        };
      }),
    );

    diagnostics.templateCount = templates.length;

    const nonEmptyTemplates = templates.filter((t) => t.html.trim().length > 0);
    if (nonEmptyTemplates.length === 0) {
      throw new Error(
        `Classic theme parse failed: ${templates.length} PHP files were found but all parsed templates are empty`,
      );
    }

    if (!topLevelPhpFiles.some((f) => f.toLowerCase() === 'index.php')) {
      diagnostics.warnings.push(
        'Classic theme is missing top-level index.php; downstream route mapping may be less accurate.',
      );
    }

    if (diagnostics.unresolvedIncludes.length > 0) {
      this.logger.warn(
        `[classic parser] ${diagnostics.unresolvedIncludes.length} unresolved include(s): ${diagnostics.unresolvedIncludes.join('; ')}`,
      );
    }
    if (diagnostics.warnings.length > 0) {
      diagnostics.warnings.forEach((warning) =>
        this.logger.warn(`[classic parser] ${warning}`),
      );
    }

    const styleTokens = extractStyleCssTokens(themeCss.combinedCss);

    return {
      type: 'classic',
      templates,
      themeName,
      tokens: {
        colors: styleTokens.colors,
        gradients: styleTokens.gradients,
        shadows: styleTokens.shadows,
        fonts: styleTokens.fonts,
        fontSizes: styleTokens.fontSizes,
        spacing: styleTokens.spacing,
        defaults: styleTokens.defaults,
        blockStyles: styleTokens.blockStyles,
        interactions: styleTokens.interactions,
      },
      diagnostics,
    };
  }

  toTemplateMarkup(source: string): string {
    return this.stripPhp(source);
  }

  applyStyleCssOverride(
    theme: PhpParseResult,
    styleCss: string,
  ): PhpParseResult {
    if (!styleCss?.trim()) return theme;

    const extracted = extractStyleCssTokens(styleCss, theme.tokens);
    return {
      ...theme,
      tokens: {
        colors: this.mergeBySlug(theme.tokens?.colors ?? [], extracted.colors),
        gradients: this.mergeBySlug(
          theme.tokens?.gradients ?? [],
          extracted.gradients,
        ),
        shadows: this.mergeBySlug(
          theme.tokens?.shadows ?? [],
          extracted.shadows,
        ),
        fonts: this.mergeBySlug(theme.tokens?.fonts ?? [], extracted.fonts),
        fontSizes: this.mergeBySlug(
          theme.tokens?.fontSizes ?? [],
          extracted.fontSizes,
        ),
        spacing: this.mergeBySlug(
          theme.tokens?.spacing ?? [],
          extracted.spacing,
        ),
        defaults: this.mergeDefaults(
          theme.tokens?.defaults,
          extracted.defaults,
        ),
        blockStyles: this.mergeBlockStyles(
          theme.tokens?.blockStyles,
          extracted.blockStyles,
        ),
        interactions: this.mergeInteractions(
          theme.tokens?.interactions,
          extracted.interactions,
        ),
      },
    };
  }

  private async buildPhpSourceMap(themeDir: string): Promise<PhpSourceMap> {
    const map = new Map<string, string>();
    await this.walkPhpFiles(themeDir, themeDir, map);
    return map;
  }

  private async walkPhpFiles(
    dir: string,
    baseDir: string,
    map: PhpSourceMap,
  ): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        await this.walkPhpFiles(fullPath, baseDir, map);
        continue;
      }
      if (!entry.toLowerCase().endsWith('.php')) continue;

      const relative = this.normalizeRelativePath(
        fullPath.slice(baseDir.length + 1),
      );
      map.set(relative, await readFile(fullPath, 'utf-8'));
    }
  }

  private resolveClassicTemplate(
    relativePath: string,
    sourceMap: PhpSourceMap,
    diagnostics: PhpParseDiagnostic,
    stack: Set<string>,
  ): string {
    const source = sourceMap.get(relativePath);
    if (!source) {
      diagnostics.unresolvedIncludes.push(relativePath);
      return `<?php /* unresolved include: ${relativePath} */ ?>`;
    }

    if (stack.has(relativePath)) {
      diagnostics.warnings.push(
        `Detected circular template include for "${relativePath}" — skipping recursive expansion.`,
      );
      return `<?php /* circular include skipped: ${relativePath} */ ?>`;
    }

    const nextStack = new Set(stack);
    nextStack.add(relativePath);

    const withTemplateParts = source
      .replace(
        /<\?php\s+get_template_part\s*\(\s*(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]+)\3)?\s*\)\s*;?\s*\?>/g,
        (_match, _quote1, slug: string, _quote2, variant?: string) =>
          this.inlineInclude(
            this.findTemplatePartCandidates(relativePath, slug, variant),
            sourceMap,
            diagnostics,
            nextStack,
            `get_template_part(${slug}${variant ? `, ${variant}` : ''})`,
          ),
      )
      .replace(
        /<\?php\s+get_header\s*\(\s*(['"])?([^'")]+)?\1?\s*\)\s*;?\s*\?>/g,
        (_match, _quote, variant?: string) =>
          this.inlineInclude(
            this.findSpecialTemplateCandidates(relativePath, 'header', variant),
            sourceMap,
            diagnostics,
            nextStack,
            `get_header(${variant ?? ''})`,
          ),
      )
      .replace(
        /<\?php\s+get_footer\s*\(\s*(['"])?([^'")]+)?\1?\s*\)\s*;?\s*\?>/g,
        (_match, _quote, variant?: string) =>
          this.inlineInclude(
            this.findSpecialTemplateCandidates(relativePath, 'footer', variant),
            sourceMap,
            diagnostics,
            nextStack,
            `get_footer(${variant ?? ''})`,
          ),
      )
      .replace(
        /<\?php\s+get_sidebar\s*\(\s*(['"])?([^'")]+)?\1?\s*\)\s*;?\s*\?>/g,
        (_match, _quote, variant?: string) =>
          this.inlineInclude(
            this.findSpecialTemplateCandidates(
              relativePath,
              'sidebar',
              variant,
            ),
            sourceMap,
            diagnostics,
            nextStack,
            `get_sidebar(${variant ?? ''})`,
          ),
      )
      .replace(
        /<\?php\s+(?:include|include_once|require|require_once)\s*\(?\s*['"]([^'"]+\.php)['"]\s*\)?\s*;?\s*\?>/g,
        (_match, includePath: string) =>
          this.inlineInclude(
            this.findRelativeIncludeCandidates(relativePath, includePath),
            sourceMap,
            diagnostics,
            nextStack,
            `include(${includePath})`,
          ),
      );

    return withTemplateParts;
  }

  private inlineInclude(
    candidates: string[],
    sourceMap: PhpSourceMap,
    diagnostics: PhpParseDiagnostic,
    stack: Set<string>,
    label: string,
  ): string {
    const resolvedPath = candidates.find((candidate) =>
      sourceMap.has(candidate),
    );
    if (!resolvedPath) {
      diagnostics.unresolvedIncludes.push(
        `${label} -> ${candidates[0] ?? 'unknown'}`,
      );
      return `<?php /* unresolved include: ${label} */ ?>`;
    }

    diagnostics.resolvedIncludes.push(resolvedPath);
    const resolved = this.resolveClassicTemplate(
      resolvedPath,
      sourceMap,
      diagnostics,
      stack,
    );

    return [
      `<?php /* include:start ${resolvedPath} */ ?>`,
      resolved,
      `<?php /* include:end ${resolvedPath} */ ?>`,
    ].join('\n');
  }

  private findTemplatePartCandidates(
    currentFile: string,
    slug: string,
    variant?: string,
  ): string[] {
    const base = slug.replace(/^\/+|\/+$/g, '');
    const candidates = new Set<string>();

    if (variant) {
      candidates.add(this.normalizeRelativePath(`${base}-${variant}.php`));
    }
    candidates.add(this.normalizeRelativePath(`${base}.php`));

    const baseName = basename(base);
    const baseDir = dirname(base);
    if (variant) {
      candidates.add(
        this.normalizeRelativePath(
          `${baseDir === '.' ? '' : `${baseDir}/`}${baseName}-${variant}.php`,
        ),
      );
    }
    candidates.add(
      this.normalizeRelativePath(
        `${baseDir === '.' ? '' : `${baseDir}/`}${baseName}.php`,
      ),
    );

    const currentDir = dirname(currentFile);
    for (const candidate of [...candidates]) {
      candidates.add(
        this.normalizeRelativePath(
          posix.join(currentDir === '.' ? '' : currentDir, candidate),
        ),
      );
    }

    return [...candidates];
  }

  private findSpecialTemplateCandidates(
    currentFile: string,
    type: 'header' | 'footer' | 'sidebar',
    variant?: string,
  ): string[] {
    const candidates = new Set<string>();
    if (variant) candidates.add(`${type}-${variant}.php`);
    candidates.add(`${type}.php`);
    const currentDir = dirname(currentFile);
    if (currentDir !== '.') {
      if (variant) {
        candidates.add(
          this.normalizeRelativePath(`${currentDir}/${type}-${variant}.php`),
        );
      }
      candidates.add(this.normalizeRelativePath(`${currentDir}/${type}.php`));
    }
    return [...candidates].map((candidate) =>
      this.normalizeRelativePath(candidate),
    );
  }

  private findRelativeIncludeCandidates(
    currentFile: string,
    includePath: string,
  ): string[] {
    const currentDir = dirname(currentFile);
    return [
      this.normalizeRelativePath(includePath),
      this.normalizeRelativePath(
        posix.join(currentDir === '.' ? '' : currentDir, includePath),
      ),
    ];
  }

  // Chuyển PHP tags thành comments có nghĩa để AI hiểu cấu trúc
  private stripPhp(source: string): string {
    return (
      source
        .replace(/^\uFEFF/, '')
        // PHP i18n functions INSIDE JSON string values → extract the first string literal
        .replace(
          /"<\?php\s+(?:esc_html_e|esc_attr_e|esc_html|esc_attr|__|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>"/g,
          '"$1"',
        )
        // PHP i18n echoes in HTML content → extract the string literal as plain text
        .replace(
          /<\?php\s+(?:esc_html_e|esc_attr_e|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        .replace(
          /<\?php\s+echo\s+(?:esc_html|esc_attr|__)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        // get_header(), get_footer(), get_sidebar() → gợi ý component
        .replace(
          /<\?php\s+\/\*\s*include:start\s+([^*]+?)\s*\*\/\s*\?>/g,
          '{/* WP: include start → $1 */}',
        )
        .replace(
          /<\?php\s+\/\*\s*include:end\s+([^*]+?)\s*\*\/\s*\?>/g,
          '{/* WP: include end → $1 */}',
        )
        .replace(
          /<\?php\s+get_header\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: <Header /> */}',
        )
        .replace(
          /<\?php\s+get_footer\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: <Footer /> */}',
        )
        .replace(
          /<\?php\s+get_sidebar\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: <Sidebar /> */}',
        )
        .replace(
          /<\?php[\s\S]*?wp_nav_menu[\s\S]*?\?>/g,
          '{/* WP: <Navigation /> */}',
        )
        // The Loop
        .replace(
          /<\?php\s+while\s*\(\s*have_posts\(\)\s*\)[^?]*\?>/g,
          '{/* WP: loop start — map over posts[] */}',
        )
        .replace(
          /<\?php\s+foreach\s*\([^?]*\?>/g,
          '{/* WP: foreach loop start */}',
        )
        .replace(/<\?php\s+endwhile\s*;?\s*\?>/g, '{/* WP: loop end */}')
        .replace(
          /<\?php\s+endforeach\s*;?\s*\?>/g,
          '{/* WP: foreach loop end */}',
        )
        // Common template tags → data hints
        .replace(
          /<\?php\s+the_title\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.title */}',
        )
        .replace(
          /<\?php\s+the_content\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.content (HTML) */}',
        )
        .replace(
          /<\?php\s+the_excerpt\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.excerpt */}',
        )
        .replace(
          /<\?php\s+the_permalink\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: /post/{post.slug} */}',
        )
        .replace(
          /<\?php\s+the_date\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.date */}',
        )
        .replace(
          /<\?php\s+the_author\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: post.author */}',
        )
        .replace(
          /<\?php\s+comments_template\([^)]*\)\s*;?\s*\?>/g,
          '{/* WP: comments */}',
        )
        .replace(
          /<\?php\s+bloginfo\(\s*['"]name['"]\s*\)[^?]*\?>/g,
          '{/* WP: site.siteName */}',
        )
        .replace(
          /<\?php\s+bloginfo\(\s*['"]description['"]\s*\)[^?]*\?>/g,
          '{/* WP: site.description */}',
        )
        .replace(
          /<\?=\s*([^?]+)\?>/g,
          (_match, expr) => `{/* WP: ${String(expr).trim()} */}`,
        )
        .replace(
          /<\?php\s+(if|elseif|else|endif|for|endfor|switch|endswitch)\b[\s\S]*?\?>/g,
          (_match, keyword) => `{/* WP: ${keyword} block */}`,
        )
        // PHP blocks còn lại → xóa nhưng giữ placeholder nếu liên quan include lỗi
        .replace(
          /<\?php\s+\/\*\s*unresolved include:\s*([^*]+?)\s*\*\/\s*\?>/g,
          '{/* WP: unresolved include → $1 */}',
        )
        .replace(/<\?php[\s\S]*?\?>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s{2,}/g, ' ')
        .trim()
    );
  }

  private normalizeRelativePath(path: string): string {
    return path
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/\/+/g, '/');
  }

  private mergeBySlug<T extends { slug: string }>(base: T[], extra: T[]): T[] {
    const map = new Map<string, T>();
    for (const item of base) map.set(item.slug, item);
    for (const item of extra) {
      if (!map.has(item.slug)) map.set(item.slug, item);
    }
    return [...map.values()];
  }

  private mergeDefaults(
    primary?: NonNullable<ThemeTokens['defaults']>,
    fallback?: NonNullable<ThemeTokens['defaults']>,
  ): ThemeTokens['defaults'] {
    if (!primary && !fallback) return undefined;
    return {
      ...(fallback ?? {}),
      ...(primary ?? {}),
      headings: {
        ...(fallback?.headings ?? {}),
        ...(primary?.headings ?? {}),
      },
    };
  }

  private mergeBlockStyles(
    primary?: NonNullable<ThemeTokens['blockStyles']>,
    fallback?: NonNullable<ThemeTokens['blockStyles']>,
  ): ThemeTokens['blockStyles'] {
    if (!primary && !fallback) return undefined;

    const merged: NonNullable<ThemeTokens['blockStyles']> = {
      ...(fallback ?? {}),
    };
    for (const [blockType, style] of Object.entries(primary ?? {})) {
      merged[blockType] = {
        ...(fallback?.[blockType] ?? {}),
        ...style,
        color: {
          ...(fallback?.[blockType]?.color ?? {}),
          ...(style.color ?? {}),
        },
        typography: {
          ...(fallback?.[blockType]?.typography ?? {}),
          ...(style.typography ?? {}),
        },
        border: {
          ...(fallback?.[blockType]?.border ?? {}),
          ...(style.border ?? {}),
        },
        spacing: {
          ...(fallback?.[blockType]?.spacing ?? {}),
          ...(style.spacing ?? {}),
        },
      };
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private mergeInteractions(
    primary?: NonNullable<ThemeTokens['interactions']>,
    fallback?: NonNullable<ThemeTokens['interactions']>,
  ): ThemeTokens['interactions'] {
    if (!primary && !fallback) return undefined;

    const mergeState = (
      a?: ThemeInteractionState,
      b?: ThemeInteractionState,
    ): ThemeInteractionState | undefined => {
      const merged: ThemeInteractionState = {
        ...(b ?? {}),
        ...(a ?? {}),
      };
      return Object.keys(merged).length > 0 ? merged : undefined;
    };

    const button =
      primary?.button || fallback?.button
        ? {
            base: mergeState(primary?.button?.base, fallback?.button?.base),
            hover: mergeState(primary?.button?.hover, fallback?.button?.hover),
            focus: mergeState(primary?.button?.focus, fallback?.button?.focus),
            active: mergeState(
              primary?.button?.active,
              fallback?.button?.active,
            ),
          }
        : undefined;

    const precise = this.mergePreciseInteractionBridges(
      primary?.precise,
      fallback?.precise,
    );

    const normalizedButton =
      button && (button.base || button.hover || button.focus || button.active)
        ? button
        : undefined;

    return normalizedButton || precise?.length
      ? {
          ...(normalizedButton ? { button: normalizedButton } : {}),
          ...(precise?.length ? { precise } : {}),
        }
      : undefined;
  }

  private mergePreciseInteractionBridges(
    primary?: ThemePreciseInteractionBridge[],
    fallback?: ThemePreciseInteractionBridge[],
  ): ThemePreciseInteractionBridge[] | undefined {
    const merged = new Map<string, ThemePreciseInteractionBridge>();

    const upsert = (entry?: ThemePreciseInteractionBridge) => {
      if (!entry) return;
      const key = `${entry.target}::${entry.className}`;
      const previous = merged.get(key);
      merged.set(key, {
        className: entry.className,
        target: entry.target,
        base: this.mergeInteractionState(entry.base, previous?.base),
        hover: this.mergeInteractionState(entry.hover, previous?.hover),
        focus: this.mergeInteractionState(entry.focus, previous?.focus),
        active: this.mergeInteractionState(entry.active, previous?.active),
      });
    };

    for (const entry of fallback ?? []) upsert(entry);
    for (const entry of primary ?? []) upsert(entry);

    const values = Array.from(merged.values()).filter(
      (entry) =>
        this.hasInteractionState(entry.base) ||
        this.hasInteractionState(entry.hover) ||
        this.hasInteractionState(entry.focus) ||
        this.hasInteractionState(entry.active),
    );

    return values.length > 0
      ? values.sort(
          (a, b) =>
            a.className.localeCompare(b.className) ||
            a.target.localeCompare(b.target),
        )
      : undefined;
  }

  private mergeInteractionState(
    primary?: ThemeInteractionState,
    fallback?: ThemeInteractionState,
  ): ThemeInteractionState | undefined {
    const merged: ThemeInteractionState = {
      ...(fallback ?? {}),
      ...(primary ?? {}),
    };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private hasInteractionState(state?: ThemeInteractionState): boolean {
    return !!state && Object.keys(state).length > 0;
  }
}
