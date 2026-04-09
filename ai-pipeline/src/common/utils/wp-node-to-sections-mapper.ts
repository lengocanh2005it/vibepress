/**
 * Deterministic mapper: WpNode[] → SectionPlan[]
 *
 * Reads the ordered WpNode tree (already parsed from WordPress block markup)
 * and produces a draft SectionPlan[] that preserves the exact section order
 * from the original WordPress template.
 *
 * The draft is injected into the AI visual-plan prompt as a hard-ordered
 * skeleton.  AI is only allowed to fill in content fields (headings, image
 * src, menu slugs, etc.) — it must NOT reorder, merge, or drop sections
 * unless a live screenshot explicitly contradicts the draft.
 */

import type { WpNode } from './wp-block-to-json.js';
import type {
  SectionPlan,
  TypographyStyle,
  NavbarSection,
  HeroSection,
  CoverSection,
  PostListSection,
  CardGridSection,
  MediaTextSection,
  FooterSection,
  PostContentSection,
  PageContentSection,
  SearchSection,
  BreadcrumbSection,
  SidebarSection,
} from '../../modules/agents/react-generator/visual-plan.schema.js';

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Map an ordered WpNode[] into a draft SectionPlan[].
 * Returns an empty array when nothing can be recognised (caller falls back to
 * AI-only planning).
 */
export function mapWpNodesToDraftSections(nodes: WpNode[]): SectionPlan[] {
  return mapNodes(nodes, nodes);
}

// ── Per-node dispatch ───────────────────────────────────────────────────────

function mapNodes(nodes: WpNode[], siblings: WpNode[]): SectionPlan[] {
  const sections: SectionPlan[] = [];
  for (const node of nodes) {
    sections.push(...mapNode(node, siblings));
  }
  return sections;
}

function mapNode(node: WpNode, siblings: WpNode[]): SectionPlan[] {
  const block = node.block;

  // template-part blocks: delegate by slug
  if (block === 'core/template-part' || block === 'template-part') {
    return toMappedSections(mapTemplatePart(node), node);
  }

  // Navigation / site header chrome
  if (block === 'core/navigation' || block === 'navigation') {
    return toMappedSections(mapNavigation(node), node);
  }

  // Group acting as a page-level wrapper — recurse into children
  if (
    (block === 'core/group' || block === 'group') &&
    node.children?.length
  ) {
    return mapGroup(node, siblings);
  }

  // Cover block (hero with background image)
  if (block === 'core/cover' || block === 'cover') {
    return toMappedSections(mapCover(node), node);
  }

  // Query / post loop
  if (block === 'core/query' || block === 'query') {
    return toMappedSections(mapQuery(node), node);
  }

  // Columns: media-text or card-grid depending on content
  if (block === 'core/columns' || block === 'columns') {
    return toMappedSections(mapColumns(node), node);
  }

  // Post / page content placeholder blocks
  if (block === 'core/post-content' || block === 'post-content') {
    return toMappedSections(mapPostContent(node), node);
  }
  if (block === 'core/page-list' || block === 'core/pages' || block === 'page-list') {
    // Treat as page-content placeholder
    const s: PageContentSection = { type: 'page-content', showTitle: true };
    return toMappedSections(s, node);
  }

  // Search
  if (block === 'core/search' || block === 'search') {
    const s: SearchSection = { type: 'search' };
    return toMappedSections(s, node);
  }

  // Separator / spacer — skip, not a section
  if (
    block === 'core/separator' ||
    block === 'separator' ||
    block === 'core/spacer' ||
    block === 'spacer'
  ) {
    return [];
  }

  // Standalone heading at root level that looks like a hero heading
  if (
    (block === 'core/heading' || block === 'heading') &&
    node.level === 1
  ) {
    return toMappedSections(mapStandaloneH1(node), node);
  }

  return [];
}

// ── template-part ───────────────────────────────────────────────────────────

