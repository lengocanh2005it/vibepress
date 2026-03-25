import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

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
  lineHeight?: string;
  contentWidth?: string;
  wideWidth?: string;
  buttonBorderRadius?: string;
  buttonPadding?: string;
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
  typography?: { fontSize?: string; fontWeight?: string; letterSpacing?: string; lineHeight?: string };
  border?: { radius?: string };
  spacing?: { padding?: string };
}

export interface ThemeTokens {
  colors: { slug: string; value: string }[];
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
}

@Injectable()
export class BlockParserService {
  private readonly logger = new Logger(BlockParserService.name);

  async parse(themeDir: string): Promise<BlockParseResult> {
    this.logger.log(`Parsing FSE/Block theme: ${themeDir}`);

    const themeJson = await this.readJson(join(themeDir, 'theme.json'));
    const tokens = this.extractTokens(themeJson);

    // Build pattern map: slug → markup (from patterns/*.php)
    const patternMap = await this.buildPatternMap(join(themeDir, 'patterns'));

    const rawParts = await this.readHtmlDir(join(themeDir, 'parts'));

    // Build part map: slug → resolved markup
    const partMap = new Map<string, string>();
    for (const p of rawParts) {
      partMap.set(p.name, this.resolvePatterns(p.markup, patternMap));
    }

    const rawTemplates = await this.readHtmlDir(join(themeDir, 'templates'));

    // Resolve patterns + template-parts in templates
    const templates = rawTemplates.map((t) => ({
      name: t.name,
      markup: this.resolveTemplateParts(
        this.resolvePatterns(t.markup, patternMap),
        partMap,
      ),
    }));

    const parts = rawParts.map((p) => ({
      name: p.name,
      markup: partMap.get(p.name) ?? p.markup,
    }));

    return { type: 'fse', themeJson, tokens, templates, parts };
  }

