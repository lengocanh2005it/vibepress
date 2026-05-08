import { Fragment, createElement, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  RuntimeBlockNode,
  RuntimeBoxSpacingSpec,
  RuntimeLayoutPolicy,
  RuntimePageRecord,
  RuntimePageResponse,
  RuntimePagePatch,
  RuntimeStyleSpec,
} from '../runtime/runtime-contract';

interface RuntimePageProps {
  slug?: string;
  apiBase?: string;
}

const ALLOWED_INLINE_ATTRS = new Set([
  'aria-label',
  'aria-current',
  'data-source-node-id',
  'data-section-id',
  'data-section-key',
  'data-section-type',
  'data-wp-block',
]);

const ALLOWED_TAGS = new Set([
  'a',
  'article',
  'aside',
  'blockquote',
  'br',
  'button',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  's',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

const DEFAULT_BLOCK_CLASS_NAMES: Record<string, string[]> = {
  'core/button': ['wp-block-button'],
  'core/buttons': ['wp-block-buttons'],
  'core/column': ['wp-block-column'],
  'core/columns': ['wp-block-columns'],
  'core/cover': ['wp-block-cover'],
  'core/group': ['wp-block-group'],
  'core/heading': ['wp-block-heading'],
  'core/image': ['wp-block-image'],
  'core/post-content': ['wp-block-post-content'],
  'core/post-featured-image': ['wp-block-post-featured-image'],
  'core/post-title': ['wp-block-post-title'],
  'core/query-title': ['wp-block-query-title'],
  'core/separator': ['wp-block-separator'],
};

const NAMED_CSS_COLORS = new Set([
  'black',
  'white',
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'gray',
  'grey',
  'silver',
  'maroon',
  'olive',
  'lime',
  'aqua',
  'teal',
  'navy',
  'fuchsia',
  'purple',
]);

export default function RuntimePage({
  slug: explicitSlug,
  apiBase = '',
}: RuntimePageProps) {
  const params = useParams();
  const slug = explicitSlug ?? params.slug ?? '';
  const [payload, setPayload] = useState<RuntimePageResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setPayload(null);
      setLoading(false);
      setError('Missing page slug.');
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          `${apiBase}/api/runtime/pages/${encodeURIComponent(slug)}`,
        );
        if (!res.ok) {
          throw new Error(`Runtime page request failed (${res.status})`);
        }
        const json = (await res.json()) as RuntimePageResponse;
        if (!cancelled) {
          setPayload(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setPayload(null);
          setLoading(false);
          setError(
            err instanceof Error ? err.message : 'Failed to load runtime page.',
          );
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [apiBase, slug]);

  if (loading) {
    return (
      <main
        className="runtime-page mx-auto max-w-6xl px-6 py-16"
        data-runtime-component="RuntimePage"
      >
        <p className="text-sm uppercase tracking-[0.2em] text-neutral-500">
          Loading runtime page
        </p>
      </main>
    );
  }

  if (error) {
    return (
      <main
        className="runtime-page mx-auto max-w-4xl px-6 py-16"
        data-runtime-component="RuntimePage"
      >
        <div className="rounded-lg border border-red-200 bg-red-50 px-6 py-5 text-red-700">
          {error}
        </div>
      </main>
    );
  }

  if (!payload) return null;

  const { page, runtimePlan } = payload;
  const layoutFamily = runtimePlan?.layoutFamily ?? 'default-page';
  const sourceKind = runtimePlan?.source?.kind ?? 'page-post-content';
  const isProfolioFse = layoutFamily.startsWith('profolio-fse');
  const hasExpandedTemplate = Boolean(runtimePlan?.source?.templateExpanded);
  const runtimePageClassName = [
    'runtime-page',
    `runtime-page--${layoutFamily}`,
    isProfolioFse ? 'runtime-page--theme-profolio-fse' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const runtimePageDataProps = {
    'data-runtime-component': 'RuntimePage',
    'data-runtime-slug': page.slug,
    'data-runtime-mode': runtimePlan?.mode ?? 'page-content',
    'data-runtime-source-kind': sourceKind,
    'data-runtime-layout-family': layoutFamily,
  } as const;
  const runtimeThemeStyle = buildRuntimeThemeStyle(
    runtimePlan?.themeTokens,
    runtimePlan?.layoutPolicy,
  );
  const runtimeContentBlockTree = Array.isArray(runtimePlan?.contentBlockTree)
    ? runtimePlan.contentBlockTree
    : [];
  const runtimePatches = selectRuntimePagePatches(runtimePlan?.overrides, page.slug);
  const runtimeContentNodes = selectRuntimeContentNodes(
    runtimePlan.blockTree,
    isProfolioFse,
    hasExpandedTemplate,
  );
  const patchedRuntimeContentNodes = applyRuntimePagePatches(
    runtimeContentNodes,
    runtimePatches,
    runtimeContentBlockTree.length === 0,
  );
  const patchedRuntimeContentBlockTree = applyRuntimePagePatches(
    runtimeContentBlockTree,
    runtimePatches,
  );
  const shouldRenderBlockTree =
    runtimeContentNodes.length > 0 && runtimePlan.mode !== 'page-content';

  if (shouldRenderBlockTree) {
    return (
      <div
        className={runtimePageClassName}
        style={runtimeThemeStyle}
        {...runtimePageDataProps}
      >
        {renderRuntimeNodes(
          patchedRuntimeContentNodes,
          page,
          `${page.slug}-runtime`,
          patchedRuntimeContentBlockTree,
        )}
      </div>
    );
  }

  if (isProfolioFse && hasExpandedTemplate) {
    return (
      <div
        className={runtimePageClassName}
        style={runtimeThemeStyle}
        {...runtimePageDataProps}
      >
        <div className="runtime-page__content wp-block-post-content prose max-w-none">
          {renderRichTextChildren(page.content ?? '', `${page.slug}-content`)}
        </div>
      </div>
    );
  }

  return (
    <main
      className={runtimePageClassName}
      style={runtimeThemeStyle}
      {...runtimePageDataProps}
    >
      <article className="runtime-page__article mx-auto max-w-5xl px-6 py-12">
        <h1 className="runtime-page__title mb-8 text-4xl font-semibold tracking-tight">
          {page.title}
        </h1>
        <div className="runtime-page__content prose max-w-none">
          {renderRichTextChildren(page.content ?? '', `${page.slug}-content`)}
        </div>
      </article>
    </main>
  );
}

function selectRuntimeContentNodes(
  nodes: RuntimeBlockNode[] | undefined,
  isProfolioFse: boolean,
  hasExpandedTemplate: boolean,
): RuntimeBlockNode[] {
  const blockTree = Array.isArray(nodes) ? nodes : [];
  if (!isProfolioFse || !hasExpandedTemplate) return blockTree;

  const profolioContentRoots = blockTree.filter(isProfolioContentRoot);
  return profolioContentRoots.length > 0 ? profolioContentRoots : blockTree;
}

function isProfolioContentRoot(node: RuntimeBlockNode): boolean {
  if (node.kind === 'cover') return true;
  return getExplicitRuntimeTag(node) === 'main';
}

function selectRuntimePagePatches(
  overrides: RuntimePageResponse['runtimePlan']['overrides'] | undefined,
  pageSlug: string,
): RuntimePagePatch[] {
  if (!overrides || overrides.pageSlug !== pageSlug) return [];
  return Array.isArray(overrides.patches) ? overrides.patches : [];
}

function applyRuntimePagePatches(
  nodes: RuntimeBlockNode[],
  patches: RuntimePagePatch[],
  allowAppendUnanchoredInsert = true,
): RuntimeBlockNode[] {
  if (!patches.length) return nodes;
  const result: RuntimeBlockNode[] = [];
  for (const node of nodes) {
    const patched = applyRuntimePagePatchesToNode(node, patches);
    if (!patched) continue;
    result.push(patched);
    for (const patch of patches) {
      if (
        patch.op === 'insert-simple-section' &&
        getRuntimePatchAfterSourceNodeId(patch) === getRuntimeNodeSourceNodeId(node)
      ) {
        result.push(buildRuntimeInsertedSimpleSection(patch, `${patched.nodeId ?? 'runtime-node'}-inserted`));
      }
    }
  }
  for (const patch of patches) {
    if (
      allowAppendUnanchoredInsert &&
      patch.op === 'insert-simple-section' &&
      !getRuntimePatchAfterSourceNodeId(patch)
    ) {
      result.push(buildRuntimeInsertedSimpleSection(patch, 'runtime-inserted'));
    }
  }
  return result;
}

function applyRuntimePagePatchesToNode(
  node: RuntimeBlockNode,
  patches: RuntimePagePatch[],
): RuntimeBlockNode | null {
  const sourceNodeId = getRuntimeNodeSourceNodeId(node);
  const directPatches = patches.filter(
    (patch) => patch.target?.sourceNodeId === sourceNodeId,
  );
  if (directPatches.some((patch) => patch.op === 'hide-node')) return null;

  let next: RuntimeBlockNode = { ...node };
  for (const patch of directPatches) {
    next = applyRuntimePagePatchToNode(next, patch);
  }

  if (node.children?.length) {
    next.children = applyRuntimePagePatches(node.children, patches, false);
  }
  return next;
}

function applyRuntimePagePatchToNode(
  node: RuntimeBlockNode,
  patch: RuntimePagePatch,
): RuntimeBlockNode {
  const value = patch.value ?? {};
  if (patch.op === 'replace-text') {
    const text = readRuntimePatchString(value.text);
    const html = readRuntimePatchString(value.html);
    if (!text && !html) return node;
    return {
      ...node,
      ...(text ? { text } : {}),
      ...(html ? { html } : { html: undefined }),
    };
  }
  if (patch.op === 'update-colors' || patch.op === 'update-style') {
    const color = readRuntimePatchString(value.color ?? value.textColor);
    const backgroundColor = readRuntimePatchString(
      value.backgroundColor ?? value.bgColor,
    );
    if (!color && !backgroundColor) return node;
    return {
      ...node,
      ...(color ? { textColor: color } : {}),
      ...(backgroundColor ? { bgColor: backgroundColor } : {}),
      style: {
        ...(node.style ?? {}),
        colors: {
          ...(node.style?.colors ?? {}),
          ...(color ? { text: color } : {}),
          ...(backgroundColor ? { background: backgroundColor } : {}),
        },
      },
    };
  }
  if (patch.op === 'replace-image') {
    const src = readRuntimePatchString(value.src);
    const alt = readRuntimePatchString(value.alt);
    if (!src) return node;
    return {
      ...node,
      src,
      ...(alt ? { alt } : {}),
      media: {
        ...(node.media ?? {}),
        src,
        ...(alt ? { alt } : {}),
      },
    };
  }
  return node;
}

function buildRuntimeInsertedSimpleSection(
  patch: RuntimePagePatch,
  keyPrefix: string,
): RuntimeBlockNode {
  const value = patch.value ?? {};
  const heading = readRuntimePatchString(value.heading) || 'New Section';
  const body = readRuntimePatchString(value.body);
  const backgroundImage = readRuntimePatchString(value.backgroundImage ?? value.src);
  const backgroundColor =
    readRuntimePatchString(value.backgroundColor) || '#111111';
  const textColor = readRuntimePatchString(value.textColor) || '#ffffff';
  const nodeId = `${keyPrefix}-simple-section`;
  return {
    nodeId,
    kind: backgroundImage ? 'cover' : 'group',
    blockName: backgroundImage ? 'core/cover' : 'core/group',
    sourceRef: { sourceNodeId: nodeId },
    customClassNames: ['runtime-page__inserted-section', 'alignfull'],
    layout: {
      kind: 'constrained',
      align: 'full',
      widthPolicy: 'full-bleed',
      innerWidthPolicy: 'content',
    },
    style: {
      colors: {
        background: backgroundColor,
        text: textColor,
      },
      spacing: {
        padding: {
          top: '80px',
          right: '20px',
          bottom: '80px',
          left: '20px',
        },
      },
    },
    ...(backgroundImage
      ? {
          src: backgroundImage,
          alt: readRuntimePatchString(value.imageAlt) || '',
          attrs: { dimRatio: 70 },
          overlayColor: backgroundColor,
        }
      : {}),
    children: [
      {
        nodeId: `${nodeId}.heading`,
        kind: 'heading',
        blockName: 'core/heading',
        sourceRef: { sourceNodeId: `${nodeId}.heading` },
        level: 2,
        text: heading,
        textAlign: 'center',
        style: {
          typography: {
            textAlign: 'center',
            fontSize: '2.5rem',
            lineHeight: '1.15',
          },
        },
      },
      ...(body
        ? [
            {
              nodeId: `${nodeId}.body`,
              kind: 'paragraph',
              blockName: 'core/paragraph',
              sourceRef: { sourceNodeId: `${nodeId}.body` },
              text: body,
              textAlign: 'center',
              style: {
                typography: {
                  textAlign: 'center',
                  lineHeight: '1.7',
                },
              },
            } as RuntimeBlockNode,
          ]
        : []),
    ],
  };
}

function getRuntimeNodeSourceNodeId(node: RuntimeBlockNode): string | undefined {
  return node.sourceRef?.sourceNodeId ?? node.nodeId;
}

function getRuntimePatchAfterSourceNodeId(
  patch: RuntimePagePatch,
): string | undefined {
  const value = patch.value ?? {};
  return (
    patch.target?.sourceNodeId ||
    readRuntimePatchString(value.afterSourceNodeId)
  );
}

function readRuntimePatchString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function renderRuntimeNodes(
  nodes: RuntimeBlockNode[],
  page: RuntimePageRecord,
  keyPrefix: string,
  contentBlockTree: RuntimeBlockNode[] = [],
): ReactNode[] {
  return nodes
    .map((node, index) =>
      renderRuntimeNode(
        node,
        page,
        `${keyPrefix}-${node.nodeId ?? `${node.blockName}-${index}`}`,
        contentBlockTree,
      ),
    )
    .filter((node): node is ReactNode => node !== null);
}

function renderRuntimeNode(
  node: RuntimeBlockNode,
  page: RuntimePageRecord,
  key: string,
  contentBlockTree: RuntimeBlockNode[] = [],
): ReactNode | null {
  const children = node.children?.length
    ? renderRuntimeNodes(node.children, page, `${key}-children`, contentBlockTree)
    : [];

  switch (node.kind) {
    case 'cover':
      return renderRuntimeCover(node, page, key, contentBlockTree);
    case 'post-title':
    case 'query-title':
      return renderRuntimeHeadingLike(node, key, page.title);
    case 'heading':
      return renderRuntimeHeadingLike(node, key, undefined);
    case 'site-title':
      return renderRuntimeHeadingLike(node, key, node.text || 'Site Title', 2);
    case 'site-tagline':
      return createElement(
        'p',
        buildRuntimeNodeProps(node, key),
        renderRuntimeTextChildren(node, `${key}-content`, 'p'),
      );
    case 'paragraph':
      return createElement(
        'p',
        buildRuntimeNodeProps(node, key),
        renderRuntimeTextChildren(node, `${key}-content`, 'p'),
      );
    case 'quote':
      return createElement(
        'blockquote',
        buildRuntimeNodeProps(node, key),
        children.length > 0
          ? children
          : renderRuntimeTextChildren(node, `${key}-content`, 'blockquote'),
      );
    case 'list': {
      const tag = node.attrs?.ordered === true ? 'ol' : 'ul';
      return createElement(
        tag,
        buildRuntimeNodeProps(node, key),
        children.length > 0
          ? children
          : renderRuntimeHtmlChildren(node.html ?? '', `${key}-html`, tag),
      );
    }
    case 'list-item':
      return createElement(
        'li',
        buildRuntimeNodeProps(node, key),
        children.length > 0
          ? children
          : renderRuntimeTextChildren(node, `${key}-content`, 'li'),
      );
    case 'image':
      return renderRuntimeImage(node, key);
    case 'post-featured-image':
      return renderRuntimeFeaturedImage(node, page, key);
    case 'separator':
      return createElement('hr', buildRuntimeNodeProps(node, key));
    case 'spacer':
      return createElement(
        'div',
        buildRuntimeNodeProps(node, key, {
          style: {
            height: normalizeCssValue(
              String(node.attrs?.height ?? node.minHeight ?? '0'),
              'spacing',
            ),
          },
        }),
      );
    case 'buttons':
      return createElement('div', buildRuntimeNodeProps(node, key), children);
    case 'button':
    case 'navigation-link':
      return renderRuntimeLink(node, key, {
        defaultHref: node.href || '#',
        classNames:
          node.kind === 'button'
            ? ['wp-block-button__link', 'wp-element-button']
            : undefined,
      });
    case 'post-content':
    case 'page-content': {
      const isStructuralContent =
        contentBlockTree.length > 0 &&
        isStructuralRuntimeContent(contentBlockTree);
      const content =
        contentBlockTree.length > 0
          ? renderRuntimeNodes(contentBlockTree, page, `${key}-content-tree`)
          : renderRichTextChildren(page.content ?? '', `${key}-content`);
      return createElement(
        resolveRuntimeNodeTag(node, 'div'),
        buildRuntimeNodeProps(node, key, {
          classNames: isStructuralContent
            ? [
                'runtime-page__content',
                'wp-block-post-content',
                'runtime-page__content--structural',
              ]
            : [
                'runtime-page__content',
                'wp-block-post-content',
                'prose',
                'max-w-none',
              ],
        }),
        content,
      );
    }
    default: {
      const tag = resolveRuntimeNodeTag(node, 'div');
      if (children.length > 0) {
        return createElement(tag, buildRuntimeNodeProps(node, key), children);
      }
      if (node.html) {
        return createElement(
          tag,
          buildRuntimeNodeProps(node, key),
          renderRuntimeHtmlChildren(node.html, `${key}-html`, tag),
        );
      }
      if (node.text) {
        return createElement(tag, buildRuntimeNodeProps(node, key), node.text);
      }
      return null;
    }
  }
}

function isStructuralRuntimeContent(nodes: RuntimeBlockNode[]): boolean {
  return nodes.some(isStructuralRuntimeNode);
}

function isStructuralRuntimeNode(node: RuntimeBlockNode): boolean {
  const structuralKinds = new Set([
    'columns',
    'column',
    'cover',
    'gallery',
    'group',
    'media-text',
    'query',
  ]);
  const structuralBlocks = new Set([
    'core/columns',
    'core/column',
    'core/cover',
    'core/gallery',
    'core/group',
    'core/media-text',
    'core/query',
  ]);

  return (
    structuralKinds.has(node.kind) ||
    structuralBlocks.has(node.blockName) ||
    node.align === 'full' ||
    node.align === 'wide' ||
    node.layout?.align === 'full' ||
    node.layout?.align === 'wide' ||
    node.layout?.kind === 'constrained' ||
    node.layout?.kind === 'flex' ||
    node.layout?.kind === 'grid' ||
    (node.children ?? []).some(isStructuralRuntimeNode)
  );
}

function renderRuntimeCover(
  node: RuntimeBlockNode,
  page: RuntimePageRecord,
  key: string,
  contentBlockTree: RuntimeBlockNode[] = [],
): ReactNode {
  const children = node.children?.length
    ? renderRuntimeNodes(node.children, page, `${key}-children`, contentBlockTree)
    : [];
  const tag = resolveRuntimeNodeTag(node, 'section');
  const props = buildRuntimeNodeProps(node, key, {
    classNames: ['wp-block-cover'],
    style: {
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: normalizeFlexAlignment(node.align) ?? 'center',
      justifyContent: normalizeJustifyContent(node.justifyContent) ?? 'center',
    },
  });
  const dimRatio = toNumber(node.attrs?.dimRatio);
  const overlayColor = resolveRuntimeColor(
    node.overlayColor ?? node.style?.colors?.overlay,
  );

  return createElement(
    tag,
    props,
    node.src
      ? createElement('img', {
          key: `${key}-image`,
          className: 'wp-block-cover__image-background',
          src: resolveAsset(node.src),
          alt: node.alt || '',
          loading: 'lazy',
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: formatFocalPoint(node),
          },
        })
      : null,
    createElement('span', {
      key: `${key}-overlay`,
      'aria-hidden': true,
      className: 'wp-block-cover__background has-background-dim',
      style: {
        position: 'absolute',
        inset: 0,
        backgroundColor: overlayColor ?? 'black',
        opacity:
          typeof dimRatio === 'number' && !Number.isNaN(dimRatio)
            ? Math.max(0, Math.min(1, dimRatio / 100))
            : 0.9,
      },
    }),
    createElement(
      'div',
      {
        key: `${key}-inner`,
        className: 'wp-block-cover__inner-container',
        style: {
          position: 'relative',
          zIndex: 1,
          width: '100%',
        },
      },
      children,
    ),
  );
}

function renderRuntimeHeadingLike(
  node: RuntimeBlockNode,
  key: string,
  fallbackText?: string,
  fallbackLevel = 1,
): ReactNode {
  const level =
    typeof node.level === 'number' && node.level >= 1 && node.level <= 6
      ? node.level
      : fallbackLevel;
  const tag = `h${level}`;
  const content =
    renderRuntimeTextChildren(node, `${key}-content`, tag) ??
    fallbackText ??
    node.text ??
    '';

  return createElement(tag, buildRuntimeNodeProps(node, key), content);
}

function renderRuntimeImage(node: RuntimeBlockNode, key: string): ReactNode | null {
  if (!node.src) return null;

  const image = createElement('img', {
    key: `${key}-img`,
    src: resolveAsset(node.src),
    alt: node.alt || '',
    width: node.width || node.media?.width || undefined,
    height: node.height || node.media?.height || undefined,
    loading: 'lazy',
    style: buildRuntimeImageStyle(node),
  });

  const content = node.href
    ? renderRuntimeLink(node, `${key}-link`, { child: image })
    : image;

  return createElement(
    'figure',
    buildRuntimeNodeProps(node, key, { classNames: ['wp-block-image'] }),
    content,
  );
}

function renderRuntimeFeaturedImage(
  node: RuntimeBlockNode,
  page: RuntimePageRecord,
  key: string,
): ReactNode | null {
  if (!page.featuredImage) return null;

  return createElement(
    'figure',
    buildRuntimeNodeProps(node, key, {
      classNames: ['wp-block-post-featured-image'],
    }),
    createElement('img', {
      key: `${key}-img`,
      src: resolveAsset(page.featuredImage),
      alt: page.title,
      loading: 'lazy',
      style: {
        display: 'block',
        width: '100%',
        height: 'auto',
        ...buildRuntimeBorderRadiusStyle(node),
      },
    }),
  );
}

function buildRuntimeImageStyle(node: RuntimeBlockNode): CSSProperties {
  const layoutContext = node.layoutContext ?? {};
  const isLayoutBoundImage =
    layoutContext.inColumn === true ||
    layoutContext.inGridLayout === true ||
    layoutContext.inFlexLayout === true;
  const shouldStretch =
    node.align === 'full' ||
    node.align === 'wide' ||
    node.layout?.align === 'full' ||
    node.layout?.align === 'wide' ||
    (node.customClassNames ?? []).some((className) =>
      ['alignfull', 'alignwide'].includes(className),
    );
  const declaredWidth =
    typeof node.width === 'number' && node.width > 0
      ? node.width
      : typeof node.media?.width === 'number' && node.media.width > 0
        ? node.media.width
        : undefined;
  const sizeSlugMaxWidth = getRuntimeImageSizeMaxWidth(node);
  const aspectRatio =
    typeof node.media?.aspectRatio === 'string' && node.media.aspectRatio.trim()
      ? node.media.aspectRatio.trim()
      : typeof node.attrs?.aspectRatio === 'string' && node.attrs.aspectRatio.trim()
      ? node.attrs.aspectRatio.trim()
      : undefined;
  const objectFit =
    typeof node.media?.scale === 'string' && node.media.scale.trim()
      ? node.media.scale.trim()
      : typeof node.attrs?.scale === 'string' && node.attrs.scale.trim()
      ? node.attrs.scale.trim()
      : undefined;

  return {
    display: 'block',
    width: shouldStretch
      ? '100%'
      : declaredWidth
        ? `${declaredWidth}px`
        : isLayoutBoundImage
          ? '100%'
          : 'auto',
    maxWidth: shouldStretch
      ? '100%'
      : sizeSlugMaxWidth
        ? `min(100%, ${sizeSlugMaxWidth}px)`
        : '100%',
    height: 'auto',
    aspectRatio,
    objectFit: objectFit as CSSProperties['objectFit'],
    objectPosition: node.media?.objectPosition,
    ...buildRuntimeBorderRadiusStyle(node),
  };
}

function getRuntimeImageSizeMaxWidth(node: RuntimeBlockNode): number | undefined {
  const sizeSlug =
    typeof node.media?.sizeSlug === 'string' && node.media.sizeSlug.trim()
      ? node.media.sizeSlug.trim()
      : typeof node.attrs?.sizeSlug === 'string'
        ? node.attrs.sizeSlug.trim()
        : '';
  const classNames = node.customClassNames ?? [];
  const classSizeSlug =
    classNames
      .map((className) => className.match(/^size-([a-z0-9_-]+)$/i)?.[1])
      .find(Boolean) ?? '';
  const normalized = (sizeSlug || classSizeSlug).toLowerCase();

  switch (normalized) {
    case 'thumbnail':
      return 150;
    case 'medium':
      return 300;
    case 'medium_large':
    case 'medium-large':
      return 768;
    case 'large':
    case 'full':
      return 1024;
    default:
      return undefined;
  }
}

function renderRuntimeLink(
  node: RuntimeBlockNode,
  key: string,
  options: {
    child?: ReactNode;
    defaultHref?: string;
    classNames?: string[];
  } = {},
): ReactNode {
  const href = options.defaultHref || node.href || '#';
  const className = [
    ...new Set([
      ...collectRuntimeBlockClassNames(node),
      ...(options.classNames ?? []),
    ]),
  ].join(' ');
  const style = buildRuntimeNodeStyle(node);
  const content =
    options.child ??
    renderRuntimeTextChildren(node, `${key}-content`, 'a') ??
    node.text ??
    href;

  if (isInternalPath(href)) {
    return (
      <Link
        key={key}
        to={toAppPath(href)}
        className={className || undefined}
        style={style}
        data-source-node-id={node.sourceRef?.sourceNodeId}
        data-wp-block={node.blockName}
      >
        {content}
      </Link>
    );
  }

  return (
    <a
      key={key}
      href={href}
      className={className || undefined}
      style={style}
      target={href.startsWith('http') ? '_blank' : undefined}
      rel={href.startsWith('http') ? 'noreferrer' : undefined}
      data-source-node-id={node.sourceRef?.sourceNodeId}
      data-wp-block={node.blockName}
    >
      {content}
    </a>
  );
}

function renderRuntimeTextChildren(
  node: RuntimeBlockNode,
  keyPrefix: string,
  unwrapTag?: string,
): ReactNode {
  if (node.html) {
    const children = renderRuntimeHtmlChildren(node.html, keyPrefix, unwrapTag);
    if (children.length > 0) return children;
  }
  return node.text ?? null;
}

function renderRuntimeHtmlChildren(
  html: string,
  keyPrefix: string,
  unwrapTag?: string,
): ReactNode[] {
  if (!html) return [];
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return [html];
  }

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return [html];

  let childNodes = Array.from(root.childNodes);
  if (
    unwrapTag &&
    childNodes.length === 1 &&
    childNodes[0]?.nodeType === Node.ELEMENT_NODE
  ) {
    const childElement = childNodes[0] as HTMLElement;
    if (childElement.tagName.toLowerCase() === unwrapTag.toLowerCase()) {
      childNodes = Array.from(childElement.childNodes);
    }
  }

  return childNodes
    .map((child, index) => renderDomNode(child, `${keyPrefix}-${index}`))
    .filter((node): node is ReactNode => node !== null);
}

function buildRuntimeNodeProps(
  node: RuntimeBlockNode,
  key: string,
  options: {
    classNames?: string[];
    style?: CSSProperties;
  } = {},
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    key,
    'data-wp-block': node.blockName,
  };
  const classNames = [
    ...new Set([
      ...collectRuntimeBlockClassNames(node),
      ...(options.classNames ?? []),
    ]),
  ];
  const style = mergeStyles(buildRuntimeNodeStyle(node), options.style);
  const id = node.domId ?? node.dom?.domId ?? node.wrapper?.domId;

  if (classNames.length > 0) props.className = classNames.join(' ');
  if (style) props.style = style;
  if (id) props.id = id;
  if (node.sourceRef?.sourceNodeId) {
    props['data-source-node-id'] = node.sourceRef.sourceNodeId;
  }

  return props;
}

