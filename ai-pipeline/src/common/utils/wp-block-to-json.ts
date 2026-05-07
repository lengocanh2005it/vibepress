import { buildSourceNodeId, type SourceRef } from './source-node-id.util.js';
import { canonicalizeThemeAssetReference } from './theme-asset.util.js';

/**
 * Converts WordPress block markup into a compact JSON tree.
 * This replaces passing raw HTML to the AI — instead AI receives structured data
 * so it cannot fabricate content (all text/images/links are pre-extracted).
 */

export interface WpNode {
  block: string;
  sourceRef?: SourceRef;
  params?: Record<string, any>;
  customClassNames?: string[];
  domId?: string;
  // Extracted content from inner HTML
  text?: string;
  level?: number; // headings: 1-6
  src?: string; // images / cover background
  alt?: string;
  width?: number; // images
  height?: number; // images
  href?: string; // links / buttons
  html?: string; // raw inner HTML for complex blocks (prose content)
  // Styling hints extracted from params
  bgColor?: string; // slug or hex — from params.backgroundColor or params.style.color.background
  textColor?: string; // slug or hex — from params.textColor or params.style.color.text
  borderRadius?: string; // from params.style.border.radius
  borderWidth?: string; // from params.style.border.width
  borderColor?: string; // from params.borderColor or params.style.border.color
  gap?: string; // from params.style.spacing.blockGap or params.gap — normalized CSS gap value
  padding?: { top?: string; right?: string; bottom?: string; left?: string }; // from params.style.spacing.padding
  margin?: { top?: string; right?: string; bottom?: string; left?: string }; // from params.style.spacing.margin
  minHeight?: string; // from params.minHeight (cover/group blocks)
  hasParallax?: boolean; // cover block parallax scroll (background-attachment: fixed)
  focalPoint?: { x: number; y: number }; // cover block focal point for background-position
  overlayColor?: string; // cover block overlay color hex (pre-resolved)
  columnWidth?: string; // wp:column percentage width (e.g. "33.33%")
  textAlign?: string; // from params.textAlign
  justifyContent?: string; // normalized horizontal layout intent from params.layout.justifyContent / rendered classes
  align?: string; // "full" | "wide" | "center" — section width hint
  menuOrientation?: 'horizontal' | 'vertical'; // navigation layout orientation
  overlayMenu?: 'always' | 'mobile' | 'never'; // core/navigation responsive overlay intent
  isResponsive?: boolean; // core/navigation responsive toggle enabled
  fontFamily?: string; // slug from params.fontFamily
  // Inline typography from params.style.typography
  typography?: {
    letterSpacing?: string;
    textTransform?: string;
    lineHeight?: string;
    fontSize?: string;
    fontWeight?: string;
    fontFamily?: string;
  };
  children?: WpNode[];
}

/**
 * Entry point: parse full template markup into a JSON array of WpNode.
 */
export function wpBlocksToJson(markup: string): WpNode[] {
  return parseBlocks(normalizeWordPressPhpMarkup(markup).trim());
}

export function wpBlocksToJsonWithSourceRefs(input: {
  markup: string;
  templateName: string;
  sourceFile: string;
}): WpNode[] {
  const nodes = parseBlocks(normalizeWordPressPhpMarkup(input.markup).trim());
  return annotateSourceRefs(nodes, {
    templateName: input.templateName,
    sourceFile: input.sourceFile,
  });
}

export function ensureWpNodesHaveSourceRefs(input: {
  nodes: WpNode[];
  templateName: string;
  sourceFile: string;
}): WpNode[] {
  return annotateSourceRefs(input.nodes, {
    templateName: input.templateName,
    sourceFile: input.sourceFile,
  });
}

/**
 * Serialize the JSON tree to a compact string for the AI prompt.
 * Strips `params` (already processed into top-level fields) to reduce token count.
 */
export function wpJsonToString(nodes: WpNode[]): string {
  return JSON.stringify(stripParams(nodes));
}

