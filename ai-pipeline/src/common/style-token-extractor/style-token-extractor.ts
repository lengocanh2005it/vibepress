import type {
  ThemeBlockStyle,
  ThemeDefaults,
  ThemeTokens,
} from '../../modules/agents/block-parser/block-parser.service.js';

export interface StyleTokenExtractionResult {
  colors: ThemeTokens['colors'];
  fonts: ThemeTokens['fonts'];
  fontSizes: ThemeTokens['fontSizes'];
  spacing: ThemeTokens['spacing'];
  defaults?: ThemeDefaults;
  blockStyles?: Record<string, ThemeBlockStyle>;
}

interface CssRule {
  selectors: string[];
  declarations: Record<string, string>;
}

interface ResolveContext {
  colors: ThemeTokens['colors'];
  fonts: ThemeTokens['fonts'];
  fontSizes: ThemeTokens['fontSizes'];
  spacing: ThemeTokens['spacing'];
  vars: Map<string, string>;
}

export function extractStyleCssTokens(
  styleCss: string | undefined,
  baseTokens?: Partial<ThemeTokens>,
): StyleTokenExtractionResult {
  if (!styleCss?.trim()) {
    return { colors: [], fonts: [], fontSizes: [], spacing: [] };
  }

  const rules = parseCssRules(styleCss);
  const vars = collectVars(rules);
  const inferred = inferTokensFromVars(vars);
  const colors = mergeBySlug(baseTokens?.colors ?? [], inferred.colors);
  const fonts = mergeBySlug(baseTokens?.fonts ?? [], inferred.fonts);
  const fontSizes = mergeBySlug(
    baseTokens?.fontSizes ?? [],
    inferred.fontSizes,
  );
  const spacing = mergeBySlug(baseTokens?.spacing ?? [], inferred.spacing);

  const ctx: ResolveContext = { colors, fonts, fontSizes, spacing, vars };

  return {
    colors: inferred.colors,
    fonts: inferred.fonts,
    fontSizes: inferred.fontSizes,
    spacing: inferred.spacing,
    defaults: extractDefaults(rules, ctx),
    blockStyles: extractBlockStyles(rules, ctx),
  };
}

export function buildStyleCssBridge(
  styleCss: string | undefined,
  baseTokens?: Partial<ThemeTokens>,
): string {
  const extracted = extractStyleCssTokens(styleCss, baseTokens);
  const tokens: ThemeTokens = {
    colors: mergeBySlug(baseTokens?.colors ?? [], extracted.colors),
    fonts: mergeBySlug(baseTokens?.fonts ?? [], extracted.fonts),
    fontSizes: mergeBySlug(baseTokens?.fontSizes ?? [], extracted.fontSizes),
    spacing: mergeBySlug(baseTokens?.spacing ?? [], extracted.spacing),
    defaults: mergeThemeDefaults(baseTokens?.defaults, extracted.defaults),
    blockStyles: mergeThemeBlockStyles(
      baseTokens?.blockStyles,
      extracted.blockStyles,
    ),
  };

  const rules = styleCss?.trim() ? parseCssRules(styleCss) : [];
  const vars = collectVars(rules);
  const ctx: ResolveContext = {
    colors: tokens.colors,
    fonts: tokens.fonts,
    fontSizes: tokens.fontSizes,
    spacing: tokens.spacing,
    vars,
  };

  const cssRules: CssRule[] = [];
  const rootDecls = buildBridgeRootDeclarations(vars);
  if (Object.keys(rootDecls).length > 0) {
    cssRules.push({ selectors: [':root'], declarations: rootDecls });
  }
  cssRules.push(...buildDerivedBridgeRules(tokens));
  cssRules.push(...buildSafeThemeBridgeRules(rules, ctx));

  const rendered = cssRules
    .map((rule) => renderCssRule(rule))
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!rendered) return '';
  return `/* WordPress style bridge */\n${rendered}\n`;
}

