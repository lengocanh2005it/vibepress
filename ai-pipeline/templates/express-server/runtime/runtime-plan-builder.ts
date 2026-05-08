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

type RuntimeLayoutContext = Record<string, any>;

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

function toRuntimeStylePropertyName(property: string): string {
  return property
    .trim()
    .replace(/^-ms-/, 'ms-')
    .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function parseRuntimeInlineStyle(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const result: Record<string, string> = {};
  for (const declaration of String(raw).split(';')) {
    const [property, ...valueParts] = declaration.split(':');
    const value = valueParts.join(':').trim();
    const name = toRuntimeStylePropertyName(property ?? '');
    if (name && value) result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractRuntimeFirstElement(block: RuntimeParsedBlock): {
  tagName?: string;
  attrsText?: string;
} {
  const match = /<([a-z0-9-]+)\b([^>]*)>/i.exec(block.innerHtml);
  if (!match) return {};
  return {
    tagName: match[1]?.toLowerCase(),
    attrsText: match[2] ?? '',
  };
}

function extractRuntimeHtmlAttr(attrsText: string | undefined, attr: string): string | undefined {
  if (!attrsText) return undefined;
  const pattern = new RegExp(`\\b${attr}=([\"'])(.*?)\\1`, 'i');
  const match = pattern.exec(attrsText);
  return match?.[2]?.trim() || undefined;
}

function extractRuntimeDomSpec(
  block: RuntimeParsedBlock,
  classNames: string[],
  wrapperTag?: string,
): Record<string, any> | undefined {
  const firstElement = extractRuntimeFirstElement(block);
  const inlineStyle = parseRuntimeInlineStyle(
    extractRuntimeHtmlAttr(firstElement.attrsText, 'style'),
  );
  const domId =
    (typeof block.attrs?.anchor === 'string' && block.attrs.anchor.trim()) ||
    extractRuntimeHtmlAttr(firstElement.attrsText, 'id');
  const tagName =
    (typeof block.attrs?.tagName === 'string' && block.attrs.tagName.trim()) ||
    firstElement.tagName ||
    wrapperTag;
  const result: Record<string, any> = {
    ...(tagName ? { tagName } : {}),
    ...(domId ? { domId } : {}),
    ...(classNames.length ? { classNames } : {}),
    ...(inlineStyle ? { style: inlineStyle } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function deriveRuntimeWidthPolicy(
  block: RuntimeParsedBlock,
  layoutSpec: Record<string, any> | undefined,
  classNames: string[],
): Record<string, string> {
  const align =
    layoutSpec?.align ||
    (typeof block.attrs?.align === 'string' ? block.attrs.align.trim() : '');
  const hasAlignFull = align === 'full' || classNames.includes('alignfull');
  const hasAlignWide = align === 'wide' || classNames.includes('alignwide');
  const isConstrained = layoutSpec?.kind === 'constrained';

  if (hasAlignFull) {
    return {
      widthPolicy: 'full-bleed',
      ...(isConstrained ? { innerWidthPolicy: 'content' } : {}),
    };
  }
  if (hasAlignWide) {
    return {
      widthPolicy: 'wide',
      ...(isConstrained ? { innerWidthPolicy: 'content' } : {}),
    };
  }
  if (isConstrained) {
    return {
      widthPolicy: 'content',
      innerWidthPolicy: 'content',
    };
  }
  if (block.blockName === 'core/image' || block.blockName === 'core/site-logo') {
    return { widthPolicy: 'intrinsic' };
  }
  return {};
}

function readRuntimeNumericAttr(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function extractRuntimeMediaSpec(
  block: RuntimeParsedBlock,
  src: string | undefined,
  alt: string | undefined,
): Record<string, any> | undefined {
  if (!src && !['core/image', 'core/cover', 'core/media-text', 'core/site-logo'].includes(block.blockName)) {
    return undefined;
  }
  const html = rewriteRuntimeHtml(block.innerHtml);
  const width =
    readRuntimeNumericAttr(block.attrs?.width) ??
    readRuntimeNumericAttr(extractFirstMatch(html, /\bwidth=(["'])([^"']+)\1/i, 2));
  const height =
    readRuntimeNumericAttr(block.attrs?.height) ??
    readRuntimeNumericAttr(extractFirstMatch(html, /\bheight=(["'])([^"']+)\1/i, 2));
  const id =
    readRuntimeNumericAttr(block.attrs?.id) ??
    readRuntimeNumericAttr(block.attrs?.mediaId);
  const sizeSlug =
    typeof block.attrs?.sizeSlug === 'string' && block.attrs.sizeSlug.trim()
      ? block.attrs.sizeSlug.trim()
      : undefined;
  const aspectRatio =
    typeof block.attrs?.aspectRatio === 'string' && block.attrs.aspectRatio.trim()
      ? block.attrs.aspectRatio.trim()
      : undefined;
  const scale =
    typeof block.attrs?.scale === 'string' && block.attrs.scale.trim()
      ? block.attrs.scale.trim()
      : undefined;
  const focalPoint = block.attrs?.focalPoint;
  const objectPosition =
    focalPoint && typeof focalPoint === 'object'
      ? (() => {
          const fp = focalPoint as Record<string, unknown>;
          const x = typeof fp.x === 'number' ? fp.x : parseFloat(String(fp.x ?? ''));
          const y = typeof fp.y === 'number' ? fp.y : parseFloat(String(fp.y ?? ''));
          return !isNaN(x) && !isNaN(y)
            ? `${Math.round(x * 100)}% ${Math.round(y * 100)}%`
            : undefined;
        })()
      : undefined;
  const result = {
    ...(src ? { src: localizeWpUploadAssetUrl(src) ?? src } : {}),
    ...(alt ? { alt } : {}),
    ...(id ? { id } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(sizeSlug ? { sizeSlug } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(scale ? { scale } : {}),
    ...(objectPosition ? { objectPosition } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildRuntimeStyleSpec(block: RuntimeParsedBlock, classNames: string[]) {
  const spacing = block.attrs?.style?.spacing;
  const typography = block.attrs?.style?.typography;
  const dimensions = block.attrs?.style?.dimensions;
  const border = block.attrs?.style?.border;
  const textAlign =
    typeof typography?.textAlign === 'string' && typography.textAlign.trim()
      ? typography.textAlign.trim()
      : typeof block.attrs?.textAlign === 'string' && block.attrs.textAlign.trim()
        ? block.attrs.textAlign.trim()
        : ['core/paragraph', 'core/heading'].includes(block.blockName) &&
            typeof block.attrs?.align === 'string' &&
            block.attrs.align.trim()
          ? block.attrs.align.trim()
          : undefined;
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
    typeof border?.radius === 'string' && border.radius.trim()
      ? border.radius.trim()
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
    ...(border && typeof border === 'object'
      ? {
          border: {
            ...(typeof border.width === 'string' && border.width.trim()
              ? { width: border.width.trim() }
              : {}),
            ...(typeof border.style === 'string' && border.style.trim()
              ? { style: border.style.trim() }
              : {}),
            ...(typeof border.color === 'string' && border.color.trim()
              ? { color: border.color.trim() }
              : {}),
            ...(border.radius && typeof border.radius === 'object'
              ? { radius: border.radius }
              : {}),
          },
        }
      : {}),
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
    ...((typography && typeof typography === 'object') || textAlign
      ? {
          typography: {
            ...(typeof typography?.fontSize === 'string' && typography.fontSize.trim()
              ? { fontSize: typography.fontSize.trim() }
              : {}),
            ...(typeof typography?.lineHeight === 'string' &&
            typography.lineHeight.trim()
              ? { lineHeight: typography.lineHeight.trim() }
              : {}),
            ...(typeof typography?.fontWeight === 'string' &&
            typography.fontWeight.trim()
              ? { fontWeight: typography.fontWeight.trim() }
              : typeof typography?.fontStyle === 'string' &&
                  typography.fontStyle.trim()
                ? { fontWeight: typography.fontStyle.trim() }
              : {}),
            ...(textAlign ? { textAlign } : {}),
            ...(typeof typography?.fontFamily === 'string' &&
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
  if (styleSpec.border && Object.keys(styleSpec.border).length === 0) {
    delete styleSpec.border;
  }

  return Object.keys(styleSpec).length > 0 ? styleSpec : undefined;
}

function buildRuntimeLayoutSpec(block: RuntimeParsedBlock) {
  const layout = block.attrs?.layout;
  const result: Record<string, any> = {};
  const classNames = extractRuntimeClassNames(block.attrs, block.innerHtml);
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
    } else if (layout.flexWrap === false) {
      result.flexWrap = 'nowrap';
    }
    if (typeof layout.contentSize === 'string' && layout.contentSize.trim()) {
      result.contentSize = layout.contentSize.trim();
    }
    if (typeof layout.wideSize === 'string' && layout.wideSize.trim()) {
      result.wideSize = layout.wideSize.trim();
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
  if (
    block.blockName === 'core/columns' &&
    block.attrs?.isStackedOnMobile !== false
  ) {
    result.responsive = {
      stackOnMobile: true,
      breakpoint: 780,
    };
  }
  Object.assign(result, deriveRuntimeWidthPolicy(block, result, classNames));
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildRuntimeBlockNode(
  block: RuntimeParsedBlock,
  path: string,
  layoutContext: RuntimeLayoutContext = {},
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
  const classNames = extractRuntimeClassNames(block.attrs, innerHtml);
  const attrs =
    Object.keys(block.attrs).length > 0 ? { ...block.attrs } : undefined;
  const styleSpec = buildRuntimeStyleSpec(block, classNames);
  const layoutSpec = buildRuntimeLayoutSpec(block);
  const childLayoutContext = buildRuntimeChildLayoutContext(
    block,
    kind,
    layoutSpec,
    layoutContext,
  );
  const childNodes = block.children.map((child, index) =>
    buildRuntimeBlockNode(child, `${path}.${index + 1}`, childLayoutContext),
  );
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
  const rawSrc =
    image.src ||
    ((typeof block.attrs.url === 'string' && block.attrs.url.trim()) ||
      extractFirstMatch(innerHtml, /\bsrc=(["'])([^"']+)\1/i, 2));
  const rawAlt =
    image.alt ||
    ((typeof block.attrs.alt === 'string' && block.attrs.alt.trim()) ||
      extractFirstMatch(innerHtml, /\balt=(["'])([^"']*)\1/i, 2));
  const domSpec = extractRuntimeDomSpec(block, classNames, wrapperTag);
  const mediaSpec = extractRuntimeMediaSpec(block, rawSrc, rawAlt);
  const node: Record<string, any> = {
    nodeId: path,
    kind,
    blockName: block.blockName,
    sourceRef: { sourceNodeId: path },
    ...(attrs ? { attrs } : {}),
    ...(domSpec ? { dom: domSpec } : {}),
    ...(mediaSpec ? { media: mediaSpec } : {}),
    ...(styleSpec ? { style: styleSpec } : {}),
    ...(layoutSpec ? { layout: layoutSpec } : {}),
    ...(Object.keys(layoutContext).length > 0
      ? { layoutContext }
      : {}),
    ...(block.blockName === 'core/post-content' ||
    block.blockName === 'core/page-content'
      ? {
          binding: {
            kind: 'content-slot',
            source: 'page.content',
          },
        }
      : {}),
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
  const src = rawSrc;
  const alt = rawAlt;
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
    const w = readRuntimeNumericAttr(block.attrs.width) ?? mediaSpec?.width;
    const h = readRuntimeNumericAttr(block.attrs.height) ?? mediaSpec?.height;
    if (w) node.width = w;
    if (h) node.height = h;
  }

  if (['core/table', 'core/verse', 'core/html', 'core/preformatted', 'core/code'].includes(block.blockName)) {
    if (innerHtml && !node.html) node.html = rewriteRuntimeHtml(innerHtml);
  }

  return node;
}

function buildRuntimeChildLayoutContext(
  block: RuntimeParsedBlock,
  kind: string,
  layoutSpec: Record<string, any> | undefined,
  parentContext: RuntimeLayoutContext,
): RuntimeLayoutContext {
  const context: RuntimeLayoutContext = {
    ...parentContext,
    parentBlockName: block.blockName,
    parentKind: kind,
  };

  if (layoutSpec?.kind) context.parentLayoutKind = layoutSpec.kind;
  if (layoutSpec?.align) context.parentAlign = layoutSpec.align;

  if (block.blockName === 'core/columns') {
    context.inColumns = true;
    if (typeof layoutSpec?.columns === 'number') {
      context.columnsCount = layoutSpec.columns;
    }
    if (layoutSpec?.align) context.columnsAlign = layoutSpec.align;
  }

  if (block.blockName === 'core/column') {
    context.inColumn = true;
    if (layoutSpec?.columnWidth) context.columnWidth = layoutSpec.columnWidth;
  }

  if (layoutSpec?.kind === 'constrained') {
    context.inConstrainedLayout = true;
  }

  if (layoutSpec?.kind === 'flex') {
    context.inFlexLayout = true;
    if (layoutSpec.orientation) {
      context.flexOrientation = layoutSpec.orientation;
    }
    if (layoutSpec.justifyContent) {
      context.flexJustifyContent = layoutSpec.justifyContent;
    }
  }

  if (layoutSpec?.kind === 'grid') {
    context.inGridLayout = true;
    if (typeof layoutSpec.columns === 'number') {
      context.gridColumns = layoutSpec.columns;
    }
  }

  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}

function findRuntimeContentSlot(
  nodes: Array<Record<string, any>>,
): Record<string, any> | undefined {
  for (const node of nodes) {
    if (node?.binding?.kind === 'content-slot') {
      return {
        nodeId: node.nodeId,
        blockName: node.blockName,
        bindingSource: node.binding.source ?? 'page.content',
        ...(node.wrapper ? { wrapper: node.wrapper } : {}),
        ...(node.dom ? { dom: node.dom } : {}),
        ...(node.layout ? { layout: node.layout } : {}),
        ...(node.style ? { style: node.style } : {}),
        ...(node.layoutContext ? { layoutContext: node.layoutContext } : {}),
      };
    }
    const found = Array.isArray(node.children)
      ? findRuntimeContentSlot(node.children)
      : undefined;
    if (found) return found;
  }
  return undefined;
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

function readRuntimeThemeTokens(themeDir: string | undefined): Record<string, any> | undefined {
  if (!themeDir) return undefined;
  const themeJsonPath = join(themeDir, 'theme.json');
  if (!existsSync(themeJsonPath)) return undefined;
  try {
    const themeJson = JSON.parse(readFileSync(themeJsonPath, 'utf-8')) as Record<string, any>;
    const settings = themeJson.settings ?? {};
    const styles = themeJson.styles ?? {};
    return {
      layout: settings.layout ?? {},
      layoutPolicy: {
        useRootPaddingAwareAlignments:
          settings.useRootPaddingAwareAlignments === true,
      },
      colors: {
        palette: settings.color?.palette ?? [],
        gradients: settings.color?.gradients ?? [],
      },
      spacing: {
        spacingSizes: settings.spacing?.spacingSizes ?? [],
        units: settings.spacing?.units ?? [],
        rootPadding: styles.spacing?.padding ?? {},
        blockGap: styles.spacing?.blockGap,
      },
      typography: {
        fontFamilies: settings.typography?.fontFamilies ?? [],
        fontSizes: settings.typography?.fontSizes ?? [],
        root: styles.typography ?? {},
      },
      blockStyles: styles.blocks ?? {},
    };
  } catch {
    return undefined;
  }
}

function buildRuntimeLayoutPolicy(
  themeTokens: Record<string, any> | undefined,
  themeSlug: string,
): Record<string, any> | undefined {
  if (!themeTokens) return undefined;
  const layout = themeTokens.layout ?? {};
  const spacing = themeTokens.spacing ?? {};
  const layoutPolicy = themeTokens.layoutPolicy ?? {};
  const result = {
    themeSlug,
    contentSize: layout.contentSize,
    wideSize: layout.wideSize,
    rootPadding: spacing.rootPadding,
    rootPaddingAwareAlignments:
      layoutPolicy.useRootPaddingAwareAlignments === true,
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  );
}

function expandTemplateMarkup(
  markup: string,
  postContent: string,
  themeDir: string,
  seen: Set<string>,
  depth = 0,
  options: { preserveContentSlots?: boolean } = {},
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
            return expandTemplateMarkup(cleaned, postContent, themeDir, nextSeen, depth + 1, options);
          }
        }
        return '';
      } catch {
        return '';
      }
    },
  );

  if (!options.preserveContentSlots) {
    markup = markup.replace(
      /<!--\s*wp:post-content(?:\s+\{[^}]*\})?\s*\/-->/gi,
      postContent,
    );
    markup = markup.replace(
      /<!--\s*wp:page-content(?:\s+\{[^}]*\})?\s*\/-->/gi,
      postContent,
    );
  }

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

function resolveRuntimeTemplateShellMarkupFromRow(row: any): string {
  const themeDir = process.env.THEME_DIR?.trim();
  const postContent = String(row.post_content ?? '');
  if (!themeDir) return postContent;

  for (const fileName of buildRuntimeTemplateCandidates(row)) {
    const templatePath = join(themeDir, 'templates', fileName);
    if (existsSync(templatePath)) {
      try {
        const templateMarkup = readFileSync(templatePath, 'utf-8');
        const resolved = expandTemplateMarkup(
          templateMarkup,
          postContent,
          themeDir,
          new Set(),
          0,
          { preserveContentSlots: true },
        );
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
  const themeDir = process.env.THEME_DIR?.trim();
  const themeTokens = readRuntimeThemeTokens(themeDir);
  const normalizedTemplate = normalizeRuntimeTemplateSlug(row?.template);
  const resolvedTemplate =
    normalizedTemplate ||
    (Number(row?.is_front_page ?? 0) === 1 ? 'front-page' : 'default');
  const markup = resolveRuntimeTemplateShellMarkupFromRow(row);
  const contentMarkup = String(row.post_content ?? '');
  const blocks = parseRuntimeBlocks(markup);
  const contentBlocks = parseRuntimeBlocks(contentMarkup);
  const blockTree = blocks.map((block, index) =>
    buildRuntimeBlockNode(block, `root.${index + 1}`),
  );
  const contentBlockTree = contentBlocks.map((block, index) =>
    buildRuntimeBlockNode(block, `content.${index + 1}`),
  );
  const contentSlot = findRuntimeContentSlot(blockTree);
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
    themeTokens,
    layoutPolicy: buildRuntimeLayoutPolicy(themeTokens, themeSlug),
    source: {
      kind: 'page-post-content',
      template: resolvedTemplate,
      slug: String(row.post_name ?? '').trim(),
      templateExpanded: Boolean(process.env.THEME_DIR?.trim()),
      sourceSummary:
        blockTree.length > 0
          ? `runtime template block tree with ${blockTree.length} root node(s) and content block tree with ${contentBlockTree.length} root node(s)`
          : 'page-content fallback',
    },
    support: {
      safeForRuntime: runtimeSignals.unsupportedBlocks.length === 0,
      unsupportedBlocks: runtimeSignals.unsupportedBlocks,
    },
    dataNeeds: ['page-detail'],
    sections: runtimeSignals.sections,
    blockTree,
    contentBlockTree,
    ...(contentSlot ? { contentSlot } : {}),
    subtreeBindings: runtimeSignals.bindings,
  };
}