export function normalizeWordPressPhpMarkup(raw: string): string {
  return String(raw ?? '')
    .replace(/<\?php\s*\/\*\*[\s\S]*?\*\/\s*\?>/g, '')
    .replace(
      /<\?php\s+(?:echo\s+)?esc_html_x\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1[\s\S]*?\?>/g,
      '$2',
    )
    .replace(
      /<\?php\s+(?:echo\s+)?(?:esc_html__|esc_attr__|esc_html_e|esc_attr_e|esc_html|esc_attr|__|_e)\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1[\s\S]*?\?>/g,
      '$2',
    )
    .replace(
      /esc_html_x\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,[\s\S]*?\)/g,
      '$2',
    )
    .replace(
      /esc_html__\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,[\s\S]*?\)/g,
      '$2',
    )
    .replace(
      /esc_attr__\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,[\s\S]*?\)/g,
      '$2',
    )
    .replace(
      /esc_attr_e\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*,[\s\S]*?\)/g,
      '$2',
    )
    .replace(
      /<\?php\s+echo\s+(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*;\s*\?>/g,
      '$2',
    )
    .replace(/<\?php[\s\S]*?\?>/g, '')
    .replace(/<\?php[^>]*$/gm, '')
    .replace(/\\(['"`])/g, '$1');
}

const BASE_USEFUL_PARAM_KEYS = new Set([
  'align', // "full" | "wide" | "center" — section width
  'className', // preserve Gutenberg/custom classes for precise interaction bridge
  'layout', // { type: "flex", justifyContent, orientation, ... }
  'fontSize', // text size slug
  'textAlign', // text alignment
  'dimRatio', // cover block overlay opacity
  'contentPosition', // cover block content position
  'isStackedOnMobile', // columns stacking behaviour
  'overlayMenu', // navigation overlay mode
  'overlayBackgroundColor', // navigation responsive overlay background color slug
  'overlayTextColor', // navigation responsive overlay text color slug
  'icon', // navigation responsive button icon intent, e.g. "menu"
  'isResponsive', // navigation responsive collapse behaviour
  'openSubmenusOnClick', // navigation interaction hint
  'verticalAlignment', // column vertical align
  'gradient', // gradient background slug
  'metadata', // block metadata — carries { name: "Testimonial" } labels used for section detection
]);

function pruneParams(
  blockName: string,
  params: Record<string, any>,
): Record<string, any> | undefined {
  const allowedKeys = getUsefulParamKeysForBlock(blockName);
  const pruned = Object.fromEntries(
    Object.entries(params).filter(([k]) => allowedKeys.has(k)),
  );
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function stripParams(nodes: WpNode[]): WpNode[] {
  return nodes.map(({ params, children, ...rest }) => ({
    ...rest,
    ...(params ? { params: pruneParams(rest.block, params) } : {}),
    ...(children ? { children: stripParams(children) } : {}),
  }));
}

function getUsefulParamKeysForBlock(blockName: string): Set<string> {
  const keys = new Set(BASE_USEFUL_PARAM_KEYS);
  if (
    [
      'social-link',
      'core/social-link',
      'social-links',
      'core/social-links',
      'uagb/slider',
      'uagb/modal',
      'uagb/tabs',
      'uagb/faq',
      'uagb/tabs-child',
      'uagb/faq-child',
    ].includes(blockName)
  ) {
    for (const key of [
      'autoplay',
      'autoplaySpeed',
      'infiniteLoop',
      'transitionEffect',
      'transitionSpeed',
      'displayDots',
      'displayArrows',
      'pauseOn',
      'verticalMode',
      'btnText',
      'triggerText',
      'buttonText',
      'modalTitle',
      'modalText',
      'modalCtaText',
      'modalCtaLink',
      'modalWidth',
      'modalWidthType',
      'modalHeight',
      'modalHeightType',
      'overlayColor',
      'overlayclick',
      'escpress',
      'closeIconPosition',
      'tabActive',
      'tabActiveFrontend',
      'tabsStyleD',
      'tabAlign',
      'tabTitle',
      'inactiveOtherItems',
      'expandFirstItem',
      'enableToggle',
      'allowMultipleOpen',
      'multiOpen',
      'url',
      'service',
      'iconColor',
      'iconColorValue',
      'size',
    ]) {
      keys.add(key);
    }
  }
  return keys;
}

// ----------------------d--------------------------------------------------

function normalizeBoxSpacing(
  value: unknown,
): WpNode['padding'] | WpNode['margin'] | undefined {
  if (!value) return undefined;

  if (typeof value === 'object') {
    const box = value as Record<string, unknown>;
    return compactBoxSpacing({
      top: normalizeCssLength(box.top),
      right: normalizeCssLength(box.right),
      bottom: normalizeCssLength(box.bottom),
      left: normalizeCssLength(box.left),
    });
  }

  if (typeof value !== 'string') return undefined;

  const parts = splitCssShorthand(value);
  if (parts.length === 0) return undefined;

  if (parts.length === 1) {
    const [all] = parts;
    return { top: all, right: all, bottom: all, left: all };
  }

  if (parts.length === 2) {
    const [vertical, horizontal] = parts;
    return {
      top: vertical,
      right: horizontal,
      bottom: vertical,
      left: horizontal,
    };
  }

  if (parts.length === 3) {
    const [top, horizontal, bottom] = parts;
    return {
      top,
      right: horizontal,
      bottom,
      left: horizontal,
    };
  }

  const [top, right, bottom, left] = parts;
  return { top, right, bottom, left };
}

function normalizeCssLength(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (
    /^(auto|inherit|initial|unset|fit-content|max-content|min-content)$/i.test(
      normalized,
    )
  ) {
    return normalized.toLowerCase();
  }
  if (
    /^(calc|min|max|clamp|var)\(/i.test(normalized) ||
    normalized.includes('/')
  ) {
    return normalized;
  }
  const collapsedAuto = normalized.replace(
    /\b(auto)(?:px|r?em|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc)\b/gi,
    '$1',
  );
  const dedupedUnits = collapsedAuto.replace(
    /(-?\d*\.?\d+)(px|r?em|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc)\2\b/gi,
    '$1$2',
  );
  return /^-?\d+(\.\d+)?$/.test(dedupedUnits)
    ? `${dedupedUnits}px`
    : dedupedUnits;
}

function parseCssNumericDimension(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  if (!normalized || /^(auto|inherit|initial|unset)$/i.test(normalized)) {
    return undefined;
  }
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeBorderRadius(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string' || typeof value === 'number') {
    return normalizeCssLength(value);
  }
  if (typeof value !== 'object') return undefined;

  const radius = value as Record<string, unknown>;
  const topLeft =
    normalizeCssLength(radius.topLeft ?? radius.top ?? radius.left) ?? '0px';
  const topRight =
    normalizeCssLength(radius.topRight ?? radius.top ?? radius.right) ?? '0px';
  const bottomRight =
    normalizeCssLength(radius.bottomRight ?? radius.bottom ?? radius.right) ??
    '0px';
  const bottomLeft =
    normalizeCssLength(radius.bottomLeft ?? radius.bottom ?? radius.left) ??
    '0px';

  if (
    topLeft === topRight &&
    topLeft === bottomRight &&
    topLeft === bottomLeft
  ) {
    return topLeft;
  }
  if (topLeft === bottomRight && topRight === bottomLeft) {
    return topLeft === topRight ? topLeft : `${topLeft} ${topRight}`;
  }
  if (topRight === bottomLeft) {
    return `${topLeft} ${topRight} ${bottomRight}`;
  }
  return `${topLeft} ${topRight} ${bottomRight} ${bottomLeft}`;
}

function normalizeColorHint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (
    /^#/.test(normalized) ||
    /^(rgb|rgba|hsl|hsla|oklch|lab|lch|color|var)\(/i.test(normalized) ||
    /^(transparent|currentcolor|inherit|initial|unset)$/i.test(normalized)
  ) {
    return normalized;
  }
  if (/^[a-z0-9_-]+$/i.test(normalized)) {
    return `var(--wp--preset--color--${normalized})`;
  }
  return undefined;
}

function normalizeHorizontalAlign(
  value: unknown,
): 'left' | 'center' | 'right' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/(^|[\s:-])center(ed)?($|[\s:-])/.test(normalized)) return 'center';
  if (/(^|[\s:-])right($|[\s:-])/.test(normalized)) return 'right';
  if (/(^|[\s:-])left($|[\s:-])/.test(normalized)) return 'left';
  return undefined;
}

function normalizeOrientation(
  value: unknown,
): 'horizontal' | 'vertical' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'horizontal' || normalized === 'vertical') {
    return normalized;
  }
  return undefined;
}

function normalizeOverlayMenu(
  value: unknown,
): 'always' | 'mobile' | 'never' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'always' ||
    normalized === 'mobile' ||
    normalized === 'never'
  ) {
    return normalized;
  }
  return undefined;
}