function collectRuntimeBlockClassNames(node: RuntimeBlockNode): string[] {
  const layoutAlign = node.layout?.align;
  const blockAlign =
    layoutAlign === 'full' || layoutAlign === 'wide'
      ? layoutAlign
      : node.align === 'full' || node.align === 'wide'
        ? node.align
        : undefined;
  return [
    ...(DEFAULT_BLOCK_CLASS_NAMES[node.blockName] ?? []),
    ...(blockAlign ? [`align${blockAlign}`] : []),
    ...(node.layout?.kind ? [`is-layout-${node.layout.kind}`] : []),
    ...(node.dom?.classNames ?? []),
    ...(node.customClassNames ?? []),
    ...(node.style?.classNames ?? []),
  ].filter(Boolean);
}

function buildRuntimeNodeStyle(node: RuntimeBlockNode): CSSProperties | undefined {
  const style: CSSProperties = {
    ...normalizeRuntimeDomStyle(node.dom?.style),
  };
  const runtimeStyle = node.style;

  applyBoxSpacing(style, 'margin', runtimeStyle?.spacing?.margin ?? node.margin);
  applyBoxSpacing(
    style,
    'padding',
    runtimeStyle?.spacing?.padding ?? node.padding,
  );
  applyBlockGap(style, runtimeStyle?.spacing?.blockGap ?? node.gap);

  const textColor = resolveRuntimeColor(runtimeStyle?.colors?.text ?? node.textColor);
  const backgroundColor = resolveRuntimeColor(
    runtimeStyle?.colors?.background ?? node.bgColor,
  );
  const borderWidth = normalizeCssValue(runtimeStyle?.border?.width);
  const borderStyle = normalizeCssValue(runtimeStyle?.border?.style);
  const borderColor = resolveRuntimeColor(runtimeStyle?.border?.color);
  const minHeight = normalizeCssValue(
    runtimeStyle?.dimensions?.minHeight ?? node.minHeight,
    'spacing',
  );
  const width = normalizeCssValue(runtimeStyle?.dimensions?.width, 'spacing');
  const fontSize = normalizeCssValue(
    runtimeStyle?.typography?.fontSize ??
      (typeof node.typography?.fontSize === 'string'
        ? node.typography.fontSize
        : undefined),
    'font-size',
  );
  const lineHeight = normalizeCssValue(runtimeStyle?.typography?.lineHeight);
  const fontFamily = normalizeCssValue(
    runtimeStyle?.typography?.fontFamily ?? node.fontFamily,
  );
  const fontWeight = runtimeStyle?.typography?.fontWeight;
  const textAlign =
    runtimeStyle?.typography?.textAlign ??
    node.textAlign ??
    getRuntimeTextAlignFromAttrs(node) ??
    undefined;

  if (textColor) style.color = textColor;
  if (backgroundColor) style.backgroundColor = backgroundColor;
  applyRuntimeBorderRadiusStyle(
    style,
    runtimeStyle?.border?.radius ?? runtimeStyle?.borderRadius ?? node.borderRadius,
  );
  if (borderWidth) style.borderWidth = borderWidth;
  if (borderStyle) style.borderStyle = borderStyle as CSSProperties['borderStyle'];
  if (borderColor) style.borderColor = borderColor;
  if (minHeight) style.minHeight = minHeight;
  if (width) style.width = width;
  if (fontSize) style.fontSize = fontSize;
  if (lineHeight) style.lineHeight = lineHeight;
  if (fontFamily) style.fontFamily = fontFamily;
  if (fontWeight) style.fontWeight = fontWeight;
  if (textAlign) style.textAlign = textAlign as CSSProperties['textAlign'];

  applyLayoutStyle(style, node, runtimeStyle);

  return Object.keys(style).length > 0 ? style : undefined;
}

