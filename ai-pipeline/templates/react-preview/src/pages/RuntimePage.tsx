import { Fragment, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  RuntimeBlockNode,
  RuntimePagePlan,
  RuntimePageRecord,
  RuntimePageResponse,
  RuntimePageSection,
  RuntimePageSubtreeBinding,
} from '../runtime/runtime-contract';

interface RuntimePageProps {
  slug?: string;
  apiBase?: string;
}

interface RuntimeRenderContext {
  page: RuntimePageRecord;
  plan: RuntimePagePlan;
  bindings: Map<string, RuntimePageSubtreeBinding>;
  sections: Map<string, RuntimePageSection>;
}

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
  const ctx: RuntimeRenderContext = {
    page,
    plan: runtimePlan,
    bindings: new Map(
      (runtimePlan.subtreeBindings ?? []).map((binding) => [
        binding.nodeId,
        binding,
      ]),
    ),
    sections: new Map(
      runtimePlan.sections.map((section) => [
        section.debugKey ?? section.sectionKey ?? '',
        section,
      ]),
    ),
  };

  return (
    <main
      className="runtime-page"
      data-runtime-component="RuntimePage"
      data-runtime-slug={page.slug}
      data-runtime-mode={runtimePlan.mode}
      data-runtime-fidelity={runtimePlan.fidelity}
      data-runtime-safe={runtimePlan.support.safeForRuntime ? 'yes' : 'no'}
    >
      {!runtimePlan.support.safeForRuntime &&
      runtimePlan.support.unsupportedBlocks.length > 0 ? (
        <div className="mx-auto max-w-6xl px-6 pt-6">
          <div className="rounded-3xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-800">
            Runtime page is in best-effort mode. Unsupported blocks:{' '}
            {runtimePlan.support.unsupportedBlocks.join(', ')}
          </div>
        </div>
      ) : null}
      {runtimePlan.blockTree.length > 0
        ? renderRuntimeNodes(runtimePlan.blockTree, ctx)
        : renderRuntimeFallback(runtimePlan, page)}
    </main>
  );
}

function renderRuntimeNodes(
  nodes: RuntimeBlockNode[],
  ctx: RuntimeRenderContext,
  path = 'root',
): ReactNode[] {
  return nodes.map((node, index) =>
    renderRuntimeNode(node, ctx, `${path}.${index + 1}`),
  );
}