  private extractTokens(themeJson: Record<string, any> | null): ThemeTokens {
    if (!themeJson)
      return { colors: [], fonts: [], fontSizes: [], spacing: [] };
    const settings = themeJson.settings ?? {};

    const colors: ThemeTokens['colors'] = (settings.color?.palette ?? []).map(
      (c: any) => ({ slug: c.slug, value: c.color }),
    );

    const fonts: ThemeTokens['fonts'] = (
      settings.typography?.fontFamilies ?? []
    ).map((f: any) => ({ slug: f.slug, family: f.fontFamily, name: f.name }));

    const fontSizes: ThemeTokens['fontSizes'] = (
      settings.typography?.fontSizes ?? []
    ).map((s: any) => ({ slug: s.slug, size: s.size }));

    const spacing: ThemeTokens['spacing'] = (
      settings.spacing?.spacingSizes ?? []
    ).map((s: any) => ({ slug: s.slug, size: s.size }));

    const defaults = this.extractDefaults(themeJson, colors, fonts, fontSizes);
    const blockStyles = this.extractBlockStyles(
      themeJson.styles?.blocks ?? {},
      colors,
      fontSizes,
    );

    return { colors, fonts, fontSizes, spacing, defaults, blockStyles };
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
    // Already a hex value
    if (value.startsWith('#')) return value;
    // Extract slug from var(--wp--preset--color--<slug>)
    const match = value.match(/var\(--wp--preset--color--([^)]+)\)/);
    if (!match) return undefined;
    const slug = match[1];
    return colors.find((c) => c.slug === slug)?.value;
  }

  private resolveFontFamily(
    value: string | undefined,
    fonts: ThemeTokens['fonts'],
  ): string | undefined {
    if (!value) return undefined;
    // Already a plain font family string (no CSS var)
    if (!value.includes('var(')) return value;
    // Extract slug from var(--wp--preset--font-family--<slug>)
    const match = value.match(/var\(--wp--preset--font-family--([^)]+)\)/);
    if (!match) return undefined;
    const slug = match[1];
    return fonts.find((f) => f.slug === slug)?.family;
  }

  private resolveFontSize(
    value: string | undefined,
    fontSizes: ThemeTokens['fontSizes'],
  ): string | undefined {
    if (!value) return undefined;
    if (!value.includes('var(')) return value;
    const match = value.match(/var\(--wp--preset--font-size--([^)]+)\)/);
    if (!match) return undefined;
    return fontSizes.find((s) => s.slug === match[1])?.size;
  }

  private extractDefaults(
    themeJson: Record<string, any>,
    colors: ThemeTokens['colors'],
    fonts: ThemeTokens['fonts'],
    fontSizes: ThemeTokens['fontSizes'],
  ): ThemeDefaults | undefined {
    const styles = themeJson.styles ?? {};
    const settings = themeJson.settings ?? {};
    const resolve = (v: string | undefined) => this.resolveCssVar(v, colors);
    const resolveFs = (v: string | undefined) => this.resolveFontSize(v, fontSizes);

    const textColor = resolve(styles.color?.text);
    const bgColor = resolve(styles.color?.background);
    const headingColor = resolve(styles.elements?.heading?.color?.text);
    const linkColor = resolve(styles.elements?.link?.color?.text);
    const captionColor = resolve(styles.elements?.caption?.color?.text);
    const buttonBgColor = resolve(styles.elements?.button?.color?.background);
    const buttonTextColor = resolve(styles.elements?.button?.color?.text);
    const fontSize = resolveFs(styles.typography?.fontSize);
    const fontFamily = this.resolveFontFamily(styles.typography?.fontFamily, fonts);
    const lineHeight = styles.typography?.lineHeight as string | undefined;
    const contentWidth = settings.layout?.contentSize as string | undefined;
    const wideWidth = settings.layout?.wideSize as string | undefined;
    const buttonBorderRadius = styles.elements?.button?.border?.radius as string | undefined;

    const rawPadding = styles.elements?.button?.spacing?.padding;
    let buttonPadding: string | undefined;
    if (rawPadding && typeof rawPadding === 'object') {
      const { top = '0', right = '0', bottom = '0', left = '0' } = rawPadding as any;
      buttonPadding = `${top} ${right} ${bottom} ${left}`;
    } else if (typeof rawPadding === 'string') {
      buttonPadding = rawPadding;
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
      !textColor && !bgColor && !headingColor && !linkColor && !captionColor &&
      !buttonBgColor && !buttonTextColor && !fontSize && !fontFamily &&
      !lineHeight && !contentWidth && !wideWidth && !buttonBorderRadius &&
      !buttonPadding && !hasHeadings
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
      ...(lineHeight && { lineHeight }),
      ...(contentWidth && { contentWidth }),
      ...(wideWidth && { wideWidth }),
      ...(buttonBorderRadius && { buttonBorderRadius }),
      ...(buttonPadding && { buttonPadding }),
      ...(hasHeadings && { headings }),
    };
  }

  private extractBlockStyles(
    blocksStyles: Record<string, any>,
    colors: ThemeTokens['colors'],
    fontSizes: ThemeTokens['fontSizes'],
  ): ThemeTokens['blockStyles'] {
    if (!blocksStyles || Object.keys(blocksStyles).length === 0) return undefined;
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

      const fontSize = this.resolveFontSize(style.typography?.fontSize, fontSizes);
      const fontWeight = style.typography?.fontWeight as string | undefined;
      const letterSpacing = style.typography?.letterSpacing as string | undefined;
      const lineHeight = style.typography?.lineHeight as string | undefined;
      if (fontSize || fontWeight || letterSpacing || lineHeight)
        resolved.typography = {
          ...(fontSize && { fontSize }),
          ...(fontWeight && { fontWeight }),
          ...(letterSpacing && { letterSpacing }),
          ...(lineHeight && { lineHeight }),
        };

      if (style.border?.radius) resolved.border = { radius: style.border.radius as string };

      const rawPad = style.spacing?.padding;
      if (rawPad) {
        if (typeof rawPad === 'object') {
          const { top = '0', right = '0', bottom = '0', left = '0' } = rawPad as any;
          resolved.spacing = { padding: `${top} ${right} ${bottom} ${left}` };
        } else {
          resolved.spacing = { padding: rawPad as string };
        }
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
  ): string {
    return markup.replace(
      /<!-- wp:template-part \{[^}]*"slug":"([^"]+)"[^}]*\} \/-->/g,
      (_, slug) => partMap.get(slug) ?? `<!-- part:${slug} not found -->`,
    );
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
      const files = (await readdir(patternsDir)).filter((f) =>
        f.endsWith('.php'),
      );
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
    depth = 0,
  ): string {
    if (depth > 5) return markup;
    return markup.replace(
      /<!-- wp:pattern \{"slug":"([^"]+)"\} \/-->/g,
      (_, slug) => {
        const patternMarkup = patternMap.get(slug);
        if (!patternMarkup) return `<!-- pattern:${slug} not found -->`;
        return this.resolvePatterns(patternMarkup, patternMap, depth + 1);
      },
    );
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

  private async readHtmlDir(
    dir: string,
  ): Promise<{ name: string; markup: string }[]> {
    try {
      const entries = await readdir(dir);
      return Promise.all(
        entries
          .filter((f) => f.endsWith('.html'))
          .map(async (file) => ({
            name: file.replace('.html', ''),
            markup: await readFile(join(dir, file), 'utf-8'),
          })),
      );
    } catch {
      return [];
    }
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