function extractTextAlignFromClassLike(
  value: unknown,
): 'left' | 'center' | 'right' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  if (
    /\b(has-text-align-center|text-center|justify-center|items-center|content-center|is-content-justification-center)\b/i.test(
      normalized,
    )
  ) {
    return 'center';
  }
  if (
    /\b(has-text-align-right|text-right|justify-end|items-end|content-end|is-content-justification-right)\b/i.test(
      normalized,
    )
  ) {
    return 'right';
  }
  if (
    /\b(has-text-align-left|text-left|justify-start|items-start|content-start|is-content-justification-left)\b/i.test(
      normalized,
    )
  ) {
    return 'left';
  }
  return undefined;
}

function extractTextAlignFromStyle(
  value: unknown,
): 'left' | 'center' | 'right' | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/text-align\s*:\s*(left|center|right)/i);
  return normalizeHorizontalAlign(match?.[1]);
}

function extractJustifyContentFromClassLike(
  value: unknown,
): 'left' | 'center' | 'right' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  if (
    /\b(is-content-justification-center|justify-center|items-center|content-center)\b/i.test(
      normalized,
    )
  ) {
    return 'center';
  }
  if (
    /\b(is-content-justification-right|justify-end|items-end|content-end)\b/i.test(
      normalized,
    )
  ) {
    return 'right';
  }
  if (
    /\b(is-content-justification-left|justify-start|items-start|content-start)\b/i.test(
      normalized,
    )
  ) {
    return 'left';
  }
  return undefined;
}

function extractJustifyContentFromStyle(
  value: unknown,
): 'left' | 'center' | 'right' | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(
    /justify-content\s*:\s*(left|center|right|flex-start|flex-end)/i,
  );
  if (!match?.[1]) return undefined;
  if (/flex-start/i.test(match[1])) return 'left';
  if (/flex-end/i.test(match[1])) return 'right';
  return normalizeHorizontalAlign(match[1]);
}

function extractTextAlignFromMarkup(
  markup: string,
): 'left' | 'center' | 'right' | undefined {
  const fromStyle = extractTextAlignFromStyle(markup);
  if (fromStyle) return fromStyle;

  for (const match of markup.matchAll(/\bclass="([^"]+)"/gi)) {
    const fromClass = extractTextAlignFromClassLike(match[1]);
    if (fromClass) return fromClass;
  }

  return undefined;
}

function extractJustifyContentFromMarkup(
  markup: string,
): 'left' | 'center' | 'right' | undefined {
  const fromStyle = extractJustifyContentFromStyle(markup);
  if (fromStyle) return fromStyle;

  for (const match of markup.matchAll(/\bclass="([^"]+)"/gi)) {
    const fromClass = extractJustifyContentFromClassLike(match[1]);
    if (fromClass) return fromClass;
  }

  return undefined;
}

function normalizeGapValue(value: unknown): string | undefined {
  if (!value) return undefined;

  if (typeof value === 'string') {
    return normalizeCssLength(value);
  }

  if (typeof value !== 'object') return undefined;

  const gap = value as Record<string, unknown>;
  const rowGap = normalizeCssLength(
    gap.top ?? gap.row ?? gap.vertical ?? gap.y,
  );
  const columnGap = normalizeCssLength(
    gap.left ?? gap.column ?? gap.horizontal ?? gap.x,
  );

  if (rowGap && columnGap) return `${rowGap} ${columnGap}`;
  return rowGap ?? columnGap ?? undefined;
}

function splitCssShorthand(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);

    if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) parts.push(current);
  return parts;
}

