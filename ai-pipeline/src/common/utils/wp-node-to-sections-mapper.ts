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
 * unless the underlying source structure explicitly contradicts the draft.
 */

import type { WpNode } from './wp-block-to-json.js';
import type {
  SectionPlan,
  SectionCta,
  TypographyStyle,
  NavbarSection,
  HeroSection,
  CtaStripSection,
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
  ModalSection,
  TestimonialSection,
  TabsSection,
  AccordionSection,
  CarouselSection,
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
  let pendingSpacer: string | undefined;
  for (const node of nodes) {
    if (isSpacerBlock(node.block)) {
      pendingSpacer = resolveSpacerHeight(node) ?? pendingSpacer;
      continue;
    }

    const mapped = mapNode(node, siblings);
    if (mapped.length === 0) continue;

    if (pendingSpacer) {
      mapped[0] = applyLeadingSpacer(mapped[0], pendingSpacer);
      pendingSpacer = undefined;
    }

    for (const section of mapped) {
      const last = sections[sections.length - 1];
      const mergedSection =
        last && section.type === 'card-grid' && last.type === 'card-grid'
          ? mergeAdjacentCardGridRows(last, section)
          : null;
      if (mergedSection) {
        sections[sections.length - 1] = mergedSection;
        continue;
      }
      sections.push(section);
    }
  }

  if (pendingSpacer && sections.length > 0) {
    sections[sections.length - 1] = applyTrailingSpacer(
      sections[sections.length - 1],
      pendingSpacer,
    );
  }
  return sections;
}

function mergeAdjacentCardGridRows(
  previous: CardGridSection,
  current: CardGridSection,
): CardGridSection | null {
  // WordPress often stores a single logical card grid as multiple adjacent
  // `wp:columns` rows separated only by spacers. Merge all consecutive card-grid
  // sections that share the same column count, regardless of columnWidths or
  // row count. This ensures multi-row card grids export correctly.
  if (previous.columns !== current.columns) {
    return null;
  }

  return {
    ...previous,
    columns: previous.columns,
    // Keep previous columnWidths (if any). If previous has none, fall back to current.
    columnWidths: previous.columnWidths ?? current.columnWidths,
    cards: [...previous.cards, ...current.cards],
  };
}

