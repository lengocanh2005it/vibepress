import type {
  ThemeBlockStyle,
  ThemeDefaults,
  ThemeInteractionTarget,
  ThemePreciseInteractionBridge,
  ThemeInteractionState,
  ThemeInteractionTokens,
  ThemeTokens,
} from '../../modules/agents/block-parser/block-parser.service.js';

export interface StyleTokenExtractionResult {
  colors: ThemeTokens['colors'];
  gradients: NonNullable<ThemeTokens['gradients']>;
  shadows: NonNullable<ThemeTokens['shadows']>;
  fonts: ThemeTokens['fonts'];
  fontSizes: ThemeTokens['fontSizes'];
  spacing: ThemeTokens['spacing'];
  defaults?: ThemeDefaults;
  blockStyles?: Record<string, ThemeBlockStyle>;
  interactions?: ThemeInteractionTokens;
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
    return {
      colors: [],
      gradients: [],
      shadows: [],
      fonts: [],
      fontSizes: [],
      spacing: [],
    };
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
    gradients: inferred.gradients,
    shadows: inferred.shadows,
    fonts: inferred.fonts,
    fontSizes: inferred.fontSizes,
    spacing: inferred.spacing,
    defaults: extractDefaults(rules, ctx),
    blockStyles: extractBlockStyles(rules, ctx),
    interactions: extractInteractionTokens(rules, ctx),
  };
}