function compactBoxSpacing(
  box: NonNullable<WpNode['padding']>,
): NonNullable<WpNode['padding']> | undefined {
  const compacted = Object.fromEntries(
    Object.entries(box).filter(([, v]) => v !== undefined && v !== ''),
  ) as NonNullable<WpNode['padding']>;

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function annotateSourceRefs(
  nodes: WpNode[],
  context: {
    templateName: string;
    sourceFile: string;
    topLevelIndex?: number;
    parentSourceNodeId?: string;
    childPath?: number[];
  },
): WpNode[] {
  return nodes.map((node, index) => {
    const topLevelIndex =
      typeof context.topLevelIndex === 'number' ? context.topLevelIndex : index;
    const childPath =
      typeof context.topLevelIndex === 'number'
        ? [...(context.childPath ?? []), index]
        : [];
    const sourceRef: SourceRef = {
      sourceNodeId: buildSourceNodeId({
        templateName: context.templateName,
        blockName: node.block,
        topLevelIndex,
        childPath,
      }),
      templateName: context.templateName,
      sourceFile: context.sourceFile,
      topLevelIndex,
      parentSourceNodeId: context.parentSourceNodeId,
      blockName: node.block,
    };

    return {
      ...node,
      sourceRef,
      ...(node.children?.length
        ? {
            children: annotateSourceRefs(node.children, {
              ...context,
              topLevelIndex,
              parentSourceNodeId: sourceRef.sourceNodeId,
              childPath,
            }),
          }
        : {}),
    };
  });
}

function parseBlocks(markup: string): WpNode[] {
  const nodes: WpNode[] = [];
  let remaining = markup;

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (!remaining) break;

    // Match opening or self-closing block comment
    const blockMatch = remaining.match(
      /^<!-- wp:([a-z][a-z0-9/\-]*)\s*(\{[\s\S]*?\})?\s*(\/?)-->/,
    );

    if (!blockMatch) {
      // Not a block comment — skip to next block or end
      const nextBlock = remaining.indexOf('<!-- wp:');
      if (nextBlock === -1) break;
      remaining = remaining.slice(nextBlock);
      continue;
    }

    const fullMatch = blockMatch[0];
    const blockName = blockMatch[1];
    const paramsStr = blockMatch[2];
    const selfClosing = blockMatch[3] === '/';

    let params: Record<string, any> | undefined;
    if (paramsStr) {
      try {
        params = JSON.parse(paramsStr);
      } catch {
        // ignore malformed JSON params
      }
    }

    remaining = remaining.slice(fullMatch.length);

    if (selfClosing) {
      // navigation-link: lift label/url to semantic fields so AI can use them as static links
      if (blockName === 'navigation-link' && params?.label) {
        const node = compact({
          block: 'navigation-link',
          text: params.label as string,
          href: canonicalizeThemeAssetReference(params.url as string) || '#',
          ...(normalizeDomId(params?.anchor)
            ? { domId: normalizeDomId(params?.anchor) }
            : {}),
        }) as WpNode;
        liftBlockParamHints(node, blockName, params);
        nodes.push(node);
      } else {
        const node = compact({
          block: blockName,
          params,
          ...(normalizeDomId(params?.anchor)
            ? { domId: normalizeDomId(params?.anchor) }
            : {}),
          ...(blockName === 'site-logo' && params?.width
            ? { width: Number(params.width) }
            : {}),
        }) as WpNode;
        liftBlockParamHints(node, blockName, params);
        nodes.push(node);
      }
      continue;
    }

    // Find the matching closing tag (handles same-name nesting)
    const closeTag = `<!-- /wp:${blockName} -->`;
    const closeIdx = findClosingIndex(remaining, blockName, closeTag);

    if (closeIdx === -1) {
      // Unclosed block — parse remaining as children so content is not lost
      const children = parseBlocks(remaining);
      nodes.push(
        compact({
          block: blockName,
          params,
          children: children.length > 0 ? children : undefined,
        }),
      );
      break; // remaining is fully consumed by children
    }

    const innerMarkup = remaining.slice(0, closeIdx);
    remaining = remaining.slice(closeIdx + closeTag.length);

    const node = buildNode(blockName, params, innerMarkup);
    const textAlign =
      normalizeHorizontalAlign(params?.textAlign) ??
      extractTextAlignFromClassLike(params?.className) ??
      node.textAlign ??
      extractTextAlignFromMarkup(innerMarkup);
    if (textAlign) node.textAlign = textAlign;
    const justifyContent =
      normalizeHorizontalAlign(params?.layout?.justifyContent) ??
      extractJustifyContentFromClassLike(params?.className) ??
      node.justifyContent ??
      extractJustifyContentFromMarkup(innerMarkup);
    if (justifyContent) node.justifyContent = justifyContent;
    const menuOrientation = normalizeOrientation(params?.layout?.orientation);
    if (menuOrientation) node.menuOrientation = menuOrientation;
    const overlayMenu = normalizeOverlayMenu(params?.overlayMenu);
    if (overlayMenu) node.overlayMenu = overlayMenu;
    if (typeof params?.isResponsive === 'boolean') {
      node.isResponsive = params.isResponsive as boolean;
    }
    // Lift color hints from params to top-level fields for AI visibility
    if (params?.backgroundColor)
      node.bgColor = params.backgroundColor as string;
    if (params?.textColor) node.textColor = params.textColor as string;
    if (params?.style?.color?.background && !node.bgColor)
      node.bgColor = params.style.color.background as string;
    if (params?.style?.color?.text && !node.textColor)
      node.textColor = params.style.color.text as string;
    // Lift border radius from params.style.border.radius
    const borderRadius = normalizeBorderRadius(params?.style?.border?.radius);
    if (borderRadius) node.borderRadius = borderRadius;
    const borderWidth = normalizeCssLength(params?.style?.border?.width);
    if (borderWidth) node.borderWidth = borderWidth;
    const borderColor = normalizeColorHint(
      params?.style?.border?.color ?? params?.borderColor,
    );
    if (borderColor) node.borderColor = borderColor;
    // Lift gap from params.style.spacing.blockGap or params.gap
    const gap = normalizeGapValue(
      params?.style?.spacing?.blockGap ?? params?.gap,
    );
    if (gap) node.gap = gap;
    // Lift padding from params.style.spacing.padding
    const pad = params?.style?.spacing?.padding;
    const normalizedPadding = normalizeBoxSpacing(pad);
    if (normalizedPadding) node.padding = normalizedPadding;
    // Lift minHeight (cover/group blocks)
    if (params?.minHeight)
      node.minHeight = normalizeCssLength(params.minHeight);
    // Lift parallax and focal point for cover blocks
    if (params?.hasParallax === true) node.hasParallax = true;
    if (params?.focalPoint && typeof params.focalPoint === 'object') {
      const fp = params.focalPoint as Record<string, unknown>;
      const x = typeof fp.x === 'number' ? fp.x : parseFloat(String(fp.x));
      const y = typeof fp.y === 'number' ? fp.y : parseFloat(String(fp.y));
      if (!isNaN(x) && !isNaN(y)) node.focalPoint = { x, y };
    }
    // Lift inline typography from params.style.typography
    const typo = params?.style?.typography;
    if (typo || params?.fontSize) {
      const t: WpNode['typography'] = {};
      if (typo?.letterSpacing) t.letterSpacing = typo.letterSpacing as string;
      if (typo?.textTransform) t.textTransform = typo.textTransform as string;
      if (typo?.lineHeight) t.lineHeight = typo.lineHeight as string;
      if (typo?.fontSize) t.fontSize = typo.fontSize as string;
      else if (params?.fontSize)
        t.fontSize = `var:preset|font-size|${String(params.fontSize)}`;
      if (typo?.fontWeight) t.fontWeight = typo.fontWeight as string;
      if (typo?.fontFamily) t.fontFamily = typo.fontFamily as string;
      if (Object.keys(t).length > 0) node.typography = t;
    }
    // Lift margin from params.style.spacing.margin
    const mar = params?.style?.spacing?.margin;
    const normalizedMargin = normalizeBoxSpacing(mar);
    if (normalizedMargin) node.margin = normalizedMargin;
    // Lift overlayColor for cover blocks (will be resolved to hex later)
    if (params?.overlayColor) node.overlayColor = params.overlayColor as string;
    // Lift column width percentage
    if (blockName === 'column' && params?.width)
      node.columnWidth = params.width as string;
    // Lift textAlign
    if (params?.textAlign && !node.textAlign) {
      node.textAlign = params.textAlign as string;
    }
    // Lift align (full/wide/center)
    if (params?.align) node.align = params.align as string;
    // Lift fontFamily slug
    if (params?.fontFamily) node.fontFamily = params.fontFamily as string;
    const customClassNames = extractUsefulCustomClassNames([
      ...(extractUsefulCustomClassNamesFromParam(params?.className) ?? []),
      ...(node.customClassNames ?? []),
    ]);
    if (customClassNames.length > 0) node.customClassNames = customClassNames;
    nodes.push(node);
  }

  return nodes;
}