function buildRuntimeBorderRadiusStyle(
  node: RuntimeBlockNode,
): CSSProperties | undefined {
  const style: CSSProperties = {};
  applyRuntimeBorderRadiusStyle(
    style,
    node.style?.border?.radius ?? node.style?.borderRadius ?? node.borderRadius,
  );
  return Object.keys(style).length > 0 ? style : undefined;
}

function applyRuntimeBorderRadiusStyle(
  style: CSSProperties,
  radius: unknown,
): void {
  if (typeof radius === 'string' || typeof radius === 'number') {
    const value = normalizeCssValue(String(radius), 'spacing');
    if (value) style.borderRadius = value;
    return;
  }
  if (!radius || typeof radius !== 'object') return;

  const box = radius as Record<string, unknown>;
  const topLeft = normalizeCssValue(
    readRadiusCorner(box, 'topLeft', 'top', 'left'),
    'spacing',
  );
  const topRight = normalizeCssValue(
    readRadiusCorner(box, 'topRight', 'top', 'right'),
    'spacing',
  );
  const bottomRight = normalizeCssValue(
    readRadiusCorner(box, 'bottomRight', 'bottom', 'right'),
    'spacing',
  );
  const bottomLeft = normalizeCssValue(
    readRadiusCorner(box, 'bottomLeft', 'bottom', 'left'),
    'spacing',
  );

  if (topLeft) style.borderTopLeftRadius = topLeft;
  if (topRight) style.borderTopRightRadius = topRight;
  if (bottomRight) style.borderBottomRightRadius = bottomRight;
  if (bottomLeft) style.borderBottomLeftRadius = bottomLeft;
}

