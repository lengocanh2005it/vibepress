import { buildSourceNodeId, type SourceRef } from './source-node-id.util.js';

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
  gap?: string; // from params.style.spacing.blockGap or params.gap — spacing preset or px value
  padding?: { top?: string; right?: string; bottom?: string; left?: string }; // from params.style.spacing.padding
  margin?: { top?: string; right?: string; bottom?: string; left?: string }; // from params.style.spacing.margin
  minHeight?: string; // from params.minHeight (cover/group blocks)
  overlayColor?: string; // cover block overlay color hex (pre-resolved)
  columnWidth?: string; // wp:column percentage width (e.g. "33.33%")
  textAlign?: string; // from params.textAlign
  align?: string; // "full" | "wide" | "center" — section width hint
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
  // uagb/tabs block
  tabs?: { label: string; content: string }[];
  // uagb/slider block
  slides?: {
    heading?: string;
    description?: string;
    cta?: { text: string; link: string };
  }[];
  // uagb/modal block
  modalTrigger?: string;
  modalHeading?: string;
  modalDescription?: string;
  modalCta?: { text: string; link: string };
}

/**
 * Entry point: parse full template markup into a JSON array of WpNode.
 */
export function wpBlocksToJson(markup: string): WpNode[] {
  return parseBlocks(markup.trim());
}

