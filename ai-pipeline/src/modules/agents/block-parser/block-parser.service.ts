import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, join, relative } from 'path';
import { extractStyleCssTokens } from '../../../common/style-token-extractor/style-token-extractor.js';

export interface ThemeDefaults {
  textColor?: string;
  bgColor?: string;
  headingColor?: string;
  linkColor?: string;
  captionColor?: string;
  buttonBgColor?: string;
  buttonTextColor?: string;
  fontSize?: string;
  fontFamily?: string;
  headingFontFamily?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textTransform?: string;
  buttonBoxShadow?: string;
  contentWidth?: string;
  wideWidth?: string;
  buttonBorderRadius?: string;
  buttonPadding?: string;
  blockGap?: string;
  rootPadding?: string;
  headings?: {
    h1?: { fontSize?: string; fontWeight?: string };
    h2?: { fontSize?: string; fontWeight?: string };
    h3?: { fontSize?: string; fontWeight?: string };
    h4?: { fontSize?: string; fontWeight?: string };
    h5?: { fontSize?: string; fontWeight?: string };
    h6?: { fontSize?: string; fontWeight?: string };
  };
}

export interface ThemeBlockStyle {
  color?: { text?: string; background?: string };
  typography?: {
    fontSize?: string;
    fontFamily?: string;
    fontWeight?: string;
    letterSpacing?: string;
    lineHeight?: string;
    textTransform?: string;
  };
  border?: {
    radius?: string;
    width?: string;
    style?: string;
    color?: string;
  };
  spacing?: { padding?: string; margin?: string; gap?: string };
  shadow?: string;
}

export interface ThemeTokens {
  colors: { slug: string; value: string }[];
  gradients?: { slug: string; value: string }[];
  shadows?: { slug: string; value: string }[];
  fonts: { slug: string; family: string; name: string }[];
  fontSizes: { slug: string; size: string }[];
  spacing: { slug: string; size: string }[];
  defaults?: ThemeDefaults;
  blockStyles?: Record<string, ThemeBlockStyle>;
}

export interface BlockParseResult {
  type: 'fse';
  themeJson: Record<string, any> | null;
  tokens: ThemeTokens;
  templates: { name: string; markup: string }[];
  parts: { name: string; markup: string }[];
  themeName?: string;
  diagnostics?: BlockParseDiagnostic;
}

export interface BlockParseDiagnostic {
  warnings: string[];
  unresolvedPatterns: string[];
  unresolvedTemplateParts: string[];
  templateCount: number;
  partCount: number;
}

@Injectable()
export class BlockParserService {
  private readonly logger = new Logger(BlockParserService.name);