function readRadiusCorner(
  radius: Record<string, unknown>,
  corner: string,
  axis: string,
  side: string,
): string | undefined {
  const value = radius[corner] ?? radius[axis] ?? radius[side];
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function applyBoxSpacing(
  style: CSSProperties,
  property: 'margin' | 'padding',
  value?: RuntimeBoxSpacingSpec | Record<string, string>,
): void {
  if (!value) return;
  const box = value as Record<string, string | undefined>;
  const top = normalizeCssValue(box.top, 'spacing');
  const right = normalizeCssValue(box.right, 'spacing');
  const bottom = normalizeCssValue(box.bottom, 'spacing');
  const left = normalizeCssValue(box.left, 'spacing');

  if (top) style[`${property}Top`] = top;
  if (right) style[`${property}Right`] = right;
  if (bottom) style[`${property}Bottom`] = bottom;
  if (left) style[`${property}Left`] = left;
}

function applyBlockGap(
  style: CSSProperties,
  value?: RuntimeStyleSpec['spacing']['blockGap'] | string,
): void {
  if (!value) return;
  if (typeof value === 'string') {
    const normalized = normalizeCssValue(value, 'spacing');
    if (normalized) style.gap = normalized;
    return;
  }
  const x = normalizeCssValue(value.x, 'spacing');
  const y = normalizeCssValue(value.y, 'spacing');
  if (x) style.columnGap = x;
  if (y) style.rowGap = y;
}

function applyLayoutStyle(
  style: CSSProperties,
  node: RuntimeBlockNode,
  runtimeStyle?: RuntimeStyleSpec,
): void {
  const layout = node.layout;
  if (node.kind === 'columns') {
    style.display = 'flex';
    style.width = '100%';
    style.minWidth = 0;
    style.flexWrap =
      (layout?.flexWrap as CSSProperties['flexWrap']) ?? 'nowrap';
    style.alignItems = normalizeFlexAlignment(node.align) ?? 'flex-start';
    if (layout?.justifyContent) {
      style.justifyContent = normalizeJustifyContent(layout.justifyContent);
    }
  } else if (node.kind === 'column') {
    style.minWidth = 0;
    const width = normalizeCssValue(node.columnWidth, 'spacing');
    if (width) {
      style.flex = `0 1 ${width}`;
      style.maxWidth = width;
    } else {
      style.flex = '1 1 0';
    }
  } else if (node.kind === 'buttons') {
    style.display = 'flex';
    style.flexWrap = 'wrap';
    style.alignItems = 'center';
  } else if (layout?.kind === 'grid') {
    style.display = 'grid';
    if (typeof layout.columns === 'number' && layout.columns > 0) {
      style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
    } else if (layout.minimumColumnWidth) {
      style.gridTemplateColumns = `repeat(auto-fit, minmax(${normalizeCssValue(
        layout.minimumColumnWidth,
        'spacing',
      )}, 1fr))`;
    }
  } else if (layout?.kind === 'flex') {
    style.display = 'flex';
    if (layout.orientation === 'vertical') {
      style.flexDirection = 'column';
      if (layout.justifyContent) {
        style.alignItems = normalizeJustifyContent(
          layout.justifyContent,
        ) as CSSProperties['alignItems'];
      }
    } else if (layout.orientation === 'horizontal') {
      style.flexDirection = 'row';
      if (layout.justifyContent) {
        style.justifyContent = normalizeJustifyContent(layout.justifyContent);
      }
    }
    style.flexWrap =
      (layout.flexWrap as CSSProperties['flexWrap']) ?? 'wrap';
  } else if (layout?.kind === 'constrained') {
    style.width = '100%';
  }

  const gap = normalizeCssValue(runtimeStyle?.gap ?? node.gap, 'spacing');
  if (gap && !style.gap) style.gap = gap;

  if (layout?.justifyContent && !style.justifyContent) {
    style.justifyContent = normalizeJustifyContent(layout.justifyContent);
  }
  if (layout?.alignItems && !style.alignItems) {
    style.alignItems = normalizeFlexAlignment(layout.alignItems);
  }
  applyRuntimeWidthPolicy(style, layout?.widthPolicy);
}

function applyRuntimeWidthPolicy(
  style: CSSProperties,
  widthPolicy?: string,
): void {
  if (!widthPolicy) return;
  if (widthPolicy === 'full-bleed') {
    style.width = '100%';
    style.maxWidth = 'none';
    return;
  }
  if (widthPolicy === 'wide') {
    style.width = 'min(100%, var(--wp--style--global--wide-size, 1280px))';
    style.maxWidth = 'var(--wp--style--global--wide-size, 1280px)';
    style.marginLeft = 'auto';
    style.marginRight = 'auto';
    return;
  }
  if (widthPolicy === 'content') {
    style.width = '100%';
    style.maxWidth = 'var(--wp--style--global--content-size, 1200px)';
    style.marginLeft = 'auto';
    style.marginRight = 'auto';
  }
}

function getRuntimeTextAlignFromAttrs(
  node: RuntimeBlockNode,
): CSSProperties['textAlign'] | undefined {
  const raw =
    typeof node.attrs?.textAlign === 'string' && node.attrs.textAlign.trim()
      ? node.attrs.textAlign
      : ['paragraph', 'heading'].includes(node.kind) &&
          typeof node.attrs?.align === 'string' &&
          node.attrs.align.trim()
        ? node.attrs.align
        : undefined;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['left', 'right', 'center', 'justify'].includes(normalized)) {
    return normalized as CSSProperties['textAlign'];
  }
  return undefined;
}