function liftBlockParamHints(
  node: WpNode,
  blockName: string,
  params: Record<string, any> | undefined,
): void {
  if (!params) return;

  if (params.backgroundColor) node.bgColor = params.backgroundColor as string;
  if (params.textColor) node.textColor = params.textColor as string;
  if (params.style?.color?.background && !node.bgColor) {
    node.bgColor = params.style.color.background as string;
  }
  if (params.style?.color?.text && !node.textColor) {
    node.textColor = params.style.color.text as string;
  }

  const borderRadius = normalizeBorderRadius(params.style?.border?.radius);
  if (borderRadius) node.borderRadius = borderRadius;
  const borderWidth = normalizeCssLength(params.style?.border?.width);
  if (borderWidth) node.borderWidth = borderWidth;
  const borderColor = normalizeColorHint(
    params.style?.border?.color ?? params.borderColor,
  );
  if (borderColor) node.borderColor = borderColor;

  const gap = normalizeGapValue(params.style?.spacing?.blockGap ?? params.gap);
  if (gap) node.gap = gap;

  const normalizedPadding = normalizeBoxSpacing(params.style?.spacing?.padding);
  if (normalizedPadding) node.padding = normalizedPadding;

  const normalizedMargin = normalizeBoxSpacing(params.style?.spacing?.margin);
  if (normalizedMargin) node.margin = normalizedMargin;

  if (params.minHeight) node.minHeight = normalizeCssLength(params.minHeight);
  if (params.overlayColor) node.overlayColor = params.overlayColor as string;
  if (blockName === 'column' && params.width) node.columnWidth = params.width;
  if (params.textAlign && !node.textAlign) node.textAlign = params.textAlign;
  if (params.align) node.align = params.align;
  if (params.fontFamily) node.fontFamily = params.fontFamily;

  const typo = params.style?.typography;
  if (typo || params.fontSize) {
    const typography: WpNode['typography'] = {};
    if (typo?.letterSpacing) typography.letterSpacing = typo.letterSpacing;
    if (typo?.textTransform) typography.textTransform = typo.textTransform;
    if (typo?.lineHeight) typography.lineHeight = typo.lineHeight;
    if (typo?.fontSize) typography.fontSize = typo.fontSize;
    else if (params.fontSize) {
      typography.fontSize = `var:preset|font-size|${String(params.fontSize)}`;
    }
    if (typo?.fontWeight) typography.fontWeight = typo.fontWeight;
    if (typo?.fontFamily) typography.fontFamily = typo.fontFamily;
    if (Object.keys(typography).length > 0) node.typography = typography;
  }

  const customClassNames = extractUsefulCustomClassNames([
    ...(extractUsefulCustomClassNamesFromParam(params.className) ?? []),
    ...(node.customClassNames ?? []),
  ]);
  if (customClassNames.length > 0) node.customClassNames = customClassNames;
}

