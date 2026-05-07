import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { basename, extname, join } from 'path';

type RuntimeParsedBlock = {
  blockName: string;
  attrs: Record<string, any>;
  innerHtml: string;
  children: RuntimeParsedBlock[];
};

interface RuntimeSectionExtractionOptions {
  preserveSourceStructuralBlocks?: boolean;
}

function inferRuntimeThemeSlug(themeDir?: string | null): string {
  const normalized = String(themeDir ?? '')
    .trim()
    .replace(/[\\/]+$/, '');
  return normalized ? basename(normalized).toLowerCase() : '';
}

function normalizeRuntimeTemplateSlug(template: unknown): string {
  return String(template ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^templates\//i, '')
    .replace(/\.(html|php)$/i, '')
    .toLowerCase();
}

function shouldPreserveSourceStructuralBlocks(
  row: any,
  themeSlug: string,
): boolean {
  if (themeSlug !== 'profolio-fse') return false;
  const template = normalizeRuntimeTemplateSlug(row?.template);
  const isFrontPage = Number(row?.is_front_page ?? 0) === 1;
  return (
    isFrontPage ||
    !template ||
    [
      'default',
      'page',
      'front-page',
      'template-about',
      'template-contact',
      'template-services',
      'blank',
      'full-width',
    ].includes(template)
  );
}

function deriveRuntimeLayoutFamily(row: any, themeSlug: string): string {
  if (themeSlug !== 'profolio-fse') return 'default-page';
  const template = normalizeRuntimeTemplateSlug(row?.template);
  if (Number(row?.is_front_page ?? 0) === 1) {
    return 'profolio-fse-front-page';
  }
  switch (template) {
    case 'front-page':
      return 'profolio-fse-front-page';
    case 'template-about':
      return 'profolio-fse-about-page';
    case 'template-contact':
      return 'profolio-fse-contact-page';
    case 'template-services':
      return 'profolio-fse-services-page';
    case 'blank':
      return 'profolio-fse-blank-page';
    case 'full-width':
      return 'profolio-fse-full-width-page';
    default:
      return 'profolio-fse-default-page';
  }
}

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
  const layoutType =
    typeof attrs.layout?.type === 'string' ? attrs.layout.type.trim() : '';
  if (layoutType === 'flex') collected.add('is-layout-flex');
  if (layoutType === 'grid') collected.add('is-layout-grid');
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

function rewriteRuntimeHtml(html: string | null | undefined): string {
  return rewriteInternalLinks(rewriteWpContentAssetUrls(String(html ?? '').trim()));
}

function walkRuntimeBlocks(
  block: RuntimeParsedBlock,
  visit: (candidate: RuntimeParsedBlock) => void,
) {
  visit(block);
  block.children.forEach((child) => walkRuntimeBlocks(child, visit));
}

function findFirstRuntimeBlock(
  block: RuntimeParsedBlock,
  blockNames: string[],
): RuntimeParsedBlock | null {
  let result: RuntimeParsedBlock | null = null;
  walkRuntimeBlocks(block, (candidate) => {
    if (!result && blockNames.includes(candidate.blockName)) {
      result = candidate;
    }
  });
  return result;
}

function collectRuntimeBlocks(
  block: RuntimeParsedBlock,
  predicate: (candidate: RuntimeParsedBlock) => boolean,
): RuntimeParsedBlock[] {
  const matches: RuntimeParsedBlock[] = [];
  walkRuntimeBlocks(block, (candidate) => {
    if (predicate(candidate)) matches.push(candidate);
  });
  return matches;
}

function extractRuntimeImageData(
  block: RuntimeParsedBlock,
): { src?: string; alt?: string } {
  const attrs = block.attrs ?? {};
  const directCandidates = [
    attrs.mediaUrl,
    attrs.imageUrl,
    attrs.url,
    attrs.backgroundImageUrl,
    attrs?.backgroundImage?.url,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

  const directSrc =
    directCandidates[0] ||
    extractFirstMatch(rewriteRuntimeHtml(block.innerHtml), /\bsrc=(["'])([^"']+)\1/i, 2);
  const directAlt =
    (typeof attrs.mediaAlt === 'string' && attrs.mediaAlt.trim()) ||
    (typeof attrs.imageAlt === 'string' && attrs.imageAlt.trim()) ||
    (typeof attrs.alt === 'string' && attrs.alt.trim()) ||
    extractFirstMatch(rewriteRuntimeHtml(block.innerHtml), /\balt=(["'])([^"']*)\1/i, 2);

  if (directSrc) {
    return {
      src: localizeWpUploadAssetUrl(directSrc) ?? directSrc,
      alt: directAlt,
    };
  }

  for (const child of block.children) {
    const childImage = extractRuntimeImageData(child);
    if (childImage.src) return childImage;
  }

  return {};
}

function extractRuntimeSectionText(block: RuntimeParsedBlock): {
  title?: string;
  body?: string;
} {
  const titleBlock = findFirstRuntimeBlock(block, [
    'core/heading',
    'uagb/advanced-heading',
  ]);
  const title =
    titleBlock &&
    (stripAllHtml(titleBlock.innerHtml) ||
      String(titleBlock.attrs.heading ?? titleBlock.attrs.title ?? '').trim());

  const bodyBlocks = collectRuntimeBlocks(
    block,
    (candidate) =>
      [
        'core/paragraph',
        'core/list-item',
        'core/button',
        'core/navigation-link',
      ].includes(candidate.blockName) &&
      rewriteRuntimeHtml(candidate.innerHtml).length > 0,
  );
  const body = bodyBlocks
    .map((candidate) => rewriteRuntimeHtml(candidate.innerHtml))
    .filter(Boolean)
    .join('');

  return {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
}

function extractRuntimeColumnCard(
  block: RuntimeParsedBlock,
  index: number,
): Record<string, any> | null {
  const image = extractRuntimeImageData(block);
  const text = extractRuntimeSectionText(block);
  const href = extractFirstMatch(
    rewriteRuntimeHtml(block.innerHtml),
    /\bhref=(["'])([^"']+)\1/i,
    2,
  );
  if (!text.title && !text.body && !image.src) return null;
  return {
    heading: text.title ?? `Card ${index + 1}`,
    body: text.body ?? '',
    ...(image.src ? { imageSrc: image.src } : {}),
    ...(image.alt ? { imageAlt: image.alt } : {}),
    ...(href ? { href } : {}),
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
  if (
    typeof block.attrs?.overlayColor === 'string' &&
    block.attrs.overlayColor.trim()
  ) {
    colors.overlay = block.attrs.overlayColor.trim();
  } else if (
    typeof block.attrs?.customOverlayColor === 'string' &&
    block.attrs.customOverlayColor.trim()
  ) {
    colors.overlay = block.attrs.customOverlayColor.trim();
  }
  const borderRadius =
    typeof block.attrs?.style?.border?.radius === 'string' &&
    block.attrs.style.border.radius.trim()
      ? block.attrs.style.border.radius.trim()
      : undefined;
  const blockGap = extractRuntimeBlockGap(spacing?.blockGap);
  const gap =
    typeof blockGap === 'string'
      ? blockGap
      : typeof block.attrs?.gap === 'string' && block.attrs.gap.trim()
        ? block.attrs.gap.trim()
        : undefined;
  const styleSpec: Record<string, any> = {
    ...(classNames.length ? { classNames } : {}),
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(borderRadius ? { borderRadius } : {}),
    ...(gap ? { gap } : {}),
    ...(spacing
      ? {
          spacing: {
            ...(extractRuntimeBoxSpacing(spacing.margin) ? { margin: extractRuntimeBoxSpacing(spacing.margin) } : {}),
            ...(extractRuntimeBoxSpacing(spacing.padding)
              ? { padding: extractRuntimeBoxSpacing(spacing.padding) }
              : {}),
            ...(blockGap ? { blockGap } : {}),
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
            ...(typeof typography.fontWeight === 'string' &&
            typography.fontWeight.trim()
              ? { fontWeight: typography.fontWeight.trim() }
              : typeof typography.fontStyle === 'string' &&
                  typography.fontStyle.trim()
                ? { fontWeight: typography.fontStyle.trim() }
              : {}),
            ...(typeof typography.textAlign === 'string' &&
            typography.textAlign.trim()
              ? { textAlign: typography.textAlign.trim() }
              : {}),
            ...(typeof typography.fontFamily === 'string' &&
            typography.fontFamily.trim()
              ? { fontFamily: typography.fontFamily.trim() }
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
            ...(typeof dimensions.width === 'string' &&
            dimensions.width.trim()
              ? { width: dimensions.width.trim() }
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
    if (
      typeof layout.minimumColumnWidth === 'string' &&
      layout.minimumColumnWidth.trim()
    ) {
      result.minimumColumnWidth = layout.minimumColumnWidth.trim();
    }
    if (typeof layout.flexWrap === 'string' && layout.flexWrap.trim()) {
      result.flexWrap = layout.flexWrap.trim();
    }
    if (typeof layout.columnCount === 'number' && layout.columnCount > 0) {
      result.columns = layout.columnCount;
    }
  }
  if (
    typeof block.attrs?.mediaPosition === 'string' &&
    block.attrs.mediaPosition.trim()
  ) {
    result.orientation = block.attrs.mediaPosition.trim();
  }
  if (typeof block.attrs?.align === 'string' && block.attrs.align.trim()) {
    result.align = block.attrs.align.trim();
  }
  if (typeof block.attrs?.width === 'string' && block.attrs.width.trim()) {
    result.columnWidth = block.attrs.width.trim();
  }
  if (typeof block.attrs?.columns === 'number' && block.attrs.columns > 0) {
    result.columns = block.attrs.columns;
  } else if (
    block.blockName === 'core/columns' ||
    block.blockName === 'uagb/container' ||
    block.blockName === 'uagb/section'
  ) {
    const visibleColumns = block.children.filter((child) =>
      ['core/column', 'uagb/container', 'uagb/section'].includes(child.blockName),
    ).length;
    if (visibleColumns > 0) result.columns = visibleColumns;
  } else if (
    layout &&
    typeof layout === 'object' &&
    layout.type === 'grid' &&
    typeof result.columns !== 'number'
  ) {
    const childCount = block.children.length;
    if (childCount > 1) result.columns = childCount;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildRuntimeBlockNode(
  block: RuntimeParsedBlock,
  path: string,
): Record<string, any> {
  const kind =
    block.blockName === 'core/media-text'
      ? 'media-text'
      : block.blockName === 'core/cover'
        ? 'cover'
        : block.blockName === 'core/columns'
          ? 'columns'
          : block.blockName === 'core/column'
            ? 'column'
            : block.blockName.split('/').pop() || 'group';
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
          : block.blockName === 'core/media-text'
            ? 'section'
            : block.blockName === 'core/group' ||
                block.blockName === 'uagb/container' ||
                block.blockName === 'uagb/section'
              ? 'section'
          : undefined;
  const image = extractRuntimeImageData(block);
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
    ...(styleSpec?.colors?.background ? { bgColor: styleSpec.colors.background } : {}),
    ...(styleSpec?.colors?.text ? { textColor: styleSpec.colors.text } : {}),
    ...(styleSpec?.colors?.overlay ? { overlayColor: styleSpec.colors.overlay } : {}),
    ...(styleSpec?.borderRadius ? { borderRadius: styleSpec.borderRadius } : {}),
    ...(styleSpec?.gap ? { gap: styleSpec.gap } : {}),
    ...(styleSpec?.spacing?.padding ? { padding: styleSpec.spacing.padding } : {}),
    ...(styleSpec?.spacing?.margin ? { margin: styleSpec.spacing.margin } : {}),
    ...(styleSpec?.dimensions?.minHeight ? { minHeight: styleSpec.dimensions.minHeight } : {}),
    ...(styleSpec?.typography?.fontFamily ? { fontFamily: styleSpec.typography.fontFamily } : {}),
    ...(styleSpec?.typography?.textAlign ? { textAlign: styleSpec.typography.textAlign } : {}),
    ...(layoutSpec?.columnWidth ? { columnWidth: layoutSpec.columnWidth } : {}),
    ...(layoutSpec?.justifyContent ? { justifyContent: layoutSpec.justifyContent } : {}),
    ...(layoutSpec?.alignItems ? { align: layoutSpec.alignItems } : {}),
    ...(typeof block.attrs.anchor === 'string' && block.attrs.anchor.trim()
      ? { domId: block.attrs.anchor.trim() }
      : {}),
    ...(childNodes.length ? { children: childNodes } : {}),
  };

  const headingLevel =
    Number(block.attrs.level ?? 0) ||
    Number(extractFirstMatch(innerHtml, /<h([1-6])\b/i));
  const src =
    image.src ||
    ((typeof block.attrs.url === 'string' && block.attrs.url.trim()) ||
      extractFirstMatch(innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2));
  const alt =
    image.alt ||
    ((typeof block.attrs.alt === 'string' && block.attrs.alt.trim()) ||
      extractFirstMatch(innerHtml, /\balt=(["'])([^"']*)\1/i, 2));
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
      'core/button',
      'core/navigation-link',
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
      'core/media-text',
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

  if (block.blockName === 'core/media-text' && !node.layout) {
    node.layout = { kind: 'grid', columns: 2 };
  }

  if (block.blockName === 'core/cover') {
    if (block.attrs.hasParallax === true) node.hasParallax = true;
    const fp = block.attrs.focalPoint;
    if (fp && typeof fp === 'object') {
      const fpObj = fp as Record<string, unknown>;
      const x = typeof fpObj.x === 'number' ? fpObj.x : parseFloat(String(fpObj.x ?? ''));
      const y = typeof fpObj.y === 'number' ? fpObj.y : parseFloat(String(fpObj.y ?? ''));
      if (!isNaN(x) && !isNaN(y)) node.focalPoint = { x, y };
    }
  }

  if (['core/image', 'core/site-logo'].includes(block.blockName)) {
    const w = typeof block.attrs.width === 'number' ? block.attrs.width
      : parseInt(String(block.attrs.width ?? ''), 10);
    const h = typeof block.attrs.height === 'number' ? block.attrs.height
      : parseInt(String(block.attrs.height ?? ''), 10);
    if (!isNaN(w) && w > 0) node.width = w;
    if (!isNaN(h) && h > 0) node.height = h;
  }

  if (['core/table', 'core/verse', 'core/html', 'core/preformatted', 'core/code'].includes(block.blockName)) {
    if (innerHtml && !node.html) node.html = rewriteRuntimeHtml(innerHtml);
  }

  return node;
}

function collectRuntimeSectionsAndBindings(
  blocks: RuntimeParsedBlock[],
  options: RuntimeSectionExtractionOptions = {},
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
    'uagb/icon-list-child',
    'uagb/buttons',
    'uagb/button-group',
    'uagb/image',
  ]);
  const preserveSourceStructuralBlocks =
    options.preserveSourceStructuralBlocks === true;

  const buildSectionBase = (
    block: RuntimeParsedBlock,
    path: string,
    type: string,
  ) => {
    const sectionId = `runtime-section-${++counter}`;
    const debugKey = `runtime-${type}-${counter}`;
    return {
      sectionId,
      debugKey,
      base: {
        id: sectionId,
        type,
        debugKey,
        sectionKey: sectionId,
        sourceNodeId: path,
        blockName: block.blockName,
        sourceRef: { sourceNodeId: path },
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
      },
    };
  };

  const pushBinding = (
    block: RuntimeParsedBlock,
    path: string,
    renderer: string,
    sectionId: string,
    debugKey: string,
  ) => {
    bindings.push({
      nodeId: path,
      blockName: block.blockName,
      renderer,
      preserveWrapper: true,
      preserveChildrenOrder: true,
      childCount: block.children.length,
      sectionId,
      sectionDebugKey: debugKey,
    });
  };

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
    if (!preserveSourceStructuralBlocks && directInfoBoxes.length >= 2) {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'card-grid',
      );
      sections.push({
        ...base,
        columns: Math.min(Math.max(directInfoBoxes.length, 1), 4),
        ...extractRuntimeSectionText(block),
        cards: directInfoBoxes.map((child, index) =>
          extractRuntimeInfoBoxCard(child, index),
        ),
      });
      pushBinding(block, path, 'card-grid', sectionId, debugKey);
      block.children
        .filter((child) => child.blockName !== 'uagb/info-box')
        .forEach((child, index) => visit(child, `${path}.${index + 1}`));
      return;
    }

    if (!preserveSourceStructuralBlocks && block.blockName === 'core/media-text') {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'media-text',
      );
      const image = extractRuntimeImageData(block);
      sections.push({
        ...base,
        ...extractRuntimeSectionText(block),
        ...(image.src ? { imageSrc: image.src } : {}),
        ...(image.alt ? { imageAlt: image.alt } : {}),
      });
      pushBinding(block, path, 'media-text', sectionId, debugKey);
      return;
    }

    if (!preserveSourceStructuralBlocks && block.blockName === 'core/cover') {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'cover',
      );
      const image = extractRuntimeImageData(block);
      const text = extractRuntimeSectionText(block);
      if (image.src || text.title || text.body) {
        const coverHasParallax = block.attrs.hasParallax === true;
        const coverFpRaw = block.attrs.focalPoint;
        const coverFp =
          coverFpRaw && typeof coverFpRaw === 'object'
            ? (() => {
                const fp = coverFpRaw as Record<string, unknown>;
                const x = typeof fp.x === 'number' ? fp.x : parseFloat(String(fp.x ?? ''));
                const y = typeof fp.y === 'number' ? fp.y : parseFloat(String(fp.y ?? ''));
                return !isNaN(x) && !isNaN(y) ? { x, y } : null;
              })()
            : null;
        sections.push({
          ...base,
          ...text,
          ...(image.src ? { imageSrc: image.src } : {}),
          ...(image.alt ? { imageAlt: image.alt } : {}),
          ...(coverHasParallax ? { hasParallax: true } : {}),
          ...(coverFp ? { focalPoint: coverFp } : {}),
        });
        pushBinding(block, path, 'cover', sectionId, debugKey);
        return;
      }
    }

    if (!preserveSourceStructuralBlocks && block.blockName === 'core/columns') {
      const cards = block.children
        .filter((child) => child.blockName === 'core/column')
        .map((child, index) => extractRuntimeColumnCard(child, index))
        .filter((card): card is Record<string, any> => Boolean(card));
      if (cards.length >= 2) {
        const { sectionId, debugKey, base } = buildSectionBase(
          block,
          path,
          'card-grid',
        );
        sections.push({
          ...base,
          ...extractRuntimeSectionText(block),
          columns: cards.length,
          cards,
        });
        pushBinding(block, path, 'card-grid', sectionId, debugKey);
        return;
      }
    }

    if (
      !preserveSourceStructuralBlocks &&
      ['core/group', 'uagb/container', 'uagb/section'].includes(block.blockName)
    ) {
      const image = extractRuntimeImageData(block);
      const text = extractRuntimeSectionText(block);
      if (image.src && (text.title || text.body)) {
        const { sectionId, debugKey, base } = buildSectionBase(
          block,
          path,
          'media-text',
        );
        sections.push({
          ...base,
          ...text,
          ...(image.src ? { imageSrc: image.src } : {}),
          ...(image.alt ? { imageAlt: image.alt } : {}),
        });
        pushBinding(block, path, 'media-text', sectionId, debugKey);
        return;
      }
    }

    if (!preserveSourceStructuralBlocks && block.blockName === 'core/gallery') {
      const imageBlocks = block.children.filter((c) => c.blockName === 'core/image');
      if (imageBlocks.length > 0) {
        const { sectionId, debugKey, base } = buildSectionBase(block, path, 'card-grid');
        const cards = imageBlocks
          .map((child, index) => {
            const img = extractRuntimeImageData(child);
            if (!img.src) return null;
            const caption =
              typeof child.attrs.caption === 'string' ? child.attrs.caption.trim() : '';
            return {
              heading: caption || `Image ${index + 1}`,
              imageSrc: img.src,
              ...(img.alt ? { imageAlt: img.alt } : {}),
            };
          })
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        if (cards.length > 0) {
          const cols =
            typeof block.attrs.columns === 'number'
              ? block.attrs.columns
              : Math.min(cards.length, 3);
          sections.push({ ...base, columns: cols, cards });
          pushBinding(block, path, 'card-grid', sectionId, debugKey);
          return;
        }
      }
    }

    if (block.blockName === 'uagb/tabs') {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'tabs',
      );
      sections.push({
        ...base,
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
      pushBinding(block, path, 'tabs', sectionId, debugKey);
    } else if (block.blockName === 'uagb/slider') {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'carousel',
      );
      sections.push({
        ...base,
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
      pushBinding(block, path, 'carousel', sectionId, debugKey);
    } else if (
      block.blockName === 'uagb/faq' ||
      block.blockName === 'uagb/content-toggle'
    ) {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'accordion',
      );
      sections.push({
        ...base,
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
      pushBinding(block, path, 'accordion', sectionId, debugKey);
    } else if (block.blockName === 'uagb/info-box') {
      const { sectionId, debugKey, base } = buildSectionBase(
        block,
        path,
        'card-grid',
      );
      sections.push({
        ...base,
        columns: 1,
        cards: [extractRuntimeInfoBoxCard(block, 0)],
      });
      pushBinding(block, path, 'card-grid', sectionId, debugKey);
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

function stripPhpPatternHeader(markup: string): string {
  const firstBlockIndex = markup.search(/<!--\s*wp:/i);
  return firstBlockIndex > 0 ? markup.slice(firstBlockIndex) : markup;
}

function expandTemplateMarkup(
  markup: string,
  postContent: string,
  themeDir: string,
  seen: Set<string>,
  depth = 0,
): string {
  if (depth > 5) return markup;

  markup = markup.replace(/<!--\s*wp:template-part\s+\{[^}]*\}\s*\/-->/gi, '');

  markup = markup.replace(
    /<!--\s*wp:pattern\s+(\{[^}]*\})\s*\/-->/gi,
    (_full, attrsRaw: string) => {
      try {
        const attrs = JSON.parse(attrsRaw) as { slug?: unknown };
        const slug = String(attrs.slug ?? '').trim();
        if (!slug || seen.has(slug)) return '';
        const patternName = slug.includes('/') ? slug.split('/').slice(1).join('/') : slug;
        for (const ext of ['.php', '.html']) {
          const patternPath = join(themeDir, 'patterns', `${patternName}${ext}`);
          if (existsSync(patternPath)) {
            const raw = readFileSync(patternPath, 'utf-8');
            const cleaned = stripPhpPatternHeader(raw);
            const nextSeen = new Set(seen);
            nextSeen.add(slug);
            return expandTemplateMarkup(cleaned, postContent, themeDir, nextSeen, depth + 1);
          }
        }
        return '';
      } catch {
        return '';
      }
    },
  );

  markup = markup.replace(
    /<!--\s*wp:post-content(?:\s+\{[^}]*\})?\s*\/-->/gi,
    postContent,
  );
  markup = markup.replace(
    /<!--\s*wp:page-content(?:\s+\{[^}]*\})?\s*\/-->/gi,
    postContent,
  );

  return markup;
}

function buildRuntimeTemplateCandidates(row: any): string[] {
  const normalizedTemplate = normalizeRuntimeTemplateSlug(row?.template);
  const isFrontPage = Number(row?.is_front_page ?? 0) === 1;
  const isPostsPage = Number(row?.is_posts_page ?? 0) === 1;
  const candidates = new Set<string>();

  if (isFrontPage) candidates.add('front-page.html');
  if (normalizedTemplate) candidates.add(`${normalizedTemplate}.html`);
  if (isPostsPage) {
    candidates.add('home.html');
    candidates.add('index.html');
  }
  candidates.add('page.html');

  return [...candidates];
}

export function resolveRuntimePageMarkupFromRow(row: any): string {
  const themeDir = process.env.THEME_DIR?.trim();
  const postContent = String(row.post_content ?? '');
  if (!themeDir) return postContent;

  for (const fileName of buildRuntimeTemplateCandidates(row)) {
    const templatePath = join(themeDir, 'templates', fileName);
    if (existsSync(templatePath)) {
      try {
        const templateMarkup = readFileSync(templatePath, 'utf-8');
        const resolved = expandTemplateMarkup(templateMarkup, postContent, themeDir, new Set());
        if (resolved.trim()) return resolved;
      } catch {
        // fall through to next candidate
      }
    }
  }

  return postContent;
}

export function buildRuntimePlanFromPageRow(row: any) {
  const themeSlug = inferRuntimeThemeSlug(process.env.THEME_DIR);
  const normalizedTemplate = normalizeRuntimeTemplateSlug(row?.template);
  const resolvedTemplate =
    normalizedTemplate ||
    (Number(row?.is_front_page ?? 0) === 1 ? 'front-page' : 'default');
  const markup = resolveRuntimePageMarkupFromRow(row);
  const blocks = parseRuntimeBlocks(markup);
  const blockTree = blocks.map((block, index) =>
    buildRuntimeBlockNode(block, `root.${index + 1}`),
  );
  const runtimeSignals = collectRuntimeSectionsAndBindings(blocks, {
    preserveSourceStructuralBlocks: shouldPreserveSourceStructuralBlocks(
      row,
      themeSlug,
    ),
  });
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
    layoutFamily: deriveRuntimeLayoutFamily(row, themeSlug),
    source: {
      kind: 'page-post-content',
      template: resolvedTemplate,
      slug: String(row.post_name ?? '').trim(),
      templateExpanded: Boolean(process.env.THEME_DIR?.trim()),
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