function resolveRuntimeNodeTag(
  node: RuntimeBlockNode,
  fallback: string,
): keyof JSX.IntrinsicElements {
  const explicitTag = getExplicitRuntimeTag(node);
  if (explicitTag && isAllowedRuntimeTag(explicitTag)) {
    return explicitTag as keyof JSX.IntrinsicElements;
  }

  switch (node.kind) {
    case 'cover':
      return 'section';
    case 'image':
    case 'post-featured-image':
      return 'figure';
    case 'paragraph':
    case 'site-tagline':
      return 'p';
    case 'quote':
      return 'blockquote';
    case 'list':
      return node.attrs?.ordered === true ? 'ol' : 'ul';
    case 'list-item':
      return 'li';
    case 'separator':
      return 'hr';
    default:
      return isAllowedRuntimeTag(fallback)
        ? (fallback as keyof JSX.IntrinsicElements)
        : 'div';
  }
}

function getExplicitRuntimeTag(node: RuntimeBlockNode): string | undefined {
  const attrTag =
    typeof node.attrs?.tagName === 'string' ? node.attrs.tagName.trim() : '';
  if (attrTag) return attrTag.toLowerCase();
  const nodeTag = typeof node.tagName === 'string' ? node.tagName.trim() : '';
  if (nodeTag) return nodeTag.toLowerCase();
  const domTag =
    typeof node.dom?.tagName === 'string' ? node.dom.tagName.trim() : '';
  if (domTag) return domTag.toLowerCase();
  const wrapperTag =
    typeof node.wrapper?.tagName === 'string' ? node.wrapper.tagName.trim() : '';
  return wrapperTag ? wrapperTag.toLowerCase() : undefined;
}

