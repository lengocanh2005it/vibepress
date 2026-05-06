import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  RuntimeBlockNode,
  RuntimeLayoutSpec,
  RuntimePagePatch,
  RuntimePagePlan,
  RuntimePageRecord,
  RuntimePageResponse,
  RuntimePageSection,
  RuntimePageSubtreeBinding,
  RuntimeStyleSpec,
} from '../runtime/runtime-contract';

interface RuntimePageProps {
  slug?: string;
  apiBase?: string;
}

type RuntimeRenderableNode = RuntimeBlockNode & {
  children?: RuntimeRenderableNode[];
  __hidden?: boolean;
};

type RuntimeRenderableSection = RuntimePageSection & {
  children?: RuntimeRenderableSection[];
  __hidden?: boolean;
};

interface RuntimePostRecord {
  id: number;
  title: string;
  excerpt?: string;
  slug: string;
  type?: string;
  date?: string;
  author?: string;
  authorSlug?: string;
  featuredImage?: string | null;
}

interface RuntimeRenderContext {
  page: RuntimePageRecord;
  plan: RuntimePagePlan;
  bindings: Map<string, RuntimePageSubtreeBinding>;
  sections: Map<string, RuntimeRenderableSection>;
  queryResults: Map<string, RuntimePostRecord[]>;
  currentPost?: RuntimePostRecord;
}

interface RuntimeSectionRenderOptions {
  embedded?: boolean;
}

export default function RuntimePage({
  slug: explicitSlug,
  apiBase = '',
}: RuntimePageProps) {
  const params = useParams();
  const slug = explicitSlug ?? params.slug ?? '';
  const [payload, setPayload] = useState<RuntimePageResponse | null>(null);
  const [queryResults, setQueryResults] = useState<
    Record<string, RuntimePostRecord[]>
  >({});
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

  useEffect(() => {
    if (!payload) {
      setQueryResults({});
      return;
    }

    const plan = applyRuntimeOverrides(payload.page, payload.runtimePlan);
    const descriptors = collectRuntimeQueryDescriptors(
      plan.blockTree as RuntimeRenderableNode[],
    );
    if (descriptors.length === 0) {
      setQueryResults({});
      return;
    }

    let cancelled = false;

    async function loadQueryResults() {
      try {
        const entries = await Promise.all(
          descriptors.map(async (descriptor) => {
            const res = await fetch(
              buildRuntimeQueryEndpoint(descriptor, apiBase),
            );
            if (!res.ok) {
              throw new Error(`Runtime query request failed (${res.status})`);
            }
            const posts = (await res.json()) as RuntimePostRecord[];
            return [descriptor.nodeId, posts] as const;
          }),
        );
        if (!cancelled) {
          setQueryResults(Object.fromEntries(entries));
        }
      } catch {
        if (!cancelled) {
          setQueryResults({});
        }
      }
    }

    void loadQueryResults();

    return () => {
      cancelled = true;
    };
  }, [apiBase, payload]);

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16">
        <p className="text-sm uppercase tracking-[0.2em] text-neutral-500">
          Loading runtime page
        </p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16">
        <div className="rounded-3xl border border-red-200 bg-red-50 px-6 py-5 text-red-700">
          {error}
        </div>
      </main>
    );
  }

  if (!payload) return null;

  const { page, runtimePlan } = payload;
  const effectivePlan = applyRuntimeOverrides(page, runtimePlan);
  const ctx: RuntimeRenderContext = {
    page,
    plan: effectivePlan,
    bindings: new Map(
      (effectivePlan.subtreeBindings ?? []).map((binding) => [
        binding.nodeId,
        binding,
      ]),
    ),
    sections: buildRuntimeSectionMap(effectivePlan.sections),
    queryResults: new Map(Object.entries(queryResults)),
  };

  return (
    <main
      className={runtimePageClassName(effectivePlan)}
      data-runtime-component="RuntimePage"
      data-runtime-slug={page.slug}
      data-runtime-version={effectivePlan.version}
      data-runtime-mode={effectivePlan.mode}
      data-runtime-fidelity={effectivePlan.fidelity}
      data-runtime-safe={effectivePlan.support.safeForRuntime ? 'yes' : 'no'}
      data-runtime-source-kind={effectivePlan.source.kind}
      data-runtime-source-template={effectivePlan.source.template}
      data-runtime-layout-family={effectivePlan.layoutFamily ?? 'default-page'}
    >
      {!effectivePlan.support.safeForRuntime &&
      effectivePlan.support.unsupportedBlocks.length > 0 ? (
        <div className="mx-auto max-w-6xl px-6 pt-6">
          <div className="rounded-3xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-800">
            Runtime page is in best-effort mode. Unsupported blocks:{' '}
            {effectivePlan.support.unsupportedBlocks.join(', ')}
          </div>
        </div>
      ) : null}
      {effectivePlan.blockTree.length > 0
        ? renderRuntimeNodes(
            effectivePlan.blockTree as RuntimeRenderableNode[],
            ctx,
          )
        : renderRuntimeFallback(
            effectivePlan,
            page,
            effectivePlan.sections as RuntimeRenderableSection[],
          )}
    </main>
  );
}

interface RuntimeQueryDescriptor {
  nodeId: string;
  postType: string;
  perPage: number;
  author?: string;
}

function runtimePageClassName(plan: RuntimePagePlan): string {
  const layoutFamily = plan.layoutFamily ?? 'default-page';
  return mergeClassNames(
    'runtime-page',
    `runtime-page--${layoutFamily}`,
    layoutFamily.startsWith('profolio-fse')
      ? 'runtime-page--theme-profolio-fse'
      : undefined,
  );
}

