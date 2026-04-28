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
  ProseBlockSection,
  SearchSection,
  BreadcrumbSection,
  SidebarSection,
  ModalSection,
  TestimonialSection,
  TabsSection,
  AccordionSection,
  CarouselSection,
  SourceSegment,
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

export function mapWpNodesToLosslessPageSections(
  nodes: WpNode[],
): SectionPlan[] {
  return mapNodesLosslessPage(nodes, nodes);
}

// ── Per-node dispatch ───────────────────────────────────────────────────────

function mapNodesLosslessPage(
  nodes: WpNode[],
  siblings: WpNode[],
): SectionPlan[] {
  const sections: SectionPlan[] = [];
  let pendingSpacer: string | undefined;
  let proseRun: WpNode[] = [];

  const flushProseRun = () => {
    if (proseRun.length === 0) return;
    const proseSection = mapNodesToProseBlock(proseRun);
    proseRun = [];
    if (!proseSection) return;
    let mapped = applyNodePresentation(
      proseSection,
      proseSection.sourceRefNode,
    );
    if (pendingSpacer) {
      mapped = applyLeadingSpacer(mapped, pendingSpacer);
      pendingSpacer = undefined;
    }
    sections.push(stripSourceRefNode(mapped));
  };

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (isSpacerBlock(node.block)) {
      pendingSpacer = resolveSpacerHeight(node) ?? pendingSpacer;
      continue;
    }

    if (isLosslessProseRunCandidate(node)) {
      proseRun.push(node);
      continue;
    }

    flushProseRun();

    const mapped = mapLosslessPageNode(node, siblings);
    if (mapped.length === 0) continue;

    if (pendingSpacer) {
      mapped[0] = applyLeadingSpacer(mapped[0], pendingSpacer);
      pendingSpacer = undefined;
    }

    for (const section of mapped) {
      sections.push(section);
    }
  }

  flushProseRun();

  if (pendingSpacer && sections.length > 0) {
    sections[sections.length - 1] = applyTrailingSpacer(
      sections[sections.length - 1],
      pendingSpacer,
    );
  }

  return sections;
}

