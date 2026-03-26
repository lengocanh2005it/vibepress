/**
 * Converts WordPress block markup into a compact JSON tree.
 * This replaces passing raw HTML to the AI — instead AI receives structured data
 * so it cannot fabricate content (all text/images/links are pre-extracted).
 */

export interface WpNode {
  block: string;
  params?: Record<string, any>;
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
}

/**
 * Entry point: parse full template markup into a JSON array of WpNode.
 */
export function wpBlocksToJson(markup: string): WpNode[] {
  return parseBlocks(markup.trim());
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
  'layout', // { type: "flex", justifyContent, orientation, ... }
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

// ---------------------------------------------------------------------------

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
      // Skip site-logo — not renderable without WP media; site-title already shows the name
      if (blockName === 'site-logo') continue;
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
        nodes.push(compact({ block: blockName, params }));
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
    if (pad && typeof pad === 'object') {
      node.padding = {
        top: pad.top as string | undefined,
        right: pad.right as string | undefined,
        bottom: pad.bottom as string | undefined,
        left: pad.left as string | undefined,
      };
    }
    // Lift minHeight (cover/group blocks)
    if (params?.minHeight) node.minHeight = String(params.minHeight);
    // Lift inline typography from params.style.typography
    const typo = params?.style?.typography;
    if (typo) {
      const t: WpNode['typography'] = {};
      if (typo.letterSpacing) t.letterSpacing = typo.letterSpacing as string;
      if (typo.textTransform) t.textTransform = typo.textTransform as string;
      if (typo.lineHeight) t.lineHeight = typo.lineHeight as string;
      if (typo.fontSize) t.fontSize = typo.fontSize as string;
      if (typo.fontWeight) t.fontWeight = typo.fontWeight as string;
      if (typo.fontFamily) t.fontFamily = typo.fontFamily as string;
      if (Object.keys(t).length > 0) node.typography = t;
    }
    // Lift margin from params.style.spacing.margin
    const mar = params?.style?.spacing?.margin;
    if (mar && typeof mar === 'object') {
      node.margin = {
        top: mar.top as string | undefined,
        right: mar.right as string | undefined,
        bottom: mar.bottom as string | undefined,
        left: mar.left as string | undefined,
      };
    }
    // Lift overlayColor for cover blocks (will be resolved to hex later)
    if (params?.overlayColor) node.overlayColor = params.overlayColor as string;
    // Lift column width percentage
    if (blockName === 'column' && params?.width) node.columnWidth = params.width as string;
    // Lift textAlign
    if (params?.textAlign) node.textAlign = params.textAlign as string;
    // Lift align (full/wide/center)
    if (params?.align) node.align = params.align as string;
    // Lift fontFamily slug
    if (params?.fontFamily) node.fontFamily = params.fontFamily as string;
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

  if (hasNestedBlocks) {
    const children = parseBlocks(innerMarkup);
    // For navigation blocks: keep navigation-link children as HINTS so the AI can
    // identify which WP menu corresponds to this navigation block (by matching item
    // labels/slugs). The AI must still ALWAYS fetch from GET /api/menus and render
    // dynamic content — never render navigation-link children as static <a> tags.
    return compact({ block: blockName, params, children });
  }

  // For wp:cover — lift background image URL to top-level src
  const coverSrc =
    blockName === 'cover' && params?.url ? { src: params.url as string } : {};

  // Leaf node — extract content from HTML
  const leaf = extractLeafContent(blockName, innerMarkup);

  // For wp:image — add dimensions from params if not already in img tag
  if (blockName === 'image') {
    if (!leaf.width && params?.width) leaf.width = params.width as number;
    if (!leaf.height && params?.height) leaf.height = params.height as number;
  }

  return compact({
    block: blockName,
    params,
    ...coverSrc,
    ...leaf,
  });
}

/**
 * Extract meaningful content from leaf HTML (no nested WP blocks).
 */
function extractLeafContent(blockName: string, html: string): Partial<WpNode> {
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
      ...(width ? { width: parseInt(width) } : {}),
      ...(height ? { height: parseInt(height) } : {}),
    };
  }

  // Button / link
  const aMatch = stripped.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (aMatch) {
    return { href: aMatch[1], text: stripTags(aMatch[2]) };
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
    return { text: textContent };
  }

  return {};
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