function isAllowedRuntimeTag(tag: string): boolean {
  return ALLOWED_TAGS.has(tag.toLowerCase());
}

function normalizeCssValue(
  value?: string | null,
  presetFamily?: 'color' | 'spacing' | 'font-size',
): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const presetMatch = raw.match(/^var:preset\|([a-z-]+)\|([a-z0-9-]+)$/i);
  if (presetMatch) {
    return `var(--wp--preset--${presetMatch[1].toLowerCase()}--${presetMatch[2].toLowerCase()})`;
  }
  if (
    presetFamily === 'spacing' &&
    raw !== '0' &&
    /^[a-z0-9-]+$/i.test(raw) &&
    !/[a-z]+$/i.test(raw.replace(/[0-9.-]/g, ''))
  ) {
    return `var(--wp--preset--spacing--${raw.toLowerCase()})`;
  }
  if (presetFamily === 'font-size' && /^[a-z0-9-]+$/i.test(raw)) {
    return raw.includes('-') ? `var(--wp--preset--font-size--${raw})` : raw;
  }
  return raw;
}

function normalizeRuntimeDomStyle(
  value?: Record<string, string>,
): CSSProperties {
  if (!value) return {};
  const style: Record<string, string> = {};
  for (const [property, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const normalizedProperty = property
      .trim()
      .replace(/^-ms-/, 'ms-')
      .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    if (normalizedProperty) style[normalizedProperty] = raw.trim();
  }
  return style as CSSProperties;
}

function resolveRuntimeColor(value?: string | null): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (
    raw.startsWith('#') ||
    raw.startsWith('rgb') ||
    raw.startsWith('hsl') ||
    raw.startsWith('var(')
  ) {
    return raw;
  }
  if (NAMED_CSS_COLORS.has(raw.toLowerCase())) return raw;
  const presetValue = normalizeCssValue(raw, 'color');
  return presetValue?.startsWith('var(') ? presetValue : undefined;
}

