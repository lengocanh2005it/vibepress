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
  SourceLayoutHint,
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
  TestimonialSection,
  TabsSection,
  SliderSection,
  ModalSection,
  AccordionSection,
  ButtonGroupSection,
} from '../../modules/agents/react-generator/visual-plan.schema.js';

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Map an ordered WpNode[] into a draft SectionPlan[].
 * Returns an empty array when nothing can be recognised (caller falls back to
 * AI-only planning).
 */
export function mapWpNodesToDraftSections(nodes: WpNode[]): SectionPlan[] {
  return mapNodes(nodes, nodes, {
    rootTemplateName: inferRootTemplateName(nodes),
  });
}

interface MapContext {
  rootTemplateName?: string;
}

// ── Per-node dispatch ───────────────────────────────────────────────────────

function mapNodes(
  nodes: WpNode[],
  siblings: WpNode[],
  context: MapContext,
): SectionPlan[] {
  const sections: SectionPlan[] = [];
  let pendingSpacer: string | undefined;
  for (const node of nodes) {
    if (isSpacerBlock(node.block)) {
      pendingSpacer = resolveSpacerHeight(node) ?? pendingSpacer;
      continue;
    }

    const mapped = mapNode(node, siblings, context);
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

function mapNode(
  node: WpNode,
  siblings: WpNode[],
  context: MapContext,
): SectionPlan[] {
  const block = node.block;

  // uagb/tabs (Spectra plugin)
  if (block === 'uagb/tabs' && node.tabs && node.tabs.length > 0) {
    const tabsSection: TabsSection = { type: 'tabs', tabs: node.tabs };
    return toMappedSections(tabsSection, node);
  }

  // uagb/slider (Spectra plugin) — always emit even when slides extraction yielded 0 items,
  // so the AI planner is aware a slider exists and doesn't silently drop it.
  if (block === 'uagb/slider') {
    const sliderSection: SliderSection = {
      type: 'slider',
      slides: node.slides ?? [],
    };
    return toMappedSections(sliderSection, node);
  }

  // uagb/modal (Spectra plugin)
  if (block === 'uagb/modal' && node.modalTrigger) {
    const modalSection: ModalSection = {
      type: 'modal',
      triggerText: node.modalTrigger,
      heading: node.modalHeading,
      description: node.modalDescription,
      cta: node.modalCta,
    };
    return toMappedSections(modalSection, node);
  }

  if (block === 'accordion' || block === 'uagb/accordion') {
    const accordionSection: AccordionSection = {
      type: 'accordion',
      items: node.accordionItems ?? [],
    };
    return toMappedSections(accordionSection, node);
  }

  // template-part blocks: delegate by slug
  if (block === 'core/template-part' || block === 'template-part') {
    return toMappedSections(mapTemplatePart(node), node);
  }

  if (block === 'vibepress/source-scope' && node.children?.length) {
    if (shouldSkipSharedSourceScope(node, context.rootTemplateName)) {
      return [];
    }
    return mapNodes(node.children, node.children, context);
  }

  // Navigation / site header chrome
  if (block === 'core/navigation' || block === 'navigation') {
    return toMappedSections(mapNavigation(node), node);
  }

  if (block === 'core/buttons' || block === 'buttons') {
    return toMappedSections(mapButtons(node), node);
  }

  if (block === 'core/button' || block === 'button') {
    return toMappedSections(mapSingleButton(node), node);
  }

  // Group acting as a page-level wrapper — recurse into children
  if ((block === 'core/group' || block === 'group') && node.children?.length) {
    return mapGroup(node, siblings, context);
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
    return toMappedSections(mapColumns(node, context), node);
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
  const labels = flattenChildren({ children } as WpNode)
    .filter(
      (child) =>
        child.block === 'core/navigation-link' ||
        child.block === 'navigation-link',
    )
    .map((child) => child.text?.trim().toLowerCase())
    .filter((value): value is string => !!value);

  if (labels.length === 0) return undefined;

  const joined = labels.join(' ');
  if (/\b(home|about|services|pricing|blog|contact)\b/.test(joined)) {
    return 'primary';
  }
  if (/\b(privacy|terms|policy|support|faq|help)\b/.test(joined)) {
    return 'footer';
  }
  return undefined;
}

function mapButtons(node: WpNode): ButtonGroupSection | null {
  const buttons = flattenChildren(node)
    .filter(
      (child) => child.block === 'core/button' || child.block === 'button',
    )
    .map((child) => ({
      text: child.text?.trim() ?? '',
      link: child.href ?? '#',
    }))
    .filter((button) => button.text);

  if (buttons.length === 0) return null;

  return {
    type: 'button-group',
    align: resolveButtonGroupAlign(node),
    buttons,
  };
}

function mapSingleButton(node: WpNode): ButtonGroupSection | null {
  if (!node.text?.trim()) return null;
  return {
    type: 'button-group',
    align: resolveButtonGroupAlign(node),
    buttons: [{ text: node.text.trim(), link: node.href ?? '#' }],
  };
}

// ── cover block ─────────────────────────────────────────────────────────────

function mapCover(node: WpNode): CoverSection | HeroSection {
  // If it has a background image and dimRatio it's a cover/hero
  const src = node.src ?? '';
  const dimRatio = (node.params?.dimRatio as number | undefined) ?? 50;
  const minHeight = normalizeCssLength(node.minHeight) ?? '400px';
  const contentAlign = (
    node.params?.contentPosition as string | undefined
  )?.includes('left')
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
    const btnNode = findFirstByBlock(node.children ?? [], [
      'core/button',
      'button',
      'core/buttons',
      'buttons',
    ]);
    if (btnNode?.text)
      s.cta = { text: btnNode.text, link: btnNode.href ?? '#' };
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

function mapGroup(
  node: WpNode,
  _siblings: WpNode[],
  context: MapContext,
): SectionPlan[] {
  const children = node.children ?? [];
  if (children.length === 0) return [];

  const groupedTestimonial = buildGroupedTestimonial(node, children);
  if (groupedTestimonial) {
    return toMappedSections(groupedTestimonial, node);
  }

  const groupedCardGrid = buildGroupedCardGrid(children);
  if (groupedCardGrid) {
    return toMappedSections(groupedCardGrid, node);
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
    const headingChild = findFirstByBlock(children, [
      'core/heading',
      'heading',
    ]);
    if (headingChild?.text) s.title = headingChild.text;
    return toMappedSections(s, node);
  }

  const buttonGroup = mapButtons(node);
  if (buttonGroup && mapNodes(children, children, context).length === 0) {
    return toMappedSections(buttonGroup, node);
  }

  // Wrapper groups often contain a centered intro group followed by one or more
  // real sub-sections (columns/media rows/card rows). Prefer the recursively
  // discovered child sections when there is more than one, otherwise we risk
  // collapsing the whole wrapper into a single hero and losing the following
  // source-backed sections.
  const nestedSections = mapNodes(children, children, context);

  // If the group produced [hero/cover, button-group], merge the button into
  // the preceding section's cta instead of emitting a separate section.
  const mergedSections = mergeTrailingButtonGroupIntoCta(nestedSections);
  if (mergedSections) {
    return inheritWrapperHints(mergedSections, node);
  }

  if (nestedSections.length > 1) {
    return inheritWrapperHints(nestedSections, node);
  }

  // Group acting as a hero: has heading + paragraph (+ optional button)
  if (isHeroGroup(children)) {
    return toMappedSections(buildHeroFromChildren(node, children), node);
  }

  // Nested group that contains further sub-sections — recurse and keep them all.
  if (nestedSections.length === 1) {
    return [applyNodePresentation(nestedSections[0], node)];
  }
  return inheritWrapperHints(nestedSections, node);
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
  const displayLayoutType = String(
    node.params?.displayLayout?.type ??
      postTemplate?.params?.layout?.type ??
      node.params?.layout?.type ??
      '',
  ).toLowerCase();
  const layout: PostListSection['layout'] =
    Number.isFinite(displayColumns) && displayColumns >= 3
      ? 'grid-3'
      : displayColumns === 2
        ? 'grid-2'
        : displayLayoutType.includes('grid')
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
  context?: MapContext,
):
  | CardGridSection
  | MediaTextSection
  | PostContentSection
  | PageContentSection
  | null {
  const cols =
    node.children?.filter(
      (c) => c.block === 'core/column' || c.block === 'column',
    ) ?? [];

  if (cols.length === 0) return null;

  const detailContentSection = buildDetailContentSectionFromColumns(
    cols,
    context,
  );
  if (detailContentSection) {
    return detailContentSection;
  }

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
      const h = findFirstByBlock(flattenChildren(col), [
        'core/heading',
        'heading',
      ]);
      const p = findFirstByBlock(flattenChildren(col), [
        'core/paragraph',
        'paragraph',
      ]);
      return {
        heading: h?.text ?? '',
        body: p?.text ?? '',
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

function buildDetailContentSectionFromColumns(
  cols: WpNode[],
  context?: MapContext,
): PostContentSection | PageContentSection | null {
  const flattened = cols.flatMap((col) => flattenChildren(col));
  const hasContent = flattened.some((child) =>
    ['core/post-content', 'post-content'].includes(child.block),
  );

  if (!hasContent) return null;

  const hasTitle = flattened.some((child) =>
    ['core/post-title', 'post-title'].includes(child.block),
  );
  const hasAuthor = flattened.some((child) =>
    ['core/post-author', 'post-author'].includes(child.block),
  );
  const hasDate = flattened.some((child) =>
    ['core/post-date', 'post-date'].includes(child.block),
  );
  const hasCategories = flattened.some((child) =>
    ['core/post-terms', 'post-terms'].includes(child.block),
  );

  if (isPageLikeTemplateName(context?.rootTemplateName)) {
    return {
      type: 'page-content',
      showTitle: true,
    };
  }

  return {
    type: 'post-content',
    showTitle: true,
    showAuthor: hasAuthor,
    showDate: hasDate,
    showCategories: hasCategories,
  };
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
  const textAlign = extractNodeTextAlign(node);
  const hero: HeroSection = {
    type: 'hero',
    layout: textAlign === 'center' ? 'centered' : 'left',
    heading: node.text ?? '',
  };
  if (textAlign && textAlign !== 'left') {
    hero.textAlign = textAlign;
  }
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

  return {
    type: 'testimonial',
    quote,
    authorName,
  };
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
    next.sectionKey = buildSectionKey(next.type, node.sourceRef);
  }
  if (node.bgColor && !next.background) next.background = node.bgColor;
  if (node.textColor && !next.textColor) next.textColor = node.textColor;
  const textAlign = extractNodeTextAlign(node);
  if (textAlign && shouldApplySectionTextAlign(next) && !next.textAlign) {
    next.textAlign = textAlign;
  }
  const sourceLayout = extractSourceLayout(node);
  if (sourceLayout && !next.sourceLayout) {
    next.sourceLayout = sourceLayout;
  }
  const contentWidth = extractContentWidth(node);
  if (contentWidth && shouldApplyContentWidth(next) && !next.contentWidth) {
    next.contentWidth = contentWidth;
  }
  if (node.padding && !next.paddingStyle) {
    next.paddingStyle = boxSpacingToCss(node.padding);
  }
  if (node.margin && !next.marginStyle) {
    next.marginStyle = boxSpacingToCss(node.margin);
  }
  if (node.gap && !next.gapStyle) {
    const gapStyle = normalizeGapStyle(node.gap);
    if (gapStyle) next.gapStyle = gapStyle;
  }
  const customClassNames = uniqueClassNames([
    ...(next.customClassNames ?? []),
    ...(node.customClassNames ?? []),
  ]);
  if (customClassNames.length > 0) {
    next.customClassNames = customClassNames;
  }
  return next;
}

function extractSourceLayout(node: WpNode): SourceLayoutHint | undefined {
  const layout = node.params?.layout;
  if (!layout || typeof layout !== 'object') return undefined;

  const sourceLayout: SourceLayoutHint = {};
  if (typeof layout.type === 'string') sourceLayout.type = layout.type;
  if (typeof layout.orientation === 'string') {
    sourceLayout.orientation = layout.orientation;
  }
  if (typeof layout.justifyContent === 'string') {
    sourceLayout.justifyContent = layout.justifyContent;
  }
  if (typeof layout.flexWrap === 'string') {
    sourceLayout.flexWrap = layout.flexWrap;
  }
  if (typeof layout.verticalAlignment === 'string') {
    sourceLayout.verticalAlignment = layout.verticalAlignment;
  }

  const columnCount = Number(layout.columnCount ?? layout.columns ?? 0);
  if (Number.isFinite(columnCount) && columnCount > 0) {
    sourceLayout.columnCount = columnCount;
  }

  const minimumColumnWidth = normalizeCssLength(
    typeof layout.minimumColumnWidth === 'string'
      ? layout.minimumColumnWidth
      : undefined,
  );
  if (minimumColumnWidth) {
    sourceLayout.minimumColumnWidth = minimumColumnWidth;
  }

  const contentSize = normalizeCssLength(
    typeof layout.contentSize === 'string' ? layout.contentSize : undefined,
  );
  if (contentSize) {
    sourceLayout.contentSize = contentSize;
  }

  const wideSize = normalizeCssLength(
    typeof layout.wideSize === 'string' ? layout.wideSize : undefined,
  );
  if (wideSize) {
    sourceLayout.wideSize = wideSize;
  }

  return Object.keys(sourceLayout).length > 0 ? sourceLayout : undefined;
}

function buildSectionKey(
  type: SectionPlan['type'],
  sourceRef?: WpNode['sourceRef'],
): string {
  const sourceNodeId = sourceRef?.sourceNodeId?.trim();
  if (sourceNodeId) {
    const suffix = sourceNodeId
      .replace(/^[^:]+::/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    if (suffix) {
      return `${type}-${suffix}`;
    }
  }
  if (
    typeof sourceRef?.topLevelIndex === 'number' &&
    sourceRef.topLevelIndex >= 0
  ) {
    return `${type}-${sourceRef.topLevelIndex}`;
  }
  return type;
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
  const btn = flat.find(
    (c) =>
      c.block === 'core/button' ||
      c.block === 'button' ||
      c.block === 'core/buttons' ||
      c.block === 'buttons',
  );
  const img = flat.find((c) => c.block === 'core/image' || c.block === 'image');

  const align =
    extractNodeTextAlign(groupNode) ??
    extractChildTextAlign([h, p, btn]) ??
    'left';
  const layout: HeroSection['layout'] =
    align === 'center' ? 'centered' : img ? 'split' : 'left';

  const s: HeroSection = {
    type: 'hero',
    layout,
    heading: h ? extractNodeText(h) : '',
  };
  if (align === 'center' || align === 'right') {
    s.textAlign = align;
  }
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  const paragraphText = p ? extractNodeText(p) : '';
  if (paragraphText) s.subheading = paragraphText;
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  if (btn?.text) s.cta = { text: btn.text, link: btn.href ?? '#' };
  if (img?.src)
    s.image = { src: img.src, alt: img.alt ?? '', position: 'right' };
  if (groupNode.padding) {
    s.paddingStyle = boxSpacingToCss(groupNode.padding);
  }
  return s;
}

function buildGroupedTestimonial(
  groupNode: WpNode,
  children: WpNode[],
): TestimonialSection | null {
  const flat = flattenChildren({ children } as WpNode);
  if (
    flat.some((child) =>
      [
        'core/heading',
        'heading',
        'core/image',
        'image',
        'core/button',
        'button',
        'core/buttons',
        'buttons',
        'core/query',
        'query',
        'core/columns',
        'columns',
      ].includes(child.block),
    )
  ) {
    return null;
  }

  const paragraphs = flat.filter(
    (child) => child.block === 'core/paragraph' || child.block === 'paragraph',
  );
  if (paragraphs.length < 2) return null;

  const metadataName = String(
    groupNode.params?.metadata?.name ?? '',
  ).toLowerCase();
  const quoteNode = paragraphs[0];
  const authorNode = paragraphs[1];
  const titleNode = paragraphs[2];
  const quote = quoteNode.html ?? quoteNode.text ?? '';
  const authorName = authorNode.text?.trim() ?? '';
  const authorTitle = titleNode?.text?.trim();
  const quoteText = stripInlineHtml(quote);

  const looksLikeTestimonial =
    metadataName.includes('testimonial') ||
    (quoteText.length >= 80 && !!authorName && authorName.length <= 80);
  if (!looksLikeTestimonial) return null;

  return {
    type: 'testimonial',
    quote,
    authorName,
    ...(authorTitle ? { authorTitle } : {}),
  };
}

/**
 * When a group's mapped children are [hero|cover, button-group], the button-group
 * is a CTA for the preceding hero/cover — merge it in and drop the separate section.
 * Returns the merged array, or null if the pattern does not match.
 */
function mergeTrailingButtonGroupIntoCta(
  sections: SectionPlan[],
): SectionPlan[] | null {
  if (sections.length < 2) return null;
  const last = sections[sections.length - 1];
  const prev = sections[sections.length - 2];
  if (last.type !== 'button-group') return null;
  if (prev.type !== 'hero' && prev.type !== 'cover') return null;

  const btnGroup = last as ButtonGroupSection;
  if (btnGroup.buttons.length === 0) return null;

  // Only merge when the preceding section has no cta yet
  const prevSection = prev as HeroSection | CoverSection;
  if (prevSection.cta) return null;

  const firstBtn = btnGroup.buttons[0];
  const merged: SectionPlan = {
    ...prevSection,
    cta: { text: firstBtn.text, link: firstBtn.link },
  };

  return [...sections.slice(0, -2), merged];
}

function resolveButtonGroupAlign(node: WpNode): ButtonGroupSection['align'] {
  const justify = String(
    node.params?.layout?.justifyContent ?? '',
  ).toLowerCase();
  if (justify === 'center') return 'center';
  if (justify === 'right' || justify === 'end') return 'right';
  const textAlign = extractNodeTextAlign(node);
  if (textAlign === 'center' || textAlign === 'right') return textAlign;
  return 'left';
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
      const p = flat.find(
        (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
      );
      return { heading: h?.text ?? '', body: p?.text ?? '' };
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
  const btn = textFlat.find(
    (c) => c.block === 'core/button' || c.block === 'button',
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
  if (p?.html ?? p?.text) s.body = p.html ?? p.text;
  if (p?.typography || p?.fontFamily) s.bodyStyle = toTypographyStyle(p);
  if (listItems.length > 0) s.listItems = listItems;
  if (btn?.text) s.cta = { text: btn.text, link: btn.href ?? '#' };
  return s;
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

function boxSpacingToCss(box: NonNullable<WpNode['padding']>): string {
  const { top = '0', right = top, bottom = top, left = right } = box;
  if (top === right && top === bottom && top === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  return `${top} ${right} ${bottom} ${left}`;
}

function normalizeGapStyle(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return normalizeCssLength(value);
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const vertical = normalizeCssLength(
    asString(
      record.vertical ??
        record.row ??
        record.top ??
        record.blockGap ??
        record.y,
    ),
  );
  const horizontal = normalizeCssLength(
    asString(
      record.horizontal ??
        record.column ??
        record.left ??
        record.inline ??
        record.x,
    ),
  );

  if (vertical && horizontal) {
    return vertical === horizontal ? vertical : `${vertical} ${horizontal}`;
  }
  return vertical ?? horizontal;
}

function normalizeCssLength(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
}

function extractNodeTextAlign(
  node?: WpNode,
): 'left' | 'center' | 'right' | undefined {
  const raw = node?.textAlign ?? node?.params?.textAlign;
  if (raw === 'left' || raw === 'center' || raw === 'right') return raw;

  const className =
    typeof node?.params?.className === 'string' ? node.params.className : '';
  if (/\bhas-text-align-center\b|\baligncenter\b/i.test(className)) {
    return 'center';
  }
  if (/\bhas-text-align-right\b|\balignright\b/i.test(className)) {
    return 'right';
  }
  if (/\bhas-text-align-left\b|\balignleft\b/i.test(className)) {
    return 'left';
  }

  const inlineStyle =
    typeof node?.html === 'string'
      ? node.html.match(/\btext-align\s*:\s*(left|center|right)\b/i)?.[1]
      : undefined;
  if (
    inlineStyle === 'left' ||
    inlineStyle === 'center' ||
    inlineStyle === 'right'
  ) {
    return inlineStyle;
  }

  return undefined;
}

function extractChildTextAlign(
  nodes: Array<WpNode | undefined>,
): 'left' | 'center' | 'right' | undefined {
  for (const node of nodes) {
    const align = extractNodeTextAlign(node);
    if (align) return align;
  }
  return undefined;
}

function extractContentWidth(node?: WpNode): string | undefined {
  const layout = node?.params?.layout;
  if (!layout || typeof layout !== 'object') return undefined;
  return normalizeCssLength(
    typeof layout.contentSize === 'string' ? layout.contentSize : undefined,
  );
}

function shouldApplySectionTextAlign(section: SectionPlan): boolean {
  return (
    section.type === 'hero' ||
    section.type === 'cover' ||
    section.type === 'slider' ||
    section.type === 'testimonial' ||
    section.type === 'newsletter' ||
    section.type === 'search'
  );
}

function shouldApplyContentWidth(section: SectionPlan): boolean {
  return (
    section.type === 'hero' ||
    section.type === 'cover' ||
    section.type === 'slider' ||
    section.type === 'testimonial' ||
    section.type === 'newsletter' ||
    section.type === 'search' ||
    section.type === 'page-content' ||
    section.type === 'post-content'
  );
}

function inheritWrapperHints(
  sections: SectionPlan[],
  wrapperNode: WpNode,
): SectionPlan[] {
  if (sections.length === 0) return sections;

  const contentWidth = extractContentWidth(wrapperNode);
  const textAlign = extractNodeTextAlign(wrapperNode);
  if (!contentWidth && !textAlign) return sections;

  const next = [...sections];
  const targetIndex = next.findIndex(
    (section) =>
      (contentWidth && shouldApplyContentWidth(section)) ||
      (textAlign && shouldApplySectionTextAlign(section)),
  );
  if (targetIndex === -1) return sections;

  const target = { ...next[targetIndex] };
  if (contentWidth && shouldApplyContentWidth(target) && !target.contentWidth) {
    target.contentWidth = contentWidth;
  }
  if (textAlign && shouldApplySectionTextAlign(target) && !target.textAlign) {
    target.textAlign = textAlign;
  }
  next[targetIndex] = target;
  return next;
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

function extractNodeText(node: WpNode): string {
  if (node.text?.trim()) return node.text.trim();
  if (node.html?.trim()) return stripInlineHtml(node.html);
  return '';
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

function inferRootTemplateName(nodes: WpNode[]): string | undefined {
  for (const node of nodes) {
    const templateName =
      node.sourceRef?.templateName ??
      inferRootTemplateName(node.children ?? []);
    if (templateName) return templateName;
  }
  return undefined;
}

function shouldSkipSharedSourceScope(
  node: WpNode,
  rootTemplateName?: string,
): boolean {
  const normalizedRoot = String(rootTemplateName ?? '')
    .trim()
    .toLowerCase();
  if (
    normalizedRoot === 'header' ||
    normalizedRoot === 'footer' ||
    normalizedRoot === 'sidebar' ||
    normalizedRoot === 'post-meta'
  ) {
    return false;
  }

  const sourceFile = String(node.params?.sourceFile ?? '')
    .trim()
    .toLowerCase();
  if (!sourceFile) return false;
  const baseName = sourceFile.split(/[\\/]/).pop() ?? sourceFile;
  return /^(header|footer|sidebar|post-meta)(?:[-_].+)?\.(php|html)$/i.test(
    baseName,
  );
}

function isPageLikeTemplateName(templateName?: string): boolean {
  const normalized = String(templateName ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'page' ||
    normalized.startsWith('page-') ||
    normalized.startsWith('page_')
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