function parseCssRules(input: string): CssRule[] {
  const css = input.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];

  const walk = (source: string) => {
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf('{', cursor);
      if (open === -1) break;

      const selector = source.slice(cursor, open).trim();
      let depth = 1;
      let i = open + 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      if (depth !== 0) break;

      const body = source.slice(open + 1, i - 1);
      if (selector.startsWith('@')) {
        walk(body);
      } else if (selector) {
        rules.push({
          selectors: selector
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          declarations: parseDeclarations(body),
        });
      }

      cursor = i;
    }
  };

  walk(css);
  return rules;
}

function parseDeclarations(block: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  let current = '';
  let parenDepth = 0;

  for (const char of block) {
    if (char === '(') parenDepth++;
    if (char === ')') parenDepth = Math.max(parenDepth - 1, 0);

    if (char === ';' && parenDepth === 0) {
      pushDeclaration(current, declarations);
      current = '';
      continue;
    }

    current += char;
  }

  pushDeclaration(current, declarations);
  return declarations;
}

function pushDeclaration(
  raw: string,
  declarations: Record<string, string>,
): void {
  const line = raw.trim();
  if (!line) return;
  const colon = line.indexOf(':');
  if (colon === -1) return;
  declarations[line.slice(0, colon).trim().toLowerCase()] = line
    .slice(colon + 1)
    .trim();
}

function collectVars(rules: CssRule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules) {
    for (const [prop, value] of Object.entries(rule.declarations)) {
      if (prop.startsWith('--')) vars.set(prop, value);
    }
  }
  return vars;
}

function inferTokensFromVars(vars: Map<string, string>) {
  const colors: ThemeTokens['colors'] = [];
  const fonts: ThemeTokens['fonts'] = [];
  const fontSizes: ThemeTokens['fontSizes'] = [];
  const spacing: ThemeTokens['spacing'] = [];

  for (const [name, value] of vars.entries()) {
    const slug = slugify(name);
    if (!slug) continue;

    if (isColor(value)) {
      colors.push({ slug, value: value.trim() });
      continue;
    }

    if (isFontFamily(value)) {
      fonts.push({ slug, family: value.trim(), name: titleize(slug) });
      continue;
    }

    if (isSize(value)) {
      if (/(spacing|space|gap|padding|margin)/i.test(name)) {
        spacing.push({ slug, size: value.trim() });
      } else if (/(font|text|size|width|radius)/i.test(name)) {
        fontSizes.push({ slug, size: value.trim() });
      }
    }
  }

  return {
    colors: dedupeBySlug(colors),
    fonts: dedupeBySlug(fonts),
    fontSizes: dedupeBySlug(fontSizes),
    spacing: dedupeBySlug(spacing),
  };
}