export function buildStyleCssBridge(
  styleCss: string | undefined,
  baseTokens?: Partial<ThemeTokens>,
): string {
  const extracted = extractStyleCssTokens(styleCss, baseTokens);
  const tokens: ThemeTokens = {
    colors: mergeBySlug(baseTokens?.colors ?? [], extracted.colors),
    gradients: mergeBySlug(baseTokens?.gradients ?? [], extracted.gradients),
    shadows: mergeBySlug(baseTokens?.shadows ?? [], extracted.shadows),
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
  const gradients: NonNullable<ThemeTokens['gradients']> = [];
  const shadows: NonNullable<ThemeTokens['shadows']> = [];
  const fonts: ThemeTokens['fonts'] = [];
  const fontSizes: ThemeTokens['fontSizes'] = [];
  const spacing: ThemeTokens['spacing'] = [];

  for (const [name, value] of vars.entries()) {
    const slug = slugify(name);
    if (!slug) continue;

    if (isGradient(value)) {
      gradients.push({ slug, value: value.trim() });
      continue;
    }

    if (isShadow(value)) {
      shadows.push({ slug, value: value.trim() });
      continue;
    }

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
    gradients: dedupeBySlug(gradients),
    shadows: dedupeBySlug(shadows),
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
    ...(resolveValue(body?.['letter-spacing'], ctx, 'plain') && {
      letterSpacing: resolveValue(body?.['letter-spacing'], ctx, 'plain'),
    }),
    ...(resolveValue(body?.['text-transform'], ctx, 'plain') && {
      textTransform: resolveValue(body?.['text-transform'], ctx, 'plain'),
    }),
    ...(resolveValue(button?.['box-shadow'], ctx, 'plain') && {
      buttonBoxShadow: resolveValue(button?.['box-shadow'], ctx, 'plain'),
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

function extractInteractionTokens(
  rules: CssRule[],
  ctx: ResolveContext,
): ThemeInteractionTokens | undefined {
  const interactions: ThemeInteractionTokens = {};

  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const target = classifyInteractionTarget(selector);
      if (target !== 'button') continue;

      const state = classifyInteractionState(selector);
      const declarations = pickInteractionDeclarations(rule.declarations, ctx);
      if (Object.keys(declarations).length === 0) continue;

      interactions.button ??= {};
      interactions.button[state] = mergeInteractionState(
        interactions.button[state],
        declarations,
      );
    }
  }

  const precise = extractPreciseInteractionBridges(rules, ctx);
  if (precise?.length) interactions.precise = precise;

  return interactions.button || interactions.precise?.length
    ? interactions
    : undefined;
}

function extractPreciseInteractionBridges(
  rules: CssRule[],
  ctx: ResolveContext,
): ThemePreciseInteractionBridge[] | undefined {
  const bridges = new Map<string, ThemePreciseInteractionBridge>();

  const upsert = (
    className: string,
    target: ThemeInteractionTarget,
    state: keyof ThemeInteractionStyleStateMap,
    declarations: ThemeInteractionState,
  ) => {
    const key = `${target}::${className}`;
    const existing = bridges.get(key) ?? { className, target };
    bridges.set(key, {
      ...existing,
      [state]: mergeInteractionState(existing[state], declarations),
    });
  };

  for (const rule of rules) {
    const declarations = pickInteractionDeclarations(rule.declarations, ctx);
    if (Object.keys(declarations).length === 0) continue;

    for (const selector of rule.selectors) {
      const target = classifyPreciseInteractionTarget(selector);
      if (!target) continue;
      const state = classifyInteractionState(selector);
      const classes = extractPreciseCustomClasses(selector, target);
      for (const className of classes) {
        upsert(className, target, state, declarations);
      }
    }
  }

  const values = Array.from(bridges.values()).filter(
    (bridge) =>
      hasInteractionStateValues(bridge.base) ||
      hasInteractionStateValues(bridge.hover) ||
      hasInteractionStateValues(bridge.focus) ||
      hasInteractionStateValues(bridge.active),
  );

  return values.length > 0
    ? values.sort(
        (a, b) =>
          a.className.localeCompare(b.className) ||
          a.target.localeCompare(b.target),
      )
    : undefined;
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
    resolveValue(decls['line-height'], ctx, 'plain') ||
    resolveValue(decls['text-transform'], ctx, 'plain')
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
            ...(resolveValue(decls['text-transform'], ctx, 'plain') && {
              textTransform: resolveValue(
                decls['text-transform'],
                ctx,
                'plain',
              ),
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
    ...(resolveValue(decls['box-shadow'], ctx, 'plain') && {
      shadow: resolveValue(decls['box-shadow'], ctx, 'plain'),
    }),
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

function classifyInteractionTarget(selector: string): 'button' | null {
  const normalized = selector.trim();
  if (!normalized) return null;
  if (
    /\b(admin|customize|wp-admin|woocommerce|elementor|tribe-|slick-|swiper-)\b/i.test(
      normalized,
    )
  ) {
    return null;
  }

  return /(\.wp-block-button\b|\.wp-block-button__link\b|\.wp-element-button\b|(^|[\s>+~])button\b|input\[type=['"]?(submit|button)['"]?\]|\.(button|btn)\b)/i.test(
    normalized,
  )
    ? 'button'
    : null;
}

type ThemeInteractionStyleStateMap = {
  base?: ThemeInteractionState;
  hover?: ThemeInteractionState;
  focus?: ThemeInteractionState;
  active?: ThemeInteractionState;
};

function classifyPreciseInteractionTarget(
  selector: string,
): ThemeInteractionTarget | null {
  const normalized = selector.trim();
  if (!normalized) return null;
  if (
    /\b(admin|customize|wp-admin|woocommerce|elementor|tribe-|slick-|swiper-)\b/i.test(
      normalized,
    )
  ) {
    return null;
  }
  if (classifyInteractionTarget(normalized) === 'button') return 'button';
  if (
    /(^|[\s>+~])img\b|\.wp-block-image\b|\.wp-block-post-featured-image\b|\.blocks-gallery-item\b/i.test(
      normalized,
    )
  ) {
    return 'image';
  }
  if (
    /(^|[\s>+~])a\b|\.wp-block-navigation-link\b|\.wp-block-post-title\b|\.wp-block-read-more\b|\.wp-block-site-title\b/i.test(
      normalized,
    )
  ) {
    return 'link';
  }
  if (
    /(^|[\s>+~])(article|figure|section|div)\b|\.wp-block-group\b|\.wp-block-cover\b|\.wp-block-column\b|\.wp-block-media-text\b|\.wp-block-post\b|\.wp-block-query\b/i.test(
      normalized,
    )
  ) {
    return 'card';
  }
  return null;
}

function extractPreciseCustomClasses(
  selector: string,
  target: ThemeInteractionTarget,
): string[] {
  const matches = selector.match(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g) ?? [];
  const classes = matches
    .map((token) => token.slice(1))
    .filter((className) => isPreciseClassCandidate(className))
    .filter((className) =>
      selectorSupportsPreciseClassTarget(selector, className, target),
    );
  return Array.from(new Set(classes));
}

function isPreciseClassCandidate(className: string): boolean {
  const normalized = className.trim().toLowerCase();
  if (!normalized) return false;
  if (!normalized.includes('-') && !normalized.includes('__')) return false;
  return !/^(wp-|has-|align|is-layout-|current-|menu-item|page-item|post-|blocks-gallery|size-|components-|editor-|screen-reader-text$)/i.test(
    normalized,
  );
}

function selectorSupportsPreciseClassTarget(
  selector: string,
  className: string,
  target: ThemeInteractionTarget,
): boolean {
  const escaped = escapeRegex(className);
  const segmentPattern = new RegExp(`[^>+~\\s]*\\.${escaped}[^>+~\\s]*`, 'i');
  const segmentMatch = selector.match(segmentPattern);
  const segment = segmentMatch?.[0] ?? '';
  if (!segment) return false;

  if (target === 'button') {
    return /wp-block-button|wp-block-button__link|wp-element-button|button\b|(^|[^a-z])a\b/i.test(
      selector,
    );
  }
  if (target === 'image') {
    return /img\b|wp-block-image|wp-block-post-featured-image|blocks-gallery-item/i.test(
      selector,
    );
  }
  if (target === 'link') {
    return /(^|[^a-z])a\b|wp-block-navigation-link|wp-block-post-title|wp-block-read-more|wp-block-site-title/i.test(
      selector,
    );
  }
  return (
    /:hover|:focus|:active/i.test(segment) ||
    /wp-block-group|wp-block-cover|wp-block-column|wp-block-media-text|wp-block-post|(^|[^a-z])(article|figure|section|div)\b/i.test(
      selector,
    )
  );
}

function classifyInteractionState(
  selector: string,
): keyof NonNullable<ThemeInteractionTokens['button']> {
  if (/:hover\b/i.test(selector)) return 'hover';
  if (/:focus-visible\b/i.test(selector) || /:focus\b/i.test(selector)) {
    return 'focus';
  }
  if (/:active\b/i.test(selector)) return 'active';
  return 'base';
}

function pickInteractionDeclarations(
  declarations: Record<string, string>,
  ctx: ResolveContext,
): ThemeInteractionState {
  const interaction: ThemeInteractionState = {};
  const mapProp = (
    key: keyof ThemeInteractionState,
    prop: string,
    kind: 'color' | 'plain',
  ) => {
    const resolved =
      kind === 'color'
        ? resolveValue(declarations[prop], ctx, 'color')
        : resolveDeclarationValue(declarations[prop] ?? '', ctx);
    if (resolved) interaction[key] = resolved;
  };

  mapProp('transition', 'transition', 'plain');
  mapProp('transform', 'transform', 'plain');
  mapProp('boxShadow', 'box-shadow', 'plain');
  mapProp('opacity', 'opacity', 'plain');
  mapProp('color', 'color', 'color');
  mapProp('backgroundColor', 'background-color', 'color');
  mapProp('textDecoration', 'text-decoration', 'plain');
  if (!interaction.backgroundColor) {
    mapProp('backgroundColor', 'background', 'color');
  }

  return interaction;
}

function mergeInteractionState(
  base: ThemeInteractionState | undefined,
  extra: ThemeInteractionState,
): ThemeInteractionState {
  return {
    ...(base ?? {}),
    ...extra,
  };
}

function hasInteractionStateValues(state?: ThemeInteractionState): boolean {
  return !!state && Object.keys(state).length > 0;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  if (d.letterSpacing) bodyDecls['letter-spacing'] = d.letterSpacing;
  if (d.textTransform) bodyDecls['text-transform'] = d.textTransform;
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

  if (d.buttonBoxShadow) {
    rules.push({
      selectors: [
        '.wp-block-button__link',
        '.wp-element-button',
        'button',
        'input[type="submit"]',
        'input[type="button"]',
      ],
      declarations: { 'box-shadow': d.buttonBoxShadow },
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
    if (style.typography?.textTransform)
      declarations['text-transform'] = style.typography.textTransform;
    if (style.shadow) declarations['box-shadow'] = style.shadow;
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

function isGradient(value: string): boolean {
  return /^(linear|radial|conic)-gradient\(/i.test(value.trim());
}

function isShadow(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'none') return false;
  // box-shadow: <offset-x> <offset-y> [blur] [spread] [color] [, ...]
  // Must have at least two length values (px/rem/em/0) and optionally a color
  return /^(?:inset\s+)?-?\d[\d.]*(?:px|rem|em)?\s+-?\d[\d.]*(?:px|rem|em)?(\s+-?\d[\d.]*(?:px|rem|em)?)*(\s+(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\(|[a-z]+))?/.test(
    v,
  );
}