function normalizeJustifyContent(
  value?: string | null,
): CSSProperties['justifyContent'] | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'left') return 'flex-start';
  if (normalized === 'right') return 'flex-end';
  if (normalized === 'space-between') return 'space-between';
  if (normalized === 'space-around') return 'space-around';
  if (normalized === 'space-evenly') return 'space-evenly';
  if (normalized === 'center') return 'center';
  if (normalized === 'stretch') return 'stretch';
  return normalized as CSSProperties['justifyContent'];
}

function normalizeFlexAlignment(
  value?: string | null,
): CSSProperties['alignItems'] | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'top' || normalized === 'start') return 'flex-start';
  if (normalized === 'bottom' || normalized === 'end') return 'flex-end';
  if (normalized === 'center') return 'center';
  if (normalized === 'stretch') return 'stretch';
  return normalized as CSSProperties['alignItems'];
}

function formatFocalPoint(node: RuntimeBlockNode): string | undefined {
  if (!node.focalPoint) return undefined;
  return `${Math.round(node.focalPoint.x * 100)}% ${Math.round(
    node.focalPoint.y * 100,
  )}%`;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mergeStyles(
  base?: CSSProperties,
  extra?: CSSProperties,
): CSSProperties | undefined {
  if (!base && !extra) return undefined;
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
  };
}