function renderRuntimeNode(
  node: RuntimeBlockNode,
  ctx: RuntimeRenderContext,
  key: string,
): ReactNode {
  const nodeId = node.sourceRef?.sourceNodeId ?? key;
  const binding = ctx.bindings.get(nodeId);
  const overlaySection =
    binding?.sectionDebugKey && ctx.sections.has(binding.sectionDebugKey)
      ? ctx.sections.get(binding.sectionDebugKey) ?? null
      : null;

  if (overlaySection) {
    const overlay = renderBoundSectionOverlay(overlaySection, ctx);
    if (overlay) return wrapRuntimeNode(node, key, overlay);
  }

  const children = node.children?.length
    ? renderRuntimeNodes(node.children, ctx, key)
    : null;
  const style = toNodeStyle(node);
  const className = toClassName(node.customClassNames);
  const text = node.html ?? node.text ?? '';
  const inspectAttrs = buildRuntimeInspectorAttrs(nodeId, overlaySection);

  switch (node.blockName) {
    case 'core/heading': {
      const level = clampHeadingLevel(node.level);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      return (
        <Tag
          key={key}
          id={node.domId}
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
          id={node.domId}
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
          id={node.domId}
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
    case 'core/site-title':
      return (
        <div
          key={key}
          id={node.domId}
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
          id={node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {renderRichTextChildren(ctx.page.content ?? '', `${nodeId}-content`)}
        </div>
      );
    case 'core/cover':
      return wrapRuntimeNode(node, key, children, {
        style: {
          ...style,
          ...(node.src
            ? {
                backgroundImage: `url("${resolveAsset(node.src)}")`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }
            : {}),
        },
        inspectAttrs,
      });
    case 'core/list':
      return (
        <ul
          key={key}
          id={node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {children}
        </ul>
      );
    case 'core/list-item':
      return (
        <li
          key={key}
          id={node.domId}
          className={className}
          style={style}
          {...inspectAttrs}
        >
          {children ?? renderRichTextChildren(text, nodeId)}
        </li>
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

function renderBoundSectionOverlay(
  section: RuntimePageSection,
  ctx: RuntimeRenderContext,
): ReactNode {
  switch (section.type) {
    case 'page-content':
      return (
        <section className={sectionClassName(section)}>
          {section.showTitle !== false ? (
            <h1 className="text-4xl font-semibold tracking-tight">
              {ctx.page.title}
            </h1>
          ) : null}
          <div className="prose max-w-none pt-6">
            {renderRichTextChildren(
              ctx.page.content ?? '',
              `${ctx.page.slug}-page-content`,
            )}
          </div>
        </section>
      );
    case 'prose-block':
      return (
        <section className={sectionClassName(section)}>
          {section.title ? (
            <h2 className="text-3xl font-semibold tracking-tight">
              {section.title}
            </h2>
          ) : null}
          {section.subtitle ? (
            <p className="pt-2 text-sm uppercase tracking-[0.18em] text-neutral-500">
              {section.subtitle}
            </p>
          ) : null}
          {section.body ? (
            <div className="prose max-w-none pt-5">
              {renderRichTextChildren(
                section.body,
                `${section.debugKey ?? section.sectionKey ?? 'prose'}-body`,
              )}
            </div>
          ) : null}
        </section>
      );
    case 'card-grid':
      return (
        <section className={sectionClassName(section)}>
          {renderSectionHeading(section)}
          <div
            className="grid gap-6"
            style={{
              gridTemplateColumns: `repeat(${Math.max(section.columns ?? 1, 1)}, minmax(0, 1fr))`,
            }}
          >
            {(section.cards ?? []).map((card, index) => (
              <article
                key={`${section.debugKey ?? 'card-grid'}-${index}`}
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
                      `${section.debugKey ?? 'card-grid'}-card-${index}`,
                    )}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      );
    case 'accordion':
      return <RuntimeAccordionSection section={section} />;
    case 'tabs':
      return <RuntimeTabsSection section={section} />;
    case 'carousel':
      return <RuntimeCarouselSection section={section} />;
    case 'hero':
    case 'cover':
    case 'media-text':
      return (
        <section className={sectionClassName(section)}>
          <div className="grid gap-8 md:grid-cols-2 md:items-center">
            <div>
              {renderSectionHeading(section)}
              {section.body ? (
                <div className="prose max-w-none pt-5">
                  {renderRichTextChildren(
                    section.body,
                    `${section.debugKey ?? section.sectionKey ?? section.type}-body`,
                  )}
                </div>
              ) : null}
            </div>
            {section.imageSrc ? (
              <img
                src={resolveAsset(section.imageSrc)}
                alt={section.imageAlt ?? section.title ?? ''}
                className="w-full rounded-3xl object-cover"
              />
            ) : null}
          </div>
        </section>
      );
    default:
      return null;
  }
}

function renderRuntimeFallback(
  plan: RuntimePagePlan,
  page: RuntimePageRecord,
): ReactNode {
  const pageContentSection = plan.sections.find(
    (section) => section.type === 'page-content',
  );

  if (pageContentSection) {
    return (
      <section className="mx-auto max-w-5xl px-6 py-16">
        {pageContentSection.showTitle !== false ? (
          <h1 className="text-4xl font-semibold tracking-tight">{page.title}</h1>
        ) : null}
        <div className="prose max-w-none pt-6">
          {renderRichTextChildren(page.content ?? '', `${page.slug}-fallback`)}
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">{page.title}</h1>
      <div className="prose max-w-none pt-6">
        {renderRichTextChildren(page.content ?? '', `${page.slug}-content`)}
      </div>
    </section>
  );
}

function RuntimeAccordionSection({ section }: { section: RuntimePageSection }) {
  return (
    <section className={sectionClassName(section)}>
      {renderSectionHeading(section)}
      <div className="space-y-4">
        {(section.items ?? []).map((item, index) => (
          <details
            key={`${section.debugKey ?? 'accordion'}-${index}`}
            className="rounded-2xl border border-neutral-200 bg-white px-5 py-4"
          >
            <summary className="cursor-pointer text-lg font-semibold">
              {String(item.heading ?? item.title ?? `Item ${index + 1}`)}
            </summary>
            {item.body ? (
              <div className="prose prose-sm max-w-none pt-4 text-neutral-700">
                {renderRichTextChildren(
                  String(item.body),
                  `${section.debugKey ?? 'accordion'}-${index}`,
                )}
              </div>
            ) : null}
          </details>
        ))}
      </div>
    </section>
  );
}

function RuntimeTabsSection({ section }: { section: RuntimePageSection }) {
  const items = section.tabs ?? section.items ?? [];
  const [activeIndex, setActiveIndex] = useState(0);
  const active = items[activeIndex] ?? null;

  return (
    <section className={sectionClassName(section)}>
      {renderSectionHeading(section)}
      <div className="flex flex-wrap gap-3 pb-5">
        {items.map((item, index) => (
          <button
            key={`${section.debugKey ?? 'tabs'}-${index}`}
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
                `${section.debugKey ?? 'tabs'}-active`,
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeCarouselSection({ section }: { section: RuntimePageSection }) {
  const slides = section.slides ?? section.items ?? [];

  return (
    <section className={sectionClassName(section)}>
      {renderSectionHeading(section)}
      <div className="flex snap-x gap-6 overflow-x-auto pb-2">
        {slides.map((slide, index) => (
          <article
            key={`${section.debugKey ?? 'carousel'}-${index}`}
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
                  `${section.debugKey ?? 'carousel'}-${index}`,
                )}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function renderRuntimeLinkNode(
  node: RuntimeBlockNode,
  key: string,
  text: string,
  style: CSSProperties,
  inspectAttrs?: Record<string, string | undefined>,
) {
  const className = toClassName(node.customClassNames);
  const href = node.href ?? '#';
  const content = renderRichTextChildren(text || href, `${key}-link`);

  if (isInternalPath(href)) {
    return (
      <Link
        key={key}
        id={node.domId}
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
      id={node.domId}
      href={href}
      className={className}
      style={style}
      target={node.blockName === 'core/navigation-link' ? undefined : '_self'}
      rel={href.startsWith('http') ? 'noreferrer' : undefined}
      {...inspectAttrs}
    >
      {content}
    </a>
  );
}

function wrapRuntimeNode(
  node: RuntimeBlockNode,
  key: string,
  children: ReactNode,
  options?: {
    style?: CSSProperties;
    inspectAttrs?: Record<string, string | undefined>;
  },
) {
  const Tag = pickWrapperTag(node);
  const className = toClassName(node.customClassNames);
  const style = options?.style ?? toNodeStyle(node);

  return (
    <Tag
      key={key}
      id={node.domId}
      className={className}
      style={style}
      {...options?.inspectAttrs}
    >
      {children}
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
    'data-section-key': section?.debugKey ?? section?.sectionKey,
    'data-section-type': section?.type,
  };
}

function pickWrapperTag(node: RuntimeBlockNode): keyof JSX.IntrinsicElements {
  if (node.blockName === 'core/columns') return 'section';
  if (node.blockName === 'core/column') return 'div';
  if (node.blockName === 'core/template-part') return 'section';
  if (node.blockName === 'uagb/container' || node.blockName === 'uagb/section')
    return 'section';
  if (node.kind === 'group' || node.kind === 'container' || node.kind === 'section')
    return 'section';
  return 'div';
}

function renderSectionHeading(section: RuntimePageSection) {
  if (!section.title && !section.subtitle) return null;
  return (
    <header className="pb-6">
      {section.subtitle ? (
        <p className="pb-2 text-sm uppercase tracking-[0.18em] text-neutral-500">
          {section.subtitle}
        </p>
      ) : null}
      {section.title ? (
        <h2 className="text-3xl font-semibold tracking-tight">
          {section.title}
        </h2>
      ) : null}
    </header>
  );
}

function sectionClassName(section: RuntimePageSection): string {
  return [
    'mx-auto max-w-6xl px-6 py-12',
    ...(section.customClassNames ?? []),
  ].join(' ');
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

function toClassName(classNames?: string[]): string | undefined {
  if (!classNames?.length) return undefined;
  return classNames.filter(Boolean).join(' ');
}

function toNodeStyle(node: RuntimeBlockNode): CSSProperties {
  const style: CSSProperties = {};
  if (node.bgColor) style.backgroundColor = node.bgColor;
  if (node.textColor) style.color = node.textColor;
  if (node.borderRadius) style.borderRadius = node.borderRadius;
  if (node.gap) style.gap = node.gap;
  if (node.minHeight) style.minHeight = node.minHeight;
  if (node.textAlign) style.textAlign = node.textAlign as CSSProperties['textAlign'];
  if (node.justifyContent)
    style.justifyContent =
      node.justifyContent as CSSProperties['justifyContent'];
  if (node.align) style.alignItems = node.align as CSSProperties['alignItems'];
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
  return style;
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
  em: (props, children) => <em {...props}>{children}</em>,
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
