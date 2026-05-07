import { Fragment, createElement, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RuntimePageResponse } from '../runtime/runtime-contract';

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
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'main',
  'mark',
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

  if (isProfolioFse && hasExpandedTemplate) {
    return (
      <div className={runtimePageClassName} {...runtimePageDataProps}>
        {renderRichTextChildren(page.content ?? '', `${page.slug}-content`)}
      </div>
    );
  }

  return (
    <main
      className={runtimePageClassName}
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
