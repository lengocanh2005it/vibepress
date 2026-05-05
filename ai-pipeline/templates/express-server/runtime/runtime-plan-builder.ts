import { createHash } from 'crypto';
import { basename, extname } from 'path';

type RuntimeParsedBlock = {
  blockName: string;
  attrs: Record<string, any>;
  innerHtml: string;
  children: RuntimeParsedBlock[];
};

function rebaseToSiteOrigin(url: string, siteUrl: string): string {
  try {
    const parsed = new URL(url);
    const site = new URL(siteUrl);
    if (parsed.origin !== site.origin) {
      parsed.protocol = site.protocol;
      parsed.hostname = site.hostname;
      parsed.port = site.port;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeWpUploadAssetUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || !/\/wp-content\/uploads\//i.test(trimmed)) return null;
  try {
    const siteUrl = process.env.SITE_URL?.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return siteUrl ? rebaseToSiteOrigin(trimmed, siteUrl) : new URL(trimmed).toString();
    }
    if (siteUrl) return new URL(trimmed, siteUrl).toString();
  } catch {
    // Fall through to returning the original string.
  }
  return trimmed;
}

function buildWpUploadAssetFileName(raw: string): string {
  const normalized = normalizeWpUploadAssetUrl(raw) ?? raw;
  let pathname = normalized;
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(/[?#]/)[0] ?? normalized;
  }
  const originalName = basename(pathname) || 'wp-asset';
  const ext = extname(originalName) || '.jpg';
  const safeExt = /^[.][a-zA-Z0-9]+$/.test(ext) ? ext.toLowerCase() : '.jpg';
  const baseName = basename(originalName, ext)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const safeBaseName = baseName || 'wp-asset';
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  return `${hash}-${safeBaseName}${safeExt}`;
}

function localizeWpUploadAssetUrl(raw: string | null | undefined): string | null {
  const normalized = normalizeWpUploadAssetUrl(raw);
  if (!normalized) return raw?.trim() ? String(raw).trim() : null;
  const previewBase = process.env.PREVIEW_BASE ?? '';
  return `${previewBase}assets/images/${buildWpUploadAssetFileName(normalized)}`;
}

function rewriteWpContentAssetUrls(html: string | null | undefined): string {
  if (!html) return '';
  return String(html).replace(
    /(?:https?:\/\/[^"'\s)]+)?\/wp-content\/uploads\/[^"'\s)]+/gi,
    (match: string) => localizeWpUploadAssetUrl(match) ?? match,
  );
}

function rewriteInternalLinks(html: string): string {
  if (!html) return '';
  const siteUrl = process.env.SITE_URL?.trim();
  if (!siteUrl) return html;
  try {
    const siteOrigin = new URL(siteUrl).origin;
    return html.replace(
      /\bhref=(["'])(https?:\/\/[^"'#\s>]+)(#[^"']*)?\1/gi,
      (full, quote: string, rawUrl: string, rawHash = '') => {
        try {
          const url = new URL(rawUrl);
          if (url.origin !== siteOrigin) return full;
          const normalizedPath = `${url.pathname}${url.search}${rawHash || url.hash || ''}` || '/';
          return `href=${quote}${normalizedPath}${quote}`;
        } catch {
          return full;
        }
      },
    );
  } catch {
    return html;
  }
}

function parseBlockAttrs(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseRuntimeBlocks(markup: string): RuntimeParsedBlock[] {
  const root: RuntimeParsedBlock = {
    blockName: '__root__',
    attrs: {},
    innerHtml: '',
    children: [],
  };
  const stack: RuntimeParsedBlock[] = [root];
  const tokenPattern =
    /<!--\s*(\/?)wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(?:\s+(\{[\s\S]*?\}))?\s*(\/)?-->/gi;

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(markup)) !== null) {
    const [token, closingSlash, blockNameRaw, attrsRaw, selfClosingSlash] =
      match;
    const current = stack[stack.length - 1];
    current.innerHtml += markup.slice(cursor, match.index);
    cursor = match.index + token.length;

    const blockName = normalizeRuntimeBlockName(blockNameRaw);
    const isClosing = Boolean(closingSlash);
    const isSelfClosing = Boolean(selfClosingSlash);

    if (isClosing) {
      if (stack.length > 1) {
        const completed = stack.pop()!;
        stack[stack.length - 1].children.push(completed);
      }
      continue;
    }

    const block: RuntimeParsedBlock = {
      blockName,
      attrs: parseBlockAttrs(attrsRaw),
      innerHtml: '',
      children: [],
    };

    if (isSelfClosing) {
      current.children.push(block);
    } else {
      stack.push(block);
    }
  }

  stack[stack.length - 1].innerHtml += markup.slice(cursor);

  while (stack.length > 1) {
    const completed = stack.pop()!;
    stack[stack.length - 1].children.push(completed);
  }

  return root.children;
}

function normalizeRuntimeBlockName(blockName: string): string {
  const normalized = String(blockName ?? '').trim().toLowerCase();
  if (!normalized) return 'core/group';
  return normalized.includes('/') ? normalized : `core/${normalized}`;
}

function stripAllHtml(html: string | null | undefined): string {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractFirstMatch(
  html: string,
  pattern: RegExp,
  group = 1,
): string | undefined {
  const match = pattern.exec(html);
  return match?.[group] ? String(match[group]).trim() : undefined;
}

function extractRuntimeClassNames(
  attrs: Record<string, any>,
  innerHtml: string,
): string[] {
  const collected = new Set<string>();
  const pushClassNames = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const entry of String(raw).split(/\s+/)) {
      const normalized = entry.trim();
      if (normalized) collected.add(normalized);
    }
  };

  pushClassNames(typeof attrs.className === 'string' ? attrs.className : null);
  pushClassNames(
    extractFirstMatch(innerHtml, /\bclass=(["'])([^"']+)\1/i, 2) ?? null,
  );
  return [...collected];
}

function extractRuntimeInfoBoxCard(
  block: RuntimeParsedBlock,
  index: number,
): Record<string, any> {
  const html = rewriteInternalLinks(rewriteWpContentAssetUrls(block.innerHtml.trim()));
  const attrs = block.attrs ?? {};
  return {
    heading:
      String(
        attrs.headingTitle ??
          attrs.title ??
          attrs.heading ??
          attrs.prefixTitle ??
          '',
      ).trim() ||
      extractFirstMatch(html, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
      extractFirstMatch(html, /<strong[^>]*>([\s\S]*?)<\/strong>/i) ||
      `Card ${index + 1}`,
    body:
      String(
        attrs.infoTitle ??
          attrs.infoText ??
          attrs.description ??
          attrs.body ??
          '',
      ).trim() ||
      extractFirstMatch(html, /<p[^>]*>([\s\S]*?)<\/p>/i) ||
      '',
    imageSrc:
      localizeWpUploadAssetUrl(
        (typeof attrs.imageUrl === 'string' && attrs.imageUrl.trim()) ||
          extractFirstMatch(html, /\bsrc=(["'])([^"']+)\1/i, 2),
      ) ??
      ((typeof attrs.imageUrl === 'string' && attrs.imageUrl.trim()) ||
        extractFirstMatch(html, /\bsrc=(["'])([^"']+)\1/i, 2)),
    imageAlt:
      (typeof attrs.imageAlt === 'string' && attrs.imageAlt.trim()) ||
      extractFirstMatch(html, /\balt=(["'])([^"']*)\1/i, 2),
    href:
      (typeof attrs.link === 'string' && attrs.link.trim()) ||
      extractFirstMatch(html, /\bhref=(["'])([^"']+)\1/i, 2),
  };
}

function extractRuntimeBoxSpacing(
  value: Record<string, any> | undefined,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const key of ['top', 'right', 'bottom', 'left'] as const) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) result[key] = raw.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractRuntimeBlockGap(
  value: unknown,
): string | { x?: string; y?: string } | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const x = typeof raw.left === 'string' ? raw.left.trim() : undefined;
  const y = typeof raw.top === 'string' ? raw.top.trim() : undefined;
  return x || y ? { ...(x ? { x } : {}), ...(y ? { y } : {}) } : undefined;
}

function buildRuntimeStyleSpec(block: RuntimeParsedBlock, classNames: string[]) {
  const spacing = block.attrs?.style?.spacing;
  const typography = block.attrs?.style?.typography;
  const dimensions = block.attrs?.style?.dimensions;
  const colors: Record<string, string> = {};
  if (typeof block.attrs?.textColor === 'string' && block.attrs.textColor.trim()) {
    colors.text = block.attrs.textColor.trim();
  }
  if (
    typeof block.attrs?.backgroundColor === 'string' &&
    block.attrs.backgroundColor.trim()
  ) {
    colors.background = block.attrs.backgroundColor.trim();
  }
  const styleSpec: Record<string, any> = {
    ...(classNames.length ? { classNames } : {}),
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(spacing
      ? {
          spacing: {
            ...(extractRuntimeBoxSpacing(spacing.margin) ? { margin: extractRuntimeBoxSpacing(spacing.margin) } : {}),
            ...(extractRuntimeBoxSpacing(spacing.padding)
              ? { padding: extractRuntimeBoxSpacing(spacing.padding) }
              : {}),
            ...(extractRuntimeBlockGap(spacing.blockGap)
              ? { blockGap: extractRuntimeBlockGap(spacing.blockGap) }
              : {}),
          },
        }
      : {}),
    ...(typography && typeof typography === 'object'
      ? {
          typography: {
            ...(typeof typography.fontSize === 'string' && typography.fontSize.trim()
              ? { fontSize: typography.fontSize.trim() }
              : {}),
            ...(typeof typography.lineHeight === 'string' &&
            typography.lineHeight.trim()
              ? { lineHeight: typography.lineHeight.trim() }
              : {}),
            ...(typeof typography.fontStyle === 'string' &&
            typography.fontStyle.trim()
              ? { fontWeight: typography.fontStyle.trim() }
              : {}),
            ...(typeof typography.textAlign === 'string' &&
            typography.textAlign.trim()
              ? { textAlign: typography.textAlign.trim() }
              : {}),
          },
        }
      : {}),
    ...(dimensions && typeof dimensions === 'object'
      ? {
          dimensions: {
            ...(typeof dimensions.minHeight === 'string' &&
            dimensions.minHeight.trim()
              ? { minHeight: dimensions.minHeight.trim() }
              : {}),
          },
        }
      : {}),
  };

  if (styleSpec.spacing && Object.keys(styleSpec.spacing).length === 0) {
    delete styleSpec.spacing;
  }
  if (styleSpec.typography && Object.keys(styleSpec.typography).length === 0) {
    delete styleSpec.typography;
  }
  if (styleSpec.dimensions && Object.keys(styleSpec.dimensions).length === 0) {
    delete styleSpec.dimensions;
  }

  return Object.keys(styleSpec).length > 0 ? styleSpec : undefined;
}

function buildRuntimeLayoutSpec(block: RuntimeParsedBlock) {
  const layout = block.attrs?.layout;
  const result: Record<string, any> = {};
  if (layout && typeof layout === 'object') {
    if (typeof layout.type === 'string' && layout.type.trim()) {
      result.kind = layout.type.trim();
    }
    if (typeof layout.justifyContent === 'string' && layout.justifyContent.trim()) {
      result.justifyContent = layout.justifyContent.trim();
    }
    if (
      typeof layout.verticalAlignment === 'string' &&
      layout.verticalAlignment.trim()
    ) {
      result.alignItems = layout.verticalAlignment.trim();
    }
    if (typeof layout.orientation === 'string' && layout.orientation.trim()) {
      result.orientation = layout.orientation.trim();
    }
  }
  if (typeof block.attrs?.align === 'string' && block.attrs.align.trim()) {
    result.align = block.attrs.align.trim();
  }
  if (typeof block.attrs?.width === 'string' && block.attrs.width.trim()) {
    result.columnWidth = block.attrs.width.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildRuntimeBlockNode(
  block: RuntimeParsedBlock,
  path: string,
): Record<string, any> {
  const kind = block.blockName.split('/').pop() || 'group';
  const innerHtml = block.innerHtml.trim();
  const childNodes = block.children.map((child, index) =>
    buildRuntimeBlockNode(child, `${path}.${index + 1}`),
  );
  const classNames = extractRuntimeClassNames(block.attrs, innerHtml);
  const attrs =
    Object.keys(block.attrs).length > 0 ? { ...block.attrs } : undefined;
  const styleSpec = buildRuntimeStyleSpec(block, classNames);
  const layoutSpec = buildRuntimeLayoutSpec(block);
  const wrapperTag =
    block.blockName === 'core/cover'
      ? 'section'
      : block.blockName === 'core/columns'
        ? 'section'
        : block.blockName === 'core/column'
          ? 'div'
          : undefined;
  const node: Record<string, any> = {
    nodeId: path,
    kind,
    blockName: block.blockName,
    sourceRef: { sourceNodeId: path },
    ...(attrs ? { attrs } : {}),
    ...(styleSpec ? { style: styleSpec } : {}),
    ...(layoutSpec ? { layout: layoutSpec } : {}),
    ...((wrapperTag || block.blockName === 'core/cover')
      ? {
          wrapper: {
            ...(wrapperTag ? { tagName: wrapperTag } : {}),
            ...(typeof block.attrs.anchor === 'string' && block.attrs.anchor.trim()
              ? { domId: block.attrs.anchor.trim() }
              : {}),
            preserveWrapper: true,
          },
        }
      : {}),
    ...(classNames.length ? { customClassNames: classNames } : {}),
    ...(typeof block.attrs.anchor === 'string' && block.attrs.anchor.trim()
      ? { domId: block.attrs.anchor.trim() }
      : {}),
    ...(childNodes.length ? { children: childNodes } : {}),
  };

  const headingLevel =
    Number(block.attrs.level ?? 0) ||
    Number(extractFirstMatch(innerHtml, /<h([1-6])\b/i));
  const src =
    (typeof block.attrs.url === 'string' && block.attrs.url.trim()) ||
    extractFirstMatch(innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2);
  const alt =
    (typeof block.attrs.alt === 'string' && block.attrs.alt.trim()) ||
    extractFirstMatch(innerHtml, /\balt=(["'])([^"']*)\1/i, 2);
  const href =
    (typeof block.attrs.url === 'string' && block.attrs.url.trim()) ||
    extractFirstMatch(innerHtml, /\bhref=(["'])([^"']+)\1/i, 2);
  const htmlText = innerHtml ? rewriteInternalLinks(rewriteWpContentAssetUrls(innerHtml)) : '';
  const text = stripAllHtml(innerHtml);

  if (
    [
      'core/heading',
      'core/paragraph',
      'core/list-item',
      'core/site-title',
      'core/site-tagline',
      'uagb/advanced-heading',
    ].includes(block.blockName)
  ) {
    if (htmlText) node.html = htmlText;
    if (text) node.text = text;
  }

  if (block.blockName === 'core/heading' && headingLevel > 0) {
    node.level = Math.max(1, Math.min(6, headingLevel));
  }

  if (
    [
      'core/image',
      'core/cover',
      'core/site-logo',
      'uagb/info-box',
      'uagb/slider-child',
    ].includes(block.blockName) &&
    src
  ) {
    node.src = localizeWpUploadAssetUrl(src) ?? src;
    if (alt) node.alt = alt;
  }

  if (
    ['core/button', 'core/navigation-link', 'uagb/icon-list'].includes(
      block.blockName,
    ) &&
    href
  ) {
    node.href = href;
    if (text) node.text = text;
  }

  if (
    ['core/group', 'core/columns', 'core/column', 'uagb/container', 'uagb/section'].includes(
      block.blockName,
    ) &&
    typeof block.attrs.backgroundColor === 'string'
  ) {
    node.bgColor = block.attrs.backgroundColor;
  }

  return node;
}

function collectRuntimeSectionsAndBindings(
  blocks: RuntimeParsedBlock[],
): {
  sections: Array<Record<string, any>>;
  bindings: Array<Record<string, any>>;
  unsupportedBlocks: string[];
} {
  const sections: Array<Record<string, any>> = [];
  const bindings: Array<Record<string, any>> = [];
  const unsupportedBlocks = new Set<string>();
  let counter = 0;
  const supportedInteractive = new Set([
    'uagb/tabs',
    'uagb/tabs-child',
    'uagb/slider',
    'uagb/slider-child',
    'uagb/faq',
    'uagb/faq-child',
    'uagb/content-toggle',
    'uagb/info-box',
    'uagb/container',
    'uagb/section',
    'uagb/advanced-heading',
    'uagb/icon-list',
  ]);

  const visit = (block: RuntimeParsedBlock, path: string) => {
    if (
      block.blockName.startsWith('uagb/') &&
      !supportedInteractive.has(block.blockName)
    ) {
      unsupportedBlocks.add(block.blockName);
    }

    const directInfoBoxes = block.children.filter(
      (child) => child.blockName === 'uagb/info-box',
    );
    if (directInfoBoxes.length >= 2) {
      const debugKey = `runtime-card-grid-${++counter}`;
      const sectionId = `runtime-section-${counter}`;
      sections.push({
        id: sectionId,
        type: 'card-grid',
        debugKey,
        sectionKey: sectionId,
        sourceNodeId: path,
        blockName: block.blockName,
        sourceRef: { sourceNodeId: path },
        columns: Math.min(Math.max(directInfoBoxes.length, 1), 4),
        title:
          extractFirstMatch(
            rewriteInternalLinks(rewriteWpContentAssetUrls(block.innerHtml.trim())),
            /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i,
          ) ?? undefined,
        subtitle:
          extractFirstMatch(
            rewriteInternalLinks(rewriteWpContentAssetUrls(block.innerHtml.trim())),
            /<p[^>]*>([\s\S]*?)<\/p>/i,
          ) ?? undefined,
        ...(buildRuntimeLayoutSpec(block)
          ? { layout: buildRuntimeLayoutSpec(block) }
          : {}),
        ...(buildRuntimeStyleSpec(
          block,
          extractRuntimeClassNames(block.attrs, block.innerHtml),
        )
          ? {
              style: buildRuntimeStyleSpec(
                block,
                extractRuntimeClassNames(block.attrs, block.innerHtml),
              ),
            }
          : {}),
        cards: directInfoBoxes.map((child, index) =>
          extractRuntimeInfoBoxCard(child, index),
        ),
      });
      bindings.push({
        nodeId: path,
        blockName: block.blockName,
        renderer: 'card-grid',
        preserveWrapper: true,
        preserveChildrenOrder: true,
        childCount: directInfoBoxes.length,
        sectionId,
        sectionDebugKey: debugKey,
      });
      block.children
        .filter((child) => child.blockName !== 'uagb/info-box')
        .forEach((child, index) => visit(child, `${path}.${index + 1}`));
      return;
    }

    if (block.blockName === 'uagb/tabs') {
      const debugKey = `runtime-tabs-${++counter}`;
      const sectionId = `runtime-section-${counter}`;
      sections.push({
        id: sectionId,
        type: 'tabs',
        debugKey,
        sectionKey: sectionId,
        sourceNodeId: path,
        blockName: block.blockName,
        sourceRef: { sourceNodeId: path },
        tabs: block.children.map((child, index) => ({
          heading:
            String(child.attrs.heading ?? child.attrs.title ?? '').trim() ||
            extractFirstMatch(child.innerHtml, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
            `Tab ${index + 1}`,
          body: rewriteInternalLinks(rewriteWpContentAssetUrls(child.innerHtml.trim())),
          imageSrc:
            localizeWpUploadAssetUrl(
              extractFirstMatch(child.innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2),
            ) ??
            extractFirstMatch(child.innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2),
          imageAlt: extractFirstMatch(child.innerHtml, /\balt=(["'])([^"']*)\1/i, 2),
        })),
      });
      bindings.push({
        nodeId: path,
        blockName: block.blockName,
        renderer: 'tabs',
        preserveWrapper: true,
        preserveChildrenOrder: true,
        childCount: block.children.length,
        sectionId,
        sectionDebugKey: debugKey,
      });
    } else if (block.blockName === 'uagb/slider') {
      const debugKey = `runtime-carousel-${++counter}`;
      const sectionId = `runtime-section-${counter}`;
      sections.push({
        id: sectionId,
        type: 'carousel',
        debugKey,
        sectionKey: sectionId,
        sourceNodeId: path,
        blockName: block.blockName,
        sourceRef: { sourceNodeId: path },
        slides: block.children.map((child, index) => ({
          heading:
            extractFirstMatch(child.innerHtml, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) ||
            `Slide ${index + 1}`,
          body: rewriteInternalLinks(rewriteWpContentAssetUrls(child.innerHtml.trim())),
          imageSrc:
            localizeWpUploadAssetUrl(
              extractFirstMatch(child.innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2),
            ) ??
            extractFirstMatch(child.innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2),
          imageAlt: extractFirstMatch(child.innerHtml, /\balt=(["'])([^"']*)\1/i, 2),
        })),
      });
      bindings.push({
        nodeId: path,
        blockName: block.blockName,
        renderer: 'carousel',
        preserveWrapper: true,
        preserveChildrenOrder: true,
        childCount: block.children.length,
        sectionId,
        sectionDebugKey: debugKey,
      });
    } else if (
      block.blockName === 'uagb/faq' ||
      block.blockName === 'uagb/content-toggle'
    ) {
      const debugKey = `runtime-accordion-${++counter}`;
      const sectionId = `runtime-section-${counter}`;
      sections.push({
        id: sectionId,
        type: 'accordion',
        debugKey,
        sectionKey: sectionId,
        sourceNodeId: path,
        blockName: block.blockName,
        sourceRef: { sourceNodeId: path },
        items: block.children.map((child, index) => ({
          heading:
            String(
              child.attrs.question ??
                child.attrs.heading ??
                child.attrs.title ??
                '',
            ).trim() || `Item ${index + 1}`,
          body: rewriteInternalLinks(rewriteWpContentAssetUrls(child.innerHtml.trim())),
        })),
      });
      bindings.push({
        nodeId: path,
        blockName: block.blockName,
        renderer: 'accordion',
        preserveWrapper: true,
        preserveChildrenOrder: true,
        childCount: block.children.length,
        sectionId,
        sectionDebugKey: debugKey,
      });
    } else if (block.blockName === 'uagb/info-box') {
      const debugKey = `runtime-card-grid-${++counter}`;
      const sectionId = `runtime-section-${counter}`;
      sections.push({
        id: sectionId,
        type: 'card-grid',
        debugKey,
        sectionKey: sectionId,
        sourceNodeId: path,
        blockName: block.blockName,
        sourceRef: { sourceNodeId: path },
        columns: 1,
        cards: [extractRuntimeInfoBoxCard(block, 0)],
      });
      bindings.push({
        nodeId: path,
        blockName: block.blockName,
        renderer: 'card-grid',
        preserveWrapper: true,
        preserveChildrenOrder: true,
        childCount: block.children.length,
        sectionId,
        sectionDebugKey: debugKey,
      });
    }

    block.children.forEach((child, index) => visit(child, `${path}.${index + 1}`));
  };

  blocks.forEach((block, index) => visit(block, `root.${index + 1}`));

  return {
    sections,
    bindings,
    unsupportedBlocks: [...unsupportedBlocks],
  };
}

export function buildRuntimePlanFromPageRow(row: any) {
  const markup = String(row.post_content ?? '');
  const blocks = parseRuntimeBlocks(markup);
  const blockTree = blocks.map((block, index) =>
    buildRuntimeBlockNode(block, `root.${index + 1}`),
  );
  const runtimeSignals = collectRuntimeSectionsAndBindings(blocks);
  const hasInteractiveSections = runtimeSignals.sections.length > 0;
  return {
    version: 2,
    mode:
      blockTree.length === 0
        ? 'page-content'
        : hasInteractiveSections
          ? 'hybrid'
          : 'block-centric',
    fidelity:
      runtimeSignals.unsupportedBlocks.length > 0
        ? 'best-effort'
        : 'strict-structure',
    layoutFamily: 'default-page',
    source: {
      kind: 'page-post-content',
      template: String(row.template ?? '').trim() || 'default',
      slug: String(row.post_name ?? '').trim(),
      sourceSummary:
        blockTree.length > 0
          ? `runtime block tree with ${blockTree.length} root node(s)`
          : 'page-content fallback',
    },
    support: {
      safeForRuntime: runtimeSignals.unsupportedBlocks.length === 0,
      unsupportedBlocks: runtimeSignals.unsupportedBlocks,
    },
    dataNeeds: ['page-detail'],
    sections: runtimeSignals.sections,
    blockTree,
    subtreeBindings: runtimeSignals.bindings,
  };
}