function mapTemplatePart(node: WpNode): SectionPlan | null {
  const slug: string = (node.params?.slug ?? node.params?.theme ?? '') as string;
  const slugL = slug.toLowerCase();

  if (slugL.includes('header') || slugL.includes('nav')) {
    const s: NavbarSection = {
      type: 'navbar',
      sticky: false,
      menuSlug: 'primary',
    };
    return s;
  }
  if (slugL.includes('footer')) {
    const s: FooterSection = {
      type: 'footer',
      menuColumns: [],
    };
    return s;
  }
  if (slugL.includes('sidebar')) {
    const s: SidebarSection = {
      type: 'sidebar',
      showSiteInfo: false,
      showPages: true,
      showPosts: true,
    };
    return s;
  }
  if (slugL.includes('breadcrumb')) {
    const s: BreadcrumbSection = { type: 'breadcrumb' };
    return s;
  }
  return null;
}

// ── navigation ──────────────────────────────────────────────────────────────

function mapNavigation(node: WpNode): NavbarSection {
  // Try to infer menuSlug from navigation-link children labels
  const menuSlug = inferMenuSlugFromNavChildren(node.children ?? []);
  return {
    type: 'navbar',
    sticky: false,
    menuSlug: menuSlug ?? 'primary',
  };
}

function inferMenuSlugFromNavChildren(children: WpNode[]): string | undefined {
  // If the WP navigation block has a `ref` (menu ID), we can't resolve it here.
  // Return undefined so AI will fill in the correct menuSlug from live menus.
  return undefined;
}

// ── cover block ─────────────────────────────────────────────────────────────

function mapCover(node: WpNode): CoverSection | HeroSection {
  // If it has a background image and dimRatio it's a cover/hero
  const src = node.src ?? '';
  const dimRatio = (node.params?.dimRatio as number | undefined) ?? 50;
  const minHeight = normalizeCssLength(node.minHeight) ?? '400px';
  const contentAlign =
    (node.params?.contentPosition as string | undefined)?.includes('left')
      ? 'left'
      : (node.params?.contentPosition as string | undefined)?.includes('right')
        ? 'right'
        : 'center';

  if (src) {
    const s: CoverSection = {
      type: 'cover',
      imageSrc: src,
      dimRatio,
      minHeight,
      contentAlign,
    };
    // Lift heading/subheading from children
    const headingNode = findFirstByBlock(node.children ?? [], ['core/heading', 'heading']);
    if (headingNode?.text) s.heading = headingNode.text;
    if (headingNode?.typography || headingNode?.fontFamily) {
      s.headingStyle = toTypographyStyle(headingNode);
    }
    const paraNode = findFirstByBlock(node.children ?? [], ['core/paragraph', 'paragraph']);
    if (paraNode?.text) s.subheading = paraNode.text;
    if (paraNode?.typography || paraNode?.fontFamily) {
      s.subheadingStyle = toTypographyStyle(paraNode);
    }
    const btnNode = findFirstByBlock(node.children ?? [], [
      'core/button', 'button', 'core/buttons', 'buttons',
    ]);
    if (btnNode?.text) s.cta = { text: btnNode.text, link: btnNode.href ?? '#' };
    return s;
  }

  // No image — treat as a text-only hero section
  const s: HeroSection = {
    type: 'hero',
    layout: contentAlign === 'center' ? 'centered' : 'left',
    heading: '',
  };
  const h = findFirstByBlock(node.children ?? [], ['core/heading', 'heading']);
  if (h?.text) s.heading = h.text;
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  const p = findFirstByBlock(node.children ?? [], ['core/paragraph', 'paragraph']);
  if (p?.text) s.subheading = p.text;
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  return s;
}

// ── group block ─────────────────────────────────────────────────────────────