function extractDefaults(
  rules: CssRule[],
  ctx: ResolveContext,
): ThemeDefaults | undefined {
  const body = pickDecls(rules, [/^body$/i, /^html$/i, /^html\s+body$/i]);
  const links = pickDecls(rules, [/^a(?::[\w-]+)?$/i]);
  const caption = pickDecls(rules, [
    /^figcaption$/i,
    /^\.wp-caption-text$/i,
    /^\.gallery-caption$/i,
    /^\.blocks-gallery-caption$/i,
  ]);
  const button = pickDecls(rules, [
    /^button$/i,
    /^button(?::[\w-]+)?$/i,
    /^\.button$/i,
    /^\.btn$/i,
    /^input\[type=['"]?(submit|button)['"]?\]$/i,
    /^\.wp-block-button__link$/i,
  ]);
  const content = pickDecls(rules, [
    /^\.entry-content$/i,
    /^\.site-content$/i,
    /^\.content-area$/i,
    /^\.container$/i,
    /^main$/i,
    /^\.site-main$/i,
    /^\.wp-site-blocks$/i,
  ]);
  const wide = pickDecls(rules, [/^\.alignwide$/i]);
  const gap = pickDecls(rules, [
    /^\.wp-block-columns$/i,
    /^\.wp-block-buttons$/i,
    /^\.is-layout-flex$/i,
    /^\.wp-block-group\.is-layout-flex$/i,
  ]);

  const headings: NonNullable<ThemeDefaults['headings']> = {};
  let headingColor: string | undefined;
  let headingFontFamily: string | undefined;
  for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
    const decls = pickDecls(rules, [new RegExp(`^${level}$`, 'i')]);
    const fontSize = resolveValue(decls?.['font-size'], ctx, 'size');
    const fontWeight = resolveValue(decls?.['font-weight'], ctx, 'plain');
    const fontFamily = resolveValue(decls?.['font-family'], ctx, 'font');
    const color = resolveValue(decls?.color, ctx, 'color');
    if (!headingColor && color) headingColor = color;
    if (!headingFontFamily && fontFamily) headingFontFamily = fontFamily;
    if (fontSize || fontWeight) {
      headings[level] = {
        ...(fontSize && { fontSize }),
        ...(fontWeight && { fontWeight }),
      };
    }
  }

  const resolved: ThemeDefaults = {
    ...(resolveValue(body?.color, ctx, 'color') && {
      textColor: resolveValue(body?.color, ctx, 'color'),
    }),
    ...(resolveValue(
      body?.['background-color'] ?? body?.background,
      ctx,
      'color',
    ) && {
      bgColor: resolveValue(
        body?.['background-color'] ?? body?.background,
        ctx,
        'color',
      ),
    }),
    ...(headingColor && { headingColor }),
    ...(resolveValue(links?.color, ctx, 'color') && {
      linkColor: resolveValue(links?.color, ctx, 'color'),
    }),
    ...(resolveValue(caption?.color, ctx, 'color') && {
      captionColor: resolveValue(caption?.color, ctx, 'color'),
    }),
    ...(resolveValue(
      button?.['background-color'] ?? button?.background,
      ctx,
      'color',
    ) && {
      buttonBgColor: resolveValue(
        button?.['background-color'] ?? button?.background,
        ctx,
        'color',
      ),
    }),
    ...(resolveValue(button?.color, ctx, 'color') && {
      buttonTextColor: resolveValue(button?.color, ctx, 'color'),
    }),
    ...(resolveValue(body?.['font-size'], ctx, 'size') && {
      fontSize: resolveValue(body?.['font-size'], ctx, 'size'),
    }),
    ...(resolveValue(body?.['font-family'], ctx, 'font') && {
      fontFamily: resolveValue(body?.['font-family'], ctx, 'font'),
    }),
    ...(headingFontFamily && { headingFontFamily }),
    ...(resolveValue(body?.['line-height'], ctx, 'plain') && {
      lineHeight: resolveValue(body?.['line-height'], ctx, 'plain'),
    }),
    ...(resolveValue(content?.['max-width'] ?? content?.width, ctx, 'size') && {
      contentWidth: resolveValue(
        content?.['max-width'] ?? content?.width,
        ctx,
        'size',
      ),
    }),
    ...(resolveValue(wide?.['max-width'] ?? wide?.width, ctx, 'size') && {
      wideWidth: resolveValue(wide?.['max-width'] ?? wide?.width, ctx, 'size'),
    }),
    ...(resolveValue(button?.['border-radius'], ctx, 'size') && {
      buttonBorderRadius: resolveValue(button?.['border-radius'], ctx, 'size'),
    }),
    ...(normalizePadding(button?.padding, ctx) && {
      buttonPadding: normalizePadding(button?.padding, ctx),
    }),
    ...(resolveValue(
      gap?.gap ?? gap?.['column-gap'] ?? gap?.['row-gap'],
      ctx,
      'size',
    ) && {
      blockGap: resolveValue(
        gap?.gap ?? gap?.['column-gap'] ?? gap?.['row-gap'],
        ctx,
        'size',
      ),
    }),
    ...(normalizePadding(content?.padding, ctx) && {
      rootPadding: normalizePadding(content?.padding, ctx),
    }),
    ...(Object.keys(headings).length > 0 && { headings }),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function extractBlockStyles(
  rules: CssRule[],
  ctx: ResolveContext,
): Record<string, ThemeBlockStyle> | undefined {
  const blockDeclMap: Array<[string, RegExp[]]> = [
    [
      'button',
      [
        /^button$/i,
        /^button(?::[\w-]+)?$/i,
        /^\.button$/i,
        /^\.btn$/i,
        /^input\[type=['"]?(submit|button)['"]?\]$/i,
        /^\.wp-block-button__link$/i,
        /^\.wp-element-button$/i,
      ],
    ],
    [
      'image',
      [
        /^\.wp-block-image\s+img$/i,
        /^\.wp-block-post-featured-image\s+img$/i,
        /^figure\s+img$/i,
      ],
    ],
    [
      'gallery',
      [
        /^\.wp-block-gallery$/i,
        /^\.wp-block-gallery\s+img$/i,
        /^\.blocks-gallery-grid$/i,
      ],
    ],
    ['group', [/^\.wp-block-group$/i, /^\.wp-block-group__inner-container$/i]],
    ['column', [/^\.wp-block-column$/i, /^\.wp-block-columns$/i]],
    ['cover', [/^\.wp-block-cover$/i, /^\.wp-block-cover__inner-container$/i]],
    ['quote', [/^\.wp-block-quote$/i, /^blockquote$/i]],
    ['table', [/^\.wp-block-table\s+table$/i, /^table$/i]],
  ];

  const result: Record<string, ThemeBlockStyle> = {};
  for (const [blockType, patterns] of blockDeclMap) {
    const decls = pickDecls(rules, patterns);
    const style = decls ? buildThemeBlockStyle(decls, ctx) : undefined;
    if (style && Object.keys(style).length > 0) {
      result[blockType] = style;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function buildThemeBlockStyle(
  decls: Record<string, string>,
  ctx: ResolveContext,
): ThemeBlockStyle | undefined {
  const resolved: ThemeBlockStyle = {
    ...(resolveValue(decls.color, ctx, 'color') ||
    resolveValue(decls['background-color'] ?? decls.background, ctx, 'color')
      ? {
          color: {
            ...(resolveValue(decls.color, ctx, 'color') && {
              text: resolveValue(decls.color, ctx, 'color'),
            }),
            ...(resolveValue(
              decls['background-color'] ?? decls.background,
              ctx,
              'color',
            ) && {
              background: resolveValue(
                decls['background-color'] ?? decls.background,
                ctx,
                'color',
              ),
            }),
          },
        }
      : {}),
    ...(resolveValue(decls['font-size'], ctx, 'size') ||
    resolveValue(decls['font-family'], ctx, 'font') ||
    resolveValue(decls['font-weight'], ctx, 'plain') ||
    resolveValue(decls['letter-spacing'], ctx, 'plain') ||
    resolveValue(decls['line-height'], ctx, 'plain')
      ? {
          typography: {
            ...(resolveValue(decls['font-size'], ctx, 'size') && {
              fontSize: resolveValue(decls['font-size'], ctx, 'size'),
            }),
            ...(resolveValue(decls['font-family'], ctx, 'font') && {
              fontFamily: resolveValue(decls['font-family'], ctx, 'font'),
            }),
            ...(resolveValue(decls['font-weight'], ctx, 'plain') && {
              fontWeight: resolveValue(decls['font-weight'], ctx, 'plain'),
            }),
            ...(resolveValue(decls['letter-spacing'], ctx, 'plain') && {
              letterSpacing: resolveValue(
                decls['letter-spacing'],
                ctx,
                'plain',
              ),
            }),
            ...(resolveValue(decls['line-height'], ctx, 'plain') && {
              lineHeight: resolveValue(decls['line-height'], ctx, 'plain'),
            }),
          },
        }
      : {}),
    ...(resolveValue(decls['border-radius'], ctx, 'size') ||
    resolveValue(decls['border-width'], ctx, 'size') ||
    resolveValue(decls['border-style'], ctx, 'plain') ||
    resolveValue(decls['border-color'], ctx, 'color')
      ? {
          border: {
            ...(resolveValue(decls['border-radius'], ctx, 'size') && {
              radius: resolveValue(decls['border-radius'], ctx, 'size'),
            }),
            ...(resolveValue(decls['border-width'], ctx, 'size') && {
              width: resolveValue(decls['border-width'], ctx, 'size'),
            }),
            ...(resolveValue(decls['border-style'], ctx, 'plain') && {
              style: resolveValue(decls['border-style'], ctx, 'plain'),
            }),
            ...(resolveValue(decls['border-color'], ctx, 'color') && {
              color: resolveValue(decls['border-color'], ctx, 'color'),
            }),
          },
        }
      : {}),
    ...(normalizePadding(decls.padding, ctx) ||
    normalizePadding(decls.margin, ctx) ||
    resolveValue(
      decls.gap ?? decls['column-gap'] ?? decls['row-gap'],
      ctx,
      'size',
    )
      ? {
          spacing: {
            ...(normalizePadding(decls.padding, ctx) && {
              padding: normalizePadding(decls.padding, ctx),
            }),
            ...(normalizePadding(decls.margin, ctx) && {
              margin: normalizePadding(decls.margin, ctx),
            }),
            ...(resolveValue(
              decls.gap ?? decls['column-gap'] ?? decls['row-gap'],
              ctx,
              'size',
            ) && {
              gap: resolveValue(
                decls.gap ?? decls['column-gap'] ?? decls['row-gap'],
                ctx,
                'size',
              ),
            }),
          },
        }
      : {}),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function pickDecls(
  rules: CssRule[],
  patterns: RegExp[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (
      !rule.selectors.some((selector) =>
        patterns.some((pattern) => pattern.test(selector)),
      )
    ) {
      continue;
    }
    Object.assign(out, rule.declarations);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveValue(
  value: string | undefined,
  ctx: ResolveContext,
  kind: 'color' | 'font' | 'size' | 'plain',
): string | undefined {
  const resolved = resolveRaw(value, ctx);
  if (!resolved) return undefined;
  if (kind === 'color') return isColor(resolved) ? resolved : undefined;
  if (kind === 'font') return isFontFamily(resolved) ? resolved : undefined;
  if (kind === 'size') return isSize(resolved) ? resolved : undefined;
  return resolved;
}

function resolveRaw(
  value: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const colorVar =
    trimmed.match(/var\(--wp--preset--color--([^)]+)\)/) ??
    trimmed.match(/var:preset\|color\|([^|)\s]+)/);
  if (colorVar) return ctx.colors.find((c) => c.slug === colorVar[1])?.value;

  const fontVar =
    trimmed.match(/var\(--wp--preset--font-family--([^)]+)\)/) ??
    trimmed.match(/var:preset\|font-family\|([^|)\s]+)/);
  if (fontVar) return ctx.fonts.find((f) => f.slug === fontVar[1])?.family;

  const fontSizeVar =
    trimmed.match(/var\(--wp--preset--font-size--([^)]+)\)/) ??
    trimmed.match(/var:preset\|font-size\|([^|)\s]+)/);
  if (fontSizeVar)
    return ctx.fontSizes.find((s) => s.slug === fontSizeVar[1])?.size;

  const spacingVar =
    trimmed.match(/var\(--wp--preset--spacing--([^)]+)\)/) ??
    trimmed.match(/var:preset\|spacing\|([^|)\s]+)/);
  if (spacingVar)
    return ctx.spacing.find((s) => s.slug === spacingVar[1])?.size;

  const genericVar = trimmed.match(/^var\((--[^,\s)]+)(?:,\s*([^)]+))?\)$/);
  if (genericVar) {
    return ctx.vars.get(genericVar[1])?.trim() ?? genericVar[2]?.trim();
  }

  return trimmed;
}

function normalizePadding(
  value: string | undefined,
  ctx: ResolveContext,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .split(/\s+/)
    .map((part) => resolveRaw(part, ctx) ?? part)
    .join(' ')
    .trim();
}

function buildBridgeRootDeclarations(
  vars: Map<string, string>,
): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const [name, value] of vars.entries()) {
    if (!name.startsWith('--')) continue;
    declarations[name] = value.trim();
  }
  return declarations;
}