function mapNodes(nodes: WpNode[], siblings: WpNode[]): SectionPlan[] {
  const sections: SectionPlan[] = [];
  let pendingSpacer: string | undefined;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (isSpacerBlock(node.block)) {
      pendingSpacer = resolveSpacerHeight(node) ?? pendingSpacer;
      continue;
    }

    const nextNode = nodes[index + 1];
    const isHeadingNode =
      node.block === 'core/heading' || node.block === 'heading';
    const isNextQueryNode =
      nextNode &&
      (nextNode.block === 'core/query' || nextNode.block === 'query');
    if (isHeadingNode && isNextQueryNode) {
      let section = applyNodePresentation(mapQuery(nextNode), nextNode);
      const title = extractNodeText(node);
      if (title) section = { ...section, title };
      const mapped = [applyNodePresentation(section, nextNode)];

      if (pendingSpacer) {
        mapped[0] = applyLeadingSpacer(mapped[0], pendingSpacer);
        pendingSpacer = undefined;
      }

      for (const mappedSection of mapped) {
        sections.push(mappedSection);
      }
      index += 1;
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

function mapLosslessPageNode(node: WpNode, siblings: WpNode[]): SectionPlan[] {
  const block = node.block;

  if (block === 'core/columns' || block === 'columns') {
    const losslessColumns = mapLosslessColumns(node);
    if (losslessColumns) {
      return losslessColumns;
    }
  }

  if ((block === 'core/group' || block === 'group') && node.children?.length) {
    const childSections = mapNodesLosslessPage(node.children, node.children);
    if (childSections.length === 0) return [];
    return applyWrapperVisualPresentation(childSections, node);
  }

  const mapped = mapNode(node, siblings);
  if (mapped.length > 0) return mapped;

  if (node.children?.length) {
    return mapNodesLosslessPage(node.children, node.children);
  }

  const proseSection = mapNodesToProseBlock([node]);
  if (!proseSection) return [];
  return [
    stripSourceRefNode(
      applyNodePresentation(proseSection, proseSection.sourceRefNode),
    ),
  ];
}

function mapLosslessColumns(node: WpNode): SectionPlan[] | null {
  const cols =
    node.children?.filter(
      (child) => child.block === 'core/column' || child.block === 'column',
    ) ?? [];
  if (cols.length === 0) return null;
  if (!shouldDecomposeColumnsLosslessly(cols)) return null;

  const sections = cols.flatMap((col) => {
    const children = col.children ?? [];
    if (children.length === 0) return [];
    const nestedSections = mapNodesLosslessPage(children, children);
    if (nestedSections.length === 0) return [];
    return nestedSections.map((section) => applyNodePresentation(section, col));
  });

  return sections.length > 0 ? sections : null;
}

function shouldDecomposeColumnsLosslessly(cols: WpNode[]): boolean {
  if (cols.length !== 2) return false;

  const imageColumnCount = cols.filter((col) =>
    columnContainsImage(col),
  ).length;
  if (imageColumnCount === 0) return false;

  // A strict media-text is one image-only column beside one text-only column.
  if (imageColumnCount === 1) {
    const [imageCol] = cols.filter((col) => columnContainsImage(col));
    const [textCol] = cols.filter((col) => !columnContainsImage(col));
    if (
      imageCol &&
      textCol &&
      columnIsImageDominant(imageCol) &&
      columnHasMeaningfulTextLikeContent(textCol)
    ) {
      return false;
    }
  }

  // If both columns contain images, or the image-owning column also carries
  // prose/list content, mapping to one media-text section would drop source
  // content from at least one side. Decompose instead.
  return true;
}

type InternalProseBlockSection = ProseBlockSection & {
  sourceRefNode: WpNode;
};

function stripSourceRefNode(
  section: InternalProseBlockSection | SectionPlan,
): SectionPlan {
  if (!('sourceRefNode' in section)) return section;
  const { sourceRefNode, ...rest } = section;
  void sourceRefNode;
  return rest as SectionPlan;
}

function isLosslessProseRunCandidate(node: WpNode): boolean {
  const block = String(node.block ?? '')
    .trim()
    .toLowerCase();
  if (!block) return false;

  if (
    [
      'core/heading',
      'heading',
      'core/paragraph',
      'paragraph',
      'core/list',
      'list',
      'core/image',
      'image',
      'core/button',
      'button',
      'core/buttons',
      'buttons',
      'core/html',
      'html',
    ].includes(block)
  ) {
    return true;
  }

  if ((block === 'core/group' || block === 'group') && node.children?.length) {
    return node.children.every(
      (child) =>
        isSpacerBlock(child.block) || isLosslessProseRunCandidate(child),
    );
  }

  return !!String(node.html ?? '').trim();
}

function mapNodesToProseBlock(
  nodes: WpNode[],
): InternalProseBlockSection | null {
  const segments = collectSourceSegmentsFromNodes(nodes);
  if (segments.length === 0) return null;

  const sourceRefNode =
    nodes.find((node) => !!node.sourceRef) ??
    nodes.find((node) => !!String(node.block ?? '').trim()) ??
    nodes[0];
  if (!sourceRefNode) return null;

  const shellVariant = segments.some((segment) => segment.type === 'image')
    ? 'wide'
    : 'article';

  return {
    type: 'prose-block',
    sourceSegments: segments,
    shellVariant,
    sourceRefNode,
  };
}

function collectSourceSegmentsFromNodes(nodes: WpNode[]): SourceSegment[] {
  const segments: SourceSegment[] = [];
  for (const node of nodes) {
    if (isSpacerBlock(node.block) || isSeparatorBlock(node.block)) continue;

    if (
      (node.block === 'core/group' || node.block === 'group') &&
      node.children?.length
    ) {
      segments.push(...collectSourceSegmentsFromNodes(node.children));
      continue;
    }

    const segment = mapNodeToSourceSegment(node);
    if (segment) segments.push(segment);
  }
  return segments;
}

function mapNodeToSourceSegment(node: WpNode): SourceSegment | null {
  const block = String(node.block ?? '')
    .trim()
    .toLowerCase();
  const customClassNames = uniqueClassNames(node.customClassNames ?? []);

  if (block === 'core/heading' || block === 'heading') {
    const text = extractNodeText(node);
    if (!text) return null;
    return {
      type: 'heading',
      text,
      ...(typeof node.html === 'string' && node.html.trim()
        ? { html: node.html.trim() }
        : {}),
      ...(typeof node.level === 'number' ? { level: node.level } : {}),
      ...(customClassNames.length > 0 ? { customClassNames } : {}),
      ...(node.typography || node.fontFamily
        ? { style: toTypographyStyle(node) }
        : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  if (block === 'core/paragraph' || block === 'paragraph') {
    const html = String(node.html ?? '').trim();
    const text = extractNodeText(node);
    if (!html && !text) return null;
    return {
      type: 'paragraph',
      html: html || text,
      ...(text ? { text } : {}),
      ...(customClassNames.length > 0 ? { customClassNames } : {}),
      ...(node.typography || node.fontFamily
        ? { style: toTypographyStyle(node) }
        : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  if (block === 'core/list' || block === 'list') {
    const listItems = flattenChildren(node)
      .filter(
        (candidate) =>
          candidate.block === 'core/list-item' ||
          candidate.block === 'list-item',
      )
      .map((candidate) => String(candidate.html ?? candidate.text ?? '').trim())
      .filter(Boolean);
    if (listItems.length === 0) {
      const html = String(node.html ?? '').trim();
      if (!html) return null;
      return {
        type: 'html',
        html,
        ...(customClassNames.length > 0 ? { customClassNames } : {}),
        ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
      };
    }

    const firstItem = flattenChildren(node).find(
      (candidate) =>
        candidate.block === 'core/list-item' || candidate.block === 'list-item',
    );

    return {
      type: 'list',
      items: listItems,
      ordered: /<ol\b/i.test(String(node.html ?? '')),
      ...(customClassNames.length > 0 ? { customClassNames } : {}),
      ...(firstItem?.customClassNames?.length
        ? { itemCustomClassNames: uniqueClassNames(firstItem.customClassNames) }
        : {}),
      ...(firstItem?.typography || firstItem?.fontFamily
        ? { style: toTypographyStyle(firstItem) }
        : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  if (
    block === 'core/image' ||
    block === 'image' ||
    (typeof node.src === 'string' && node.src.trim())
  ) {
    if (!node.src?.trim()) return null;
    const captionMatch = String(node.html ?? '').match(
      /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i,
    );
    return {
      type: 'image',
      src: node.src,
      ...(typeof node.alt === 'string' ? { alt: node.alt } : {}),
      ...(captionMatch?.[1]
        ? { caption: stripInlineHtml(captionMatch[1]) }
        : {}),
      ...(typeof node.width === 'number' ? { width: node.width } : {}),
      ...(typeof node.height === 'number' ? { height: node.height } : {}),
      ...(customClassNames.length > 0 ? { customClassNames } : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  const html = String(node.html ?? '').trim();
  if (!html) return null;
  return {
    type: 'html',
    html,
    ...(customClassNames.length > 0 ? { customClassNames } : {}),
    ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
  };
}

function isSeparatorBlock(block?: string): boolean {
  return block === 'core/separator' || block === 'separator';
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

  // Gallery block: map to card-grid with image cards
  if (block === 'core/gallery' || block === 'gallery') {
    return toMappedSections(mapGallery(node), node);
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
    const mappedColumns = mapColumns(node);
    if (mappedColumns) {
      return toMappedSections(mappedColumns, node);
    }
    const childSections = mapNodes(node.children ?? [], node.children ?? []);
    if (childSections.length === 0) return [];
    return applyWrapperVisualPresentation(
      mergeGroupedSections(childSections, node),
      node,
    );
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

  // DB-backed pages often contain root-level prose/image runs. Preserve those
  // blocks as explicit sections so the planner does not keep only the nearby
  // interactive widgets and silently drop the main page body.
  if (block === 'core/paragraph' || block === 'paragraph') {
    return toMappedSections(mapStandaloneParagraph(node), node);
  }
  if (block === 'core/list' || block === 'list') {
    return toMappedSections(mapStandaloneList(node), node);
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
    const headingCustomClassNames = extractStyleVariantClassNames(
      headingNode?.customClassNames,
    );
    if (headingCustomClassNames.length > 0) {
      s.headingCustomClassNames = headingCustomClassNames;
    }
    if (headingNode?.typography || headingNode?.fontFamily) {
      s.headingStyle = toTypographyStyle(headingNode);
    }
    const paraNode = findFirstByBlock(node.children ?? [], [
      'core/paragraph',
      'paragraph',
    ]);
    if (paraNode?.text) s.subheading = paraNode.text;
    const subheadingCustomClassNames = extractStyleVariantClassNames(
      paraNode?.customClassNames,
    );
    if (subheadingCustomClassNames.length > 0) {
      s.subheadingCustomClassNames = subheadingCustomClassNames;
    }
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
  const heroHeadingCustomClassNames = extractStyleVariantClassNames(
    h?.customClassNames,
  );
  if (heroHeadingCustomClassNames.length > 0) {
    s.headingCustomClassNames = heroHeadingCustomClassNames;
  }
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  const p = findFirstByBlock(node.children ?? [], [
    'core/paragraph',
    'paragraph',
  ]);
  if (p?.text) s.subheading = p.text;
  const heroSubheadingCustomClassNames = extractStyleVariantClassNames(
    p?.customClassNames,
  );
  if (heroSubheadingCustomClassNames.length > 0) {
    s.subheadingCustomClassNames = heroSubheadingCustomClassNames;
  }
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  applySectionCtas(s, node.children ?? []);
  return s;
}

function mapGallery(node: WpNode): CardGridSection | null {
  const imageNodes = (node.children ?? []).filter(
    (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
  );
  if (imageNodes.length === 0) return null;
  const cards = imageNodes.map((img) => ({
    heading: img.alt ?? '',
    body: '',
    imageSrc: img.src,
    imageAlt: img.alt ?? '',
    ...(img.customClassNames?.length
      ? { imageCustomClassNames: uniqueClassNames(img.customClassNames) }
      : {}),
  }));
  const columns = Math.min(Math.max(imageNodes.length, 2), 4) as 2 | 3 | 4;
  return { type: 'card-grid', columns, cards };
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
    return applyWrapperVisualPresentation(
      mergeGroupedSections(segmentedInteractiveSections, node),
      node,
    );
  }

  // Testimonial groups can be explicit ("testimonial" metadata) or implicit
  // (a long quote plus compact author/source copy nested in the group).
  const metadataName = (
    (node.params?.metadata as Record<string, string> | undefined)?.name ?? ''
  ).toLowerCase();
  if (metadataName.includes('testimonial') || isLikelyTestimonialGroup(node)) {
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
    return toMappedSections(
      buildStandaloneButtonsSection(node, children),
      node,
    );
  }

  // Group that acts as a full-width CTA banner: has buttons and a heading but
  // no multi-column layout. A background color or full/wide alignment marks it
  // as a standalone CTA strip so it isn't swallowed by the hero heuristic.
  if (!hasInteractive && !hasPostContent && isCtaBannerGroup(node, children)) {
    return toMappedSections(buildCtaBannerSection(node, children), node);
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
      const titleCustomClassNames = extractStyleVariantClassNames(
        headingChild.customClassNames,
      );
      if (titleCustomClassNames.length > 0) {
        section = {
          ...section,
          titleCustomClassNames,
        };
      }
    }
    return [applyNodePresentation(section, node)];
  }

  // Composite groups that mix intro copy with one or more direct rows/columns
  // should recurse into their children instead of collapsing into a single hero.
  if (!hasInteractive && !hasPostContent && isCompositeGroup(children)) {
    return applyWrapperVisualPresentation(
      mergeGroupedSections(mapNodes(children, children), node),
      node,
    );
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
  return applyWrapperVisualPresentation(
    mergeGroupedSections(nestedSections, node),
    node,
  );
}

// ── query block (post list) ─────────────────────────────────────────────────

function mapQuery(node: WpNode): PostListSection {
  const postTemplate = findFirstByBlock(node.children ?? [], [
    'core/post-template',
    'post-template',
  ]);
  const templateDirectChildren = postTemplate?.children ?? [];
  const templateNodes = postTemplate ? flattenChildren(postTemplate) : [];
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
  const separatorNode = templateNodes.find((child) =>
    ['core/separator', 'separator'].includes(child.block),
  );
  const columnsBlock = templateDirectChildren.find(
    (child) => child.block === 'core/columns' || child.block === 'columns',
  );
  const columnNodes =
    columnsBlock?.children?.filter(
      (child) => child.block === 'core/column' || child.block === 'column',
    ) ?? [];
  const hasPostMetaTemplatePart = templateNodes.some((child) => {
    const slug = String(child.params?.slug ?? '').toLowerCase();
    return (
      (child.block === 'core/template-part' ||
        child.block === 'template-part') &&
      slug.includes('post-meta')
    );
  });
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
  const compactMetaRowTemplate =
    (hasAuthorBlock || hasDateBlock || hasTermsBlock) &&
    !hasExcerptBlock &&
    !hasFeaturedImageBlock;

  // A post template that has only a title (no explicit meta blocks, no excerpt,
  // no featured image) is a minimal list. WordPress themes often render date/
  // author/category at the theme level without explicit blocks, so we should
  // default to list layout and show meta fields rather than inferring a grid
  // from the displayLayout columns count.
  const isMinimalTitleOnlyTemplate =
    !hasExcerptBlock &&
    !hasFeaturedImageBlock &&
    !hasAuthorBlock &&
    !hasDateBlock &&
    !hasTermsBlock;

  const layout: PostListSection['layout'] = compactMetaRowTemplate
    ? 'list'
    : isMinimalTitleOnlyTemplate
      ? 'list'
      : Number.isFinite(displayColumns) && displayColumns >= 3
        ? 'grid-3'
        : displayColumns === 2
          ? 'grid-2'
          : columnsInTemplate
            ? 'grid-3'
            : 'list';
  const itemLayout: PostListSection['itemLayout'] =
    compactMetaRowTemplate || isMinimalTitleOnlyTemplate
      ? 'title-meta-inline'
      : 'stacked';
  const metaLayout: PostListSection['metaLayout'] = 'inline';
  const metaAlign: PostListSection['metaAlign'] =
    itemLayout === 'title-meta-inline' ? 'end' : 'start';
  const titleColumnWidth = normalizeCssLength(columnNodes[0]?.columnWidth);
  const metaColumnWidth = normalizeCssLength(columnNodes[1]?.columnWidth);
  const showDividers = !!separatorNode;
  const dividerColor = separatorNode?.bgColor ?? separatorNode?.textColor;
  const splitCategoryLine =
    hasPostMetaTemplatePart &&
    itemLayout === 'title-meta-inline' &&
    metaAlign === 'end';
  const categoryPrefix = splitCategoryLine ? 'in ' : undefined;
  const metaSeparator: PostListSection['metaSeparator'] = splitCategoryLine
    ? 'dash'
    : undefined;

  return {
    type: 'post-list',
    layout,
    showDate: isMinimalTitleOnlyTemplate
      ? true
      : booleanAttr(node.params?.displayPostDate, hasDateBlock),
    showAuthor: isMinimalTitleOnlyTemplate
      ? true
      : booleanAttr(node.params?.displayAuthor, hasAuthorBlock),
    showCategory: isMinimalTitleOnlyTemplate
      ? true
      : booleanAttr(
          node.params?.displayPostTerms ?? node.params?.displayCategories,
          hasTermsBlock,
        ),
    showExcerpt: booleanAttr(node.params?.displayPostExcerpt, hasExcerptBlock),
    showFeaturedImage: booleanAttr(
      node.params?.displayFeaturedImage,
      hasFeaturedImageBlock,
    ),
    itemLayout,
    metaLayout,
    metaAlign,
    ...(metaSeparator ? { metaSeparator } : {}),
    ...(showDividers ? { showDividers: true } : {}),
    ...(dividerColor ? { dividerColor } : {}),
    ...(titleColumnWidth ? { titleColumnWidth } : {}),
    ...(metaColumnWidth ? { metaColumnWidth } : {}),
    ...(splitCategoryLine ? { splitCategoryLine: true } : {}),
    ...(categoryPrefix ? { categoryPrefix } : {}),
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

  if (isDetailLayoutColumns(cols)) return null;

  // 2-col: check if one side is image and other is text → media-text
  if (cols.length === 2 && isStrictMediaTextColumns(cols)) {
    return buildMediaTextFromColumns(cols);
  }

  // Otherwise: card-grid
  const cards = cols
    .map((col) => {
      const flat = flattenChildren(col);
      const h = findFirstByBlock(flat, ['core/heading', 'heading']);
      const img = findFirstByBlock(flat, ['core/image', 'image']);
      const body = extractRichTextFromNodes(flat);
      return {
        heading: h ? extractNodeText(h) : '',
        body,
        ...(img?.src
          ? {
              imageSrc: img.src,
              imageAlt: img.alt ?? '',
              ...(img.customClassNames?.length
                ? {
                    imageCustomClassNames: uniqueClassNames(
                      img.customClassNames,
                    ),
                  }
                : {}),
            }
          : {}),
        ...(col.customClassNames?.length
          ? { customClassNames: uniqueClassNames(col.customClassNames) }
          : {}),
      };
    })
    .filter((c) => c.heading || c.body || c.imageSrc);

  if (cards.length === 0) return null;

  const colCount = Math.min(Math.max(cols.length, 2), 4) as 2 | 3 | 4;
  const nodeClasses = node.customClassNames ?? [];
  const s: CardGridSection = {
    type: 'card-grid',
    columns: colCount,
    cards,
  };
  const columnWidths = cols
    .map((col) => normalizeCssLength(col.columnWidth))
    .filter((value): value is string => !!value);
  if (columnWidths.length === cols.length) s.columnWidths = columnWidths;
  const extraClasses: string[] = [];
  if (nodeClasses.includes('is-style-asterisk')) {
    extraClasses.push('vp-card-grid-intro-centered');
  }
  if (cards.length >= 2 && isStatsCardSet(cards)) {
    extraClasses.push('vp-stats-row');
  } else if (cards.length >= 2 && isTeamCardSet(cards)) {
    extraClasses.push('vp-team-grid');
  }
  if (nodeClasses.length > 0 || extraClasses.length > 0) {
    s.customClassNames = uniqueClassNames([...nodeClasses, ...extraClasses]);
  }
  return s;
}

function isDetailLayoutColumns(cols: WpNode[]): boolean {
  const flat = cols.flatMap((col) => flattenChildren(col));
  const hasPostDetailCore = flat.some((node) =>
    POST_DETAIL_LAYOUT_BLOCKS.has(node.block),
  );
  if (!hasPostDetailCore) return false;

  return flat.some((node) => SIDEBAR_WIDGET_BLOCKS.has(node.block));
}

function isStrictMediaTextColumns(cols: WpNode[]): boolean {
  if (cols.length !== 2) return false;
  const imageColumns = cols.filter((col) => columnContainsImage(col));
  if (imageColumns.length !== 1) return false;

  const imageColumn = imageColumns[0]!;
  const textColumn = cols.find((col) => col !== imageColumn);
  if (!textColumn) return false;

  return (
    columnIsImageDominant(imageColumn) &&
    !columnContainsImage(textColumn) &&
    columnHasMeaningfulTextLikeContent(textColumn)
  );
}

function columnContainsImage(col: WpNode): boolean {
  return (
    findFirstByBlock(flattenChildren(col), ['core/image', 'image']) !== null
  );
}

function columnIsImageDominant(col: WpNode): boolean {
  const meaningfulNonImageNodes = flattenChildren(col).filter((node) => {
    const block = node.block;
    if (
      block === 'core/image' ||
      block === 'image' ||
      block === 'core/spacer' ||
      block === 'spacer' ||
      block === 'core/separator' ||
      block === 'separator' ||
      block === 'core/group' ||
      block === 'group' ||
      block === 'core/column' ||
      block === 'column'
    ) {
      return false;
    }

    if (block === 'core/buttons' || block === 'buttons') {
      return false;
    }

    if (block === 'core/button' || block === 'button') {
      return !!extractNodeText(node) || !!node.href;
    }

    return (
      !!extractNodeText(node) ||
      !!String(node.html ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  });

  return meaningfulNonImageNodes.length === 0;
}

function columnHasMeaningfulTextLikeContent(col: WpNode): boolean {
  return flattenChildren(col).some((node) => {
    const block = node.block;
    if (
      block === 'core/image' ||
      block === 'image' ||
      block === 'core/spacer' ||
      block === 'spacer' ||
      block === 'core/separator' ||
      block === 'separator' ||
      block === 'core/group' ||
      block === 'group' ||
      block === 'core/column' ||
      block === 'column'
    ) {
      return false;
    }

    return (
      !!extractNodeText(node) ||
      !!String(node.html ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  });
}

/** Cards where every entry has a short number/%-heavy heading → stats row. */
function isStatsCardSet(
  cards: Array<{ heading: string; body?: string; imageSrc?: string }>,
): boolean {
  if (cards.some((c) => c.imageSrc)) return false;
  return cards.every(
    (c) =>
      c.heading.length <= 12 && /\d/.test(c.heading) && !/</.test(c.heading),
  );
}

/** Cards where every entry has an image AND a heading (name) → team member grid. */
function isTeamCardSet(
  cards: Array<{ heading: string; body?: string; imageSrc?: string }>,
): boolean {
  return cards.every((c) => !!c.imageSrc && !!c.heading);
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
  const headingCustomClassNames = extractStyleVariantClassNames(
    node.customClassNames,
  );
  if (headingCustomClassNames.length > 0) {
    hero.headingCustomClassNames = headingCustomClassNames;
  }
  if (node.typography || node.fontFamily) {
    hero.headingStyle = toTypographyStyle(node);
  }
  if (node.customClassNames?.length) {
    hero.customClassNames = uniqueClassNames(node.customClassNames);
  }
  return hero;
}

function mapStandaloneParagraph(node: WpNode): HeroSection | null {
  const text = extractNodeText(node);
  if (!text) return null;

  const preferHeading = isHeadingLikeStandaloneText(node, text);
  const hero: HeroSection = {
    type: 'hero',
    layout: inferSectionAlignment(node, []) === 'center' ? 'centered' : 'left',
    heading: preferHeading ? text : '',
    ...(!preferHeading ? { subheading: text } : {}),
  };
  const classNames = extractStyleVariantClassNames(node.customClassNames);
  if (classNames.length > 0) {
    if (preferHeading) {
      hero.headingCustomClassNames = classNames;
    } else {
      hero.subheadingCustomClassNames = classNames;
    }
  }
  if (node.typography || node.fontFamily) {
    if (preferHeading) {
      hero.headingStyle = toTypographyStyle(node);
    } else {
      hero.subheadingStyle = toTypographyStyle(node);
    }
  }
  if (node.customClassNames?.length) {
    hero.customClassNames = uniqueClassNames(node.customClassNames);
  }
  return hero;
}

function mapStandaloneList(node: WpNode): HeroSection | null {
  const text = extractRichTextFromNodes(flattenChildren(node));
  if (!text) return null;

  const firstListItem = flattenChildren(node).find(
    (candidate) =>
      candidate.block === 'core/list-item' || candidate.block === 'list-item',
  );
  const hero: HeroSection = {
    type: 'hero',
    layout: inferSectionAlignment(node, []) === 'center' ? 'centered' : 'left',
    heading: '',
    subheading: text,
  };
  const classNames = extractStyleVariantClassNames(
    firstListItem?.customClassNames,
  );
  if (classNames.length > 0) {
    hero.subheadingCustomClassNames = classNames;
  }
  if (firstListItem?.typography || firstListItem?.fontFamily) {
    hero.subheadingStyle = toTypographyStyle(firstListItem);
  }
  if (node.customClassNames?.length) {
    hero.customClassNames = uniqueClassNames(node.customClassNames);
  }
  return hero;
}

function isHeadingLikeStandaloneText(node: WpNode, text: string): boolean {
  const html = String(node.html ?? '');
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return false;

  if (/<(?:strong|b)\b/i.test(html)) return true;
  if (compact.length <= 72 && !/[.!?]$/.test(compact)) return true;
  if (
    node.typography?.fontWeight &&
    /^(6|7|8|9)00$/.test(node.typography.fontWeight)
  ) {
    return true;
  }

  return false;
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
  const quoteCustomClassNames = extractStyleVariantClassNames(
    node.customClassNames,
  );
  if (quoteCustomClassNames.length > 0) {
    section.quoteCustomClassNames = quoteCustomClassNames;
  }
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
    const paragraphNode = flat.find(
      (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
    );
    const subheading = extractRichTextFromNodes(flat);
    const img = flat.find(
      (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
    );
    const btn = findBestButtonNode(flat);
    return {
      ...(h?.text ? { heading: h.text } : {}),
      ...(extractStyleVariantClassNames(h?.customClassNames).length
        ? {
            headingCustomClassNames: extractStyleVariantClassNames(
              h?.customClassNames,
            ),
          }
        : {}),
      ...(subheading ? { subheading } : {}),
      ...(extractStyleVariantClassNames(paragraphNode?.customClassNames).length
        ? {
            subheadingCustomClassNames: extractStyleVariantClassNames(
              paragraphNode?.customClassNames,
            ),
          }
        : {}),
      ...(img?.src ? { imageSrc: img.src, imageAlt: img.alt ?? '' } : {}),
      ...(img?.customClassNames?.length
        ? {
            imageCustomClassNames: uniqueClassNames(img.customClassNames),
          }
        : {}),
      ...(btn?.text ? { cta: buildSectionCta(btn) } : {}),
    };
  });

  // Fallback: if no labeled slider-children, treat all children as a single slide
  if (slides.length === 0) {
    const flat = flattenChildren(node);
    const h = flat.find(
      (c) => c.block === 'core/heading' || c.block === 'heading',
    );
    const paragraphNode = flat.find(
      (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
    );
    const subheading = extractRichTextFromNodes(flat);
    const img = flat.find(
      (c) => (c.block === 'core/image' || c.block === 'image') && c.src,
    );
    if (!h && !img) return null;
    slides.push({
      ...(h?.text ? { heading: h.text } : {}),
      ...(extractStyleVariantClassNames(h?.customClassNames).length
        ? {
            headingCustomClassNames: extractStyleVariantClassNames(
              h?.customClassNames,
            ),
          }
        : {}),
      ...(subheading ? { subheading } : {}),
      ...(extractStyleVariantClassNames(paragraphNode?.customClassNames).length
        ? {
            subheadingCustomClassNames: extractStyleVariantClassNames(
              paragraphNode?.customClassNames,
            ),
          }
        : {}),
      ...(img?.src ? { imageSrc: img.src, imageAlt: img.alt ?? '' } : {}),
      ...(img?.customClassNames?.length
        ? {
            imageCustomClassNames: uniqueClassNames(img.customClassNames),
          }
        : {}),
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
        ...(extractStyleVariantClassNames(h?.customClassNames).length
          ? {
              headingCustomClassNames: extractStyleVariantClassNames(
                h?.customClassNames,
              ),
            }
          : {}),
        ...(body ? { body } : {}),
        ...(extractStyleVariantClassNames(
          flat.find(
            (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
          )?.customClassNames,
        ).length
          ? {
              bodyCustomClassNames: extractStyleVariantClassNames(
                flat.find(
                  (c) =>
                    c.block === 'core/paragraph' || c.block === 'paragraph',
                )?.customClassNames,
              ),
            }
          : {}),
        ...(imageNode?.src
          ? {
              imageSrc: imageNode.src,
              imageAlt: imageNode.alt ?? '',
              ...(imageNode.customClassNames?.length
                ? {
                    imageCustomClassNames: uniqueClassNames(
                      imageNode.customClassNames,
                    ),
                  }
                : {}),
            }
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
        ...(extractStyleVariantClassNames(headingNode?.customClassNames).length
          ? {
              headingCustomClassNames: extractStyleVariantClassNames(
                headingNode?.customClassNames,
              ),
            }
          : {}),
        ...(extractStyleVariantClassNames(
          flat.find(
            (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
          )?.customClassNames,
        ).length
          ? {
              bodyCustomClassNames: extractStyleVariantClassNames(
                flat.find(
                  (c) =>
                    c.block === 'core/paragraph' || c.block === 'paragraph',
                )?.customClassNames,
              ),
            }
          : {}),
      };
    })
    .filter(
      (
        item,
      ): item is {
        heading: string;
        body: string;
        headingCustomClassNames?: string[];
        bodyCustomClassNames?: string[];
      } => !!item,
    );

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
  const triggerCustomClassNames = extractStyleVariantClassNames(
    triggerButtonNode?.customClassNames,
  );
  if (triggerCustomClassNames.length > 0) {
    section.triggerCustomClassNames = triggerCustomClassNames;
  }
  const headingCustomClassNames = extractStyleVariantClassNames(
    headingNode?.customClassNames,
  );
  if (headingCustomClassNames.length > 0) {
    section.headingCustomClassNames = headingCustomClassNames;
  }
  const bodyNode = flat.find(
    (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
  );
  const bodyCustomClassNames = extractStyleVariantClassNames(
    bodyNode?.customClassNames,
  );
  if (bodyCustomClassNames.length > 0) {
    section.bodyCustomClassNames = bodyCustomClassNames;
  }
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
    if (imageNode.customClassNames?.length) {
      section.imageCustomClassNames = uniqueClassNames(
        imageNode.customClassNames,
      );
    }
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
  let mergedClassNames = uniqueClassNames([
    ...(next.customClassNames ?? []),
    ...(node.customClassNames ?? []),
  ]);
  const inferredAlign = inferNodeAlignment(node);
  const presentation = {
    ...(next.presentation ?? {}),
  };
  if (inferredAlign && !presentation.contentAlign) {
    presentation.contentAlign = inferredAlign;
  }
  if (inferredAlign && !presentation.textAlign) {
    presentation.textAlign = inferredAlign;
  }
  if (!presentation.itemsAlign && inferredAlign) {
    presentation.itemsAlign =
      inferredAlign === 'center'
        ? 'center'
        : inferredAlign === 'right'
          ? 'end'
          : 'start';
  }
  if (!presentation.justify && inferredAlign) {
    presentation.justify =
      inferredAlign === 'center'
        ? 'center'
        : inferredAlign === 'right'
          ? 'end'
          : 'start';
  }
  if (node.align === 'full' || node.align === 'wide') {
    presentation.container = 'shell';
  }
  if (inferredAlign) {
    mergedClassNames = mergedClassNames.filter(
      (className) => !/^vp-section-align-(left|center|right)$/.test(className),
    );
    mergedClassNames.push(`vp-section-align-${inferredAlign}`);
  }
  // For card-grid: auto-inject centered intro marker when asterisk style or
  // when the wrapping node is center-aligned (common WP pattern for feature grids)
  if (next.type === 'card-grid') {
    const hasAsterisk = mergedClassNames.includes('is-style-asterisk');
    const wrapperCentered = inferNodeAlignment(node) === 'center';
    if (
      (hasAsterisk || wrapperCentered) &&
      !mergedClassNames.includes('vp-card-grid-intro-centered')
    ) {
      mergedClassNames.push('vp-card-grid-intro-centered');
    }
  }
  const customClassNames = mergedClassNames;
  const buttonClassNames = extractLikelyButtonClassNames(node.customClassNames);
  if (buttonClassNames.length > 0) {
    applyButtonClassesToSectionCtas(next, buttonClassNames);
  }
  if (customClassNames.length > 0) {
    next.customClassNames = customClassNames;
  }
  if (Object.keys(presentation).length > 0) {
    next.presentation = presentation;
  }
  return next;
}

function applyWrapperVisualPresentation<T extends SectionPlan>(
  sections: T[],
  node: WpNode,
): T[] {
  if (sections.length === 0) return sections;
  if (!node.bgColor && !node.textColor) return sections;
  return sections.map((section) => {
    const next: T = { ...section };
    if (node.bgColor && !next.background) next.background = node.bgColor;
    if (node.textColor && !next.textColor) next.textColor = node.textColor;
    return next;
  });
}

function mergeGroupedSections(
  sections: SectionPlan[],
  node: WpNode,
): SectionPlan[] {
  if (sections.length < 2) return sections;

  const merged: SectionPlan[] = [];
  for (let index = 0; index < sections.length; index++) {
    const current = sections[index]!;
    const next = sections[index + 1];

    if (current.type === 'hero' && canMergeHeroIntoCardGrid(current, next)) {
      merged.push(mergeHeroIntoCardGrid(current, next, node));
      index += 1;
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function canMergeHeroIntoCardGrid(
  current: HeroSection,
  next: SectionPlan | undefined,
): next is CardGridSection {
  if (!next || next.type !== 'card-grid') {
    return false;
  }

  return (
    !current.image &&
    !current.cta &&
    (!current.ctas || current.ctas.length === 0) &&
    !!current.heading &&
    next.cards.length > 0
  );
}

function mergeHeroIntoCardGrid(
  hero: HeroSection,
  grid: CardGridSection,
  node: WpNode,
): CardGridSection {
  const gridAlignmentClasses = (grid.customClassNames ?? []).filter(
    (className) => /^vp-section-align-(left|center|right)$/.test(className),
  );
  const mergedNonAlignmentClasses = uniqueClassNames(
    [...(grid.customClassNames ?? []), ...(hero.customClassNames ?? [])].filter(
      (className) => !/^vp-section-align-(left|center|right)$/.test(className),
    ),
  );
  const mergedClasses = uniqueClassNames([
    ...gridAlignmentClasses,
    ...mergedNonAlignmentClasses,
    hero.layout === 'centered' ? 'vp-card-grid-intro-centered' : '',
  ]);
  // is-style-asterisk implies a centered, decorated card grid in WordPress
  const customClassNames = uniqueClassNames([
    ...mergedClasses,
    mergedClasses.includes('is-style-asterisk')
      ? 'vp-card-grid-intro-centered'
      : '',
  ]);

  return {
    ...grid,
    title: hero.heading || grid.title,
    subtitle: hero.subheading || grid.subtitle,
    sourceRef: node.sourceRef ?? grid.sourceRef,
    customClassNames:
      customClassNames.length > 0 ? customClassNames : undefined,
    background: grid.background ?? hero.background,
    textColor: grid.textColor ?? hero.textColor,
  };
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
  if (typeof topLevelIndex !== 'number') {
    return type;
  }
  return `${type}-${topLevelIndex}`;
}

// ── helpers: recognise group intent ────────────────────────────────────────

function isHeroGroup(children: WpNode[]): boolean {
  const meaningfulChildren = children.filter(
    (child) => !isSpacerBlock(child.block),
  );
  const headings = meaningfulChildren.filter(
    (c) => c.block === 'core/heading' || c.block === 'heading',
  );
  const hasH1OrH2 = headings.some((c) => c.level === 1 || c.level === 2);
  // Accept a sole heading of any level when no columns are present (e.g. H3-led intro)
  const hasSoleHeading = headings.length === 1;
  const hasHeading = hasH1OrH2 || hasSoleHeading;
  const hasPara = meaningfulChildren.some(
    (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
  );
  const hasDirectColumns = meaningfulChildren.some(
    (c) => c.block === 'core/columns' || c.block === 'columns',
  );
  return hasHeading && hasPara && !hasDirectColumns;
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
  const flat = flattenChildren({ children } as WpNode);
  const paragraphCandidates = collectParagraphCandidates(groupNode);
  if (paragraphCandidates.length === 0) return null;

  const quoteCandidate = selectQuoteCandidate(paragraphCandidates);
  if (!quoteCandidate) return null;

  const supportingCandidates = paragraphCandidates.filter(
    (candidate) => candidate !== quoteCandidate,
  );
  const avatarNode = flat.find(
    (node) =>
      (node.block === 'core/image' || node.block === 'image') && node.src,
  );
  if (supportingCandidates.length === 0 && !avatarNode?.src) return null;

  const quote = cleanTestimonialQuote(quoteCandidate.text);
  if (!quote) return null;

  const authorNameCandidate = selectAuthorNameCandidate(
    supportingCandidates,
    quoteCandidate.order,
  );
  const authorTitleCandidate = selectAuthorTitleCandidate(
    supportingCandidates,
    quoteCandidate.order,
    authorNameCandidate?.order,
  );
  const authorName = authorNameCandidate?.text ?? '';
  const authorTitle = authorTitleCandidate?.text;

  const section: TestimonialSection = {
    type: 'testimonial',
    quote,
    authorName,
    authorTitle,
    ...(avatarNode?.src ? { authorAvatar: avatarNode.src } : {}),
    ...(avatarNode?.customClassNames?.length
      ? {
          authorAvatarCustomClassNames: uniqueClassNames(
            avatarNode.customClassNames,
          ),
        }
      : {}),
  };
  const quoteCustomClassNames = extractStyleVariantClassNames(
    quoteCandidate.node.customClassNames,
  );
  if (quoteCustomClassNames.length > 0) {
    section.quoteCustomClassNames = quoteCustomClassNames;
  }
  const authorCustomClassNames = uniqueClassNames([
    ...extractStyleVariantClassNames(
      authorNameCandidate?.node.customClassNames,
    ),
    ...extractStyleVariantClassNames(
      authorTitleCandidate?.node.customClassNames,
    ),
  ]);
  if (authorCustomClassNames.length > 0) {
    section.authorCustomClassNames = authorCustomClassNames;
  }
  const contentAlign = inferSectionAlignment(groupNode, children);
  if (contentAlign) section.contentAlign = contentAlign;
  return section;
}

type ParagraphCandidate = {
  node: WpNode;
  text: string;
  order: number;
};

function isLikelyTestimonialGroup(node: WpNode): boolean {
  const flat = flattenChildren(node);
  if (
    flat.some((child) =>
      ['core/heading', 'heading', 'core/query', 'query'].includes(child.block),
    )
  ) {
    return false;
  }

  const paragraphCandidates = collectParagraphCandidates(node);
  if (paragraphCandidates.length < 2) return false;

  const quoteCandidate = selectQuoteCandidate(paragraphCandidates);
  if (!quoteCandidate) return false;

  return paragraphCandidates.some((candidate) => {
    if (candidate === quoteCandidate) return false;
    return (
      looksLikePersonName(candidate.text) ||
      looksLikeAuthorDescriptor(candidate.text)
    );
  });
}

function collectParagraphCandidates(node: WpNode): ParagraphCandidate[] {
  return flattenChildren(node)
    .filter(
      (child) =>
        child.block === 'core/paragraph' || child.block === 'paragraph',
    )
    .map((child, order) => {
      const text = extractNodeText(child);
      return text ? { node: child, text, order } : null;
    })
    .filter((candidate): candidate is ParagraphCandidate => !!candidate);
}

function selectQuoteCandidate(
  candidates: ParagraphCandidate[],
): ParagraphCandidate | undefined {
  const quoted = candidates.find((candidate) => hasQuotedWrap(candidate.text));
  if (quoted) return quoted;

  const longParagraph = candidates.find((candidate) =>
    looksLikeLongFormQuote(candidate.text),
  );
  if (longParagraph) return longParagraph;

  return [...candidates]
    .filter((candidate) => candidate.text.length >= 48)
    .sort((left, right) => right.text.length - left.text.length)[0];
}

function selectAuthorNameCandidate(
  candidates: ParagraphCandidate[],
  quoteOrder: number,
): ParagraphCandidate | undefined {
  const ordered = prioritizeCandidatesAfterQuote(candidates, quoteOrder);
  const explicitName = ordered.find((candidate) =>
    looksLikePersonName(candidate.text),
  );
  if (explicitName) return explicitName;

  return ordered.find(
    (candidate) =>
      candidate.text.length <= 80 &&
      !looksLikeLongFormQuote(candidate.text) &&
      !looksLikeAuthorDescriptor(candidate.text),
  );
}

function selectAuthorTitleCandidate(
  candidates: ParagraphCandidate[],
  quoteOrder: number,
  authorNameOrder?: number,
): ParagraphCandidate | undefined {
  const ordered = prioritizeCandidatesAfterQuote(candidates, quoteOrder).filter(
    (candidate) => candidate.order !== authorNameOrder,
  );
  const descriptor = ordered.find((candidate) =>
    looksLikeAuthorDescriptor(candidate.text),
  );
  if (descriptor) return descriptor;

  return ordered.find(
    (candidate) =>
      candidate.text.length <= 120 && !looksLikeLongFormQuote(candidate.text),
  );
}

function prioritizeCandidatesAfterQuote(
  candidates: ParagraphCandidate[],
  quoteOrder: number,
): ParagraphCandidate[] {
  const afterQuote = candidates
    .filter((candidate) => candidate.order > quoteOrder)
    .sort((left, right) => left.order - right.order);
  if (afterQuote.length > 0) return afterQuote;
  return [...candidates].sort((left, right) => left.order - right.order);
}

function cleanTestimonialQuote(text: string): string {
  return text.replace(/^[\s"'“”‘’«»]+|[\s"'“”‘’«»]+$/g, '').trim();
}

function hasQuotedWrap(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^[“"‘'«]/.test(trimmed) || /[”"’'»]$/.test(trimmed);
}

function looksLikeLongFormQuote(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 48) return false;
  return (
    hasQuotedWrap(trimmed) || /[.!?…]/.test(trimmed) || trimmed.length >= 80
  );
}

function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/[,:;.!?()]/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return false;
  return parts.every(
    (part) =>
      /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(part) &&
      part !== part.toLowerCase(),
  );
}

function looksLikeAuthorDescriptor(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (looksLikeLongFormQuote(trimmed)) return false;
  return /,| at | @ | founder|ceo|cto|co-founder|manager|director|lead|owner|team|company|studio|agency|inc|llc/i.test(
    trimmed,
  );
}

function buildGroupedCardGrid(children: WpNode[]): CardGridSection | null {
  let title: string | undefined;
  let subtitle: string | undefined;
  let titleCustomClassNames: string[] | undefined;
  let subtitleCustomClassNames: string[] | undefined;
  let columnCount: 2 | 3 | 4 = 3;
  const cards: Array<{
    heading: string;
    body: string;
    headingCustomClassNames?: string[];
    bodyCustomClassNames?: string[];
  }> = [];
  let foundCardGrid = false;

  for (const child of children) {
    const block = child.block;

    if (
      !foundCardGrid &&
      (block === 'core/heading' || block === 'heading') &&
      child.text
    ) {
      title ??= child.text;
      titleCustomClassNames ??= extractStyleVariantClassNames(
        child.customClassNames,
      );
      continue;
    }

    if (
      !foundCardGrid &&
      (block === 'core/paragraph' || block === 'paragraph') &&
      child.text
    ) {
      subtitle ??= child.text;
      subtitleCustomClassNames ??= extractStyleVariantClassNames(
        child.customClassNames,
      );
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
  if (titleCustomClassNames?.length) {
    section.titleCustomClassNames = titleCustomClassNames;
  }
  if (subtitle) section.subtitle = subtitle;
  if (subtitleCustomClassNames?.length) {
    section.subtitleCustomClassNames = subtitleCustomClassNames;
  }
  // Presence of intro heading + subtitle with a card grid often indicates a
  // centered section layout in WordPress — pre-mark it so the generator picks
  // up centered intro styling without waiting for the outer node alignment pass.
  if (title && subtitle) {
    section.customClassNames = ['vp-card-grid-intro-centered'];
  }
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
    heading: h ? extractNodeText(h) : '',
  };
  const headingCustomClassNames = extractStyleVariantClassNames(
    h?.customClassNames,
  );
  if (headingCustomClassNames.length > 0) {
    s.headingCustomClassNames = headingCustomClassNames;
  }
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  const richSubheading = extractRichTextFromNodes(flat);
  if (richSubheading) s.subheading = richSubheading;
  const subheadingCustomClassNames = extractStyleVariantClassNames(
    p?.customClassNames,
  );
  if (subheadingCustomClassNames.length > 0) {
    s.subheadingCustomClassNames = subheadingCustomClassNames;
  }
  if (p?.typography || p?.fontFamily) s.subheadingStyle = toTypographyStyle(p);
  applySectionCtas(s, children);
  if (img?.src)
    s.image = {
      src: img.src,
      alt: img.alt ?? '',
      position: 'right',
      ...(img.customClassNames?.length
        ? { customClassNames: uniqueClassNames(img.customClassNames) }
        : {}),
    };
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
  const attrAlign =
    normalizeHorizontalAlign(node.textAlign) ??
    normalizeHorizontalAlign(node.justifyContent) ??
    normalizeHorizontalAlign(node.align) ??
    normalizeHorizontalAlign(node.params?.textAlign) ??
    normalizeHorizontalAlign(node.params?.contentPosition) ??
    normalizeHorizontalAlign(node.params?.layout?.justifyContent) ??
    normalizeHorizontalAlign(node.params?.align) ??
    normalizeHorizontalAlign(node.params?.layout?.horizontalAlignment);

  if (attrAlign) return attrAlign;

  // WordPress alignment utility classes (e.g. "has-text-align-center", "aligncenter")
  for (const cls of node.customClassNames ?? []) {
    const c = cls.trim().toLowerCase();
    if (c === 'has-text-align-center' || c === 'aligncenter') return 'center';
    if (c === 'has-text-align-right' || c === 'alignright') return 'right';
    if (c === 'has-text-align-left' || c === 'alignleft') return 'left';
  }

  return undefined;
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
        heading: h ? extractNodeText(h) : '',
        body: extractRichTextFromNodes(flat),
        ...(extractStyleVariantClassNames(h?.customClassNames).length
          ? {
              headingCustomClassNames: extractStyleVariantClassNames(
                h?.customClassNames,
              ),
            }
          : {}),
        ...(extractStyleVariantClassNames(
          flat.find(
            (c) => c.block === 'core/paragraph' || c.block === 'paragraph',
          )?.customClassNames,
        ).length
          ? {
              bodyCustomClassNames: extractStyleVariantClassNames(
                flat.find(
                  (c) =>
                    c.block === 'core/paragraph' || c.block === 'paragraph',
                )?.customClassNames,
              ),
            }
          : {}),
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
    ...(imgNode.customClassNames?.length
      ? {
          imageCustomClassNames: uniqueClassNames(imgNode.customClassNames),
        }
      : {}),
  };
  const columnWidths = cols
    .map((col) => normalizeCssLength(col.columnWidth))
    .filter((value): value is string => !!value);
  if (columnWidths.length === cols.length) s.columnWidths = columnWidths;
  if (h?.text) s.heading = h.text;
  const mediaHeadingCustomClassNames = extractStyleVariantClassNames(
    h?.customClassNames,
  );
  if (mediaHeadingCustomClassNames.length > 0) {
    s.headingCustomClassNames = mediaHeadingCustomClassNames;
  }
  if (h?.typography || h?.fontFamily) s.headingStyle = toTypographyStyle(h);
  const richBody = extractRichTextFromNodes(textFlat);
  if (richBody) s.body = richBody;
  const mediaBodyCustomClassNames = extractStyleVariantClassNames(
    p?.customClassNames,
  );
  if (mediaBodyCustomClassNames.length > 0) {
    s.bodyCustomClassNames = mediaBodyCustomClassNames;
  }
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

const POST_DETAIL_LAYOUT_BLOCKS = new Set<string>([
  ...POST_CONTENT_BLOCKS,
  'core/post-date',
  'post-date',
  'core/post-author-name',
  'post-author-name',
  'core/post-author-biography',
  'post-author-biography',
  'core/post-terms',
  'post-terms',
  'core/comments',
  'comments',
  'core/comment-template',
  'comment-template',
  'core/comments-title',
  'comments-title',
  'core/post-comments-form',
  'post-comments-form',
  'core/comments-pagination',
  'comments-pagination',
]);

const SIDEBAR_WIDGET_BLOCKS = new Set<string>([
  'core/template-part',
  'template-part',
  'core/search',
  'search',
  'core/categories',
  'categories',
  'core/avatar',
  'avatar',
  'core/navigation',
  'navigation',
]);

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
  if (
    (node.block === 'core/group' || node.block === 'group') &&
    node.children
  ) {
    return isButtonOnlyGroup(node.children);
  }
  return false;
}

/**
 * A CTA banner group has buttons and a heading but no columns.
 * A background color or full/wide alignment confirms it is a standalone CTA
 * strip rather than a normal hero section.
 */
function isCtaBannerGroup(node: WpNode, children: WpNode[]): boolean {
  const meaningful = children.filter((c) => !isSpacerBlock(c.block));
  const hasButtons = meaningful.some(
    (c) =>
      isButtonBlock(c.block) ||
      c.block === 'core/buttons' ||
      c.block === 'buttons',
  );
  if (!hasButtons) return false;
  const hasColumns = meaningful.some(
    (c) => c.block === 'core/columns' || c.block === 'columns',
  );
  if (hasColumns) return false;
  const hasBg = !!(
    node.bgColor ||
    (node.params?.backgroundColor as string | undefined) ||
    (node.params?.gradient as string | undefined) ||
    (node.params?.style as Record<string, unknown> | undefined)?.color
  );
  const isWideOrFull =
    node.params?.align === 'full' || node.params?.align === 'wide';
  return hasBg || isWideOrFull;
}

function buildCtaBannerSection(
  node: WpNode,
  children: WpNode[],
): CtaStripSection {
  const ctas = buildSectionCtas(children);
  const align = inferSectionAlignment(node, children);
  const s: CtaStripSection = {
    type: 'cta-strip',
    ...(align ? { align } : {}),
  };
  if (ctas[0]) s.cta = ctas[0];
  if (ctas.length > 1) s.ctas = ctas;
  return s;
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

function extractStyleVariantClassNames(values?: string[]): string[] {
  return uniqueClassNames(
    (values ?? []).filter((value) => /^is-style-/i.test(value.trim())),
  );
}
