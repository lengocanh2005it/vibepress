export interface CanonicalPagePathLike {
  id: number | string;
  slug?: string | null;
  parentId?: number | string | null;
}

export interface CanonicalPagePathOptions {
  frontPageId?: number | string | null;
}

function normalizeSlugSegment(value: unknown): string | null {
  const normalized = String(value ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return normalized || null;
}

export function buildCanonicalPagePath(
  page: CanonicalPagePathLike,
  pages: CanonicalPagePathLike[],
  options: CanonicalPagePathOptions = {},
): string {
  const pageId = String(page.id ?? '').trim();
  const frontPageId = String(options.frontPageId ?? '').trim();
  if (pageId && frontPageId && pageId === frontPageId) return '/';

  const byId = new Map(
    pages.map((entry) => [String(entry.id ?? '').trim(), entry] as const),
  );
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: CanonicalPagePathLike | undefined = page;

  while (current) {
    const currentId = String(current.id ?? '').trim();
    if (currentId) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      if (frontPageId && currentId === frontPageId) break;
    }

    const slug = normalizeSlugSegment(current.slug);
    if (slug) segments.unshift(slug);

    const parentId = String(current.parentId ?? '').trim();
    if (!parentId || parentId === '0') break;
    current = byId.get(parentId);
  }

  if (segments.length === 0) {
    return pageId ? `/page/${pageId}` : '/page';
  }

  return `/${segments.join('/')}`;
}