function buildDerivedBridgeRules(tokens: ThemeTokens): CssRule[] {
  const rules: CssRule[] = [];
  const d = tokens.defaults;
  if (!d) {
    rules.push(...buildBlockStyleBridgeRules(tokens.blockStyles));
    return rules;
  }

  const bodyDecls: Record<string, string> = {};
  if (d.bgColor) bodyDecls['background-color'] = d.bgColor;
  if (d.textColor) bodyDecls.color = d.textColor;
  if (d.fontFamily) bodyDecls['font-family'] = d.fontFamily;
  if (d.fontSize) bodyDecls['font-size'] = d.fontSize;
  if (d.lineHeight) bodyDecls['line-height'] = d.lineHeight;
  if (Object.keys(bodyDecls).length > 0) {
    rules.push({ selectors: ['body'], declarations: bodyDecls });
  }

  const headingDecls: Record<string, string> = {};
  if (d.headingFontFamily) headingDecls['font-family'] = d.headingFontFamily;
  if (d.headingColor) headingDecls.color = d.headingColor;
  if (Object.keys(headingDecls).length > 0) {
    rules.push({
      selectors: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      declarations: headingDecls,
    });
  }

  if (d.headings) {
    for (const [level, style] of Object.entries(d.headings)) {
      const declarations: Record<string, string> = {};
      if (style.fontSize) declarations['font-size'] = style.fontSize;
      if (style.fontWeight) declarations['font-weight'] = style.fontWeight;
      if (Object.keys(declarations).length > 0) {
        rules.push({ selectors: [level], declarations });
      }
    }
  }

  if (d.linkColor) {
    rules.push({
      selectors: ['a', 'a:visited'],
      declarations: { color: d.linkColor },
    });
  }

  if (d.captionColor) {
    rules.push({
      selectors: [
        'figcaption',
        '.wp-caption-text',
        '.gallery-caption',
        '.blocks-gallery-caption',
      ],
      declarations: { color: d.captionColor },
    });
  }

  if (d.blockGap) {
    rules.push({
      selectors: ['.is-layout-flex', '.wp-block-buttons', '.wp-block-columns'],
      declarations: { gap: d.blockGap },
    });
  }

  if (d.rootPadding) {
    rules.push({
      selectors: ['.wp-site-blocks', '.site-content', '.site-main', 'main'],
      declarations: { padding: d.rootPadding },
    });
  }

  if (d.wideWidth) {
    rules.push({
      selectors: ['.alignwide'],
      declarations: {
        'max-width': d.wideWidth,
        'margin-left': 'auto',
        'margin-right': 'auto',
      },
    });
  }

  if (d.contentWidth) {
    rules.push({
      selectors: ['.entry-content', '.site-content', '.site-main', 'main'],
      declarations: {
        'max-width': d.contentWidth,
        'margin-left': 'auto',
        'margin-right': 'auto',
      },
    });
  }

  rules.push(...buildBlockStyleBridgeRules(tokens.blockStyles));
  return rules;
}