/**
 * Find the index of the matching closing tag, accounting for same-name nesting.
 */
function findClosingIndex(
  markup: string,
  blockName: string,
  closeTag: string,
): number {
  const escapedName = blockName.replace('/', '\\/');
  const openPattern = new RegExp(`<!-- wp:${escapedName}[\\s{/]`);

  let depth = 1;
  let pos = 0;

  while (pos < markup.length && depth > 0) {
    const nextClose = markup.indexOf(closeTag, pos);

    if (nextClose === -1) return -1;

    // Check if there's another open tag before the close tag
    const openAfterPos = (() => {
      const sub = markup.slice(pos);
      const m = sub.match(openPattern);
      return m && m.index !== undefined ? pos + m.index : -1;
    })();

    if (openAfterPos !== -1 && openAfterPos < nextClose) {
      depth++;
      pos = openAfterPos + 1;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + closeTag.length;
    }
  }

  return -1;
}

/**
 * Build a WpNode from a block name, params, and inner markup.
 * Decides whether to recurse into children or extract leaf content.
 */
function buildNode(
  blockName: string,
  params: Record<string, any> | undefined,
  innerMarkup: string,
): WpNode {
  const domId =
    normalizeDomId(params?.anchor) ?? extractDomIdFromMarkup(innerMarkup);
  const wrapperCustomClassNames = mergeCustomClassNameLists(
    extractUsefulCustomClassNamesFromParam(params?.className),
    extractOpeningTagCustomClassNames(innerMarkup),
  );
  const hasNestedBlocks = /<!-- wp:[a-z]/.test(innerMarkup);
  const modalSyntheticChildren = isUagbModalBlock(blockName)
    ? extractUagbModalTriggerChildren(innerMarkup)
    : [];

  if (hasNestedBlocks) {
    const children = mergeSyntheticChildren(
      parseBlocks(innerMarkup),
      modalSyntheticChildren,
    );
    // For navigation blocks: keep navigation-link children as HINTS so the AI can
    // identify which WP menu corresponds to this navigation block (by matching item
    // labels/slugs). The AI must still ALWAYS fetch from GET /api/menus and render
    // dynamic content — never render navigation-link children as static <a> tags.

    // For cover blocks: lift background image URL, overlay color, and minHeight to
    // top-level fields even when the cover has nested children. These fields live in
    // params.url / params.overlayColor / params.customOverlayColor / params.minHeight
    // and would be stripped by pruneParams (since 'url' etc. are not in USEFUL_PARAM_KEYS).
    // Without lifting them here, the AI never sees the background image of real hero
    // sections and renders the block without the correct visual treatment.
    const coverExtras: Partial<WpNode> = {};
    if (blockName === 'cover') {
      if (params?.url) {
        const cleanUrl = canonicalizeThemeAssetReference(params.url as string);
        if (cleanUrl) coverExtras.src = cleanUrl;
      }
      if (params?.customOverlayColor) {
        coverExtras.overlayColor = params.customOverlayColor as string;
      } else if (params?.overlayColor) {
        coverExtras.overlayColor = params.overlayColor as string;
      }
      if (params?.minHeight)
        coverExtras.minHeight = normalizeCssLength(params.minHeight);
    }
    const detailsExtras: Partial<WpNode> = {};
    if (blockName === 'details' || blockName === 'core/details') {
      const summaryText = extractDetailsSummaryText(innerMarkup);
      if (summaryText) detailsExtras.text = summaryText;
    }
    return compact({
      block: blockName,
      params,
      ...(domId ? { domId } : {}),
      ...(wrapperCustomClassNames.length
        ? {
            customClassNames: wrapperCustomClassNames,
          }
        : {}),
      ...coverExtras,
      ...detailsExtras,
      children,
    });
  }

  // For wp:cover (leaf, no nested blocks) — lift background image URL to top-level src
  const rawCoverUrl =
    blockName === 'cover' && params?.url
      ? canonicalizeThemeAssetReference(params.url as string)
      : '';
  const coverSrc = rawCoverUrl ? { src: rawCoverUrl } : {};

  // UAGB info-box stores title, description, and CTA inside innerHTML as class-based
  // HTML (not nested block comments). Parse them into synthetic child WpNodes so that
  // standard mappers (mapUagbInfoBox, mapUagbSlider) can find them via flattenChildren.
  if (blockName === 'uagb/info-box' || blockName === 'info-box') {
    const syntheticChildren: WpNode[] = [];
    const stripped = innerMarkup
      .replace(/\s+class="[^"]*"/g, '')
      .replace(/\s+style="[^"]*"/g, '');
    const titleMatch =
      stripped.match(
        /<h[1-6][^>]*class="[^"]*uagb-ifb-title[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/i,
      ) ?? stripped.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const titleText = titleMatch
      ? stripTags(titleMatch[titleMatch.length - 1])
      : undefined;
    const descMatch = innerMarkup.match(
      /<p[^>]*class="[^"]*uagb-ifb-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    );
    const descText = descMatch ? stripTags(descMatch[1]) : undefined;
    const ctaMatch =
      innerMarkup.match(
        /<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?<span[^>]*class="[^"]*uagb-inline-editing[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      ) ?? innerMarkup.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const ctaHref = ctaMatch?.[1];
    const ctaText = ctaMatch ? stripTags(ctaMatch[2]) : undefined;
    if (titleText)
      syntheticChildren.push({ block: 'heading', level: 3, text: titleText });
    if (descText)
      syntheticChildren.push({ block: 'paragraph', text: descText });
    if (ctaText && ctaHref)
      syntheticChildren.push({
        block: 'button',
        text: ctaText,
        href: canonicalizeThemeAssetReference(ctaHref) ?? ctaHref,
      });
    if (syntheticChildren.length > 0) {
      return compact({
        block: blockName,
        params,
        ...(domId ? { domId } : {}),
        ...(wrapperCustomClassNames.length
          ? {
              customClassNames: wrapperCustomClassNames,
            }
          : {}),
        children: syntheticChildren,
      });
    }
  }

  // Leaf node — extract content from HTML
  const leaf = extractLeafContent(blockName, innerMarkup);
  const {
    customClassNames: _leafCustomClassNames,
    ...leafWithoutCustomClasses
  } = leaf;
  const leafCustomClassNames = mergeCustomClassNameLists(
    wrapperCustomClassNames,
    _leafCustomClassNames,
  );

  // For wp:image — add dimensions from params if not already in img tag
  if (blockName === 'image') {
    const width = parseCssNumericDimension(params?.width);
    const height = parseCssNumericDimension(params?.height);
    if (!leaf.width && width !== undefined) leaf.width = width;
    if (!leaf.height && height !== undefined) leaf.height = height;
  }
  if (blockName === 'site-logo' && !leaf.width && params?.width) {
    leaf.width = Number(params.width);
  }

  return compact({
    block: blockName,
    params,
    ...(domId ? { domId } : {}),
    ...(leafCustomClassNames.length
      ? {
          customClassNames: leafCustomClassNames,
        }
      : {}),
    ...coverSrc,
    ...leafWithoutCustomClasses,
    ...(modalSyntheticChildren.length > 0
      ? { children: modalSyntheticChildren }
      : {}),
  });
}