  async parse(themeDir: string): Promise<BlockParseResult> {
    this.logger.log(`Parsing FSE/Block theme: ${themeDir}`);

    let themeName = 'Unknown';
    let styleCss = '';
    try {
      styleCss = await readFile(join(themeDir, 'style.css'), 'utf-8');
      const nameMatch = styleCss.match(/Theme Name:\s*(.+)/);
      if (nameMatch) themeName = nameMatch[1].trim();
    } catch {
      // style.css might not exist or be readable
    }

    const themeJson = await this.readJson(join(themeDir, 'theme.json'));
    const tokens = this.extractTokens(themeJson, styleCss);
    const diagnostics: BlockParseDiagnostic = {
      warnings: [],
      unresolvedPatterns: [],
      unresolvedTemplateParts: [],
      templateCount: 0,
      partCount: 0,
    };

    // Build pattern map: slug → markup (from patterns/*.php)
    const patternMap = await this.buildPatternMap(join(themeDir, 'patterns'));

    const rawParts = await this.readHtmlDir(join(themeDir, 'parts'));
    const rawPartMap = new Map<string, string>();
    for (const p of rawParts) {
      rawPartMap.set(
        p.name,
        this.resolvePatterns(p.markup, patternMap, diagnostics),
      );
    }

    // Build part map: slug → fully resolved markup (patterns + nested template-parts)
    const partMap = new Map<string, string>();
    for (const p of rawParts) {
      partMap.set(
        p.name,
        this.resolvePartMarkup(
          p.name,
          rawPartMap,
          diagnostics,
          new Set<string>(),
        ),
      );
    }

    const rawTemplates = await this.readHtmlDir(join(themeDir, 'templates'));
    if (rawTemplates.length === 0) {
      throw new Error(
        `FSE theme parse failed: no templates found in ${join(themeDir, 'templates')}`,
      );
    }

    // Resolve patterns + template-parts in templates
    const templates = rawTemplates.map((t) => ({
      name: t.name,
      markup: this.resolveTemplateParts(
        this.resolvePatterns(t.markup, patternMap, diagnostics),
        partMap,
        diagnostics,
      ),
    }));

    const parts = rawParts.map((p) => ({
      name: p.name,
      markup: partMap.get(p.name) ?? p.markup,
    }));

    diagnostics.templateCount = templates.length;
    diagnostics.partCount = parts.length;

    if (templates.every((t) => t.markup.trim().length === 0)) {
      throw new Error(
        `FSE theme parse failed: ${templates.length} templates were found but all resolved template markups are empty`,
      );
    }

    diagnostics.unresolvedPatterns = this.collectUnresolvedRefs(
      [...templates, ...parts].map((item) => item.markup),
      /<!-- pattern:([^ ]+) not found -->/g,
    );
    diagnostics.unresolvedTemplateParts = this.collectUnresolvedRefs(
      [...templates, ...parts].map((item) => item.markup),
      /<!-- part:([^ ]+) not found -->/g,
    );

    if (diagnostics.unresolvedPatterns.length > 0) {
      diagnostics.warnings.push(
        `${diagnostics.unresolvedPatterns.length} unresolved pattern reference(s): ${diagnostics.unresolvedPatterns.join(', ')}`,
      );
    }
    if (diagnostics.unresolvedTemplateParts.length > 0) {
      diagnostics.warnings.push(
        `${diagnostics.unresolvedTemplateParts.length} unresolved template-part reference(s): ${diagnostics.unresolvedTemplateParts.join(', ')}`,
      );
    }

    diagnostics.warnings.forEach((warning) =>
      this.logger.warn(`[block parser] ${warning}`),
    );

    return {
      type: 'fse',
      themeJson,
      tokens,
      templates,
      parts,
      themeName,
      diagnostics,
    };
  }

  applyThemeJsonOverride(
    theme: BlockParseResult,
    overrideThemeJson: Record<string, any>,
  ): BlockParseResult {
    if (!overrideThemeJson || Object.keys(overrideThemeJson).length === 0) {
      return theme;
    }

    const mergedThemeJson = this.deepMergeThemeJson(
      theme.themeJson ?? {},
      overrideThemeJson,
    );
    const mergedJsonTokens = this.extractTokens(mergedThemeJson);

    return {
      ...theme,
      themeJson: mergedThemeJson,
      tokens: this.mergeThemeTokens(mergedJsonTokens, theme.tokens),
    };
  }