function buildBlockStyleBridgeRules(
  blockStyles?: Record<string, ThemeBlockStyle>,
): CssRule[] {
  if (!blockStyles) return [];

  const selectorMap: Record<string, string[]> = {
    button: [
      '.wp-block-button__link',
      '.wp-element-button',
      'button',
      'input[type="submit"]',
      'input[type="button"]',
    ],
    image: ['.wp-block-image img', '.wp-block-post-featured-image img'],
    gallery: [
      '.wp-block-gallery',
      '.wp-block-gallery img',
      '.blocks-gallery-grid',
    ],
    group: ['.wp-block-group', '.wp-block-group__inner-container'],
    column: ['.wp-block-column'],
    cover: ['.wp-block-cover', '.wp-block-cover__inner-container'],
    quote: ['.wp-block-quote', 'blockquote'],
    table: ['.wp-block-table table', 'table'],
  };

  const rules: CssRule[] = [];
  for (const [blockType, style] of Object.entries(blockStyles)) {
    const selectors = selectorMap[blockType];
    if (!selectors?.length) continue;

    const declarations: Record<string, string> = {};
    if (style.color?.text) declarations.color = style.color.text;
    if (style.color?.background)
      declarations['background-color'] = style.color.background;
    if (style.typography?.fontSize)
      declarations['font-size'] = style.typography.fontSize;
    if (style.typography?.fontFamily)
      declarations['font-family'] = style.typography.fontFamily;
    if (style.typography?.fontWeight)
      declarations['font-weight'] = style.typography.fontWeight;
    if (style.typography?.letterSpacing)
      declarations['letter-spacing'] = style.typography.letterSpacing;
    if (style.typography?.lineHeight)
      declarations['line-height'] = style.typography.lineHeight;
    if (style.border?.radius)
      declarations['border-radius'] = style.border.radius;
    if (style.border?.width) declarations['border-width'] = style.border.width;
    if (style.border?.style) declarations['border-style'] = style.border.style;
    if (style.border?.color) declarations['border-color'] = style.border.color;
    if (style.spacing?.padding) declarations.padding = style.spacing.padding;
    if (style.spacing?.margin) declarations.margin = style.spacing.margin;
    if (style.spacing?.gap) declarations.gap = style.spacing.gap;

    if (Object.keys(declarations).length > 0) {
      rules.push({ selectors, declarations });
    }
  }

  return rules;
}