/**
 * Extract meaningful content from leaf HTML (no nested WP blocks).
 */
function extractLeafContent(blockName: string, html: string): Partial<WpNode> {
  const customClassNames = extractUsefulCustomClassNamesFromHtml(html);
  const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+class="[^"]*"/g, '')
    .replace(/\s+style="[^"]*"/g, '')
    .replace(/\s+data-[a-z\-]+="[^"]*"/g, '')
    .replace(/\s+aria-[a-z\-]+="[^"]*"/g, '')
    .trim();

  // Heading
  const headingMatch = stripped.match(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (headingMatch) {
    return {
      level: parseInt(headingMatch[1]),
      text: stripTags(headingMatch[2]),
      html: headingMatch[2].trim(),
    };
  }

  // Image
  const imgMatch =
    htmlWithoutComments.match(/<img([^>]*)>/i) ??
    stripped.match(/<img([^>]*)>/i);
  if (imgMatch) {
    const attrs = imgMatch[1];
    const src = attrs.match(/src="([^"]+)"/)?.[1] ?? '';
    const alt = attrs.match(/alt="([^"]*)"/)?.[1] ?? '';
    const style = attrs.match(/style="([^"]+)"/)?.[1] ?? '';
    const width =
      attrs.match(/width="([^"]+)"/)?.[1] ??
      style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)?.[1];
    const height =
      attrs.match(/height="([^"]+)"/)?.[1] ??
      style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)?.[1];
    const numericWidth = parseCssNumericDimension(width);
    const numericHeight = parseCssNumericDimension(height);
    return {
      src: canonicalizeThemeAssetReference(src) ?? src,
      alt,
      ...(customClassNames.length ? { customClassNames } : {}),
      ...(numericWidth !== undefined ? { width: numericWidth } : {}),
      ...(numericHeight !== undefined ? { height: numericHeight } : {}),
    };
  }

  // Button / standalone link. Paragraphs with inline links must keep their full
  // rich text instead of being collapsed to only the anchor text.
  const aMatch = stripped.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  const isStandaloneLinkBlock =
    /^(core\/)?(button|navigation-link|social-link)$/i.test(blockName) ||
    /^<a\b[^>]*>[\s\S]*<\/a>$/i.test(stripped);
  if (aMatch && isStandaloneLinkBlock) {
    return {
      href: canonicalizeThemeAssetReference(aMatch[1]) ?? aMatch[1],
      text: stripTags(aMatch[2]),
      ...(customClassNames.length ? { customClassNames } : {}),
    };
  }

  // Paragraph or generic text
  const textContent = stripTags(stripped).replace(/\s+/g, ' ').trim();
  if (textContent.length > 0) {
    // For content-heavy blocks keep raw HTML so downstream rich-text renderers can
    // preserve the original paragraph/link/inline markup structure.
    const hasInlineHtml = /<(strong|em|b|i|a|code|mark|s|u|span)[^>]*>/i.test(
      stripped,
    );
    // For list items, preserve inline HTML (e.g. <strong>, <em>, <a>) so the
    // structured rich-text renderer can keep bold/italic/link formatting intact.
    if (
      (blockName === 'core/list-item' || blockName === 'list-item') &&
      hasInlineHtml
    ) {
      return {
        text: textContent,
        html: stripped,
        ...(customClassNames.length ? { customClassNames } : {}),
      };
    }
    if (
      blockName === 'post-content' ||
      blockName === 'query' ||
      textContent.length > 200 ||
      hasInlineHtml
    ) {
      return { html: stripped };
    }
    return {
      text: textContent,
      ...(customClassNames.length ? { customClassNames } : {}),
    };
  }

  return customClassNames.length ? { customClassNames } : {};
}