export function wpBlocksToJsonWithSourceRefs(input: {
  markup: string;
  templateName: string;
  sourceFile: string;
}): WpNode[] {
  const nodes = parseBlocks(input.markup.trim());
  return annotateSourceRefs(nodes, {
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

const USEFUL_PARAM_KEYS = new Set([
  'align', // "full" | "wide" | "center" — section width
  'className', // preserve Gutenberg/custom classes for precise interaction bridge
  'layout', // { type: "flex", justifyContent, orientation, ... }
  'width', // explicit block width (notably site-logo / image sizing)
  'height', // explicit block height when present
  'fontSize', // text size slug
  'textAlign', // text alignment
  'dimRatio', // cover block overlay opacity
  'contentPosition', // cover block content position
  'isStackedOnMobile', // columns stacking behaviour
  'verticalAlignment', // column vertical align
  'gradient', // gradient background slug
]);

function pruneParams(
  params: Record<string, any>,
): Record<string, any> | undefined {
  const pruned = Object.fromEntries(
    Object.entries(params).filter(([k]) => USEFUL_PARAM_KEYS.has(k)),
  );
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function stripParams(nodes: WpNode[]): WpNode[] {
  return nodes.map(({ params, children, ...rest }) => ({
    ...rest,
    ...(params ? { params: pruneParams(params) } : {}),
    ...(children ? { children: stripParams(children) } : {}),
  }));
}

// ----------------------d--------------------------------------------------

function normalizeBoxSpacing(
  value: unknown,
): WpNode['padding'] | WpNode['margin'] | undefined {
  if (!value) return undefined;

  if (typeof value === 'object') {
    const box = value as Record<string, unknown>;
    return compactBoxSpacing({
      top: box.top as string | undefined,
      right: box.right as string | undefined,
      bottom: box.bottom as string | undefined,
      left: box.left as string | undefined,
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
  return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
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
              sourceFile:
                node.block === 'vibepress/source-scope' &&
                typeof node.params?.sourceFile === 'string'
                  ? node.params.sourceFile
                  : context.sourceFile,
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

    const partBoundaryMatch = remaining.match(
      /^<!-- vibepress:part:(?:start|end) [^>]+-->/,
    );
    if (partBoundaryMatch) {
      remaining = remaining.slice(partBoundaryMatch[0].length);
      continue;
    }

    const sourceScopeMatch = remaining.match(
      /^<!-- vibepress:source:start ([^>]+?) -->/,
    );
    if (sourceScopeMatch) {
      const sourceFile = sourceScopeMatch[1].trim();
      remaining = remaining.slice(sourceScopeMatch[0].length);
      const endIdx = findSourceScopeClosingIndex(remaining, sourceFile);
      if (endIdx === -1) {
        const children = parseBlocks(remaining);
        nodes.push(
          compact({
            block: 'vibepress/source-scope',
            params: { sourceFile },
            children: children.length > 0 ? children : undefined,
          }),
        );
        break;
      }

      const innerMarkup = remaining.slice(0, endIdx);
      remaining = remaining.slice(
        endIdx + `<!-- vibepress:source:end ${sourceFile} -->`.length,
      );
      const children = parseBlocks(innerMarkup);
      nodes.push(
        compact({
          block: 'vibepress/source-scope',
          params: { sourceFile },
          children: children.length > 0 ? children : undefined,
        }),
      );
      continue;
    }

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
        nodes.push(
          compact({
            block: 'navigation-link',
            text: params.label as string,
            href: (params.url as string) || '#',
          }),
        );
      } else {
        nodes.push(
          compact({
            block: blockName,
            params,
          }),
        );
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
    // Lift color hints from params to top-level fields for AI visibility
    if (params?.backgroundColor)
      node.bgColor = params.backgroundColor as string;
    if (params?.textColor) node.textColor = params.textColor as string;
    if (params?.style?.color?.background && !node.bgColor)
      node.bgColor = params.style.color.background as string;
    if (params?.style?.color?.text && !node.textColor)
      node.textColor = params.style.color.text as string;
    // Lift border radius from params.style.border.radius
    const borderRadius = params?.style?.border?.radius;
    if (borderRadius) node.borderRadius = borderRadius as string;
    // Lift gap from params.style.spacing.blockGap or params.gap
    const gap = params?.style?.spacing?.blockGap ?? params?.gap;
    if (gap) node.gap = gap as string;
    // Lift padding from params.style.spacing.padding
    const pad = params?.style?.spacing?.padding;
    const normalizedPadding = normalizeBoxSpacing(pad);
    if (normalizedPadding) node.padding = normalizedPadding;
    // Lift minHeight (cover/group blocks)
    if (params?.minHeight)
      node.minHeight = normalizeCssLength(params.minHeight);
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
    if (params?.textAlign) node.textAlign = params.textAlign as string;
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

function findSourceScopeClosingIndex(
  markup: string,
  sourceFile: string,
): number {
  const startTag = `<!-- vibepress:source:start ${sourceFile} -->`;
  const endTag = `<!-- vibepress:source:end ${sourceFile} -->`;
  let depth = 1;
  let pos = 0;

  while (pos < markup.length && depth > 0) {
    const nextStart = markup.indexOf(startTag, pos);
    const nextEnd = markup.indexOf(endTag, pos);

    if (nextEnd === -1) return -1;

    if (nextStart !== -1 && nextStart < nextEnd) {
      depth++;
      pos = nextStart + startTag.length;
      continue;
    }

    depth--;
    if (depth === 0) return nextEnd;
    pos = nextEnd + endTag.length;
  }

  return -1;
}

function extractAnchorContentByClass(
  html: string,
  classToken: string,
): { text: string; link: string } | undefined {
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    const classValue = attrs.match(/\bclass="([^"]*)"/i)?.[1] ?? '';
    if (!classValue.split(/\s+/).includes(classToken)) continue;

    const text = stripTags(match[2] ?? '').trim();
    if (!text) continue;

    return {
      text,
      link: attrs.match(/\bhref="([^"]*)"/i)?.[1] || '#',
    };
  }

  return undefined;
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
  const hasNestedBlocks = /<!-- wp:[a-z]/.test(innerMarkup);

  // uagb/tabs: extract tab labels from HTML <ul> and tab content from
  // uagb/tabs-child blocks, then return a flat node with a tabs array.
  if (blockName === 'uagb/tabs') {
    const labelMatches = [
      ...innerMarkup.matchAll(/<div[^>]*>\s*([^<]+?)\s*<\/div>\s*<\/a>/g),
    ];
    const labels = labelMatches.map((m) => m[1].trim()).filter(Boolean);

    const childPattern =
      /<!-- wp:uagb\/tabs-child[^>]*-->([\s\S]*?)<!-- \/wp:uagb\/tabs-child -->/g;
    const contents: string[] = [];
    let childMatch: RegExpExecArray | null;
    while ((childMatch = childPattern.exec(innerMarkup)) !== null) {
      const childInner = childMatch[1];
      // Extract plain text from inner blocks
      const text = stripTags(childInner.replace(/<!--[\s\S]*?-->/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
      contents.push(text);
    }

    const tabs = labels.map((label, i) => ({
      label,
      content: contents[i] ?? '',
    }));

    return compact({ block: 'uagb/tabs', tabs });
  }

  // uagb/slider: extract slides from uagb/slider-child blocks.
  // Each child contains a uagb/info-box with title, desc, and optional CTA link.
  if (blockName === 'uagb/slider') {
    const childPattern =
      /<!-- wp:uagb\/slider-child[^>]*-->([\s\S]*?)<!-- \/wp:uagb\/slider-child -->/g;
    const slides: WpNode['slides'] = [];
    let childMatch: RegExpExecArray | null;
    while ((childMatch = childPattern.exec(innerMarkup)) !== null) {
      const childInner = childMatch[1];
      // Match any heading level (h1-h6) whose class contains uagb-ifb-title; fall back to first heading.
      const headingMatch =
        /<h[1-6][^>]*class="[^"]*uagb-ifb-title[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/.exec(
          childInner,
        ) ?? /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/.exec(childInner);
      // Match any <p> whose class contains uagb-ifb-desc; fall back to first <p>.
      const descMatch =
        /<p[^>]*class="[^"]*uagb-ifb-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(
          childInner,
        ) ?? /<p[^>]*>([\s\S]*?)<\/p>/.exec(childInner);
      const cta = extractAnchorContentByClass(
        childInner,
        'uagb-infobox-cta-link',
      );
      const slide: NonNullable<WpNode['slides']>[number] = {};
      if (headingMatch) slide.heading = stripTags(headingMatch[1]).trim();
      if (descMatch) slide.description = stripTags(descMatch[1]).trim();
      if (cta) {
        slide.cta = cta;
      }
      slides.push(slide);
    }
    return compact({ block: 'uagb/slider', slides });
  }

  // uagb/modal: extract trigger button text and popup content (info-box inside modal).
  if (blockName === 'uagb/modal') {
    const trigger = extractAnchorContentByClass(
      innerMarkup,
      'uagb-modal-button-link',
    );
    const popupContent =
      /<!-- wp:uagb\/info-box[^>]*-->([\s\S]*?)<!-- \/wp:uagb\/info-box -->/.exec(
        innerMarkup,
      );
    const triggerText = trigger?.text || 'Open Modal';
    let modalHeading: string | undefined;
    let modalDescription: string | undefined;
    let modalCta: { text: string; link: string } | undefined;
    if (popupContent) {
      const inner = popupContent[1];
      const hMatch =
        /<h3[^>]*class="uagb-ifb-title"[^>]*>([\s\S]*?)<\/h3>/.exec(inner);
      const dMatch = /<p[^>]*class="uagb-ifb-desc"[^>]*>([\s\S]*?)<\/p>/.exec(
        inner,
      );
      const cta = extractAnchorContentByClass(inner, 'uagb-infobox-cta-link');
      if (hMatch) modalHeading = stripTags(hMatch[1]).trim();
      if (dMatch) modalDescription = stripTags(dMatch[1]).trim();
      if (cta) {
        modalCta = cta;
      }
    }
    return compact({
      block: 'uagb/modal',
      modalTrigger: triggerText,
      modalHeading,
      modalDescription,
      modalCta,
    });
  }

  if (hasNestedBlocks) {
    const children = parseBlocks(innerMarkup);
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
      if (params?.url) coverExtras.src = params.url as string;
      if (params?.customOverlayColor) {
        coverExtras.overlayColor = params.customOverlayColor as string;
      } else if (params?.overlayColor) {
        coverExtras.overlayColor = params.overlayColor as string;
      }
      if (params?.minHeight)
        coverExtras.minHeight = normalizeCssLength(params.minHeight);
    }
    return compact({
      block: blockName,
      params,
      ...(extractUsefulCustomClassNamesFromParam(params?.className)?.length
        ? {
            customClassNames: extractUsefulCustomClassNamesFromParam(
              params?.className,
            ),
          }
        : {}),
      ...coverExtras,
      children,
    });
  }

  // For wp:cover (leaf, no nested blocks) — lift background image URL to top-level src
  const coverSrc =
    blockName === 'cover' && params?.url ? { src: params.url as string } : {};

  // Leaf node — extract content from HTML
  const leaf = extractLeafContent(blockName, innerMarkup);

  // For wp:image — add dimensions from params if not already in img tag
  if (blockName === 'image') {
    if (!leaf.width && params?.width) leaf.width = params.width as number;
    if (!leaf.height && params?.height) leaf.height = params.height as number;
  }

  // When a paragraph/heading block has fontWeight="700" set via Gutenberg typography,
  // wrap the text in <strong> and expose it as node.html so the AI renders it bold
  // via dangerouslySetInnerHTML instead of losing the formatting as plain text.
  const blockFontWeight = (params as any)?.style?.typography?.fontWeight;
  if (
    (blockName === 'paragraph' || blockName === 'core/paragraph') &&
    (blockFontWeight === '700' || blockFontWeight === 'bold') &&
    leaf.text &&
    !leaf.html
  ) {
    leaf.html = `<strong>${leaf.text}</strong>`;
  }

  return compact({
    block: blockName,
    params,
    ...(extractUsefulCustomClassNamesFromParam(params?.className)?.length
      ? {
          customClassNames: extractUsefulCustomClassNamesFromParam(
            params?.className,
          ),
        }
      : {}),
    ...coverSrc,
    ...leaf,
  });
}

/**
 * Extract meaningful content from leaf HTML (no nested WP blocks).
 */
function extractLeafContent(blockName: string, html: string): Partial<WpNode> {
  const customClassNames = extractUsefulCustomClassNamesFromHtml(html);
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
    };
  }

  // Image
  const imgMatch = stripped.match(/<img([^>]*)>/i);
  if (imgMatch) {
    const attrs = imgMatch[1];
    const src = attrs.match(/src="([^"]+)"/)?.[1] ?? '';
    const alt = attrs.match(/alt="([^"]*)"/)?.[1] ?? '';
    const width = attrs.match(/width="([^"]+)"/)?.[1];
    const height = attrs.match(/height="([^"]+)"/)?.[1];
    return {
      src,
      alt,
      ...(customClassNames.length ? { customClassNames } : {}),
      ...(width ? { width: parseInt(width) } : {}),
      ...(height ? { height: parseInt(height) } : {}),
    };
  }

  // Button / link
  const aMatch = stripped.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (aMatch) {
    return {
      href: aMatch[1],
      text: stripTags(aMatch[2]),
      ...(customClassNames.length ? { customClassNames } : {}),
    };
  }

  // Paragraph or generic text
  const textContent = stripTags(stripped).replace(/\s+/g, ' ').trim();
  if (textContent.length > 0) {
    // For content-heavy blocks keep raw HTML so AI renders it with dangerouslySetInnerHTML
    if (
      blockName === 'post-content' ||
      blockName === 'query' ||
      textContent.length > 200
    ) {
      return { html: stripped };
    }
    // For list items, preserve inline HTML (e.g. <strong>, <em>, <a>) so the
    // renderer can use dangerouslySetInnerHTML to keep bold/italic formatting.
    const hasInlineHtml = /<(strong|em|b|i|a|code|mark|s|u|span)[^>]*>/i.test(
      stripped,
    );
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
    return {
      text: textContent,
      ...(customClassNames.length ? { customClassNames } : {}),
    };
  }

  return customClassNames.length ? { customClassNames } : {};
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

function extractUsefulCustomClassNames(tokens: string[]): string[] {
  return Array.from(
    new Set(
      tokens.filter((token) => {
        const normalized = token.trim().toLowerCase();
        if (!normalized) return false;
        if (!normalized.includes('-') && !normalized.includes('__'))
          return false;
        return !/^(wp-|has-|align|is-layout-|current-|menu-item|page-item|post-|blocks-gallery|size-|components-|editor-|screen-reader-text$)/i.test(
          normalized,
        );
      }),
    ),
  );
}