function buildSafeThemeBridgeRules(
  rules: CssRule[],
  ctx: ResolveContext,
): CssRule[] {
  const bridgeRules: CssRule[] = [];
  for (const rule of rules) {
    const selectors = rule.selectors.filter((selector) =>
      isSafeBridgeSelector(selector),
    );
    if (selectors.length === 0) continue;

    const declarations = pickBridgeDeclarations(rule.declarations, ctx);
    if (Object.keys(declarations).length === 0) continue;

    bridgeRules.push({ selectors, declarations });
  }
  return bridgeRules;
}

function isSafeBridgeSelector(selector: string): boolean {
  const normalized = selector.trim();
  if (!normalized) return false;
  if (/#/.test(normalized)) return false;
  if (
    /\b(admin|customize|woocommerce|elementor|jetpack|tribe-|slick-|swiper-)/i.test(
      normalized,
    )
  ) {
    return false;
  }

  if (
    /(^|[\s>+~])(html|body|:root|main|article|section|figure|figcaption|blockquote|hr|pre|code|table|thead|tbody|tr|th|td|ul|ol|li|p|a|img|button|input|textarea|select|label|form|h[1-6])(?=$|[\s.#:[>+~])/i.test(
      normalized,
    )
  ) {
    return true;
  }

  return /(\.wp-block-|\bwp-element-button\b|\.wp-caption|\.gallery-caption|\.blocks-gallery-caption|\.align(?:wide|full|left|right|center)\b|\.has-[\w-]+\b|\.is-layout-[\w-]+\b|\.wp-site-blocks\b|\.site-main\b|\.site-content\b|\.entry-content\b|\.screen-reader-text\b)/i.test(
    normalized,
  );
}

function pickBridgeDeclarations(
  declarations: Record<string, string>,
  ctx: ResolveContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [prop, value] of Object.entries(declarations)) {
    if (!isAllowedBridgeDeclaration(prop, value)) continue;
    out[prop] = resolveDeclarationValue(value, ctx) ?? value.trim();
  }
  return out;
}

function isAllowedBridgeDeclaration(prop: string, value: string): boolean {
  if (!value.trim() || /url\(/i.test(value)) return false;
  if (/^content$/i.test(prop)) return false;
  return /^(--|color|background(?:-color|-image|-position|-repeat|-size)?|font(?:-family|-size|-weight|-style)?|line-height|letter-spacing|text-(?:align|transform|decoration)|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap|display|flex(?:-(?:direction|wrap|grow|shrink|basis))?|grid(?:-(?:template-columns|template-rows|auto-flow|column|row))?|justify-(?:content|items|self)|align-(?:content|items|self)|place-(?:content|items|self)|width|min-width|max-width|height|min-height|max-height|border(?:-(?:radius|width|style|color))?|box-shadow|object-(?:fit|position)|aspect-ratio|overflow(?:-[xy])?|list-style(?:-(?:type|position))?|white-space|word-break|clip|clip-path|position|top|right|bottom|left|opacity)$/i.test(
    prop,
  );
}

function resolveDeclarationValue(
  value: string,
  ctx: ResolveContext,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(
    /var\((--[^,\s)]+)(?:,\s*([^)]+))?\)/g,
    (_match, varName: string, fallback?: string) =>
      ctx.vars.get(varName)?.trim() ?? fallback?.trim() ?? `var(${varName})`,
  );
}