function normalizeDomId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function extractDomIdFromMarkup(markup: string): string | undefined {
  const openingTagMatch = String(markup ?? '').match(
    /^\s*<([a-z0-9:-]+)\b([^>]*)>/i,
  );
  if (!openingTagMatch?.[2]) return undefined;
  const idMatch = openingTagMatch[2].match(/\bid=(['"])(.*?)\1/i);
  return normalizeDomId(idMatch?.[2]);
}

function extractDetailsSummaryText(html: string): string | undefined {
  const summaryMatch = String(html ?? '').match(
    /<summary[^>]*>([\s\S]*?)<\/summary>/i,
  );
  const summaryText = summaryMatch ? stripTags(summaryMatch[1]) : '';
  return summaryText.trim() || undefined;
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove undefined fields to keep JSON compact */
function compact(node: WpNode): WpNode {
  return Object.fromEntries(
    Object.entries(node).filter(
      ([, v]) =>
        v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
    ),
  ) as WpNode;
}

function extractUsefulCustomClassNamesFromParam(
  value: unknown,
): string[] | undefined {
  if (!value) return undefined;
  const tokens = String(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const classes = extractUsefulCustomClassNames(tokens);
  return classes.length > 0 ? classes : undefined;
}

function extractUsefulCustomClassNamesFromHtml(html: string): string[] {
  const matches = Array.from(html.matchAll(/\bclass="([^"]+)"/gi));
  const tokens = matches.flatMap((match) =>
    String(match[1] ?? '')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );
  return extractUsefulCustomClassNames(tokens);
}

function extractOpeningTagCustomClassNames(markup: string): string[] {
  const openingTagMatch = String(markup ?? '').match(
    /^\s*<([a-z0-9:-]+)\b([^>]*)>/i,
  );
  if (!openingTagMatch?.[2]) return [];
  const classMatch = openingTagMatch[2].match(/\bclass=(['"])(.*?)\1/i);
  return classMatch?.[2]
    ? (extractUsefulCustomClassNamesFromParam(classMatch[2]) ?? [])
    : [];
}

function mergeCustomClassNameLists(
  ...lists: Array<string[] | undefined>
): string[] {
  return Array.from(
    new Set(
      lists
        .flatMap((list) => list ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function isUagbModalBlock(blockName: string): boolean {
  return blockName === 'uagb/modal' || blockName === 'modal';
}

function extractUagbModalTriggerChildren(innerMarkup: string): WpNode[] {
  const matches = Array.from(
    innerMarkup.matchAll(
      /<(a|button)\b([^>]*\bclass="[^"]*\buagb-modal-(?:trigger|button-link)\b[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi,
    ),
  );
  const nodes: WpNode[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const tag = String(match[1] ?? '').toLowerCase();
    const attrs = String(match[2] ?? '');
    const inner = String(match[3] ?? '');
    const text = stripTags(inner).replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const className = attrs.match(/\bclass="([^"]+)"/i)?.[1];
    const customClassNames = extractUsefulCustomClassNamesFromParam(className);
    const rawHref = attrs.match(/\bhref="([^"]+)"/i)?.[1];
    const href =
      tag === 'a'
        ? (canonicalizeThemeAssetReference(rawHref ?? '#') ?? rawHref ?? '#')
        : undefined;
    const signature = [
      text,
      href ?? '',
      (customClassNames ?? []).join('|'),
    ].join('::');
    if (seen.has(signature)) continue;
    seen.add(signature);

    nodes.push(
      compact({
        block: 'button',
        text,
        ...(href ? { href } : {}),
        ...(customClassNames?.length ? { customClassNames } : {}),
      }),
    );
  }

  return nodes;
}

function mergeSyntheticChildren(
  children: WpNode[],
  syntheticChildren: WpNode[],
): WpNode[] {
  if (syntheticChildren.length === 0) return children;
  const merged = [...syntheticChildren];
  const seen = new Set(
    syntheticChildren.map((node) =>
      [
        node.block,
        node.text ?? '',
        node.href ?? '',
        (node.customClassNames ?? []).join('|'),
      ].join('::'),
    ),
  );

  for (const child of children) {
    const signature = [
      child.block,
      child.text ?? '',
      child.href ?? '',
      (child.customClassNames ?? []).join('|'),
    ].join('::');
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(child);
  }

  return merged;
}

function extractUsefulCustomClassNames(tokens: string[]): string[] {
  const standaloneUsefulClassNames = new Set(['wow']);
  return Array.from(
    new Set(
      tokens.filter((token) => {
        const normalized = token.trim().toLowerCase();
        if (!normalized) return false;
        if (
          !normalized.includes('-') &&
          !normalized.includes('__') &&
          !standaloneUsefulClassNames.has(normalized)
        )
          return false;
        return !/^(wp-|has-|align|is-layout-|current-|menu-item|page-item|post-|blocks-gallery|size-|components-|editor-|screen-reader-text$)/i.test(
          normalized,
        );
      }),
    ),
  );
}

/**
 * Maps a WordPress block name to a ThemeInteractionTarget used by the
 * validator's repair/detection logic. Returns undefined for blocks that do
 * not map to a specific interactive element type.
 */
export function inferTargetFromBlockName(
  blockName: string,
): 'button' | 'link' | 'image' | 'card' | undefined {
  const lower = (blockName ?? '').toLowerCase();
  if (lower === 'core/button') return 'button';
  if (
    lower === 'core/image' ||
    lower === 'core/post-featured-image' ||
    lower === 'core/site-logo'
  )
    return 'image';
  if (
    lower === 'core/navigation-link' ||
    lower === 'core/navigation-submenu' ||
    lower === 'core/social-link' ||
    lower === 'core/loginout' ||
    lower === 'core/read-more'
  )
    return 'link';
  return undefined;
}