  private extractTokens(
    themeJson: Record<string, any> | null,
    styleCss?: string,
  ): ThemeTokens {
    // Extraction order:
    // 1. Read structured presets/defaults from theme.json.
    // 2. Parse style.css for additional concrete CSS values and selectors.
    // 3. Merge them into a single ThemeTokens object that downstream planner /
    //    generator code can consume without caring where a token came from.
    const settings = themeJson?.settings ?? {};
    const asArray = <T = any>(value: unknown): T[] =>
      Array.isArray(value) ? (value as T[]) : [];

    const colors: ThemeTokens['colors'] = asArray(settings.color?.palette).map(
      (c: any) => ({ slug: c.slug, value: c.color }),
    );

    const gradients: NonNullable<ThemeTokens['gradients']> = asArray(
      settings.color?.gradients,
    ).map((g: any) => ({ slug: g.slug, value: g.gradient }));

    const shadows: NonNullable<ThemeTokens['shadows']> = asArray(
      settings.shadow?.presets,
    ).map((s: any) => ({ slug: s.slug, value: s.shadow }));

    const fonts: ThemeTokens['fonts'] = asArray(
      settings.typography?.fontFamilies,
    ).map((f: any) => ({ slug: f.slug, family: f.fontFamily, name: f.name }));

    const fontSizes: ThemeTokens['fontSizes'] = asArray(
      settings.typography?.fontSizes,
    ).map((s: any) => ({ slug: s.slug, size: s.size }));

    const spacing: ThemeTokens['spacing'] = asArray(
      settings.spacing?.spacingSizes,
    ).map((s: any) => ({ slug: s.slug, size: s.size }));

    const defaults = themeJson
      ? this.extractDefaults(themeJson, colors, fonts, fontSizes, spacing)
      : undefined;
    const blockStyles = themeJson
      ? this.extractBlockStyles(
          themeJson.styles?.blocks ?? {},
          colors,
          fonts,
          fontSizes,
          spacing,
        )
      : undefined;
    // style.css acts as a supplement/override layer for real rendered theme
    // defaults, especially when a classic theme does not express everything in
    // theme.json.
    const cssTokens = extractStyleCssTokens(styleCss, {
      colors,
      gradients,
      shadows,
      fonts,
      fontSizes,
      spacing,
    });

    return {
      colors: this.mergeBySlug(colors, cssTokens.colors),
      gradients: this.mergeBySlug(gradients, cssTokens.gradients ?? []),
      shadows: this.mergeBySlug(shadows, cssTokens.shadows ?? []),
      fonts: this.mergeBySlug(fonts, cssTokens.fonts),
      fontSizes: this.mergeBySlug(fontSizes, cssTokens.fontSizes),
      spacing: this.mergeBySlug(spacing, cssTokens.spacing),
      defaults: this.mergeDefaults(defaults, cssTokens.defaults),
      blockStyles: this.mergeBlockStyles(blockStyles, cssTokens.blockStyles),
    };
  }