function mapGroup(node: WpNode, _siblings: WpNode[]): SectionPlan[] {
  const children = node.children ?? [];
  if (children.length === 0) return [];

  // Group acting as a hero: has heading + paragraph (+ optional button)
  if (isHeroGroup(children)) {
    return toMappedSections(buildHeroFromChildren(node, children), node);
  }

  // Group acting as a 2-column media-text layout
  if (isMediaTextGroup(children)) {
    return toMappedSections(buildMediaTextFromColumns(children), node);
  }

  // Group with a query inside → defer to query mapper
  const queryChild = children.find(
    (c) => c.block === 'core/query' || c.block === 'query',
  );
  if (queryChild) return toMappedSections(mapQuery(queryChild), node);

  // Group with a search block
  const searchChild = children.find(
    (c) => c.block === 'core/search' || c.block === 'search',
  );
  if (searchChild) {
    const s: SearchSection = { type: 'search' };
    const headingChild = findFirstByBlock(children, ['core/heading', 'heading']);
    if (headingChild?.text) s.title = headingChild.text;
    return toMappedSections(s, node);
  }

  // Nested group that contains further sub-sections — recurse and keep them all.
  const nestedSections = mapNodes(children, children);
  if (nestedSections.length === 1) {
    return [applyNodePresentation(nestedSections[0], node)];
  }
  return nestedSections;
}

// ── query block (post list) ─────────────────────────────────────────────────

function mapQuery(node: WpNode): PostListSection {
  const perPage = (node.params?.perPage as number | undefined) ?? 6;
  // Infer layout from children: if post-template has columns layout it's a grid
  const postTemplate = findFirstByBlock(node.children ?? [], [
    'core/post-template',
    'post-template',
  ]);
  const columnsInTemplate =
    postTemplate?.children?.some(
      (c) => c.block === 'core/columns' || c.block === 'columns',
    ) ?? false;
  const layout: PostListSection['layout'] = columnsInTemplate
    ? 'grid-3'
    : 'list';

  return {
    type: 'post-list',
    layout,
    showDate: true,
    showAuthor: false,
    showCategory: true,
    showExcerpt: true,
    showFeaturedImage: true,
  };
}

// ── columns block ───────────────────────────────────────────────────────────

function mapColumns(node: WpNode): CardGridSection | MediaTextSection | null {
  const cols = node.children?.filter(
    (c) => c.block === 'core/column' || c.block === 'column',
  ) ?? [];

  if (cols.length === 0) return null;

  // 2-col: check if one side is image and other is text → media-text
  if (cols.length === 2) {
    const hasImage = cols.some(
      (c) => findFirstByBlock(flattenChildren(c), ['core/image', 'image']) !== null,
    );
    if (hasImage) {
      return buildMediaTextFromColumns(cols);
    }
  }

  // Otherwise: card-grid
  const cards = cols.map((col) => {
    const h = findFirstByBlock(flattenChildren(col), ['core/heading', 'heading']);
    const p = findFirstByBlock(flattenChildren(col), ['core/paragraph', 'paragraph']);
    return {
      heading: h?.text ?? '',
      body: p?.text ?? '',
    };
  }).filter((c) => c.heading || c.body);

  if (cards.length === 0) return null;

  const colCount = Math.min(Math.max(cols.length, 2), 4) as 2 | 3 | 4;
  const s: CardGridSection = {
    type: 'card-grid',
    columns: colCount,
    cards,
  };
  const columnWidths = cols
    .map((col) => normalizeCssLength(col.columnWidth))
    .filter((value): value is string => !!value);
  if (columnWidths.length === cols.length) s.columnWidths = columnWidths;
  return s;
}

// ── post-content ────────────────────────────────────────────────────────────

function mapPostContent(node: WpNode): PostContentSection | PageContentSection {
  // If it's inside a post/single template context it's a post-content; the
  // caller decides dataNeeds. We default to post-content and let AI/reviewer
  // correct it when the component contract says pageDetail instead.
  const s: PostContentSection = {
    type: 'post-content',
    showTitle: true,
    showAuthor: true,
    showDate: true,
    showCategories: true,
  };
  return s;
}