function renderCssRule(rule: CssRule): string {
  const selectors = rule.selectors
    .map((selector) => selector.trim())
    .filter(Boolean);
  const declarations = Object.entries(rule.declarations)
    .map(([prop, value]) => `${prop}: ${value};`)
    .join(' ');
  if (selectors.length === 0 || !declarations) return '';
  return `${selectors.join(', ')} { ${declarations} }`;
}

function mergeThemeDefaults(
  base?: ThemeDefaults,
  extra?: ThemeDefaults,
): ThemeDefaults | undefined {
  if (!base && !extra) return undefined;
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    headings: {
      ...(base?.headings ?? {}),
      ...(extra?.headings ?? {}),
    },
  };
}

function mergeThemeBlockStyles(
  base?: Record<string, ThemeBlockStyle>,
  extra?: Record<string, ThemeBlockStyle>,
): Record<string, ThemeBlockStyle> | undefined {
  if (!base && !extra) return undefined;

  const result: Record<string, ThemeBlockStyle> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extra ?? {})) {
    result[key] = {
      ...(result[key] ?? {}),
      ...value,
      color: {
        ...(result[key]?.color ?? {}),
        ...(value.color ?? {}),
      },
      typography: {
        ...(result[key]?.typography ?? {}),
        ...(value.typography ?? {}),
      },
      border: {
        ...(result[key]?.border ?? {}),
        ...(value.border ?? {}),
      },
      spacing: {
        ...(result[key]?.spacing ?? {}),
        ...(value.spacing ?? {}),
      },
    };
  }

  return result;
}

function mergeBySlug<T extends { slug: string }>(base: T[], extra: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of base) map.set(item.slug, item);
  for (const item of extra) if (!map.has(item.slug)) map.set(item.slug, item);
  return [...map.values()];
}

function dedupeBySlug<T extends { slug: string }>(items: T[]): T[] {
  return mergeBySlug([], items);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/^--/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    /^#([0-9a-f]{3,8})$/i.test(v) ||
    /^rgba?\(/.test(v) ||
    /^hsla?\(/.test(v) ||
    /^(transparent|currentcolor|inherit|white|black)$/.test(v)
  );
}

function isFontFamily(value: string): boolean {
  const v = value.trim();
  return Boolean(v) && (v.includes(',') || v.includes('"') || v.includes("'"));
}

function isSize(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    /^-?\d*\.?\d+(px|rem|em|vh|vw|svh|svw|dvh|dvw|%|fr|ch)$/.test(v) ||
    /^\d+(\.\d+)?$/.test(v) ||
    /^calc\(.+\)$/.test(v) ||
    /^clamp\(.+\)$/.test(v) ||
    /^min\(.+\)$/.test(v) ||
    /^max\(.+\)$/.test(v)
  );
}
