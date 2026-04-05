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
  for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
    const decls = pickDecls(rules, [new RegExp(`^${level}$`, 'i')]);
    const fontSize = resolveValue(decls?.['font-size'], ctx, 'size');
    const fontWeight = resolveValue(decls?.['font-weight'], ctx, 'plain');
    const color = resolveValue(decls?.color, ctx, 'color');
    if (!headingColor && color) headingColor = color;
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
    ...(Object.keys(headings).length > 0 && { headings }),
  };

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function extractBlockStyles(
  rules: CssRule[],
  ctx: ResolveContext,
): Record<string, ThemeBlockStyle> | undefined {
  const button = pickDecls(rules, [
    /^button$/i,
    /^button(?::[\w-]+)?$/i,
    /^\.button$/i,
    /^\.btn$/i,
    /^input\[type=['"]?(submit|button)['"]?\]$/i,
    /^\.wp-block-button__link$/i,
  ]);

  if (!button) return undefined;

  const resolved: ThemeBlockStyle = {
    ...(resolveValue(button.color, ctx, 'color') ||
    resolveValue(button['background-color'] ?? button.background, ctx, 'color')
      ? {
          color: {
            ...(resolveValue(button.color, ctx, 'color') && {
              text: resolveValue(button.color, ctx, 'color'),
            }),
            ...(resolveValue(
              button['background-color'] ?? button.background,
              ctx,
              'color',
            ) && {
              background: resolveValue(
                button['background-color'] ?? button.background,
                ctx,
                'color',
              ),
            }),
          },
        }
      : {}),
    ...(resolveValue(button['border-radius'], ctx, 'size')
      ? {
          border: {
            radius: resolveValue(button['border-radius'], ctx, 'size'),
          },
        }
      : {}),
    ...(normalizePadding(button.padding, ctx) ||
    normalizePadding(button.margin, ctx)
      ? {
          spacing: {
            ...(normalizePadding(button.padding, ctx) && {
              padding: normalizePadding(button.padding, ctx),
            }),
            ...(normalizePadding(button.margin, ctx) && {
              margin: normalizePadding(button.margin, ctx),
            }),
          },
        }
      : {}),
    ...(resolveValue(button['font-size'], ctx, 'size') ||
    resolveValue(button['font-family'], ctx, 'font') ||
    resolveValue(button['font-weight'], ctx, 'plain') ||
    resolveValue(button['letter-spacing'], ctx, 'plain') ||
    resolveValue(button['line-height'], ctx, 'plain')
      ? {
          typography: {
            ...(resolveValue(button['font-size'], ctx, 'size') && {
              fontSize: resolveValue(button['font-size'], ctx, 'size'),
            }),
            ...(resolveValue(button['font-family'], ctx, 'font') && {
              fontFamily: resolveValue(button['font-family'], ctx, 'font'),
            }),
            ...(resolveValue(button['font-weight'], ctx, 'plain') && {
              fontWeight: resolveValue(button['font-weight'], ctx, 'plain'),
            }),
            ...(resolveValue(button['letter-spacing'], ctx, 'plain') && {
              letterSpacing: resolveValue(
                button['letter-spacing'],
                ctx,
                'plain',
              ),
            }),
            ...(resolveValue(button['line-height'], ctx, 'plain') && {
              lineHeight: resolveValue(button['line-height'], ctx, 'plain'),
            }),
          },
        }
      : {}),
  };

  return Object.keys(resolved).length > 0 ? { button: resolved } : undefined;
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