function buildRuntimeThemeStyle(
  themeTokens?: unknown,
  layoutPolicy?: RuntimeLayoutPolicy,
): CSSProperties | undefined {
  if (!themeTokens || typeof themeTokens !== 'object') return undefined;
  const style: Record<string, string> = {};
  const tokens = themeTokens as Record<string, unknown>;
  const layout = tokens.layout as Record<string, unknown> | undefined;
  const colors = tokens.colors as Record<string, unknown> | undefined;
  const spacing = tokens.spacing as Record<string, unknown> | undefined;
  const typography =
    tokens.typography as Record<string, unknown> | undefined;

  const contentSize = readTokenString(layout?.contentSize);
  const wideSize = readTokenString(layout?.wideSize);
  const policyContentSize = readTokenString(layoutPolicy?.contentSize);
  const policyWideSize = readTokenString(layoutPolicy?.wideSize);
  if (policyContentSize || contentSize) {
    style['--wp--style--global--content-size'] =
      policyContentSize ?? contentSize!;
  }
  if (policyWideSize || wideSize) {
    style['--wp--style--global--wide-size'] = policyWideSize ?? wideSize!;
  }

  const rootPadding =
    (layoutPolicy?.rootPadding as Record<string, unknown> | undefined) ??
    (spacing?.rootPadding as Record<string, unknown> | undefined);
  const rootPaddingLeft = readTokenString(rootPadding?.left);
  const rootPaddingRight = readTokenString(rootPadding?.right);
  if (rootPaddingLeft) {
    style['--wp--style--root--padding-left'] = rootPaddingLeft;
  }
  if (rootPaddingRight) {
    style['--wp--style--root--padding-right'] = rootPaddingRight;
  }

  const palette = Array.isArray(colors?.palette) ? colors.palette : [];
  for (const entry of palette) {
    const token = entry as Record<string, unknown>;
    const slug = readTokenString(token.slug);
    const color = readTokenString(token.color);
    if (slug && color) style[`--wp--preset--color--${slug}`] = color;
  }

  const spacingSizes = Array.isArray(spacing?.spacingSizes)
    ? spacing.spacingSizes
    : [];
  for (const entry of spacingSizes) {
    const token = entry as Record<string, unknown>;
    const slug = readTokenString(token.slug);
    const size = readTokenString(token.size);
    if (slug && size) style[`--wp--preset--spacing--${slug}`] = size;
  }

  const fontSizes = Array.isArray(typography?.fontSizes)
    ? typography.fontSizes
    : [];
  for (const entry of fontSizes) {
    const token = entry as Record<string, unknown>;
    const slug = readTokenString(token.slug);
    const size = readTokenString(token.size);
    if (slug && size) style[`--wp--preset--font-size--${slug}`] = size;
  }

  const fontFamilies = Array.isArray(typography?.fontFamilies)
    ? typography.fontFamilies
    : [];
  for (const entry of fontFamilies) {
    const token = entry as Record<string, unknown>;
    const slug = readTokenString(token.slug);
    const family = readTokenString(token.fontFamily);
    if (slug && family) style[`--wp--preset--font-family--${slug}`] = family;
  }

  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

function readTokenString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function renderRichTextChildren(html: string, keyPrefix: string): ReactNode[] {
  if (!html) return [];
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return [html];
  }

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return [html];

  return Array.from(root.childNodes)
    .map((node, index) => renderDomNode(node, `${keyPrefix}-${index}`))
    .filter((node): node is ReactNode => node !== null);
}

function renderDomNode(node: ChildNode, key: string): ReactNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  const children = Array.from(element.childNodes)
    .map((child, index) => renderDomNode(child, `${key}-${index}`))
    .filter((child): child is ReactNode => child !== null);

  if (!ALLOWED_TAGS.has(tag)) {
    return <Fragment key={key}>{children}</Fragment>;
  }

  if (tag === 'a') return renderAnchor(element, key, children);
  if (tag === 'img') return renderImage(element, key);
  if (tag === 'br' || tag === 'hr') {
    return createElement(tag, buildCommonProps(element, key));
  }

  return createElement(
    tag,
    buildCommonProps(element, key),
    children.length > 0 ? children : undefined,
  );
}

function renderAnchor(
  element: HTMLElement,
  key: string,
  children: ReactNode[],
): ReactNode {
  const href = element.getAttribute('href') || '#';
  const props = {
    ...buildCommonProps(element, key),
    title: element.getAttribute('title') || undefined,
  };

  if (isInternalPath(href)) {
    return (
      <Link key={key} to={toAppPath(href)} {...props}>
        {children.length > 0 ? children : href}
      </Link>
    );
  }

  return (
    <a
      key={key}
      href={href}
      target={href.startsWith('http') ? '_blank' : undefined}
      rel={href.startsWith('http') ? 'noreferrer' : undefined}
      {...props}
    >
      {children.length > 0 ? children : href}
    </a>
  );
}

function renderImage(element: HTMLElement, key: string): ReactNode {
  const props = buildCommonProps(element, key);
  const src = resolveAsset(element.getAttribute('src') || '');
  const srcSet = element.getAttribute('srcset') || undefined;
  const sizes = element.getAttribute('sizes') || undefined;
  const width = element.getAttribute('width') || undefined;
  const height = element.getAttribute('height') || undefined;

  return (
    <img
      {...props}
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      width={width}
      height={height}
      alt={element.getAttribute('alt') || ''}
      loading="lazy"
    />
  );
}

function buildCommonProps(
  element: HTMLElement,
  key: string,
): Record<string, unknown> {
  const props: Record<string, unknown> = { key };
  const className = element.getAttribute('class');
  const style = parseStyle(element.getAttribute('style'));
  const id = element.getAttribute('id');

  if (className) props.className = className;
  if (style) props.style = style;
  if (id) props.id = id;

  for (const attr of ALLOWED_INLINE_ATTRS) {
    const value = element.getAttribute(attr);
    if (value != null) props[attr] = value;
  }

  return props;
}

function parseStyle(raw: string | null): CSSProperties | undefined {
  if (!raw) return undefined;
  const style: Record<string, string> = {};

  for (const declaration of raw.split(';')) {
    const [property, ...valueParts] = declaration.split(':');
    const value = valueParts.join(':').trim();
    if (!property || !value) continue;
    const camelName = property
      .trim()
      .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    if (camelName) style[camelName] = value;
  }

  return Object.keys(style).length ? (style as CSSProperties) : undefined;
}

function resolveAsset(src: string): string {
  if (!src) return src;
  if (src.startsWith('theme-asset:')) {
    const assetPath = src.slice('theme-asset:'.length).replace(/^\/+/, '');
    return `${import.meta.env.BASE_URL}assets/${assetPath.replace(/^assets\//, '')}`;
  }
  if (src.startsWith('/assets/')) {
    return `${import.meta.env.BASE_URL}assets/${src.slice('/assets/'.length)}`;
  }
  return src;
}

function isInternalPath(url: string): boolean {
  if (!url || url.startsWith('#')) return false;
  try {
    const base =
      typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost';
    const resolved = new URL(url, base);
    return resolved.origin === new URL(base).origin;
  } catch {
    return url.startsWith('/');
  }
}

function toAppPath(url: string): string {
  try {
    const base =
      typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost';
    const resolved = new URL(url, base);
    return `${resolved.pathname}${resolved.search}${resolved.hash}` || '/';
  } catch {
    return url || '/';
  }
}