  /**
   * Resolve a WordPress CSS var like `var(--wp--preset--color--contrast)`
   * to its hex value using the extracted color palette.
   */
  private resolveCssVar(
    value: string | undefined,
    colors: ThemeTokens['colors'],
  ): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    // Already a hex value
    if (trimmed.startsWith('#')) return trimmed;
    const shorthand = trimmed.match(/var:preset\|color\|([^|)\s]+)/);
    if (shorthand) return colors.find((c) => c.slug === shorthand[1])?.value;
    // Extract slug from var(--wp--preset--color--<slug>)
    const match = trimmed.match(/var\(--wp--preset--color--([^)]+)\)/);
    if (!match) return undefined;
    const slug = match[1];
    return colors.find((c) => c.slug === slug)?.value;
  }

  private resolveFontFamily(
    value: string | undefined,
    fonts: ThemeTokens['fonts'],
  ): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    const shorthand = trimmed.match(/var:preset\|font-family\|([^|)\s]+)/);
    if (shorthand) return fonts.find((f) => f.slug === shorthand[1])?.family;
    // Already a plain font family string (no CSS var)
    if (!trimmed.includes('var(')) return trimmed;
    // Extract slug from var(--wp--preset--font-family--<slug>)
    const match = trimmed.match(/var\(--wp--preset--font-family--([^)]+)\)/);
    if (!match) return undefined;
    const slug = match[1];
    return fonts.find((f) => f.slug === slug)?.family;
  }

  private resolveFontSize(
    value: string | undefined,
    fontSizes: ThemeTokens['fontSizes'],
  ): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    const shorthand = trimmed.match(/var:preset\|font-size\|([^|)\s]+)/);
    if (shorthand) return fontSizes.find((s) => s.slug === shorthand[1])?.size;
    if (!trimmed.includes('var(')) return trimmed;
    const match = trimmed.match(/var\(--wp--preset--font-size--([^)]+)\)/);
    if (!match) return undefined;
    return fontSizes.find((s) => s.slug === match[1])?.size;
  }

  private resolveSpacingVar(
    value: string | undefined,
    spacing: ThemeTokens['spacing'],
  ): string | undefined {
    if (!value) return undefined;
    // Direct value (e.g. "1.5rem")
    if (!value.includes('var')) return value;
    // "var:preset|spacing|50" (theme.json shorthand)
    const shorthand = value.match(/var:preset\|spacing\|([^|)\s]+)/);
    if (shorthand) return spacing.find((s) => s.slug === shorthand[1])?.size;
    // "var(--wp--preset--spacing--50)"
    const cssVar = value.match(/var\(--wp--preset--spacing--([^)]+)\)/);
    if (cssVar) return spacing.find((s) => s.slug === cssVar[1])?.size;
    return undefined;
  }

  private normalizeSpacingShorthand(
    value: string | undefined,
    spacing: ThemeTokens['spacing'],
  ): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed
      .split(/\s+/)
      .map((part) => this.resolveSpacingVar(part, spacing) ?? part)
      .join(' ');
  }

  private extractDefaults(
    themeJson: Record<string, any>,
    colors: ThemeTokens['colors'],
    fonts: ThemeTokens['fonts'],
    fontSizes: ThemeTokens['fontSizes'],
    spacing: ThemeTokens['spacing'],
  ): ThemeDefaults | undefined {
    const styles = themeJson.styles ?? {};
    const settings = themeJson.settings ?? {};
    const resolve = (v: string | undefined) => this.resolveCssVar(v, colors);
    const resolveFs = (v: string | undefined) =>
      this.resolveFontSize(v, fontSizes);
    const resolveSp = (v: string | undefined) =>
      this.resolveSpacingVar(v, spacing);

    const textColor = resolve(styles.color?.text);
    const bgColor = resolve(styles.color?.background);
    const headingColor = resolve(styles.elements?.heading?.color?.text);
    const linkColor = resolve(styles.elements?.link?.color?.text);
    const captionColor = resolve(styles.elements?.caption?.color?.text);
    const buttonBgColor = resolve(styles.elements?.button?.color?.background);
    const buttonTextColor = resolve(styles.elements?.button?.color?.text);
    const fontSize = resolveFs(styles.typography?.fontSize);
    const fontFamily = this.resolveFontFamily(
      styles.typography?.fontFamily,
      fonts,
    );
    const headingFontFamily = this.resolveFontFamily(
      styles.elements?.heading?.typography?.fontFamily,
      fonts,
    );
    const lineHeight = styles.typography?.lineHeight as string | undefined;
    const letterSpacing = styles.typography?.letterSpacing as
      | string
      | undefined;
    const textTransform = styles.typography?.textTransform as
      | string
      | undefined;
    const blockGap = resolveSp(styles.spacing?.blockGap);
    const contentWidth = settings.layout?.contentSize as string | undefined;
    const wideWidth = settings.layout?.wideSize as string | undefined;
    const rawButtonBorderRadius = styles.elements?.button?.border?.radius as
      | string
      | undefined;
    const buttonBorderRadius =
      this.normalizeSpacingShorthand(rawButtonBorderRadius, spacing) ??
      rawButtonBorderRadius;

    const rawPadding = styles.elements?.button?.spacing?.padding;
    let buttonPadding: string | undefined;
    if (rawPadding && typeof rawPadding === 'object') {
      const {
        top = '0',
        right = '0',
        bottom = '0',
        left = '0',
      } = rawPadding as any;
      buttonPadding = `${resolveSp(top) ?? top} ${resolveSp(right) ?? right} ${resolveSp(bottom) ?? bottom} ${resolveSp(left) ?? left}`;
    } else if (typeof rawPadding === 'string') {
      buttonPadding =
        this.normalizeSpacingShorthand(rawPadding, spacing) ?? rawPadding;
    }

    // Root/global padding from styles.spacing.padding (applied to .wp-site-blocks in WP)
    const rawRootPadding = styles.spacing?.padding;
    let rootPadding: string | undefined;
    if (rawRootPadding && typeof rawRootPadding === 'object') {
      const raw = rawRootPadding as Record<string, string>;
      const t = resolveSp(raw.top) ?? raw.top ?? '0';
      const r = resolveSp(raw.right) ?? raw.right ?? '0';
      const b = resolveSp(raw.bottom) ?? raw.bottom ?? '0';
      const l = resolveSp(raw.left) ?? raw.left ?? '0';
      // Only keep if at least one side is non-zero
      if (t !== '0' || r !== '0' || b !== '0' || l !== '0') {
        rootPadding = `${t} ${r} ${b} ${l}`;
      }
    } else if (typeof rawRootPadding === 'string') {
      rootPadding =
        this.normalizeSpacingShorthand(rawRootPadding, spacing) ??
        rawRootPadding;
    }

    // Per-heading typography
    const headingLevels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
    const headings: ThemeDefaults['headings'] = {};
    let hasHeadings = false;
    for (const level of headingLevels) {
      const typo = styles.elements?.heading?.[level]?.typography;
      if (!typo) continue;
      const hFontSize = resolveFs(typo.fontSize);
      const hFontWeight = typo.fontWeight as string | undefined;
      if (hFontSize || hFontWeight) {
        headings[level] = {
          ...(hFontSize && { fontSize: hFontSize }),
          ...(hFontWeight && { fontWeight: hFontWeight }),
        };
        hasHeadings = true;
      }
    }

    if (
      !textColor &&
      !bgColor &&
      !headingColor &&
      !linkColor &&
      !captionColor &&
      !buttonBgColor &&
      !buttonTextColor &&
      !fontSize &&
      !fontFamily &&
      !headingFontFamily &&
      !lineHeight &&
      !letterSpacing &&
      !textTransform &&
      !contentWidth &&
      !wideWidth &&
      !buttonBorderRadius &&
      !buttonPadding &&
      !blockGap &&
      !rootPadding &&
      !hasHeadings
    )
      return undefined;

    return {
      ...(textColor && { textColor }),
      ...(bgColor && { bgColor }),
      ...(headingColor && { headingColor }),
      ...(linkColor && { linkColor }),
      ...(captionColor && { captionColor }),
      ...(buttonBgColor && { buttonBgColor }),
      ...(buttonTextColor && { buttonTextColor }),
      ...(fontSize && { fontSize }),
      ...(fontFamily && { fontFamily }),
      ...(headingFontFamily &&
        headingFontFamily !== fontFamily && { headingFontFamily }),
      ...(lineHeight && { lineHeight }),
      ...(letterSpacing && { letterSpacing }),
      ...(textTransform && { textTransform }),
      ...(contentWidth && { contentWidth }),
      ...(wideWidth && { wideWidth }),
      ...(buttonBorderRadius && { buttonBorderRadius }),
      ...(buttonPadding && { buttonPadding }),
      ...(blockGap && { blockGap }),
      ...(rootPadding && { rootPadding }),
      ...(hasHeadings && { headings }),
    };
  }

  private extractBlockStyles(
    blocksStyles: Record<string, any>,
    colors: ThemeTokens['colors'],
    fonts: ThemeTokens['fonts'],
    fontSizes: ThemeTokens['fontSizes'],
    spacing: ThemeTokens['spacing'],
  ): ThemeTokens['blockStyles'] {
    if (!blocksStyles || Object.keys(blocksStyles).length === 0)
      return undefined;
    const result: NonNullable<ThemeTokens['blockStyles']> = {};

    for (const [blockType, style] of Object.entries(blocksStyles)) {
      const resolved: ThemeBlockStyle = {};

      const textColor = this.resolveCssVar(style.color?.text, colors);
      const bgColor = this.resolveCssVar(style.color?.background, colors);
      if (textColor || bgColor)
        resolved.color = {
          ...(textColor && { text: textColor }),
          ...(bgColor && { background: bgColor }),
        };

      const fontSize = this.resolveFontSize(
        style.typography?.fontSize,
        fontSizes,
      );
      const fontFamily = this.resolveFontFamily(
        style.typography?.fontFamily,
        fonts,
      );
      const fontWeight = style.typography?.fontWeight as string | undefined;
      const letterSpacing = style.typography?.letterSpacing as
        | string
        | undefined;
      const lineHeight = style.typography?.lineHeight as string | undefined;
      const textTransform = style.typography?.textTransform as
        | string
        | undefined;
      if (
        fontSize ||
        fontFamily ||
        fontWeight ||
        letterSpacing ||
        lineHeight ||
        textTransform
      )
        resolved.typography = {
          ...(fontSize && { fontSize }),
          ...(fontFamily && { fontFamily }),
          ...(fontWeight && { fontWeight }),
          ...(letterSpacing && { letterSpacing }),
          ...(lineHeight && { lineHeight }),
          ...(textTransform && { textTransform }),
        };

      const borderRadius = this.normalizeSpacingShorthand(
        style.border?.radius as string | undefined,
        spacing,
      );
      const borderWidth = this.normalizeSpacingShorthand(
        style.border?.width as string | undefined,
        spacing,
      );
      const borderStyle = style.border?.style as string | undefined;
      const borderColor = this.resolveCssVar(
        style.border?.color as string | undefined,
        colors,
      );
      if (borderRadius || borderWidth || borderStyle || borderColor)
        resolved.border = {
          ...(borderRadius && { radius: borderRadius }),
          ...(borderWidth && { width: borderWidth }),
          ...(borderStyle && { style: borderStyle }),
          ...(borderColor && { color: borderColor }),
        };

      const resolveSp = (v: string | undefined) =>
        this.resolveSpacingVar(v, spacing);

      const rawPad = style.spacing?.padding;
      const rawMargin = style.spacing?.margin;
      const rawGap = style.spacing?.blockGap as string | undefined;
      const resolvedPad = (() => {
        if (!rawPad) return undefined;
        if (typeof rawPad === 'object') {
          const {
            top = '0',
            right = '0',
            bottom = '0',
            left = '0',
          } = rawPad as any;
          return `${resolveSp(top) ?? top} ${resolveSp(right) ?? right} ${resolveSp(bottom) ?? bottom} ${resolveSp(left) ?? left}`;
        }
        return (
          this.normalizeSpacingShorthand(rawPad as string, spacing) ??
          (rawPad as string)
        );
      })();
      const resolvedMargin = (() => {
        if (!rawMargin) return undefined;
        if (typeof rawMargin === 'object') {
          const {
            top = '0',
            right = '0',
            bottom = '0',
            left = '0',
          } = rawMargin as any;
          return `${resolveSp(top) ?? top} ${resolveSp(right) ?? right} ${resolveSp(bottom) ?? bottom} ${resolveSp(left) ?? left}`;
        }
        return (
          this.normalizeSpacingShorthand(rawMargin as string, spacing) ??
          (rawMargin as string)
        );
      })();
      const resolvedGap = rawGap ? (resolveSp(rawGap) ?? rawGap) : undefined;
      if (resolvedPad || resolvedMargin || resolvedGap) {
        resolved.spacing = {
          ...(resolvedPad && { padding: resolvedPad }),
          ...(resolvedMargin && { margin: resolvedMargin }),
          ...(resolvedGap && { gap: resolvedGap }),
        };
      }

      if (Object.keys(resolved).length > 0) {
        const shortName = blockType.replace('core/', '');
        result[shortName] = resolved;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Replace <!-- wp:template-part {"slug":"header",...} /--> with part markup.
   */
  private resolveTemplateParts(
    markup: string,
    partMap: Map<string, string>,
    diagnostics?: BlockParseDiagnostic,
  ): string {
    return markup.replace(
      /<!-- wp:template-part \{[^}]*"slug":"([^"]+)"[^}]*\} \/-->/g,
      (_, slug) => {
        const partMarkup =
          this.findPartMarkup(slug, partMap) ??
          `<!-- part:${slug} not found -->`;
        return this.wrapResolvedPart(slug, partMarkup);
      },
    );
  }

  private resolvePartMarkup(
    partName: string,
    rawPartMap: Map<string, string>,
    diagnostics: BlockParseDiagnostic,
    stack: Set<string>,
  ): string {
    const markup = rawPartMap.get(partName);
    if (!markup) {
      diagnostics.unresolvedTemplateParts.push(partName);
      return `<!-- part:${partName} not found -->`;
    }

    if (stack.has(partName)) {
      diagnostics.warnings.push(
        `Circular template-part reference detected for "${partName}" — nested expansion stopped.`,
      );
      return `<!-- part:${partName} circular reference -->`;
    }

    const nextStack = new Set(stack);
    nextStack.add(partName);

    return markup.replace(
      /<!-- wp:template-part \{[^}]*"slug":"([^"]+)"[^}]*\} \/-->/g,
      (_, slug) => {
        const resolvedName = this.findPartName(slug, rawPartMap);
        if (!resolvedName) return `<!-- part:${slug} not found -->`;
        return this.wrapResolvedPart(
          slug,
          this.resolvePartMarkup(
            resolvedName,
            rawPartMap,
            diagnostics,
            nextStack,
          ),
        );
      },
    );
  }

  private wrapResolvedPart(slug: string, markup: string): string {
    return [
      `<!-- vibepress:part:start ${slug} -->`,
      markup,
      `<!-- vibepress:part:end ${slug} -->`,
    ].join('\n');
  }

  private findPartMarkup(
    slug: string,
    partMap: Map<string, string>,
  ): string | undefined {
    const resolvedName = this.findPartName(slug, partMap);
    return resolvedName ? partMap.get(resolvedName) : undefined;
  }

  private findPartName(
    slug: string,
    partMap: Map<string, unknown>,
  ): string | undefined {
    if (partMap.has(slug)) return slug;

    const normalizedSlug = slug.replace(/^\/+|\/+$/g, '');
    if (partMap.has(normalizedSlug)) return normalizedSlug;

    const matches = [...partMap.keys()].filter((key) => {
      if (key === normalizedSlug) return true;
      return (
        key.endsWith(`/${normalizedSlug}`) || basename(key) === normalizedSlug
      );
    });

    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Read patterns/*.php, extract slug from PHP header comment,
   * strip PHP tags, return map of slug → markup.
   */
  private async buildPatternMap(
    patternsDir: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const files = await this.walkFiles(patternsDir, '.php');
      for (const file of files) {
        const raw = await readFile(join(patternsDir, file), 'utf-8');
        const slugMatch = raw.match(/\*\s*Slug:\s*(.+)/);
        if (!slugMatch) continue;
        const slug = slugMatch[1].trim();
        const markup = this.stripPhp(raw);
        map.set(slug, markup);
      }
    } catch {
      // patterns dir may not exist
    }
    return map;
  }

  /**
   * Replace <!-- wp:pattern {"slug":"..."} /--> with actual pattern markup.
   * Resolves recursively up to 5 levels deep.
   */
  private resolvePatterns(
    markup: string,
    patternMap: Map<string, string>,
    _diagnostics?: BlockParseDiagnostic,
    depth = 0,
  ): string {
    if (depth > 5) return markup;
    return markup.replace(
      /<!-- wp:pattern \{"slug":"([^"]+)"\} \/-->/g,
      (_, slug) => {
        const patternMarkup = patternMap.get(slug);
        if (!patternMarkup) return `<!-- pattern:${slug} not found -->`;
        return this.resolvePatterns(
          patternMarkup,
          patternMap,
          _diagnostics,
          depth + 1,
        );
      },
    );
  }

  private collectUnresolvedRefs(markups: string[], re: RegExp): string[] {
    const results = new Set<string>();
    for (const markup of markups) {
      for (const match of markup.matchAll(re)) {
        results.add(match[1]);
      }
    }
    return [...results];
  }

  /**
   * Strip PHP from pattern files:
   * 1. Remove the header <?php ... ?> doc block
   * 2. Replace echo esc_html_x('text', ...) etc. → text
   * 3. Remove remaining <?php ... ?> tags
   */
  private stripPhp(raw: string): string {
    return (
      raw
        .replace(/<\?php\s*\/\*\*[\s\S]*?\*\/\s*\?>/g, '')
        // PHP i18n in JSON string values: "<?php esc_html_e('Team', 'domain'); ?>" → "Team"
        .replace(
          /"<\?php\s+(?:esc_html_e|esc_attr_e|esc_html|esc_attr|__|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>"/g,
          '"$1"',
        )
        // PHP i18n in HTML content: <?php esc_html_e('text', 'domain'); ?> → text
        // Also handles esc_attr_e (e.g. alt attributes)
        .replace(
          /<\?php\s+(?:esc_html_e|esc_attr_e|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        .replace(
          /<\?php\s+echo\s+(?:esc_html|esc_attr|__)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        // <?php echo esc_html_x('text', 'context', 'domain'); ?> → text
        // Must run BEFORE the bare esc_html_x regex so outer PHP tags are removed together
        .replace(
          /<\?php\s+echo\s+esc_html_x\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        .replace(/esc_html_x\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/esc_html__\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/esc_attr_e\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/esc_attr__\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/echo\s+(['"`])([\s\S]*?)\1\s*;/g, '$2')
        .replace(/<\?php[\s\S]*?\?>/g, '')
        .replace(/<\?php[^>]*$/gm, '')
        .trim()
    );
  }

  private mergeBySlug<T extends { slug: string }>(base: T[], extra: T[]): T[] {
    const map = new Map<string, T>();
    for (const item of base) map.set(item.slug, item);
    for (const item of extra) if (!map.has(item.slug)) map.set(item.slug, item);
    return [...map.values()];
  }

  private mergeThemeTokens(
    primary: ThemeTokens,
    fallback: ThemeTokens,
  ): ThemeTokens {
    return {
      colors: this.mergeBySlug(primary.colors, fallback.colors),
      gradients: this.mergeBySlug(
        primary.gradients ?? [],
        fallback.gradients ?? [],
      ),
      shadows: this.mergeBySlug(primary.shadows ?? [], fallback.shadows ?? []),
      fonts: this.mergeBySlug(primary.fonts, fallback.fonts),
      fontSizes: this.mergeBySlug(primary.fontSizes, fallback.fontSizes),
      spacing: this.mergeBySlug(primary.spacing, fallback.spacing),
      defaults: this.mergeDefaults(primary.defaults, fallback.defaults),
      blockStyles: this.mergeBlockStyles(
        primary.blockStyles,
        fallback.blockStyles,
      ),
    };
  }

  private deepMergeThemeJson(
    base: Record<string, any>,
    override: Record<string, any>,
  ): Record<string, any> {
    const result: Record<string, any> = { ...base };

    for (const [key, overrideValue] of Object.entries(override)) {
      const baseValue = result[key];
      if (this.isPlainObject(baseValue) && this.isPlainObject(overrideValue)) {
        result[key] = this.deepMergeThemeJson(baseValue, overrideValue);
        continue;
      }
      result[key] = overrideValue;
    }

    return result;
  }

  private isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private mergeDefaults(
    primary?: ThemeDefaults,
    fallback?: ThemeDefaults,
  ): ThemeDefaults | undefined {
    if (!primary && !fallback) return undefined;

    const headings = this.mergeHeadings(primary?.headings, fallback?.headings);
    const merged: ThemeDefaults = {
      ...(fallback ?? {}),
      ...(primary ?? {}),
      ...(headings && { headings }),
    };

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private mergeHeadings(
    primary?: ThemeDefaults['headings'],
    fallback?: ThemeDefaults['headings'],
  ): ThemeDefaults['headings'] | undefined {
    if (!primary && !fallback) return undefined;

    const merged: NonNullable<ThemeDefaults['headings']> = {};
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      const value = {
        ...(fallback?.[level] ?? {}),
        ...(primary?.[level] ?? {}),
      };
      if (Object.keys(value).length > 0) merged[level] = value;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private mergeBlockStyles(
    primary?: Record<string, ThemeBlockStyle>,
    fallback?: Record<string, ThemeBlockStyle>,
  ): Record<string, ThemeBlockStyle> | undefined {
    if (!primary && !fallback) return undefined;

    const merged: Record<string, ThemeBlockStyle> = { ...(fallback ?? {}) };

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

  private async readHtmlDir(
    dir: string,
  ): Promise<{ name: string; markup: string }[]> {
    try {
      const entries = await this.walkFiles(dir, '.html');
      return Promise.all(
        entries.map(async (file) => ({
          name: this.normalizeRelativeName(file.replace(/\.html$/i, '')),
          markup: await readFile(join(dir, file), 'utf-8'),
        })),
      );
    } catch {
      return [];
    }
  }

  private async walkFiles(
    dir: string,
    ext: '.php' | '.html',
  ): Promise<string[]> {
    const results: string[] = [];
    const visit = async (currentDir: string): Promise<void> => {
      const entries = await readdir(currentDir);
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const info = await stat(fullPath);
        if (info.isDirectory()) {
          await visit(fullPath);
          continue;
        }
        if (!entry.toLowerCase().endsWith(ext)) continue;
        results.push(relative(dir, fullPath).replace(/\\/g, '/'));
      }
    };

    await visit(dir);
    return results.sort((a, b) => a.localeCompare(b));
  }

  private normalizeRelativeName(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  }

  private async readJson(path: string): Promise<Record<string, any> | null> {
    try {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