// ── standalone H1 ───────────────────────────────────────────────────────────

function mapStandaloneH1(node: WpNode): HeroSection {
  const hero: HeroSection = {
    type: 'hero',
    layout: node.textAlign === 'center' ? 'centered' : 'left',
    heading: node.text ?? '',
  };
  if (node.typography || node.fontFamily) {
    hero.headingStyle = toTypographyStyle(node);
  }
  return hero;
}

function toMappedSections(
  section: SectionPlan | null,
  node: WpNode,
): SectionPlan[] {
  if (!section) return [];
  return [applyNodePresentation(section, node)];
}

function applyNodePresentation<T extends SectionPlan>(
  section: T,
  node: WpNode,
): T {
  const next: T = { ...section };
  if (node.bgColor && !next.background) next.background = node.bgColor;
  if (node.textColor && !next.textColor) next.textColor = node.textColor;
  if (node.padding && !next.paddingStyle) {
    next.paddingStyle = boxSpacingToCss(node.padding);
  }
  if (node.margin && !next.marginStyle) {
    next.marginStyle = boxSpacingToCss(node.margin);
  }
  if (node.gap && !next.gapStyle) {
    next.gapStyle = node.gap;
  }
  return next;
}

// ── helpers: recognise group intent ────────────────────────────────────────