function collectRuntimeQueryDescriptors(
  nodes: RuntimeRenderableNode[],
): RuntimeQueryDescriptor[] {
  const descriptors: RuntimeQueryDescriptor[] = [];
  const visit = (node: RuntimeRenderableNode) => {
    if (node.blockName === 'core/query') {
      const attrsQuery =
        node.attrs?.query && typeof node.attrs.query === 'object'
          ? (node.attrs.query as Record<string, unknown>)
          : null;
      const nodeId = node.nodeId ?? node.sourceRef?.sourceNodeId;
      if (attrsQuery && nodeId) {
        const postType =
          typeof attrsQuery.postType === 'string' && attrsQuery.postType.trim()
            ? attrsQuery.postType.trim()
            : 'post';
        const perPage =
          typeof attrsQuery.perPage === 'number' && attrsQuery.perPage > 0
            ? attrsQuery.perPage
            : 3;
        const author =
          typeof attrsQuery.author === 'string' && attrsQuery.author.trim()
            ? attrsQuery.author.trim()
            : undefined;
        descriptors.push({ nodeId, postType, perPage, author });
      }
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return descriptors;
}

function buildRuntimeQueryEndpoint(
  descriptor: RuntimeQueryDescriptor,
  apiBase = '',
): string {
  const params = new URLSearchParams();
  params.set('perPage', String(descriptor.perPage));
  if (descriptor.author) params.set('author', descriptor.author);
  if (descriptor.postType === 'post') {
    params.set('type', 'post');
    return `${apiBase}/api/posts?${params.toString()}`;
  }
  return `${apiBase}/api/post-types/${encodeURIComponent(descriptor.postType)}/posts?${params.toString()}`;
}

function buildRuntimeSectionMap(
  sections: RuntimePageSection[],
): Map<string, RuntimeRenderableSection> {
  const map = new Map<string, RuntimeRenderableSection>();
  const visit = (section: RuntimeRenderableSection) => {
    for (const key of getSectionKeys(section)) {
      map.set(key, section);
    }
    section.children?.forEach(visit);
  };
  sections.forEach((section) => visit(section as RuntimeRenderableSection));
  return map;
}

function renderRuntimeNodes(
  nodes: RuntimeRenderableNode[],
  ctx: RuntimeRenderContext,
  path = 'root',
): ReactNode[] {
  return nodes.map((node, index) =>
    renderRuntimeNode(node, ctx, `${path}.${index + 1}`),
  );
}

function renderRuntimeNode(
  node: RuntimeRenderableNode,
  ctx: RuntimeRenderContext,
  key: string,
): ReactNode {
  if (node.__hidden) return null;

  const nodeId = node.nodeId ?? node.sourceRef?.sourceNodeId ?? key;
  const binding = ctx.bindings.get(nodeId);
  const overlaySection = resolveOverlaySection(binding, ctx.sections);

  if (overlaySection && !overlaySection.__hidden) {
    const preserveWrapper = binding?.preserveWrapper !== false;
    const overlay = renderBoundSectionOverlay(overlaySection, ctx, {
      embedded: preserveWrapper,
    });
    if (overlay) {
      return preserveWrapper ? wrapRuntimeNode(node, key, overlay) : overlay;
    }
  }

  const children = node.children?.length
    ? renderRuntimeNodes(node.children, ctx, nodeId)
    : null;
  const style = toNodeStyle(node);
  const className = toNodeClassName(node);
  const text = node.html ?? node.text ?? '';
  const inspectAttrs = buildRuntimeInspectorAttrs(nodeId, overlaySection);

  switch (node.blockName) {
    case 'core/heading':
    case 'uagb/advanced-heading': {
      const level =
        node.blockName === 'uagb/advanced-heading'
          ? clampHeadingLevel(node.level ?? 2)
          : clampHeadingLevel(node.level);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      return (
        <Tag
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {renderRichTextChildren(text, nodeId)}
        </Tag>
      );
    }
    case 'core/paragraph':
      return (
        <p
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {renderRichTextChildren(text, nodeId)}
        </p>
      );
    case 'core/image':
    case 'core/site-logo':
      if (!node.src) return wrapRuntimeNode(node, key, children);
      return (
        <img
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          src={resolveAsset(node.src)}
          alt={node.alt ?? ''}
          className={className}
          style={style}
          {...inspectAttrs}
        />
      );
    case 'core/button':
    case 'core/navigation-link':
      return renderRuntimeLinkNode(node, key, text, style, inspectAttrs);
    case 'core/buttons':
      return wrapRuntimeNode(node, key, children, {
        inspectAttrs,
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          ...style,
        },
      });
    case 'core/site-title':
      return (
        <div
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {renderRichTextChildren(text || ctx.page.title, nodeId)}
        </div>
      );
    case 'core/post-content':
    case 'core/page-content':
      return (
        <div
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {renderRichTextChildren(ctx.page.content ?? '', `${nodeId}-content`)}
        </div>
      );
    case 'core/query': {
      const queryTemplate = node.children?.find(
        (child) => child.blockName === 'core/post-template',
      );
      const queryPosts = ctx.queryResults.get(nodeId);
      if (queryTemplate && queryPosts && queryPosts.length > 0) {
        return renderRuntimeQueryNode(
          node,
          queryTemplate as RuntimeRenderableNode,
          queryPosts,
          ctx,
          key,
          inspectAttrs,
        );
      }
      return wrapRuntimeNode(node, key, children, { inspectAttrs });
    }
    case 'core/post-template':
      return wrapRuntimeNode(node, key, children, { inspectAttrs });
    case 'core/post-title':
      if (ctx.currentPost) {
        return renderRuntimePostTitleNode(
          node,
          ctx.currentPost,
          key,
          style,
          inspectAttrs,
        );
      }
      return wrapRuntimeNode(
        node,
        key,
        text ? renderRichTextChildren(text, nodeId) : children,
        { inspectAttrs },
      );
    case 'core/post-date':
      if (ctx.currentPost?.date) {
        return (
          <p
            key={key}
            id={node.wrapper?.domId ?? node.domId}
            className={className}
            style={style}
            {...inspectAttrs}
          >
            {ctx.currentPost.date}
          </p>
        );
      }
      return wrapRuntimeNode(node, key, children, { inspectAttrs });
    case 'core/post-excerpt':
      if (ctx.currentPost?.excerpt) {
        return (
          <div
            key={key}
            id={node.wrapper?.domId ?? node.domId}
            className={className}
            style={style}
            {...inspectAttrs}
          >
            {renderRichTextChildren(ctx.currentPost.excerpt, `${nodeId}-excerpt`)}
          </div>
        );
      }
      return wrapRuntimeNode(node, key, children, { inspectAttrs });
    case 'core/post-featured-image':
      if (ctx.currentPost?.featuredImage) {
        return (
          <img
            key={key}
            id={node.wrapper?.domId ?? node.domId}
            src={resolveAsset(ctx.currentPost.featuredImage)}
            alt={ctx.currentPost.title ?? ''}
            className={className}
            style={style}
            {...inspectAttrs}
          />
        );
      }
      return wrapRuntimeNode(node, key, children, { inspectAttrs });
    case 'core/cover': {
      const coverBgPos = node.focalPoint
        ? `${Math.round(node.focalPoint.x * 100)}% ${Math.round(node.focalPoint.y * 100)}%`
        : 'center';
      return wrapRuntimeNode(node, key, children, {
        style: {
          ...style,
          ...(node.src
            ? {
                backgroundImage: `url("${resolveAsset(node.src)}")`,
                backgroundSize: 'cover',
                backgroundPosition: coverBgPos,
                backgroundRepeat: 'no-repeat',
                ...(node.hasParallax ? { backgroundAttachment: 'fixed' } : {}),
              }
            : {}),
        },
        innerClassName: node.overlayColor ? 'bg-black/40' : undefined,
        innerStyle: node.overlayColor
          ? { backgroundColor: node.overlayColor }
          : undefined,
        inspectAttrs,
      });
    }
    case 'core/list': {
      const isOrdered = node.attrs?.ordered === true;
      const ListTag = isOrdered ? 'ol' : 'ul';
      return (
        <ListTag
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {children}
        </ListTag>
      );
    }
    case 'core/list-item':
      return (
        <li
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {children ?? renderRichTextChildren(text, nodeId)}
        </li>
      );
    case 'core/spacer':
      return <div key={key} style={{ ...style, height: node.minHeight ?? '2rem' }} />;
    case 'core/separator':
      return <hr key={key} className={className} style={style} {...inspectAttrs} />;
    case 'core/quote':
    case 'core/pullquote':
      return (
        <blockquote
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {children ?? renderRichTextChildren(text, nodeId)}
        </blockquote>
      );
    case 'core/code':
    case 'core/preformatted':
    case 'core/verse':
      return (
        <pre
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          <code>{node.text ?? ''}</code>
        </pre>
      );
    case 'core/video': {
      const videoSrc =
        node.src ??
        (typeof node.attrs?.src === 'string' ? node.attrs.src : undefined) ??
        (typeof node.attrs?.url === 'string' ? node.attrs.url : undefined);
      if (videoSrc) {
        return (
          <video
            key={key}
            id={node.wrapper?.domId ?? node.domId}
            src={resolveAsset(videoSrc)}
            controls
            className={className}
            style={{ maxWidth: '100%', ...style }}
            {...inspectAttrs}
          />
        );
      }
      return wrapRuntimeNode(node, key, children ?? (text ? renderRichTextChildren(text, nodeId) : null), { inspectAttrs });
    }
    case 'core/embed': {
      const embedUrl = typeof node.attrs?.url === 'string' ? node.attrs.url : '';
      if (embedUrl) {
        return (
          <div
            key={key}
            id={node.wrapper?.domId ?? node.domId}
            className={className}
            style={{ position: 'relative', ...style }}
            {...inspectAttrs}
          >
            <iframe
              src={embedUrl}
              title={typeof node.attrs?.caption === 'string' ? node.attrs.caption : 'Embedded content'}
              style={{ width: '100%', minHeight: '400px', border: 'none' }}
              loading="lazy"
              allowFullScreen
            />
          </div>
        );
      }
      return wrapRuntimeNode(node, key, children ?? (text ? renderRichTextChildren(text, nodeId) : null), { inspectAttrs });
    }
    case 'core/gallery': {
      const galleryCols = typeof node.attrs?.columns === 'number' ? node.attrs.columns : 3;
      return (
        <div
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${galleryCols}, minmax(0, 1fr))`,
            gap: node.gap ?? '1rem',
            ...style,
          }}
          {...inspectAttrs}
        >
          {children}
        </div>
      );
    }
    case 'core/social-links':
      return (
        <nav
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          aria-label="Social media links"
          className={className}
          style={{ display: 'flex', flexWrap: 'wrap', gap: node.gap ?? '0.5rem', alignItems: 'center', ...style }}
          {...inspectAttrs}
        >
          {children}
        </nav>
      );
    case 'core/social-link': {
      const socialHref =
        node.href ??
        (typeof node.attrs?.url === 'string' ? node.attrs.url : '#');
      const socialLabel =
        (typeof node.attrs?.label === 'string' && node.attrs.label
          ? node.attrs.label
          : typeof node.attrs?.service === 'string' && node.attrs.service
          ? node.attrs.service
          : 'Social link');
      return (
        <a
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          href={socialHref}
          aria-label={socialLabel}
          className={className}
          style={style}
          target="_blank"
          rel="noreferrer noopener"
          {...inspectAttrs}
        >
          {children ?? socialLabel}
        </a>
      );
    }
    case 'core/html':
      return (
        <div
          key={key}
          id={node.wrapper?.domId ?? node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {text ? renderRichTextChildren(text, nodeId) : children}
        </div>
      );
    default:
      return wrapRuntimeNode(
        node,
        key,
        children ?? (text ? renderRichTextChildren(text, nodeId) : null),
        { inspectAttrs },
      );
  }
}

function renderRuntimeQueryNode(
  node: RuntimeRenderableNode,
  templateNode: RuntimeRenderableNode,
  posts: RuntimePostRecord[],
  ctx: RuntimeRenderContext,
  key: string,
  inspectAttrs?: Record<string, string | undefined>,
): ReactNode {
  const templateNodeId =
    templateNode.nodeId ?? templateNode.sourceRef?.sourceNodeId ?? `${key}-template`;
  const templateClassName = toNodeClassName(templateNode);
  const templateStyle = toNodeStyle(templateNode);
  const templateChildren = templateNode.children ?? [];

  return wrapRuntimeNode(
    node,
    key,
    <div
      className={templateClassName}
      style={templateStyle}
      {...buildRuntimeInspectorAttrs(templateNodeId)}
    >
      {posts.map((post, index) => {
        const postCtx: RuntimeRenderContext = {
          ...ctx,
          currentPost: post,
        };
        return (
          <article
            key={`${templateNodeId}-${post.id ?? index}`}
            className="wp-block-post"
          >
            {renderRuntimeNodes(
              templateChildren,
              postCtx,
              `${templateNodeId}.${index + 1}`,
            )}
          </article>
        );
      })}
    </div>,
    { inspectAttrs },
  );
}

function renderRuntimePostTitleNode(
  node: RuntimeRenderableNode,
  post: RuntimePostRecord,
  key: string,
  style: CSSProperties,
  inspectAttrs?: Record<string, string | undefined>,
): ReactNode {
  const className = toNodeClassName(node);
  const headingLevel = clampHeadingLevel(node.level ?? 2);
  const Tag = `h${headingLevel}` as keyof JSX.IntrinsicElements;
  const isLinked = node.attrs?.isLink === true;
  const titleChildren = renderRichTextChildren(post.title ?? '', `${key}-post-title`);

  return (
    <Tag
      key={key}
      id={node.wrapper?.domId ?? node.domId}
      className={className}
      style={style}
      {...inspectAttrs}
    >
      {isLinked ? (
        <Link to={getRuntimePostHref(post)}>{titleChildren}</Link>
      ) : (
        titleChildren
      )}
    </Tag>
  );
}

function resolveOverlaySection(
  binding: RuntimePageSubtreeBinding | undefined,
  sections: Map<string, RuntimeRenderableSection>,
): RuntimeRenderableSection | null {
  if (!binding) return null;
  if (binding.sectionId && sections.has(binding.sectionId)) {
    return sections.get(binding.sectionId) ?? null;
  }
  if (binding.sectionDebugKey && sections.has(binding.sectionDebugKey)) {
    return sections.get(binding.sectionDebugKey) ?? null;
  }
  return null;
}

function renderBoundSectionOverlay(
  section: RuntimeRenderableSection,
  ctx: RuntimeRenderContext,
  options: RuntimeSectionRenderOptions = {},
): ReactNode {
  if (section.__hidden) return null;
  const embedded = options.embedded === true;

  switch (section.type) {
    case 'page-content':
      return renderSectionShell(
        section,
        <>
          {section.showTitle !== false ? (
            <h1 className={embedded ? undefined : 'text-4xl font-semibold tracking-tight'}>
              {ctx.page.title}
            </h1>
          ) : null}
          <div className={embedded ? undefined : 'prose max-w-none pt-6'}>
            {renderRichTextChildren(
              ctx.page.content ?? '',
              `${ctx.page.slug}-page-content`,
            )}
          </div>
        </>,
        options,
      );
    case 'prose-block':
      return renderSectionShell(
        section,
        <>
          {renderSectionHeading(section, options)}
          {section.body ? (
            <div className={embedded ? undefined : 'prose max-w-none pt-5'}>
              {renderRichTextChildren(
                section.body,
                `${getSectionPrimaryKey(section)}-body`,
              )}
            </div>
          ) : null}
          {renderNestedSections(section, ctx, options)}
        </>,
        options,
      );
    case 'card-grid': {
      const columnCount = Math.max(
        section.layout?.columns ?? section.columns ?? 1,
        1,
      );
      return renderSectionShell(
        section,
        <>
          {renderSectionHeading(section, options)}
          <div
            className="grid"
            style={{
              ...toGridGapStyle(section.style),
              gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
            }}
          >
            {(section.cards ?? []).map((card, index) => (
              <article
                key={`${getSectionPrimaryKey(section)}-${index}`}
                className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm"
              >
                {card.imageSrc ? (
                  <img
                    src={resolveAsset(String(card.imageSrc))}
                    alt={String(card.imageAlt ?? card.heading ?? '')}
                    className="mb-4 aspect-[4/3] w-full rounded-2xl object-cover"
                  />
                ) : null}
                <h3 className="text-xl font-semibold">
                  {String(card.heading ?? card.title ?? `Item ${index + 1}`)}
                </h3>
                {card.body ? (
                  <div className="prose prose-sm max-w-none pt-3 text-neutral-700">
                    {renderRichTextChildren(
                      String(card.body),
                      `${getSectionPrimaryKey(section)}-card-${index}`,
                    )}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          {renderNestedSections(section, ctx, options)}
        </>,
        options,
      );
    }
    case 'accordion':
      return <RuntimeAccordionSection section={section} />;
    case 'tabs':
      return <RuntimeTabsSection section={section} />;
    case 'carousel':
      return <RuntimeCarouselSection section={section} />;
    case 'hero':
    case 'cover':
      return renderCoverLikeSection(section, ctx, options);
    case 'media-text':
      return renderMediaTextSection(section, ctx, options);
    default:
      return renderSectionShell(
        section,
        <>
          {renderSectionHeading(section, options)}
          {section.body ? (
            <div className={embedded ? undefined : 'prose max-w-none pt-5'}>
              {renderRichTextChildren(
                section.body,
                `${getSectionPrimaryKey(section)}-generic`,
              )}
            </div>
          ) : null}
          {renderNestedSections(section, ctx, options)}
        </>,
        options,
      );
  }
}

function renderCoverLikeSection(
  section: RuntimeRenderableSection,
  ctx: RuntimeRenderContext,
  options: RuntimeSectionRenderOptions = {},
) {
  const embedded = options.embedded === true;
  const image = getSectionImage(section);
  const coverFp = section.focalPoint as { x: number; y: number } | undefined;
  const coverBgPos = coverFp
    ? `${Math.round(coverFp.x * 100)}% ${Math.round(coverFp.y * 100)}%`
    : 'center';
  const style = toSectionStyle(section, {
    ...(image?.src
      ? {
          backgroundImage: `url("${resolveAsset(image.src)}")`,
          backgroundSize: 'cover',
          backgroundPosition: coverBgPos,
          backgroundRepeat: 'no-repeat',
          ...(section.hasParallax ? { backgroundAttachment: 'fixed' } : {}),
        }
      : {}),
  });

  return (
    <section
      className={sectionClassName(section, true, embedded)}
      style={style}
      {...buildRuntimeInspectorAttrs(
        section.sourceNodeId ?? getSectionPrimaryKey(section),
        section,
      )}
    >
      <div
        className={embedded ? undefined : 'mx-auto max-w-6xl px-6 py-16'}
        style={
          section.style?.colors?.overlay
            ? { backgroundColor: section.style.colors.overlay }
            : undefined
        }
      >
        {renderSectionHeading(section, options)}
        {section.body ? (
          <div
            className={embedded ? undefined : 'prose max-w-none pt-5 text-white/95'}
          >
            {renderRichTextChildren(
              section.body,
              `${getSectionPrimaryKey(section)}-cover`,
            )}
          </div>
        ) : null}
        {renderNestedSections(section, ctx, options)}
      </div>
    </section>
  );
}

function renderMediaTextSection(
  section: RuntimeRenderableSection,
  ctx: RuntimeRenderContext,
  options: RuntimeSectionRenderOptions = {},
) {
  const embedded = options.embedded === true;
  const image = getSectionImage(section);
  const isReversed =
    section.layout?.orientation === 'reverse' ||
    section.layout?.orientation === 'right';

  return renderSectionShell(
    section,
    <div
      className="grid gap-8 md:grid-cols-2 md:items-center"
      style={toLayoutStyle(section.layout, section.style, true)}
    >
      <div style={{ order: isReversed ? 2 : 1 }}>
        {renderSectionHeading(section, options)}
        {section.body ? (
          <div className={embedded ? undefined : 'prose max-w-none pt-5'}>
            {renderRichTextChildren(
              section.body,
              `${getSectionPrimaryKey(section)}-body`,
            )}
          </div>
        ) : null}
        {renderNestedSections(section, ctx, options)}
      </div>
      {image?.src ? (
        <img
          src={resolveAsset(image.src)}
          alt={image.alt ?? section.title ?? ''}
          className="w-full rounded-3xl object-cover"
          style={{ order: isReversed ? 1 : 2 }}
        />
      ) : null}
    </div>,
    options,
  );
}

function renderRuntimeFallback(
  plan: RuntimePagePlan,
  page: RuntimePageRecord,
  sections: RuntimeRenderableSection[],
): ReactNode {
  const pageContentSection = sections.find(
    (section) => section.type === 'page-content' && !section.__hidden,
  );

  if (pageContentSection) {
    return renderSectionShell(
      pageContentSection,
      <>
        {pageContentSection.showTitle !== false ? (
          <h1 className="text-4xl font-semibold tracking-tight">{page.title}</h1>
        ) : null}
        <div className="prose max-w-none pt-6">
          {renderRichTextChildren(page.content ?? '', `${page.slug}-fallback`)}
        </div>
      </>,
    );
  }

  return (
    <section
      className="mx-auto max-w-5xl px-6 py-16"
      data-runtime-component="RuntimePage"
      data-runtime-fallback="yes"
      data-runtime-source-kind={plan.source.kind}
    >
      <h1 className="text-4xl font-semibold tracking-tight">{page.title}</h1>
      <div className="prose max-w-none pt-6">
        {renderRichTextChildren(page.content ?? '', `${page.slug}-content`)}
      </div>
    </section>
  );
}

function RuntimeAccordionSection({
  section,
}: {
  section: RuntimeRenderableSection;
}) {
  return renderSectionShell(
    section,
    <>
      {renderSectionHeading(section)}
      <div className="space-y-4">
        {(section.items ?? []).map((item, index) => (
          <details
            key={`${getSectionPrimaryKey(section)}-${index}`}
            className="rounded-2xl border border-neutral-200 bg-white px-5 py-4"
          >
            <summary className="cursor-pointer text-lg font-semibold">
              {String(item.heading ?? item.title ?? `Item ${index + 1}`)}
            </summary>
            {item.body ? (
              <div className="prose prose-sm max-w-none pt-4 text-neutral-700">
                {renderRichTextChildren(
                  String(item.body),
                  `${getSectionPrimaryKey(section)}-${index}`,
                )}
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </>,
  );
}

function RuntimeTabsSection({ section }: { section: RuntimeRenderableSection }) {
  const items = section.tabs ?? section.items ?? [];
  const [activeIndex, setActiveIndex] = useState(0);
  const active = items[activeIndex] ?? null;

  return renderSectionShell(
    section,
    <>
      {renderSectionHeading(section)}
      <div className="flex flex-wrap gap-3 pb-5">
        {items.map((item, index) => (
          <button
            key={`${getSectionPrimaryKey(section)}-${index}`}
            type="button"
            onClick={() => setActiveIndex(index)}
            className={
              index === activeIndex
                ? 'rounded-full bg-black px-4 py-2 text-sm font-medium text-white'
                : 'rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700'
            }
          >
            {String(item.heading ?? item.title ?? `Tab ${index + 1}`)}
          </button>
        ))}
      </div>
      {active ? (
        <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
          {active.imageSrc ? (
            <img
              src={resolveAsset(String(active.imageSrc))}
              alt={String(active.imageAlt ?? active.heading ?? '')}
              className="mb-5 w-full rounded-2xl object-cover"
            />
          ) : null}
          {active.body ? (
            <div className="prose max-w-none">
              {renderRichTextChildren(
                String(active.body),
                `${getSectionPrimaryKey(section)}-active`,
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </>,
  );
}

function RuntimeCarouselSection({
  section,
}: {
  section: RuntimeRenderableSection;
}) {
  const slides = section.slides ?? section.items ?? [];

  return renderSectionShell(
    section,
    <>
      {renderSectionHeading(section)}
      <div className="flex snap-x gap-6 overflow-x-auto pb-2">
        {slides.map((slide, index) => (
          <article
            key={`${getSectionPrimaryKey(section)}-${index}`}
            className="min-w-[min(26rem,85vw)] snap-start rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm"
          >
            {slide.imageSrc ? (
              <img
                src={resolveAsset(String(slide.imageSrc))}
                alt={String(slide.imageAlt ?? slide.heading ?? '')}
                className="mb-4 aspect-[16/10] w-full rounded-2xl object-cover"
              />
            ) : null}
            <h3 className="text-xl font-semibold">
              {String(slide.heading ?? slide.title ?? `Slide ${index + 1}`)}
            </h3>
            {slide.body ? (
              <div className="prose prose-sm max-w-none pt-3 text-neutral-700">
                {renderRichTextChildren(
                  String(slide.body),
                  `${getSectionPrimaryKey(section)}-${index}`,
                )}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </>,
  );
}

function renderRuntimeLinkNode(
  node: RuntimeRenderableNode,
  key: string,
  text: string,
  style: CSSProperties,
  inspectAttrs?: Record<string, string | undefined>,
) {
  const className = toNodeClassName(node);
  const href = node.href ?? '#';
  const content = renderRichTextChildren(text || href, `${key}-link`);

  if (isInternalPath(href)) {
    return (
      <Link
        key={key}
        id={node.wrapper?.domId ?? node.domId}
        to={toAppPath(href)}
        className={className}
        style={style}
        {...inspectAttrs}
      >
        {content}
      </Link>
    );
  }

  return (
    <a
      key={key}
      id={node.wrapper?.domId ?? node.domId}
      href={href}
      className={className}
      style={style}
      target={href.startsWith('http') ? '_blank' : '_self'}
      rel={href.startsWith('http') ? 'noreferrer' : undefined}
      {...inspectAttrs}
    >
      {content}
    </a>
  );
}

function wrapRuntimeNode(
  node: RuntimeRenderableNode,
  key: string,
  children: ReactNode,
  options?: {
    style?: CSSProperties;
    inspectAttrs?: Record<string, string | undefined>;
    innerClassName?: string;
    innerStyle?: CSSProperties;
  },
) {
  const Tag = pickWrapperTag(node);
  const className = toNodeClassName(node);
  const style = options?.style ?? toNodeStyle(node);
  const domId = node.wrapper?.domId ?? node.domId;

  return (
    <Tag
      key={key}
      id={domId}
      className={className}
      style={style}
      {...options?.inspectAttrs}
    >
      {options?.innerClassName || options?.innerStyle ? (
        <div className={options.innerClassName} style={options.innerStyle}>
          {children}
        </div>
      ) : (
        children
      )}
    </Tag>
  );
}

function buildRuntimeInspectorAttrs(
  sourceNodeId: string,
  section?: RuntimePageSection | null,
): Record<string, string | undefined> {
  return {
    'data-runtime-component': 'RuntimePage',
    'data-source-node-id': sourceNodeId,
    'data-section-id': section?.id,
    'data-section-key': section?.debugKey ?? section?.sectionKey,
    'data-section-type': section?.type,
  };
}

function pickWrapperTag(
  node: RuntimeRenderableNode,
): keyof JSX.IntrinsicElements {
  const explicitTag = node.wrapper?.tagName ?? node.tagName;
  if (explicitTag) return explicitTag as keyof JSX.IntrinsicElements;
  if (node.blockName === 'core/columns') return 'section';
  if (node.blockName === 'core/column') return 'div';
  if (node.blockName === 'core/template-part') return 'section';
  if (node.blockName === 'core/media-text') return 'section';
  if (node.blockName === 'core/buttons') return 'div';
  if (node.blockName === 'uagb/container' || node.blockName === 'uagb/section')
    return 'section';
  if (
    node.kind === 'group' ||
    node.kind === 'container' ||
    node.kind === 'section' ||
    node.kind === 'cover' ||
    node.kind === 'media-text'
  ) {
    return 'section';
  }
  return 'div';
}

function renderSectionHeading(
  section: RuntimePageSection,
  options: RuntimeSectionRenderOptions = {},
) {
  const embedded = options.embedded === true;
  if (!section.title && !section.subtitle) return null;
  return (
    <header className={embedded ? undefined : 'pb-6'}>
      {section.subtitle ? (
        <p
          className={
            embedded
              ? undefined
              : 'pb-2 text-sm uppercase tracking-[0.18em] text-neutral-500'
          }
        >
          {section.subtitle}
        </p>
      ) : null}
      {section.title ? (
        <h2 className={embedded ? undefined : 'text-3xl font-semibold tracking-tight'}>
          {section.title}
        </h2>
      ) : null}
    </header>
  );
}

function renderSectionShell(
  section: RuntimeRenderableSection,
  children: ReactNode,
  options: RuntimeSectionRenderOptions = {},
) {
  if (options.embedded) {
    return <Fragment>{children}</Fragment>;
  }
  return (
    <section
      className={sectionClassName(section, false, options.embedded)}
      style={toSectionStyle(section)}
      {...buildRuntimeInspectorAttrs(
        section.sourceNodeId ?? getSectionPrimaryKey(section),
        section,
      )}
    >
      {children}
    </section>
  );
}

function renderNestedSections(
  section: RuntimeRenderableSection,
  ctx: RuntimeRenderContext,
  options: RuntimeSectionRenderOptions = {},
) {
  if (!section.children?.length) return null;
  return section.children.map((child) =>
    renderBoundSectionOverlay(child, ctx, options),
  );
}

export function sectionClassName(
  section: RuntimePageSection,
  isCover = false,
  embedded = false,
): string {
  const base =
    embedded
      ? ''
      : section.layout?.align === 'full' || isCover
      ? 'w-full py-12'
      : 'mx-auto max-w-6xl px-6 py-12';
  return mergeClassNames(
    base,
    section.customClassNames,
    section.style?.classNames,
  );
}

function clampHeadingLevel(level?: number): number {
  if (!Number.isFinite(level)) return 2;
  return Math.max(1, Math.min(6, Number(level)));
}

function resolveAsset(src?: string): string {
  if (!src) return '';
  if (src.startsWith('theme-asset:/')) {
    return src.replace('theme-asset:/', '/');
  }
  return src;
}

function getRuntimePostHref(post: RuntimePostRecord): string {
  if (post.type === 'product') {
    return `/product/${post.slug}`;
  }
  return `/${post.slug}`;
}

function toAppPath(url?: string): string {
  if (!url) return '/';
  if (url.startsWith('/')) return url;
  try {
    const resolved = new URL(url, window.location.origin);
    return `${resolved.pathname}${resolved.search}${resolved.hash}` || '/';
  } catch {
    return url;
  }
}

function isInternalPath(url?: string): boolean {
  if (!url) return false;
  if (url.startsWith('/')) return true;
  try {
    const resolved = new URL(url, window.location.origin);
    return resolved.origin === window.location.origin;
  } catch {
    return false;
  }
}

function mergeClassNames(
  ...parts: Array<string | string[] | undefined | null>
): string | undefined {
  const values = parts.flatMap((part) => {
    if (!part) return [];
    return Array.isArray(part) ? part : [part];
  });
  const filtered = values.map((value) => value.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered.join(' ') : undefined;
}

function toNodeClassName(node: RuntimeRenderableNode): string | undefined {
  return mergeClassNames(node.customClassNames, node.style?.classNames);
}

function toNodeStyle(node: RuntimeRenderableNode): CSSProperties {
  const style: CSSProperties = {};
  applyStyleSpec(style, node.style, node.layout);

  if (node.bgColor) style.backgroundColor = node.bgColor;
  if (node.textColor) style.color = node.textColor;
  if (node.borderRadius) style.borderRadius = node.borderRadius;
  if (node.gap) style.gap = node.gap;
  if (node.minHeight) style.minHeight = node.minHeight;
  if (node.textAlign) {
    style.textAlign = node.textAlign as CSSProperties['textAlign'];
  }
  if (node.justifyContent) {
    style.justifyContent =
      node.justifyContent as CSSProperties['justifyContent'];
  }
  if (node.align) {
    style.alignItems = node.align as CSSProperties['alignItems'];
  }
  if (node.columnWidth) style.flexBasis = node.columnWidth;
  if (node.padding) {
    style.paddingTop = node.padding.top;
    style.paddingRight = node.padding.right;
    style.paddingBottom = node.padding.bottom;
    style.paddingLeft = node.padding.left;
  }
  if (node.margin) {
    style.marginTop = node.margin.top;
    style.marginRight = node.margin.right;
    style.marginBottom = node.margin.bottom;
    style.marginLeft = node.margin.left;
  }
  if (node.fontFamily) style.fontFamily = node.fontFamily;

  if (node.blockName === 'core/columns' && !style.display) {
    style.display = 'grid';
    style.gridTemplateColumns = `repeat(${Math.max(
      node.layout?.columns ?? node.children?.length ?? 1,
      1,
    )}, minmax(0, 1fr))`;
  }
  if (node.blockName === 'core/buttons' && !style.display) {
    style.display = 'flex';
    style.flexWrap = 'wrap';
  }
  if (node.blockName === 'core/media-text' && !style.display) {
    style.display = 'grid';
    style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
    style.alignItems = 'center';
  }

  return style;
}

function toSectionStyle(
  section: RuntimePageSection,
  extra?: CSSProperties,
): CSSProperties {
  const style: CSSProperties = {};
  applyStyleSpec(style, section.style, section.layout);
  return { ...style, ...extra };
}

function applyStyleSpec(
  style: CSSProperties,
  styleSpec?: RuntimeStyleSpec,
  layout?: RuntimeLayoutSpec,
) {
  if (styleSpec?.colors?.background) {
    style.backgroundColor = styleSpec.colors.background;
  }
  if (styleSpec?.colors?.text) {
    style.color = styleSpec.colors.text;
  }
  if (styleSpec?.borderRadius) {
    style.borderRadius = styleSpec.borderRadius;
  }
  if (styleSpec?.gap) {
    style.gap = styleSpec.gap;
  }
  if (styleSpec?.spacing?.padding) {
    style.paddingTop = styleSpec.spacing.padding.top;
    style.paddingRight = styleSpec.spacing.padding.right;
    style.paddingBottom = styleSpec.spacing.padding.bottom;
    style.paddingLeft = styleSpec.spacing.padding.left;
  }
  if (styleSpec?.spacing?.margin) {
    style.marginTop = styleSpec.spacing.margin.top;
    style.marginRight = styleSpec.spacing.margin.right;
    style.marginBottom = styleSpec.spacing.margin.bottom;
    style.marginLeft = styleSpec.spacing.margin.left;
  }
  if (typeof styleSpec?.spacing?.blockGap === 'string') {
    style.gap = styleSpec.spacing.blockGap;
  } else if (styleSpec?.spacing?.blockGap) {
    style.columnGap = styleSpec.spacing.blockGap.x;
    style.rowGap = styleSpec.spacing.blockGap.y;
  }
  if (styleSpec?.typography?.fontFamily) {
    style.fontFamily = styleSpec.typography.fontFamily;
  }
  if (styleSpec?.typography?.fontSize) {
    style.fontSize = styleSpec.typography.fontSize;
  }
  if (styleSpec?.typography?.fontWeight) {
    style.fontWeight =
      styleSpec.typography.fontWeight as CSSProperties['fontWeight'];
  }
  if (styleSpec?.typography?.lineHeight) {
    style.lineHeight = styleSpec.typography.lineHeight;
  }
  if (styleSpec?.typography?.textAlign) {
    style.textAlign =
      styleSpec.typography.textAlign as CSSProperties['textAlign'];
  }
  if (styleSpec?.dimensions?.minHeight) {
    style.minHeight = styleSpec.dimensions.minHeight;
  }
  if (styleSpec?.dimensions?.width) {
    style.width = styleSpec.dimensions.width;
  }
  Object.assign(style, toLayoutStyle(layout, styleSpec));
}

function toLayoutStyle(
  layout?: RuntimeLayoutSpec,
  styleSpec?: RuntimeStyleSpec,
  preferGrid = false,
): CSSProperties {
  if (!layout) return {};
  const style: CSSProperties = {};
  const gap =
    styleSpec?.gap ??
    (typeof styleSpec?.spacing?.blockGap === 'string'
      ? styleSpec.spacing.blockGap
      : undefined);

  if (layout.kind === 'flex') {
    style.display = 'flex';
  }
  if (layout.kind === 'grid' || (preferGrid && !layout.kind)) {
    style.display = 'grid';
  }
  if (layout.justifyContent) {
    style.justifyContent =
      layout.justifyContent as CSSProperties['justifyContent'];
  }
  if (layout.alignItems) {
    style.alignItems = layout.alignItems as CSSProperties['alignItems'];
  }
  if (layout.orientation === 'vertical') {
    style.flexDirection = 'column';
  } else if (layout.orientation === 'horizontal') {
    style.flexDirection = 'row';
  }
  if (layout.flexWrap) {
    style.flexWrap = layout.flexWrap as CSSProperties['flexWrap'];
  }
  if (layout.columnWidth) {
    style.flexBasis = layout.columnWidth;
  }
  if (layout.minimumColumnWidth && (style.display === 'grid' || preferGrid)) {
    style.display = 'grid';
    style.gridTemplateColumns = `repeat(auto-fit, minmax(${layout.minimumColumnWidth}, 1fr))`;
  } else if (layout.columns && (style.display === 'grid' || preferGrid)) {
    style.display = 'grid';
    style.gridTemplateColumns = `repeat(${Math.max(
      layout.columns,
      1,
    )}, minmax(0, 1fr))`;
  }
  if (gap && !style.gap) {
    style.gap = gap;
  }
  return style;
}

function toGridGapStyle(styleSpec?: RuntimeStyleSpec): CSSProperties {
  if (typeof styleSpec?.spacing?.blockGap === 'string') {
    return { gap: styleSpec.spacing.blockGap };
  }
  if (styleSpec?.spacing?.blockGap) {
    return {
      columnGap: styleSpec.spacing.blockGap.x,
      rowGap: styleSpec.spacing.blockGap.y,
    };
  }
  if (styleSpec?.gap) return { gap: styleSpec.gap };
  return { gap: '1.5rem' };
}

function getSectionImage(section: RuntimePageSection): {
  src?: string;
  alt?: string;
} | null {
  if (section.image?.src) {
    return { src: section.image.src, alt: section.image.alt };
  }
  if (section.imageSrc) {
    return { src: section.imageSrc, alt: section.imageAlt };
  }
  return null;
}

function getSectionPrimaryKey(section: RuntimePageSection): string {
  return (
    section.id ??
    section.debugKey ??
    section.sectionKey ??
    section.sourceNodeId ??
    section.type
  );
}

function getSectionKeys(section: RuntimePageSection): string[] {
  return [
    section.id,
    section.debugKey,
    section.sectionKey,
    section.sourceNodeId,
  ].filter((value): value is string => Boolean(value));
}

function applyRuntimeOverrides(
  page: RuntimePageRecord,
  plan: RuntimePagePlan,
): RuntimePagePlan {
  const overrideSet =
    plan.overrides && plan.overrides.pageSlug === page.slug
      ? plan.overrides
      : null;
  if (!overrideSet?.patches.length) return plan;

  const next: RuntimePagePlan = {
    ...plan,
    sections: plan.sections.map((section) => cloneSection(section)),
    blockTree: plan.blockTree.map((node) => cloneNode(node)),
  };

  for (const patch of overrideSet.patches) {
    applyRuntimePatch(next, patch);
  }

  return next;
}

function cloneNode(node: RuntimeBlockNode): RuntimeRenderableNode {
  return {
    ...node,
    style: node.style ? { ...node.style } : undefined,
    layout: node.layout ? { ...node.layout } : undefined,
    wrapper: node.wrapper ? { ...node.wrapper } : undefined,
    sourceRef: node.sourceRef ? { ...node.sourceRef } : undefined,
    children: node.children?.map((child) => cloneNode(child)),
  };
}

function cloneSection(section: RuntimePageSection): RuntimeRenderableSection {
  return {
    ...section,
    image: section.image ? { ...section.image } : undefined,
    layout: section.layout ? { ...section.layout } : undefined,
    style: section.style ? { ...section.style } : undefined,
    sourceRef: section.sourceRef ? { ...section.sourceRef } : undefined,
    cards: section.cards?.map((card) => ({ ...card })),
    items: section.items?.map((item) => ({ ...item })),
    slides: section.slides?.map((item) => ({ ...item })),
    tabs: section.tabs?.map((item) => ({ ...item })),
    children: section.children?.map((child) => cloneSection(child)),
  };
}

function applyRuntimePatch(plan: RuntimePagePlan, patch: RuntimePagePatch) {
  const targetNode = patch.target.sourceNodeId
    ? findNodeBySourceNodeId(
        plan.blockTree as RuntimeRenderableNode[],
        patch.target.sourceNodeId,
      )
    : null;
  const targetSection = patch.target.sectionId
    ? findSectionById(
        plan.sections as RuntimeRenderableSection[],
        patch.target.sectionId,
      )
    : null;

  switch (patch.op) {
    case 'replace-text':
      applyReplaceTextPatch(targetNode, targetSection, patch.value);
      return;
    case 'replace-image':
      applyReplaceImagePatch(targetNode, targetSection, patch.value);
      return;
    case 'update-style':
      applyUpdateStylePatch(targetNode, targetSection, patch.value);
      return;
    case 'hide-node':
      if (targetNode) targetNode.__hidden = true;
      if (targetSection) targetSection.__hidden = true;
      return;
    case 'show-node':
      if (targetNode) targetNode.__hidden = false;
      if (targetSection) targetSection.__hidden = false;
      return;
    case 'reorder-within-parent':
      applyReorderPatch(targetNode, targetSection, patch.value);
      return;
    default:
      return;
  }
}

function applyReplaceTextPatch(
  node: RuntimeRenderableNode | null,
  section: RuntimeRenderableSection | null,
  value: Record<string, unknown>,
) {
  const html = readString(value.html);
  const text = readString(value.text);
  const title = readString(value.title);
  const subtitle = readString(value.subtitle);
  const body = readString(value.body);

  if (node) {
    if (html) node.html = html;
    if (text) node.text = text;
    if (!html && !text) {
      node.text = body ?? title ?? subtitle ?? node.text;
    }
  }

  if (section) {
    if (title) section.title = title;
    if (subtitle) section.subtitle = subtitle;
    if (body) section.body = body;
    if (!title && !subtitle && !body && (html || text)) {
      section.body = html ?? text ?? section.body;
    }
  }
}

function applyReplaceImagePatch(
  node: RuntimeRenderableNode | null,
  section: RuntimeRenderableSection | null,
  value: Record<string, unknown>,
) {
  const src = readString(value.src ?? value.imageSrc);
  const alt = readString(value.alt ?? value.imageAlt);

  if (node && src) {
    node.src = src;
    if (alt !== undefined) node.alt = alt;
  }

  if (section && src) {
    section.imageSrc = src;
    section.imageAlt = alt ?? section.imageAlt;
    section.image = {
      src,
      alt: alt ?? section.image?.alt,
    };
  }
}

function applyUpdateStylePatch(
  node: RuntimeRenderableNode | null,
  section: RuntimeRenderableSection | null,
  value: Record<string, unknown>,
) {
  const style = asObject(value.style);
  const layout = asObject(value.layout);
  const wrapper = asObject(value.wrapper);
  const classNames = readStringArray(value.classNames ?? value.customClassNames);

  if (node) {
    node.style = {
      ...(node.style ?? {}),
      ...(style as RuntimeStyleSpec),
      ...(classNames.length > 0 ? { classNames } : {}),
    };
    node.layout = {
      ...(node.layout ?? {}),
      ...(layout as RuntimeLayoutSpec),
    };
    if (wrapper) {
      node.wrapper = {
        ...(node.wrapper ?? {}),
        ...wrapper,
      };
    }
  }

  if (section) {
    section.style = {
      ...(section.style ?? {}),
      ...(style as RuntimeStyleSpec),
      ...(classNames.length > 0 ? { classNames } : {}),
    };
    section.layout = {
      ...(section.layout ?? {}),
      ...(layout as RuntimeLayoutSpec),
    };
  }
}

function applyReorderPatch(
  node: RuntimeRenderableNode | null,
  section: RuntimeRenderableSection | null,
  value: Record<string, unknown>,
) {
  const order = readStringArray(
    value.order ?? value.childIds ?? value.childSourceNodeIds,
  );
  if (order.length === 0) return;

  if (node?.children?.length) {
    node.children = reorderByKeys(node.children, order, (child) =>
      child.nodeId ?? child.sourceRef?.sourceNodeId ?? '',
    );
  }
  if (section?.children?.length) {
    section.children = reorderByKeys(section.children, order, (child) =>
      getSectionPrimaryKey(child),
    );
  }
}

function reorderByKeys<T>(
  items: T[],
  order: string[],
  readKey: (item: T) => string,
): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((a, b) => {
    const aRank = rank.get(readKey(a));
    const bRank = rank.get(readKey(b));
    if (aRank === undefined && bRank === undefined) return 0;
    if (aRank === undefined) return 1;
    if (bRank === undefined) return -1;
    return aRank - bRank;
  });
}

function findNodeBySourceNodeId(
  nodes: RuntimeRenderableNode[],
  sourceNodeId: string,
): RuntimeRenderableNode | null {
  for (const node of nodes) {
    const nodeId = node.nodeId ?? node.sourceRef?.sourceNodeId;
    if (nodeId === sourceNodeId) return node;
    const child = node.children?.length
      ? findNodeBySourceNodeId(node.children, sourceNodeId)
      : null;
    if (child) return child;
  }
  return null;
}

function findSectionById(
  sections: RuntimeRenderableSection[],
  sectionId: string,
): RuntimeRenderableSection | null {
  for (const section of sections) {
    if (getSectionKeys(section).includes(sectionId)) return section;
    const child = section.children?.length
      ? findSectionById(section.children, sectionId)
      : null;
    if (child) return child;
  }
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === 'string' && entry.trim() ? entry.trim() : null,
    )
    .filter((entry): entry is string => Boolean(entry));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function renderRichTextChildren(html: string, keyPrefix: string): ReactNode[] {
  if (!html) return [];
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return [html];
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return [html];

  return Array.from(root.childNodes)
    .map((node, index) => renderDomNode(node, `${keyPrefix}-${index}`))
    .filter((node): node is ReactNode => node !== null);
}

function renderDomNode(node: ChildNode, key: string): ReactNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return text.trim().length > 0 ? text : null;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as HTMLElement;
  const children = Array.from(el.childNodes)
    .map((child, index) => renderDomNode(child, `${key}-${index}`))
    .filter((child): child is ReactNode => child !== null);

  const tag = el.tagName.toLowerCase();
  const className = el.getAttribute('class') ?? undefined;
  const style = el.getAttribute('style') ?? undefined;

  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '#';
    return isInternalPath(href) ? (
      <Link key={key} to={toAppPath(href)} className={className}>
        {children}
      </Link>
    ) : (
      <a key={key} href={href} className={className}>
        {children}
      </a>
    );
  }

  if (tag === 'img') {
    return (
      <img
        key={key}
        src={resolveAsset(el.getAttribute('src') ?? '')}
        alt={el.getAttribute('alt') ?? ''}
        className={className}
      />
    );
  }

  return (
    <Fragment key={key}>
      {createElementFromTag(tag, className, style, children)}
    </Fragment>
  );
}

function createElementFromTag(
  tag: string,
  className: string | undefined,
  style: string | undefined,
  children: ReactNode[],
) {
  const props: Record<string, unknown> = {};
  if (className) props.className = className;
  if (style) props.style = styleToObject(style);
  return tag in intrinsicTagMap
    ? intrinsicTagMap[tag](props, children)
    : intrinsicTagMap.div(props, children);
}

const intrinsicTagMap: Record<
  string,
  (props: Record<string, unknown>, children: ReactNode[]) => ReactNode
> = {
  div: (props, children) => <div {...props}>{children}</div>,
  p: (props, children) => <p {...props}>{children}</p>,
  span: (props, children) => <span {...props}>{children}</span>,
  strong: (props, children) => <strong {...props}>{children}</strong>,
  b: (props, children) => <strong {...props}>{children}</strong>,
  em: (props, children) => <em {...props}>{children}</em>,
  i: (props, children) => <em {...props}>{children}</em>,
  ul: (props, children) => <ul {...props}>{children}</ul>,
  ol: (props, children) => <ol {...props}>{children}</ol>,
  li: (props, children) => <li {...props}>{children}</li>,
  h1: (props, children) => <h1 {...props}>{children}</h1>,
  h2: (props, children) => <h2 {...props}>{children}</h2>,
  h3: (props, children) => <h3 {...props}>{children}</h3>,
  h4: (props, children) => <h4 {...props}>{children}</h4>,
  h5: (props, children) => <h5 {...props}>{children}</h5>,
  h6: (props, children) => <h6 {...props}>{children}</h6>,
  blockquote: (props, children) => <blockquote {...props}>{children}</blockquote>,
  figure: (props, children) => <figure {...props}>{children}</figure>,
  figcaption: (props, children) => <figcaption {...props}>{children}</figcaption>,
  pre: (props, children) => <pre {...props}>{children}</pre>,
  code: (props, children) => <code {...props}>{children}</code>,
  kbd: (props, children) => <kbd {...props}>{children}</kbd>,
  table: (props, children) => <table {...props}>{children}</table>,
  thead: (props, children) => <thead {...props}>{children}</thead>,
  tbody: (props, children) => <tbody {...props}>{children}</tbody>,
  tfoot: (props, children) => <tfoot {...props}>{children}</tfoot>,
  tr: (props, children) => <tr {...props}>{children}</tr>,
  th: (props, children) => <th {...props}>{children}</th>,
  td: (props, children) => <td {...props}>{children}</td>,
  caption: (props, children) => <caption {...props}>{children}</caption>,
  mark: (props, children) => <mark {...props}>{children}</mark>,
  s: (props, children) => <s {...props}>{children}</s>,
  del: (props, children) => <del {...props}>{children}</del>,
  ins: (props, children) => <ins {...props}>{children}</ins>,
  sub: (props, children) => <sub {...props}>{children}</sub>,
  sup: (props, children) => <sup {...props}>{children}</sup>,
  section: (props, children) => <section {...props}>{children}</section>,
  article: (props, children) => <article {...props}>{children}</article>,
  aside: (props, children) => <aside {...props}>{children}</aside>,
  header: (props, children) => <header {...props}>{children}</header>,
  footer: (props, children) => <footer {...props}>{children}</footer>,
  nav: (props, children) => <nav {...props}>{children}</nav>,
  details: (props, children) => <details {...props}>{children}</details>,
  summary: (props, children) => <summary {...props}>{children}</summary>,
  address: (props, children) => <address {...props}>{children}</address>,
  br: (_props, _children) => <br />,
  hr: (_props, _children) => <hr />,
};

function styleToObject(style: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const part of style.split(';')) {
    const [rawName, rawValue] = part.split(':');
    const name = rawName?.trim();
    const value = rawValue?.trim();
    if (!name || !value) continue;
    const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = value;
  }
  return out as CSSProperties;
}