function mapNode(node: WpNode, siblings: WpNode[]): SectionPlan[] {
  const block = node.block;

  // template-part blocks: delegate by slug
  if (block === 'core/template-part' || block === 'template-part') {
    return toMappedSections(mapTemplatePart(node), node);
  }

  // Navigation / site header chrome
  if (block === 'core/navigation' || block === 'navigation') {
    return toMappedSections(mapNavigation(node, siblings), node);
  }

  if (isButtonBlock(block)) {
    return toMappedSections(mapStandaloneButtons(node), node);
  }

  // Group acting as a page-level wrapper — recurse into children
  if ((block === 'core/group' || block === 'group') && node.children?.length) {
    return mapGroup(node, siblings);
  }

  // Cover block (hero with background image)
  if (block === 'core/cover' || block === 'cover') {
    return toMappedSections(mapCover(node), node);
  }

  // Standalone image block: preserve it as an explicit visual section instead
  // of expecting the LLM to remember an image-only region from raw HTML.
  if (block === 'core/image' || block === 'image') {
    return toMappedSections(mapImage(node), node);
  }

  if (node.src) {
    return toMappedSections(mapImage(node), node);
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
  if (
    block === 'core/page-list' ||
    block === 'core/pages' ||
    block === 'page-list'
  ) {
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
  if (block === 'core/separator' || block === 'separator') {
    return [];
  }

  if (block === 'core/quote' || block === 'quote') {
    return toMappedSections(mapQuote(node), node);
  }

  if (block === 'core/pullquote' || block === 'pullquote') {
    return toMappedSections(mapQuote(node), node);
  }

  if (block === 'core/heading' || block === 'heading') {
    return toMappedSections(mapStandaloneHeading(node), node);
  }

  // ── UAGB / Spectra blocks ───────────────────────────────────────────────

  // Slider: map to CarouselSection with one slide per uagb/slider-child
  if (block === 'uagb/slider') {
    return toMappedSections(mapUagbSlider(node), node);
  }

  // Info-box: a single card — collect as card-grid at parent level or standalone
  if (block === 'uagb/info-box') {
    return toMappedSections(mapUagbInfoBox(node), node);
  }

  // Modal / popup / dialog: preserve trigger + modal content
  if (/\b(modal|popup|dialog)\b/.test(block)) {
    return toMappedSections(mapUagbModal(node), node);
  }

  // Tabs: preserve interactive tab groups as tabs
  if (block === 'uagb/tabs') {
    return toMappedSections(mapUagbTabs(node), node);
  }

  // Accordion / FAQ / content-toggle: preserve panel headings + bodies
  if (/\b(accordion|faq|content-toggle|toggle)\b/.test(block)) {
    return toMappedSections(mapAccordionLike(node), node);
  }

  // Container / section / advanced-heading / icon-list: treat as group wrapper
  if (
    block === 'uagb/container' ||
    block === 'uagb/section' ||
    block === 'uagb/advanced-heading' ||
    block === 'uagb/icon-list'
  ) {
    if (node.children?.length) return mapGroup(node, siblings);
    return [];
  }

  // Unknown block (e.g. elementor-*, other plugin blocks, etc.)
  // If it has nested children, treat it like a group wrapper and recurse so
  // sections are not silently dropped.
  if (node.children?.length) {
    return mapGroup(node, siblings);
  }

  return [];
}

// ── template-part ───────────────────────────────────────────────────────────

function mapTemplatePart(node: WpNode): SectionPlan | null {
  const slug: string = (node.params?.slug ??
    node.params?.theme ??
    '') as string;
  const slugL = slug.toLowerCase();

  if (slugL.includes('header') || slugL.includes('nav')) {
    const s: NavbarSection = {
      type: 'navbar',
      sticky: false,
      menuSlug: 'primary',
      orientation: 'horizontal',
      overlayMenu: 'mobile',
      isResponsive: true,
      showSiteLogo: true,
      showSiteTitle: true,
    };
    return s;
  }
  if (slugL.includes('footer')) {
    const s: FooterSection = {
      type: 'footer',
      menuColumns: [],
      showSiteLogo: true,
      showSiteTitle: true,
      showTagline: true,
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

function mapNavigation(node: WpNode, siblings: WpNode[]): NavbarSection {
  // Try to infer menuSlug from navigation-link children labels
  const menuSlug = inferMenuSlugFromNavChildren(node.children ?? []);
  const orientation =
    node.menuOrientation ??
    (node.params?.layout?.orientation as
      | 'horizontal'
      | 'vertical'
      | undefined) ??
    'horizontal';
  const overlayMenu =
    node.overlayMenu ?? (orientation === 'vertical' ? 'never' : 'mobile');
  const isResponsive = node.isResponsive ?? overlayMenu !== 'never';
  const siblingNodes = siblings.flatMap((sibling) => flattenChildren(sibling));
  const siteLogoNode = siblingNodes.find((candidate) =>
    ['core/site-logo', 'site-logo'].includes(candidate.block),
  );
  const siteTitleNode = siblingNodes.find((candidate) =>
    ['core/site-title', 'site-title'].includes(candidate.block),
  );
  return {
    type: 'navbar',
    sticky: false,
    menuSlug: menuSlug ?? 'primary',
    orientation,
    overlayMenu,
    isResponsive,
    ...(siteLogoNode ? { showSiteLogo: true } : {}),
    ...(siteTitleNode ? { showSiteTitle: true } : {}),
    ...(siteLogoNode?.width
      ? { logoWidth: normalizeCssLength(String(siteLogoNode.width)) }
      : {}),
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
    inferSectionAlignment(node, node.children ?? []) ??
    ((node.params?.contentPosition as string | undefined)?.includes('left')
      ? 'left'
      : (node.params?.contentPosition as string | undefined)?.includes('right')
        ? 'right'
        : 'center');

  if (src) {
    const s: CoverSection = {
      type: 'cover',
      imageSrc: src,
      dimRatio,
      minHeight,
      contentAlign,
    };
    // Lift heading/subheading from children
    const headingNode = findFirstByBlock(node.children ?? [], [
      'core/heading',
      'heading',
    ]);
    if (headingNode?.text) s.heading = headingNode.text;
    if (headingNode?.typography || headingNode?.fontFamily) {
      s.headingStyle = toTypographyStyle(headingNode);
    }
    const paraNode = findFirstByBlock(node.children ?? [], [
      'core/paragraph',
      'paragraph',
    ]);
    if (paraNode?.text) s.subheading = paraNode.text;
    if (paraNode?.typography || paraNode?.fontFamily) {
      s.subheadingStyle = toTypographyStyle(paraNode);
    }
    applySectionCtas(s, node.children ?? []);
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
  const p = findFirstByBlock(node.children ?? [], [
    'core/paragraph',
    'paragraph',
  ]);
  if (p?.text) s.subheading = p.text;
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  applySectionCtas(s, node.children ?? []);
  return s;
}

function mapImage(node: WpNode): CoverSection | null {
  if (!node.src) return null;

  return {
    type: 'cover',
    imageSrc: node.src,
    dimRatio: 0,
    minHeight: normalizeCssLength(node.minHeight) ?? '420px',
    contentAlign: 'center',
  };
}

// ── group block ─────────────────────────────────────────────────────────────

function mapGroup(node: WpNode, _siblings: WpNode[]): SectionPlan[] {
  const children = node.children ?? [];
  if (children.length === 0) return [];

  const segmentedInteractiveSections = buildSegmentedInteractiveSections(
    node,
    children,
  );
  if (segmentedInteractiveSections) {
    return segmentedInteractiveSections;
  }

  // Testimonial group: metadata.name contains "testimonial" or content starts with a curly quote
  const metadataName = (
    (node.params?.metadata as Record<string, string> | undefined)?.name ?? ''
  ).toLowerCase();
  if (metadataName.includes('testimonial')) {
    const testimonial = buildTestimonialFromGroup(node, children);
    if (testimonial) return toMappedSections(testimonial, node);
  }

  // If any UAGB interactive block (slider/modal/tabs) is nested anywhere in the
  // subtree, skip static heuristics so recursion maps each child to the correct
  // interactive section type.
  const hasInteractive = hasDeepInteractiveBlock(children);

  // If the group contains post-content blocks anywhere (single/page templates),
  // skip card-grid and hero heuristics — recurse so post-content maps correctly.
  const hasPostContent =
    children.some((c) => POST_CONTENT_BLOCKS.includes(c.block)) ||
    children.some((c) =>
      c.children?.some((cc) => POST_CONTENT_BLOCKS.includes(cc.block)),
    );

  if (!hasInteractive && !hasPostContent && isButtonOnlyGroup(children)) {
    return toMappedSections(buildStandaloneButtonsSection(node, children), node);
  }

  if (!hasInteractive && !hasPostContent) {
    const groupedCardGrid = buildGroupedCardGrid(children);
    // Reject degenerate card-grids (e.g. footer nav groups mapped to 1 card with no body)
    const isDegenerate =
      groupedCardGrid &&
      groupedCardGrid.cards.length <= 1 &&
      groupedCardGrid.cards.every((c) => !c.body);
    if (groupedCardGrid && !isDegenerate) {
      return toMappedSections(groupedCardGrid, node);
    }
  }

  // Query-led archive/index groups often include a heading or intro copy above
  // the loop. Preserve the query as the primary section and lift the heading
  // into the post-list title instead of misclassifying the whole group as hero.
  const queryChild = children.find(
    (c) => c.block === 'core/query' || c.block === 'query',
  );
  if (queryChild) {
    const headingChild = findFirstByBlock(children, [
      'core/query-title',
      'query-title',
      'core/heading',
      'heading',
    ]);
    let section = applyNodePresentation(mapQuery(queryChild), queryChild);
    if (headingChild) {
      const title = extractNodeText(headingChild);
      if (title) section = { ...section, title };
    }
    return [applyNodePresentation(section, node)];
  }

  // Composite groups that mix intro copy with one or more direct rows/columns
  // should recurse into their children instead of collapsing into a single hero.
  if (!hasInteractive && !hasPostContent && isCompositeGroup(children)) {
    return mapNodes(children, children);
  }

  // Group acting as a hero: has heading + paragraph (+ optional button)
  if (!hasInteractive && !hasPostContent && isHeroGroup(children)) {
    return toMappedSections(buildHeroFromChildren(node, children), node);
  }

  // Group acting as a 2-column media-text layout
  if (!hasInteractive && !hasPostContent && isMediaTextGroup(children)) {
    return toMappedSections(buildMediaTextFromColumns(children), node);
  }

  // Group with a search block
  const searchChild = children.find(
    (c) => c.block === 'core/search' || c.block === 'search',
  );
  if (searchChild) {
    const s: SearchSection = { type: 'search' };
    const headingChild = findFirstByBlock(children, [
      'core/heading',
      'heading',
    ]);
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
  const postTemplate = findFirstByBlock(node.children ?? [], [
    'core/post-template',
    'post-template',
  ]);
  const templateNodes = postTemplate ? flattenChildren(postTemplate) : [];
  const displayColumns = Number(
    node.params?.displayLayout?.columns ??
      postTemplate?.params?.layout?.columnCount ??
      postTemplate?.params?.layout?.columns ??
      0,
  );
  const columnsInTemplate =
    postTemplate?.children?.some(
      (c) => c.block === 'core/columns' || c.block === 'columns',
    ) ?? false;
  const layout: PostListSection['layout'] =
    Number.isFinite(displayColumns) && displayColumns >= 3
      ? 'grid-3'
      : displayColumns === 2
        ? 'grid-2'
        : columnsInTemplate
          ? 'grid-3'
          : 'list';

  const hasAuthorBlock = templateNodes.some((child) =>
    ['core/post-author', 'post-author'].includes(child.block),
  );
  const hasDateBlock = templateNodes.some((child) =>
    ['core/post-date', 'post-date'].includes(child.block),
  );
  const hasTermsBlock = templateNodes.some((child) =>
    ['core/post-terms', 'post-terms'].includes(child.block),
  );
  const hasExcerptBlock = templateNodes.some((child) =>
    ['core/post-excerpt', 'post-excerpt'].includes(child.block),
  );
  const hasFeaturedImageBlock = templateNodes.some((child) =>
    ['core/post-featured-image', 'post-featured-image'].includes(child.block),
  );

  return {
    type: 'post-list',
    layout,
    showDate: booleanAttr(node.params?.displayPostDate, hasDateBlock || true),
    showAuthor: booleanAttr(node.params?.displayAuthor, hasAuthorBlock),
    showCategory: booleanAttr(
      node.params?.displayPostTerms ?? node.params?.displayCategories,
      hasTermsBlock,
    ),
    showExcerpt: booleanAttr(
      node.params?.displayPostExcerpt,
      hasExcerptBlock || true,
    ),
    showFeaturedImage: booleanAttr(
      node.params?.displayFeaturedImage,
      hasFeaturedImageBlock || true,
    ),
  };
}

// ── columns block ───────────────────────────────────────────────────────────

function mapColumns(
  node: WpNode,
): CardGridSection | MediaTextSection | FooterSection | null {
  const cols =
    node.children?.filter(
      (c) => c.block === 'core/column' || c.block === 'column',
    ) ?? [];

  if (cols.length === 0) return null;

  const footer = buildFooterFromColumns(cols);
  if (footer) return footer;

  // 2-col: check if one side is image and other is text → media-text
  if (cols.length === 2) {
    const hasImage = cols.some(
      (c) =>
        findFirstByBlock(flattenChildren(c), ['core/image', 'image']) !== null,
    );
    if (hasImage) {
      return buildMediaTextFromColumns(cols);
    }
  }

  // Otherwise: card-grid
  const cards = cols
    .map((col) => {
      const flat = flattenChildren(col);
      const h = findFirstByBlock(flat, ['core/heading', 'heading']);
      const body = extractRichTextFromNodes(flat);
      return {
        heading: h?.text ?? '',
        body,
      };
    })
    .filter((c) => c.heading || c.body);

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

function buildFooterFromColumns(cols: WpNode[]): FooterSection | null {
  const flatColumns = cols.map((col) => flattenChildren(col));
  const brandColumnIndex = flatColumns.findIndex((flat) =>
    flat.some((node) =>
      ['core/site-logo', 'site-logo', 'core/site-title', 'site-title'].includes(
        node.block,
      ),
    ),
  );
  if (brandColumnIndex === -1) return null;

  const brandFlat = flatColumns[brandColumnIndex] ?? [];
  const siteLogoNode = brandFlat.find((node) =>
    ['core/site-logo', 'site-logo'].includes(node.block),
  );
  const siteTitleNode = brandFlat.find((node) =>
    ['core/site-title', 'site-title'].includes(node.block),
  );
  const siteTaglineNode = brandFlat.find((node) =>
    ['core/site-tagline', 'site-tagline'].includes(node.block),
  );
  const menuColumns = collectFooterMenuColumns(cols);

  if (
    !siteLogoNode &&
    !siteTitleNode &&
    !siteTaglineNode &&
    menuColumns.length === 0
  ) {
    return null;
  }

  const section: FooterSection = {
    type: 'footer',
    menuColumns,
    ...(siteLogoNode ? { showSiteLogo: true } : {}),
    ...(siteTitleNode ? { showSiteTitle: true } : {}),
    ...(siteTaglineNode ? { showTagline: true } : {}),
    ...(siteLogoNode?.width
      ? { logoWidth: normalizeCssLength(String(siteLogoNode.width)) }
      : {}),
  };

  const columnWidths = cols
    .map((col) => normalizeCssLength(col.columnWidth))
    .filter((value): value is string => !!value);
  if (columnWidths.length === cols.length) section.columnWidths = columnWidths;
  return section;
}

function collectFooterMenuColumns(
  cols: WpNode[],
): Array<{ title: string; menuSlug: string }> {
  const results: Array<{ title: string; menuSlug: string }> = [];
  const seen = new Set<string>();

  const visit = (node: WpNode) => {
    const directChildren = node.children ?? [];
    const headingNode = directChildren.find((child) =>
      ['core/heading', 'heading'].includes(child.block),
    );
    const hasNavigationDescendant = flattenChildren(node).some((child) =>
      ['core/navigation', 'navigation'].includes(child.block),
    );
    const title = headingNode?.text?.trim();
    if (title && hasNavigationDescendant) {
      const key = title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          title,
          menuSlug: slugifyMenuKey(title),
        });
      }
    }
    for (const child of directChildren) visit(child);
  };

  for (const col of cols) visit(col);
  return results;
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

// ── standalone heading / quote ──────────────────────────────────────────────

function mapStandaloneHeading(node: WpNode): HeroSection | null {
  if (!node.text?.trim()) return null;
  const hero: HeroSection = {
    type: 'hero',
    layout: inferSectionAlignment(node, []) === 'center' ? 'centered' : 'left',
    heading: node.text ?? '',
  };
  if (node.typography || node.fontFamily) {
    hero.headingStyle = toTypographyStyle(node);
  }
  return hero;
}

function mapQuote(node: WpNode): TestimonialSection | null {
  const quote = extractNodeText(node);
  if (!quote) return null;

  const authorMatch = node.html?.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
  const authorName = authorMatch ? stripInlineHtml(authorMatch[1]) : '';

  const section: TestimonialSection = {
    type: 'testimonial',
    quote,
    authorName,
  };
  const contentAlign = inferSectionAlignment(node, node.children ?? []);
  if (contentAlign) section.contentAlign = contentAlign;
  return section;
}

// ── UAGB / Spectra mappers ──────────────────────────────────────────────────

function mapUagbSlider(node: WpNode): CarouselSection | null {
  const slideChildren = (node.children ?? []).filter(
    (c) => c.block === 'uagb/slider-child',
  );
  const slides = slideChildren.map((child) => {
    const flat = flattenChildren(child);
    const h = flat.find(
      (c) => c.block === 'core/heading' || c.block === 'heading',
    );
    const subheading = extractRichTextFromNodes(flat);
    const img = flat.find(
      (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
    );
    const btn = findBestButtonNode(flat);
    return {
      ...(h?.text ? { heading: h.text } : {}),
      ...(subheading ? { subheading } : {}),
      ...(img?.src ? { imageSrc: img.src, imageAlt: img.alt ?? '' } : {}),
      ...(btn?.text ? { cta: buildSectionCta(btn) } : {}),
    };
  });

  // Fallback: if no labeled slider-children, treat all children as a single slide
  if (slides.length === 0) {
    const flat = flattenChildren(node);
    const h = flat.find(
      (c) => c.block === 'core/heading' || c.block === 'heading',
    );
    const subheading = extractRichTextFromNodes(flat);
    const img = flat.find(
      (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
    );
    if (!h && !img) return null;
    slides.push({
      ...(h?.text ? { heading: h.text } : {}),
      ...(subheading ? { subheading } : {}),
      ...(img?.src ? { imageSrc: img.src, imageAlt: img.alt ?? '' } : {}),
    });
  }

  const section: CarouselSection = {
    type: 'carousel',
    slides,
    autoplay: booleanAttr(node.params?.autoplay, slides.length > 1),
    loop: booleanAttr(node.params?.infiniteLoop, true),
    showDots: booleanAttr(node.params?.displayDots, true),
    showArrows: booleanAttr(node.params?.displayArrows, true),
    vertical: booleanAttr(node.params?.verticalMode, false),
  };
  const autoplaySpeed = numberAttr(node.params?.autoplaySpeed);
  if (autoplaySpeed !== undefined) section.autoplaySpeed = autoplaySpeed;
  const transitionSpeed = numberAttr(node.params?.transitionSpeed);
  if (transitionSpeed !== undefined) {
    section.transitionSpeed = transitionSpeed;
  }
  const effect = normalizeCarouselEffect(node.params?.transitionEffect);
  if (effect) section.effect = effect;
  const pauseOn = normalizePauseMode(node.params?.pauseOn);
  if (pauseOn) section.pauseOn = pauseOn;
  const contentAlign = inferSectionAlignment(
    node,
    slideChildren.length > 0 ? slideChildren : (node.children ?? []),
  );
  if (contentAlign) section.contentAlign = contentAlign;
  return section;
}

function mapUagbInfoBox(node: WpNode): CardGridSection | null {
  const flat = flattenChildren(node);
  const h = flat.find(
    (c) => c.block === 'core/heading' || c.block === 'heading',
  );
  const heading =
    h?.text ?? (node.params?.iconBoxTitle as string | undefined) ?? '';
  const body =
    extractRichTextFromNodes(flat) ??
    (node.params?.iconBoxDesc as string | undefined) ??
    '';
  if (!heading && !body) return null;
  return { type: 'card-grid', columns: 3, cards: [{ heading, body }] };
}

function mapUagbTabs(node: WpNode): TabsSection | null {
  const tabChildren = (node.children ?? []).filter(
    (c) => c.block === 'uagb/tabs-child',
  );
  const tabs = tabChildren
    .map((tab) => {
      const flat = flattenChildren(tab);
      const h = flat.find(
        (c) => c.block === 'core/heading' || c.block === 'heading',
      );
      const imageNode = flat.find(
        (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
      );
      const buttonNode = findBestButtonNode(flat);
      const tabTitle =
        (tab.params?.tabTitle as string | undefined) ?? h?.text ?? '';
      const body = extractRichTextFromNodes(flat);
      const heading =
        h?.text && h.text.trim() && h.text.trim() !== tabTitle.trim()
          ? h.text
          : undefined;
      return {
        label: tabTitle,
        ...(heading ? { heading } : {}),
        ...(body ? { body } : {}),
        ...(imageNode?.src
          ? { imageSrc: imageNode.src, imageAlt: imageNode.alt ?? '' }
          : {}),
        ...(buttonNode?.text
          ? {
              cta: buildSectionCta(buttonNode),
            }
          : {}),
      };
    })
    .filter((tab) => tab.label || tab.heading || tab.body || tab.imageSrc);

  if (tabs.length === 0) return null;
  const section: TabsSection = {
    type: 'tabs',
    tabs,
  };
  const activeTab = clampIndex(
    numberAttr(node.params?.tabActiveFrontend ?? node.params?.tabActive),
    tabs.length,
  );
  if (activeTab !== undefined) section.activeTab = activeTab;
  if (typeof node.params?.tabsStyleD === 'string' && node.params.tabsStyleD) {
    section.variant = String(node.params.tabsStyleD);
  }
  const tabAlign = normalizeHorizontalAlign(node.params?.tabAlign);
  if (tabAlign) section.tabAlign = tabAlign;
  return section;
}

function mapAccordionLike(node: WpNode): AccordionSection | null {
  const panelChildren = (node.children ?? []).filter((child) =>
    /\b(accordion|faq|content-toggle|toggle)\b/.test(child.block),
  );
  const sourcePanels =
    panelChildren.length > 0 ? panelChildren : (node.children ?? []);

  const items = sourcePanels
    .map((panel) => {
      const flat = flattenChildren(panel);
      const headingNode = flat.find(
        (c) => c.block === 'core/heading' || c.block === 'heading',
      );
      const heading =
        headingNode?.text ??
        (panel.params?.title as string | undefined) ??
        (panel.params?.heading as string | undefined) ??
        (panel.params?.label as string | undefined) ??
        (panel.params?.question as string | undefined) ??
        '';
      const body =
        extractRichTextFromNodes(flat) ??
        (panel.params?.content as string | undefined) ??
        (panel.params?.body as string | undefined) ??
        (panel.params?.answer as string | undefined) ??
        '';
      if (!heading && !body) return null;
      return {
        heading,
        body,
      };
    })
    .filter((item): item is { heading: string; body: string } => !!item);

  if (items.length === 0) return null;

  const title =
    (node.params?.title as string | undefined) ??
    (node.params?.heading as string | undefined);
  const allowMultiple =
    typeof node.params?.allowMultipleOpen === 'boolean'
      ? Boolean(node.params.allowMultipleOpen)
      : typeof node.params?.multiOpen === 'boolean'
        ? Boolean(node.params.multiOpen)
        : typeof node.params?.inactiveOtherItems === 'boolean'
          ? !Boolean(node.params.inactiveOtherItems)
          : undefined;
  const defaultOpenItems =
    typeof node.params?.expandFirstItem === 'boolean'
      ? node.params.expandFirstItem
        ? [0]
        : []
      : undefined;
  const enableToggle =
    typeof node.params?.enableToggle === 'boolean'
      ? Boolean(node.params.enableToggle)
      : undefined;
  const variant =
    typeof node.params?.layout === 'string' && node.params.layout.trim()
      ? node.params.layout.trim()
      : undefined;

  return {
    type: 'accordion',
    ...(title ? { title } : {}),
    items,
    ...(allowMultiple !== undefined ? { allowMultiple } : {}),
    ...(enableToggle !== undefined ? { enableToggle } : {}),
    ...(defaultOpenItems ? { defaultOpenItems } : {}),
    ...(variant ? { variant } : {}),
  };
}

function mapUagbModal(node: WpNode): ModalSection | null {
  const flat = flattenChildren(node);
  const headingNode = flat.find(
    (c) => c.block === 'core/heading' || c.block === 'heading',
  );
  const imageNode = flat.find(
    (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
  );
  const triggerButtonNode =
    findBestButtonNode(flat, {
      requiredCustomClassName: 'uagb-modal-trigger',
    }) ??
    findBestButtonNode(flat, {
      requiredCustomClassName: 'uagb-modal-button-link',
    });
  const buttonNode =
    findBestButtonNode(flat, {
      excludeCustomClassName: 'uagb-modal-trigger',
    }) ??
    findBestButtonNode(flat, {
      excludeCustomClassName: 'uagb-modal-button-link',
    });
  const heading =
    headingNode?.text ??
    (node.params?.modalTitle as string | undefined) ??
    (node.params?.title as string | undefined) ??
    '';
  const body =
    extractRichTextFromNodes(flat) ??
    (node.params?.modalText as string | undefined) ??
    (node.params?.content as string | undefined) ??
    '';
  const triggerText =
    (node.params?.btnText as string | undefined) ??
    (node.params?.triggerText as string | undefined) ??
    (node.params?.buttonText as string | undefined) ??
    triggerButtonNode?.text ??
    '';

  if (
    !heading &&
    !body &&
    !triggerText &&
    !buttonNode?.text &&
    !imageNode?.src
  ) {
    return null;
  }

  const section: ModalSection = {
    type: 'modal',
    ...(triggerText ? { triggerText } : {}),
    ...(heading ? { heading } : {}),
    layout: imageNode?.src ? 'split' : 'centered',
  };
  const closeOnOverlay = normalizeEnableDisableAttr(node.params?.overlayclick);
  if (closeOnOverlay !== undefined) section.closeOnOverlay = closeOnOverlay;
  const closeOnEsc = normalizeEnableDisableAttr(node.params?.escpress);
  if (closeOnEsc !== undefined) section.closeOnEsc = closeOnEsc;
  const width = buildCssDimension(
    node.params?.modalWidth,
    node.params?.modalWidthType,
  );
  if (width) section.width = width;
  const height = buildCssDimension(
    node.params?.modalHeight,
    node.params?.modalHeightType,
  );
  if (height) section.height = height;
  if (
    typeof node.params?.overlayColor === 'string' &&
    node.params.overlayColor
  ) {
    section.overlayColor = node.params.overlayColor;
  }
  if (
    typeof node.params?.closeIconPosition === 'string' &&
    node.params.closeIconPosition
  ) {
    section.closeIconPosition = String(node.params.closeIconPosition);
  }
  if (body) section.body = body;
  if (buttonNode?.text) {
    section.cta = buildSectionCta(buttonNode);
  }
  if (imageNode?.src) {
    section.imageSrc = imageNode.src;
    section.imageAlt = imageNode.alt ?? '';
  }
  if (!section.cta && typeof node.params?.modalCtaText === 'string') {
    section.cta = {
      text: String(node.params.modalCtaText),
      link:
        (node.params?.modalCtaLink as string | undefined) ??
        (node.params?.link as string | undefined) ??
        '#',
    };
  }
  return section;
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
  if (node.sourceRef && !next.sourceRef) next.sourceRef = node.sourceRef;
  if (!next.sectionKey) {
    next.sectionKey = buildSectionKey(next.type, node.sourceRef?.topLevelIndex);
  }
  if (node.bgColor && !next.background) next.background = node.bgColor;
  if (node.textColor && !next.textColor) next.textColor = node.textColor;
  if (node.padding && !next.paddingStyle) {
    next.paddingStyle = boxSpacingToCss(node.padding);
  }
  if (node.margin && !next.marginStyle) {
    next.marginStyle = boxSpacingToCss(node.margin);
  }
  if (node.gap && !next.gapStyle) {
    next.gapStyle =
      typeof node.gap === 'string'
        ? node.gap
        : (normalizeGapStyleValue(node.gap) ?? next.gapStyle);
  }
  const customClassNames = uniqueClassNames([
    ...(next.customClassNames ?? []),
    ...(node.customClassNames ?? []),
  ]);
  const buttonClassNames = extractLikelyButtonClassNames(node.customClassNames);
  if (buttonClassNames.length > 0) {
    applyButtonClassesToSectionCtas(next, buttonClassNames);
  }
  if (customClassNames.length > 0) {
    next.customClassNames = customClassNames;
  }
  return next;
}

function extractLikelyButtonClassNames(values?: string[]): string[] {
  return uniqueClassNames(
    (values ?? []).filter((value) =>
      /^(is-style-(outline|fill)|wp-block-button__width-|has-custom-width$|vp-hover-(shadow|lift))/.test(
        value.trim(),
      ),
    ),
  );
}

function applyButtonClassesToSectionCtas<T extends SectionPlan>(
  section: T,
  buttonClassNames: string[],
): T {
  if (buttonClassNames.length === 0) return section;

  const ctas =
    'ctas' in section && Array.isArray(section.ctas) && section.ctas.length > 0
      ? section.ctas
      : 'cta' in section && section.cta
        ? [section.cta]
        : [];
  if (ctas.length === 0) return section;

  const merged = ctas.map((cta) => ({
    ...cta,
    customClassNames: uniqueClassNames([
      ...(cta.customClassNames ?? []),
      ...buttonClassNames,
    ]),
  }));

  if ('cta' in section) {
    (section as { cta?: SectionCta }).cta = merged[0];
  }
  if ('ctas' in section && merged.length > 1) {
    (section as { ctas?: SectionCta[] }).ctas = merged;
  }
  return section;
}

function normalizeGapStyleValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const spacing = value as Record<string, unknown>;
  const row = normalizeCssLength(
    typeof spacing.top === 'string' ? spacing.top : undefined,
  );
  const column = normalizeCssLength(
    typeof spacing.left === 'string' ? spacing.left : undefined,
  );
  if (row && column) return `${row} ${column}`;
  return row ?? column ?? undefined;
}

function buildSectionKey(
  type: SectionPlan['type'],
  topLevelIndex?: number,
): string {
  if (typeof topLevelIndex !== 'number' || topLevelIndex <= 0) {
    return type;
  }
  return `${type}-${topLevelIndex}`;
}

// ── helpers: recognise group intent ────────────────────────────────────────

function isHeroGroup(children: WpNode[]): boolean {
  const meaningfulChildren = children.filter(
    (child) => !isSpacerBlock(child.block),
  );
  const hasH1OrH2 = meaningfulChildren.some(
    (c) =>
      (c.block === 'core/heading' || c.block === 'heading') &&
      (c.level === 1 || c.level === 2),
  );
  const hasPara = meaningfulChildren.some(
    (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
  );
  const hasDirectColumns = meaningfulChildren.some(
    (c) => c.block === 'core/columns' || c.block === 'columns',
  );
  return hasH1OrH2 && hasPara && !hasDirectColumns;
}

function isCompositeGroup(children: WpNode[]): boolean {
  const meaningfulChildren = children.filter(
    (child) => !isSpacerBlock(child.block),
  );
  const directColumnsCount = meaningfulChildren.filter(
    (child) => child.block === 'core/columns' || child.block === 'columns',
  ).length;
  return directColumnsCount >= 1 && meaningfulChildren.length > 1;
}

function buildTestimonialFromGroup(
  groupNode: WpNode,
  children: WpNode[],
): TestimonialSection | null {
  const allText = flattenChildren({ children } as WpNode)
    .filter((n) => n.block === 'core/paragraph' || n.block === 'paragraph')
    .map((n) => n.text ?? '')
    .filter(Boolean);

  if (allText.length === 0) return null;

  // First paragraph is the quote; look for curly-quote wrapper or just take it
  const quote = allText[0].replace(/^["“«]+|["”»]+$/g, '').trim();
  if (!quote) return null;

  const authorName = allText[1] ?? '';
  const authorTitle = allText[2] ?? undefined;

  const section: TestimonialSection = {
    type: 'testimonial',
    quote,
    authorName,
    authorTitle,
  };
  const contentAlign = inferSectionAlignment(groupNode, children);
  if (contentAlign) section.contentAlign = contentAlign;
  return section;
}

function buildGroupedCardGrid(children: WpNode[]): CardGridSection | null {
  let title: string | undefined;
  let subtitle: string | undefined;
  let columnCount: 2 | 3 | 4 = 3;
  const cards: { heading: string; body: string }[] = [];
  let foundCardGrid = false;

  for (const child of children) {
    const block = child.block;

    if (
      !foundCardGrid &&
      (block === 'core/heading' || block === 'heading') &&
      child.text
    ) {
      title ??= child.text;
      continue;
    }

    if (
      !foundCardGrid &&
      (block === 'core/paragraph' || block === 'paragraph') &&
      child.text
    ) {
      subtitle ??= child.text;
      continue;
    }

    if (block === 'core/spacer' || block === 'spacer') {
      continue;
    }

    const cardGridRows = collectCardGridRows(child);
    if (cardGridRows) {
      foundCardGrid = true;
      for (const row of cardGridRows) {
        columnCount = row.columns;
        cards.push(...row.cards);
      }
      continue;
    }

    return null;
  }

  if (!foundCardGrid || cards.length === 0) return null;

  const section: CardGridSection = {
    type: 'card-grid',
    columns: columnCount,
    cards,
  };
  if (title) section.title = title;
  if (subtitle) section.subtitle = subtitle;
  return section;
}

function collectCardGridRows(node: WpNode): CardGridSection[] | null {
  const block = node.block;

  if (block === 'core/spacer' || block === 'spacer') {
    return [];
  }

  if (block === 'core/columns' || block === 'columns') {
    const mapped = mapColumns(node);
    return mapped?.type === 'card-grid' ? [mapped] : null;
  }

  if ((block === 'core/group' || block === 'group') && node.children?.length) {
    const rows: CardGridSection[] = [];
    for (const child of node.children) {
      const nestedRows = collectCardGridRows(child);
      if (nestedRows === null) return null;
      rows.push(...nestedRows);
    }
    return rows.length > 0 ? rows : null;
  }

  return null;
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
  const img = flat.find((c) => c.block === 'core/image' || c.block === 'image');

  const align = inferSectionAlignment(groupNode, children);
  const layout: HeroSection['layout'] =
    align === 'center' ? 'centered' : img ? 'split' : 'left';

  const s: HeroSection = {
    type: 'hero',
    layout,
    heading: h?.text ?? '',
  };
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  const richSubheading = extractRichTextFromNodes(flat);
  if (richSubheading) s.subheading = richSubheading;
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  applySectionCtas(s, children);
  if (img?.src)
    s.image = { src: img.src, alt: img.alt ?? '', position: 'right' };
  if (groupNode.padding) {
    s.paddingStyle = boxSpacingToCss(groupNode.padding);
  }
  return s;
}

type HorizontalAlign = 'left' | 'center' | 'right';

function inferSectionAlignment(
  node: WpNode,
  children: WpNode[],
): HorizontalAlign | undefined {
  const direct = inferNodeAlignment(node);
  if (direct) return direct;

  const counts: Record<HorizontalAlign, number> = {
    left: 0,
    center: 0,
    right: 0,
  };
  for (const candidate of flattenChildren({ children } as WpNode)) {
    const align = inferNodeAlignment(candidate);
    if (align) counts[align] += 1;
  }

  const nonZero = (Object.entries(counts) as Array<[HorizontalAlign, number]>)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (nonZero.length === 0) return undefined;
  if (nonZero.length === 1) return nonZero[0][0];

  const [best, second] = nonZero;
  if (best[1] > second[1]) return best[0];
  if (
    counts.center > 0 &&
    counts.center >= counts.left &&
    counts.center >= counts.right
  ) {
    return 'center';
  }
  return undefined;
}

function inferNodeAlignment(node: WpNode): HorizontalAlign | undefined {
  return (
    normalizeHorizontalAlign(node.textAlign) ??
    normalizeHorizontalAlign(node.justifyContent) ??
    normalizeHorizontalAlign(node.align) ??
    normalizeHorizontalAlign(node.params?.textAlign) ??
    normalizeHorizontalAlign(node.params?.contentPosition) ??
    normalizeHorizontalAlign(node.params?.layout?.justifyContent) ??
    normalizeHorizontalAlign(node.params?.align) ??
    normalizeHorizontalAlign(node.params?.layout?.horizontalAlignment)
  );
}

function normalizeHorizontalAlign(value: unknown): HorizontalAlign | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/(^|[\s:-])center(ed)?($|[\s:-])/.test(normalized)) return 'center';
  if (/(^|[\s:-])right($|[\s:-])/.test(normalized)) return 'right';
  if (/(^|[\s:-])left($|[\s:-])/.test(normalized)) return 'left';
  return undefined;
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
      const h = flat.find(
        (c) => c.block === 'core/heading' || c.block === 'heading',
      );
      return {
        heading: h?.text ?? '',
        body: extractRichTextFromNodes(flat),
      };
    });
    return { type: 'card-grid', columns: 2, cards };
  }

  const textFlat = imgInFirst ? flat1 : flat0;
  const h = textFlat.find(
    (c) => c.block === 'core/heading' || c.block === 'heading',
  );
  const p = textFlat.find(
    (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
  );
  const listItems = textFlat
    .filter((c) => c.block === 'core/list-item' || c.block === 'list-item')
    .map((c) => c.html ?? c.text ?? '')
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
  const richBody = extractRichTextFromNodes(textFlat);
  if (richBody) s.body = richBody;
  if (p?.typography || p?.fontFamily) s.bodyStyle = toTypographyStyle(p);
  if (listItems.length > 0) s.listItems = listItems;
  applySectionCtas(s, textFlat);
  return s;
}

const INTERACTIVE_UAGB_BLOCKS = ['uagb/slider', 'uagb/modal', 'uagb/tabs'];

const POST_CONTENT_BLOCKS = [
  'core/post-content',
  'post-content',
  'core/post-title',
  'post-title',
  'core/post-featured-image',
  'post-featured-image',
];

function hasDeepInteractiveBlock(nodes: WpNode[]): boolean {
  for (const node of nodes) {
    if (INTERACTIVE_UAGB_BLOCKS.includes(node.block)) return true;
    if (node.children?.length && hasDeepInteractiveBlock(node.children))
      return true;
  }
  return false;
}

function buildSegmentedInteractiveSections(
  groupNode: WpNode,
  children: WpNode[],
): SectionPlan[] | null {
  const hasInteractiveChild = children.some((child) =>
    ['uagb/slider', 'uagb/modal', 'uagb/tabs'].includes(child.block),
  );
  if (!hasInteractiveChild) return null;

  const sections: SectionPlan[] = [];
  let prefixEnd = 0;
  while (prefixEnd < children.length) {
    const block = children[prefixEnd]?.block;
    if (
      block &&
      ![
        'core/heading',
        'heading',
        'core/paragraph',
        'paragraph',
        'core/button',
        'button',
        'core/buttons',
        'buttons',
        'core/image',
        'image',
        'core/spacer',
        'spacer',
      ].includes(block)
    ) {
      break;
    }
    prefixEnd++;
  }

  const prefixChildren = children
    .slice(0, prefixEnd)
    .filter((child) => !isSpacerBlock(child.block));
  if (
    prefixChildren.some(
      (child) => child.block === 'core/heading' || child.block === 'heading',
    )
  ) {
    sections.push(
      applyNodePresentation(
        buildHeroFromChildren(groupNode, prefixChildren),
        groupNode,
      ),
    );
  }

  const remainder = children.slice(prefixEnd);
  for (const child of remainder) {
    if (isSpacerBlock(child.block)) continue;
    sections.push(...mapNode(child, children));
  }

  return sections.length > 0 ? sections : null;
}

// ── low-level helpers ───────────────────────────────────────────────────────

function findFirstByBlock(nodes: WpNode[], blocks: string[]): WpNode | null {
  for (const node of nodes) {
    if (blocks.includes(node.block)) return node;
    if (node.children?.length) {
      const found = findFirstByBlock(node.children, blocks);
      if (found) return found;
    }
  }
  return null;
}

function isSpacerBlock(block: string): boolean {
  return block === 'core/spacer' || block === 'spacer';
}

function resolveSpacerHeight(node: WpNode): string | undefined {
  const raw =
    node.params?.height ??
    node.params?.style?.spacing?.height ??
    node.minHeight;
  if (raw == null) return undefined;
  return normalizeCssLength(String(raw));
}

function applyLeadingSpacer<T extends SectionPlan>(
  section: T,
  spacerHeight: string,
): T {
  if (section.marginStyle) return section;
  return {
    ...section,
    marginStyle: `${spacerHeight} 0 0`,
  };
}

function applyTrailingSpacer<T extends SectionPlan>(
  section: T,
  spacerHeight: string,
): T {
  if (section.marginStyle) return section;
  return {
    ...section,
    marginStyle: `0 0 ${spacerHeight}`,
  };
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

function isButtonBlock(block?: string): boolean {
  return (
    block === 'core/button' ||
    block === 'button' ||
    block === 'core/buttons' ||
    block === 'buttons'
  );
}

function buildSectionCta(node: WpNode): SectionCta {
  return {
    text: node.text ?? '',
    link: node.href ?? '#',
    ...(node.customClassNames?.length
      ? { customClassNames: uniqueClassNames(node.customClassNames) }
      : {}),
  };
}

function buildSectionCtas(nodes: WpNode[]): SectionCta[] {
  const seen = new Set<string>();
  const result: SectionCta[] = [];
  for (const node of findButtonNodes(nodes)) {
    const cta = buildSectionCta(node);
    if (!cta.text.trim()) continue;
    const key = `${cta.text}\u0000${cta.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cta);
  }
  return result;
}

function applySectionCtas<T extends { cta?: SectionCta; ctas?: SectionCta[] }>(
  section: T,
  nodes: WpNode[],
): T {
  const ctas = buildSectionCtas(nodes);
  if (ctas.length === 0) return section;
  section.cta = ctas[0];
  if (ctas.length > 1) {
    section.ctas = ctas;
  }
  return section;
}

function findButtonNodes(nodes: WpNode[]): WpNode[] {
  const candidates: WpNode[] = [];
  const visit = (node: WpNode, inheritedButtonClasses: string[] = []) => {
    const mergedButtonClasses = isButtonBlock(node.block)
      ? uniqueClassNames([
          ...inheritedButtonClasses,
          ...(node.customClassNames ?? []),
        ])
      : inheritedButtonClasses;
    if (
      isButtonBlock(node.block) &&
      typeof node.text === 'string' &&
      node.text.trim().length > 0
    ) {
      candidates.push({
        ...node,
        ...(mergedButtonClasses.length > 0
          ? { customClassNames: mergedButtonClasses }
          : {}),
      });
    }
    for (const child of node.children ?? []) visit(child, mergedButtonClasses);
  };
  for (const node of nodes) visit(node);
  return candidates;
}

function findBestButtonNode(
  nodes: WpNode[],
  options?: {
    requiredCustomClassName?: string;
    excludeCustomClassName?: string;
  },
): WpNode | undefined {
  const candidates = findButtonNodes(nodes).filter((node) => {
    if (
      options?.requiredCustomClassName &&
      !nodeHasCustomClass(node, options.requiredCustomClassName)
    ) {
      return false;
    }
    if (
      options?.excludeCustomClassName &&
      nodeHasCustomClass(node, options.excludeCustomClassName)
    ) {
      return false;
    }
    return true;
  });

  const actionableButton = candidates.find(
    (node) =>
      (node.block === 'core/button' || node.block === 'button') &&
      typeof node.text === 'string' &&
      node.text.trim().length > 0,
  );
  if (actionableButton) return actionableButton;

  return candidates.find(
    (node) =>
      isButtonBlock(node.block) &&
      typeof node.text === 'string' &&
      node.text.trim().length > 0,
  );
}

function nodeHasCustomClass(node: WpNode, className: string): boolean {
  const target = className.trim().toLowerCase();
  if (!target) return false;
  return (node.customClassNames ?? []).some(
    (entry) => entry.trim().toLowerCase() === target,
  );
}

function mapStandaloneButtons(node: WpNode): CtaStripSection | null {
  return buildStandaloneButtonsSection(node, [node]);
}

function buildStandaloneButtonsSection(
  node: WpNode,
  nodes: WpNode[],
): CtaStripSection | null {
  const ctas = buildSectionCtas(nodes);
  if (ctas.length === 0) return null;

  const align = inferSectionAlignment(node, node.children ?? []);
  const section: CtaStripSection = {
    type: 'cta-strip',
    ...(align ? { align } : {}),
  };
  section.cta = ctas[0];
  if (ctas.length > 1) section.ctas = ctas;
  return section;
}

function isButtonOnlyGroup(children: WpNode[]): boolean {
  const meaningfulChildren = children.filter(
    (child) => !isSpacerBlock(child.block),
  );
  if (meaningfulChildren.length === 0) return false;
  return meaningfulChildren.every(isButtonOnlyNode);
}

function isButtonOnlyNode(node: WpNode): boolean {
  if (isSpacerBlock(node.block)) return true;
  if (isButtonBlock(node.block)) {
    return findButtonNodes([node]).length > 0;
  }
  if ((node.block === 'core/group' || node.block === 'group') && node.children) {
    return isButtonOnlyGroup(node.children);
  }
  return false;
}

function boxSpacingToCss(box: NonNullable<WpNode['padding']>): string {
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

function slugifyMenuKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function booleanAttr(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function numberAttr(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return undefined;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampIndex(
  value: number | undefined,
  length: number,
): number | undefined {
  if (value === undefined || length <= 0) return undefined;
  return Math.min(Math.max(Math.floor(value), 0), length - 1);
}

function normalizeCarouselEffect(
  value: unknown,
): CarouselSection['effect'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['slide', 'fade', 'flip', 'coverflow'].includes(normalized)) {
    return normalized as CarouselSection['effect'];
  }
  return undefined;
}

function normalizePauseMode(
  value: unknown,
): CarouselSection['pauseOn'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'hover' || normalized === 'click') {
    return normalized;
  }
  return undefined;
}

function normalizeEnableDisableAttr(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'enable') return true;
  if (normalized === 'disable') return false;
  return undefined;
}

function buildCssDimension(value: unknown, unit: unknown): string | undefined {
  const numeric = numberAttr(value);
  if (numeric === undefined) return undefined;
  const unitValue =
    typeof unit === 'string' && unit.trim().length > 0 ? unit.trim() : 'px';
  return `${numeric}${unitValue}`;
}

function extractNodeText(node: WpNode): string {
  if (node.text?.trim()) return node.text.trim();
  if (node.html?.trim()) return stripInlineHtml(node.html);
  return '';
}

function extractRichTextFromNodes(nodes: WpNode[]): string {
  const texts = nodes
    .filter(
      (node) =>
        node.block === 'core/paragraph' ||
        node.block === 'paragraph' ||
        node.block === 'core/list-item' ||
        node.block === 'list-item',
    )
    .map((node) => extractNodeText(node))
    .filter(Boolean);
  return texts.join('\n');
}

function stripInlineHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function uniqueClassNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