function isHeroGroup(children: WpNode[]): boolean {
  const flat = flattenChildren({ children } as WpNode);
  const hasH1OrH2 = flat.some(
    (c) =>
      (c.block === 'core/heading' || c.block === 'heading') &&
      (c.level === 1 || c.level === 2),
  );
  const hasPara = flat.some(
    (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
  );
  return hasH1OrH2 && hasPara;
}

function buildHeroFromChildren(
  groupNode: WpNode,
  children: WpNode[],
): HeroSection {
  const flat = flattenChildren({ children } as WpNode);
  const h = flat.find(
    (c) =>
      (c.block === 'core/heading' || c.block === 'heading') &&
      (c.level === 1 || c.level === 2),
  );
  const p = flat.find(
    (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
  );
  const btn = flat.find(
    (c) =>
      c.block === 'core/button' ||
      c.block === 'button' ||
      c.block === 'core/buttons' ||
      c.block === 'buttons',
  );
  const img = flat.find(
    (c) => c.block === 'core/image' || c.block === 'image',
  );

  const align = groupNode.textAlign ?? groupNode.params?.textAlign ?? 'left';
  const layout: HeroSection['layout'] =
    align === 'center' ? 'centered' : img ? 'split' : 'left';

  const s: HeroSection = {
    type: 'hero',
    layout,
    heading: h?.text ?? '',
  };
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  if (p?.text) s.subheading = p.text;
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  if (btn?.text) s.cta = { text: btn.text, link: btn.href ?? '#' };
  if (img?.src) s.image = { src: img.src, alt: img.alt ?? '', position: 'right' };
  if (groupNode.padding) {
    s.paddingStyle = boxSpacingToCss(groupNode.padding);
  }
  return s;
}

function isMediaTextGroup(children: WpNode[]): boolean {
  const cols = children.filter(
    (c) => c.block === 'core/column' || c.block === 'column',
  );
  if (cols.length !== 2) return false;
  const flat0 = flattenChildren(cols[0]);
  const flat1 = flattenChildren(cols[1]);
  const hasImg =
    flat0.some((c) => c.block === 'core/image' || c.block === 'image') ||
    flat1.some((c) => c.block === 'core/image' || c.block === 'image');
  return hasImg;
}

function buildMediaTextFromColumns(
  cols: WpNode[],
): MediaTextSection | CardGridSection {
  const flat0 = flattenChildren(cols[0]);
  const flat1 = cols[1] ? flattenChildren(cols[1]) : [];

  const imgInFirst = flat0.find(
    (c) => c.block === 'core/image' || c.block === 'image',
  );
  const imgInSecond = flat1.find(
    (c) => c.block === 'core/image' || c.block === 'image',
  );

  const imgNode = imgInFirst ?? imgInSecond;
  if (!imgNode?.src) {
    // Fallback to card-grid
    const cards = cols.map((col) => {
      const flat = flattenChildren(col);
      const h = flat.find((c) => c.block === 'core/heading' || c.block === 'heading');
      const p = flat.find((c) => c.block === 'core/paragraph' || c.block === 'paragraph');
      return { heading: h?.text ?? '', body: p?.text ?? '' };
    });
    return { type: 'card-grid', columns: 2, cards };
  }

  const textFlat = imgInFirst ? flat1 : flat0;
  const h = textFlat.find((c) => c.block === 'core/heading' || c.block === 'heading');
  const p = textFlat.find((c) => c.block === 'core/paragraph' || c.block === 'paragraph');
  const btn = textFlat.find(
    (c) => c.block === 'core/button' || c.block === 'button',
  );
  const listItems = textFlat
    .filter((c) => c.block === 'core/list-item' || c.block === 'list-item')
    .map((c) => c.text ?? '')
    .filter(Boolean);

  const s: MediaTextSection = {
    type: 'media-text',
    imageSrc: imgNode.src,
    imageAlt: imgNode.alt ?? '',
    imagePosition: imgInFirst ? 'left' : 'right',
  };
  const columnWidths = cols
    .map((col) => normalizeCssLength(col.columnWidth))
    .filter((value): value is string => !!value);
  if (columnWidths.length === cols.length) s.columnWidths = columnWidths;
  if (h?.text) s.heading = h.text;
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  if (p?.text) s.body = p.text;
  if (p?.typography || p?.fontFamily) s.bodyStyle = toTypographyStyle(p);
  if (listItems.length > 0) s.listItems = listItems;
  if (btn?.text) s.cta = { text: btn.text, link: btn.href ?? '#' };
  return s;
}

// ── low-level helpers ───────────────────────────────────────────────────────

function findFirstByBlock(
  nodes: WpNode[],
  blocks: string[],
): WpNode | null {
  for (const node of nodes) {
    if (blocks.includes(node.block)) return node;
    if (node.children?.length) {
      const found = findFirstByBlock(node.children, blocks);
      if (found) return found;
    }
  }
  return null;
}

/** Flatten all descendant WpNodes into a single array (depth-first). */
function flattenChildren(node: WpNode): WpNode[] {
  const result: WpNode[] = [];
  const visit = (n: WpNode) => {
    result.push(n);
    for (const child of n.children ?? []) visit(child);
  };
  for (const child of node.children ?? []) visit(child);
  return result;
}

function boxSpacingToCss(
  box: NonNullable<WpNode['padding']>,
): string {
  const { top = '0', right = top, bottom = top, left = right } = box;
  if (top === right && top === bottom && top === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  return `${top} ${right} ${bottom} ${left}`;
}

function normalizeCssLength(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
}

function toTypographyStyle(node?: WpNode): TypographyStyle | undefined {
  if (!node) return undefined;
  const typography: TypographyStyle = {
    ...(node.typography?.fontSize && { fontSize: node.typography.fontSize }),
    ...(node.typography?.fontFamily && {
      fontFamily: node.typography.fontFamily,
    }),
    ...(node.fontFamily &&
      !node.typography?.fontFamily && { fontFamily: node.fontFamily }),
    ...(node.typography?.fontWeight && {
      fontWeight: node.typography.fontWeight,
    }),
    ...(node.typography?.letterSpacing && {
      letterSpacing: node.typography.letterSpacing,
    }),
    ...(node.typography?.lineHeight && {
      lineHeight: node.typography.lineHeight,
    }),
    ...(node.typography?.textTransform && {
      textTransform: node.typography.textTransform,
    }),
  };
  return Object.keys(typography).length > 0 ? typography : undefined;
}
