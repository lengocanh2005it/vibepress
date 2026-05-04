import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import type {
  ColorPalette,
  CommentsSection,
  ComponentVisualPlan,
  FooterSection,
  LayoutTokens,
  NavbarSection,
  PageContentSection,
  ProseBlockSection,
  PostContentSection,
  PostFeaturedImageSection,
  PostListSection,
  PostMetaSection,
  PostNavigationSection,
  PostTermsSection,
  PostTitleSection,
  SearchSection,
  SectionPlan,
  SidebarSection,
  SourceSegment,
  TypographyTokens,
  VisualPlanLockPolicy,
  VisualPlanRenderAuthority,
} from '../react-generator/visual-plan.schema.js';
import { toVisualDataNeeds } from '../shared/visual-data-needs.util.js';
import { assessDeterministicRenderAuthority } from './deterministic-render-authority-policy.util.js';

const TRANSACTIONAL_TEMPLATE_NAMES = new Set([
  'cart',
  'checkout',
  'my-account',
  'order-pay',
  'order-received',
]);

export interface BlockTreePlannerComponentPlan {
  templateName: string;
  componentName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  isDetail: boolean;
  fixedSlug?: string;
}

interface DetailShellInfo {
  hasSidebar: boolean;
  sidebarNodes?: BlockNode[];
  sidebarWidth?: string;
  sidebarPosition?: 'left' | 'right';
  sidebarColumnSourceNodeId?: string;
  shellPaddingStyle?: string;
  shellMarginStyle?: string;
  shellGapStyle?: string;
  shellSourceRef?: BlockNode['sourceRef'];
  shellCustomClassNames?: string[];
}

interface SidebarShellPresentation {
  paddingStyle?: string;
  marginStyle?: string;
  gapStyle?: string;
  sourceRef?: BlockNode['sourceRef'];
  customClassNames?: string[];
}

export interface BuildBlockTreeDrivenVisualPlanInput {
  componentPlan: BlockTreePlannerComponentPlan;
  draftSections?: SectionPlan[];
  draftBlockTree?: BlockNode[];
  content: DbContentResult;
  tokens: ThemeTokens | undefined;
  globalPalette: ColorPalette;
  globalTypography: TypographyTokens;
  deriveComponentLayout: (
    tokens: ThemeTokens | undefined,
    componentName: string,
    isDetailPage?: boolean,
  ) => LayoutTokens;
  buildRichBoundPageDetailSections: (
    componentPlan: BlockTreePlannerComponentPlan,
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
  ) => SectionPlan[] | undefined;
  buildBoundPageContentFallbackSection: (
    componentPlan: BlockTreePlannerComponentPlan,
    content: DbContentResult,
    showTitle: boolean,
  ) => PageContentSection;
}

export function buildBlockTreeDrivenVisualPlanForComponent(
  input: BuildBlockTreeDrivenVisualPlanInput,
): ComponentVisualPlan | undefined {
  const { componentPlan, draftSections, draftBlockTree, content, tokens } =
    input;
  if (!draftBlockTree?.length) return undefined;

  const dataNeeds = toVisualDataNeeds(componentPlan.dataNeeds);
  const layout = input.deriveComponentLayout(
    tokens,
    componentPlan.componentName,
    componentPlan.isDetail === true && componentPlan.route !== '/',
  );
  const authorityAssessment = assessDeterministicRenderAuthority({
    componentPlan,
    draftBlockTree,
    draftSections,
  });
  const renderAuthority = authorityAssessment.renderAuthority;
  const lockPolicy = buildDeterministicLockPolicy(authorityAssessment.reason);
  const base = {
    componentName: componentPlan.componentName,
    dataNeeds,
    palette: input.globalPalette,
    typography: input.globalTypography,
    layout,
    blockStyles: tokens?.blockStyles,
  } as const;
  const authorityDecorators =
    componentPlan.type === 'partial'
      ? {
          deterministicAuthority: true,
          renderAuthority,
          lockPolicy,
        }
      : {
          renderAuthority: 'ai' as const,
        };

  if (isEligibleBlockTreeSharedPartial(componentPlan)) {
    const sections = buildBlockTreeDrivenSharedPartialSections({
      componentPlan,
      draftBlockTree,
      draftSections,
      content,
    });
    if (sections.length > 0) {
      return {
        ...base,
        ...authorityDecorators,
        renderMode: 'block-centric',
        sections,
      };
    }
  }

  if (
    componentPlan.type === 'page' &&
    componentPlan.isDetail === true &&
    componentPlan.fixedSlug &&
    dataNeeds.includes('pageDetail')
  ) {
    const result = buildBlockTreeDrivenBoundPageDetailSections({
      componentPlan,
      draftBlockTree,
      content,
      tokens,
      deriveComponentLayout: input.deriveComponentLayout,
      buildRichBoundPageDetailSections: input.buildRichBoundPageDetailSections,
      buildBoundPageContentFallbackSection:
        input.buildBoundPageContentFallbackSection,
    });
    if (result) {
      return {
        ...base,
        ...authorityDecorators,
        layout: result.layout ?? layout,
        sections: result.sections,
      };
    }
  }

  const normalizedTemplate = normalizeTemplateIdentifier(
    componentPlan.templateName,
  );
  if (
    componentPlan.type === 'page' &&
    componentPlan.isDetail === true &&
    dataNeeds.includes('postDetail') &&
    /^(single|single-with-sidebar)$/.test(normalizedTemplate)
  ) {
    const result = buildBlockTreeDrivenPostDetailSections({
      componentPlan,
      draftBlockTree,
      content,
      layout,
    });
    if (result) {
      return {
        ...base,
        ...authorityDecorators,
        layout: result.layout ?? layout,
        sections: result.sections,
      };
    }
  }

  if (
    componentPlan.type === 'page' &&
    componentPlan.isDetail !== true &&
    isEligibleBlockTreeListingTemplate(componentPlan, draftBlockTree)
  ) {
    const result = buildBlockTreeDrivenListingSections({
      componentPlan,
      draftBlockTree,
      draftSections,
      content,
      layout,
    });
    if (result?.sections?.length) {
      return {
        ...base,
        ...authorityDecorators,
        layout: result.layout ?? layout,
        sections: result.sections,
      };
    }
  }

  if (
    componentPlan.type === 'page' &&
    componentPlan.isDetail !== true &&
    isEligibleBlockTreeTransactionalTemplate(componentPlan, draftBlockTree)
  ) {
    const sections = buildBlockTreeDrivenTransactionalSections({
      draftBlockTree,
      draftSections,
    });
    if (sections?.length) {
      return {
        ...base,
        ...authorityDecorators,
        sections,
      };
    }
  }

  return undefined;
}

export function shouldBypassCoverageAuditForBlockTreeListingPlan(
  componentPlan: BlockTreePlannerComponentPlan,
  sections: SectionPlan[],
): boolean {
  if (
    componentPlan.type !== 'page' ||
    componentPlan.isDetail === true ||
    !toVisualDataNeeds(componentPlan.dataNeeds).includes('posts')
  ) {
    return false;
  }
  return sections.some(
    (section) => section.type === 'post-list' || section.type === 'search',
  );
}

export function shouldShortCircuitBlockTreeVisualPlan(
  componentPlan: BlockTreePlannerComponentPlan,
  draftBlockTree?: BlockNode[],
): boolean {
  return (
    isEligibleBlockTreeSharedPartial(componentPlan) ||
    isEligibleBlockTreeListingTemplate(componentPlan, draftBlockTree) ||
    isEligibleTransactionalTemplateByName(componentPlan) ||
    isEligibleTransactionalByComponentName(componentPlan)
  );
}

function isEligibleBlockTreeSharedPartial(
  componentPlan: BlockTreePlannerComponentPlan,
): boolean {
  if (componentPlan.type !== 'partial') return false;
  return /^(header|footer|navigation|nav|sidebar|postmeta)$/i.test(
    componentPlan.componentName,
  );
}

function buildDeterministicLockPolicy(reason: string): VisualPlanLockPolicy {
  return {
    bypassAiGeneration: true,
    bypassAiReviewRewrite: true,
    allowAiFixModes: ['syntax-only'],
    reason,
  };
}

function buildBlockTreeDrivenSharedPartialSections(input: {
  componentPlan: BlockTreePlannerComponentPlan;
  draftBlockTree: BlockNode[];
  draftSections?: SectionPlan[];
  content: DbContentResult;
}): SectionPlan[] {
  const { componentPlan, draftBlockTree, draftSections, content } = input;
  const explicitChromeSections = (draftSections ?? []).filter(
    (section) => section.type === 'navbar' || section.type === 'footer',
  );
  if (explicitChromeSections.length > 0) {
    return explicitChromeSections;
  }

  const orderedNodes = collectBlockNodesInOrder(draftBlockTree);
  const normalizedName = componentPlan.componentName.toLowerCase();

  if (/^(header|navigation|nav)$/.test(normalizedName)) {
    const navigationNode = orderedNodes.find(
      (node) => node.kind === 'navigation',
    );
    const section: NavbarSection = {
      type: 'navbar',
      sticky: false,
      menuSlug: content.menus[0]?.slug ?? 'primary',
      orientation:
        navigationNode?.menuOrientation ??
        readLayoutOrientation(navigationNode) ??
        'horizontal',
      overlayMenu: navigationNode?.overlayMenu ?? 'mobile',
      isResponsive: navigationNode?.isResponsive ?? true,
      ...(navigationNode?.sourceRef
        ? { sourceRef: navigationNode.sourceRef }
        : {}),
      debugKey: 'navbar-0',
    };
    return [section];
  }

  if (/^footer$/.test(normalizedName)) {
    const footerColumnsNode = orderedNodes.find(
      (node) => node.kind === 'columns',
    );
    const supplementalImages = orderedNodes
      .filter(
        (node) =>
          node.kind === 'image' &&
          typeof node.src === 'string' &&
          node.src.trim(),
      )
      .map((node) => ({
        src: node.src!.trim(),
        ...(node.alt?.trim() ? { alt: node.alt.trim() } : {}),
        ...(node.customClassNames?.length
          ? { customClassNames: [...new Set(node.customClassNames)] }
          : {}),
      }));
    const section: FooterSection = {
      type: 'footer',
      menuColumns: inferFooterMenuColumnsFromBlockTree(orderedNodes),
      ...(supplementalImages.length > 0 ? { supplementalImages } : {}),
      showSiteLogo: orderedNodes.some((node) => node.kind === 'site-logo'),
      showSiteTitle: orderedNodes.some((node) => node.kind === 'site-title'),
      showTagline: orderedNodes.some((node) => node.kind === 'site-tagline'),
      ...(footerColumnsNode?.children?.length
        ? {
            columnWidths: footerColumnsNode.children
              .map((child) => child.columnWidth?.trim())
              .filter((value): value is string => !!value),
          }
        : {}),
      ...(footerColumnsNode?.sourceRef
        ? { sourceRef: footerColumnsNode.sourceRef }
        : {}),
      debugKey: 'footer-0',
    };
    return [section];
  }

  if (/^postmeta$/.test(normalizedName)) {
    const orderedNodes = collectBlockNodesInOrder(draftBlockTree);
    const stats = collectPostDetailBlockStats(orderedNodes);
    if (!stats.hasMetaSection) return [];
    const section: PostMetaSection = {
      type: 'post-meta',
      layout: 'inline',
      showAuthor: stats.hasAuthor,
      showDate: stats.hasDate,
      showCategories: stats.hasCategoryTerms,
      ...(stats.metaNode?.sourceRef
        ? { sourceRef: stats.metaNode.sourceRef }
        : {}),
      ...(stats.metaNode?.customClassNames?.length
        ? { customClassNames: [...stats.metaNode.customClassNames] }
        : {}),
      debugKey: 'post-meta-0',
      sectionKey: 'post-meta-0',
    };
    return [section];
  }

  if (/^sidebar$/.test(normalizedName)) {
    return [buildSidebarSectionFromBlockTree(draftBlockTree, content)];
  }

  return [];
}

function inferFooterMenuColumnsFromBlockTree(
  nodes: BlockNode[],
): FooterSection['menuColumns'] {
  const groups = nodes.filter((node) => node.kind === 'group');
  const result: NonNullable<FooterSection['menuColumns']> = [];
  for (const group of groups) {
    const titleNode = (group.children ?? []).find(
      (child) => child.kind === 'heading',
    );
    const navNode = (group.children ?? []).find((child) =>
      containsKind(child, 'navigation'),
    );
    const title = titleNode?.text?.trim();
    if (!title || !navNode) continue;
    result.push({
      title,
      menuSlug: slugifyLabel(title),
    });
  }
  return result;
}

function containsKind(node: BlockNode, kind: string): boolean {
  if (node.kind === kind) return true;
  return (node.children ?? []).some((child) => containsKind(child, kind));
}

function readLayoutOrientation(
  node: BlockNode | undefined,
): 'horizontal' | 'vertical' | undefined {
  const orientation = node?.attrs?.layout as
    | { orientation?: 'horizontal' | 'vertical' }
    | undefined;
  return orientation?.orientation;
}

function slugifyLabel(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isEligibleBlockTreeListingTemplate(
  componentPlan: BlockTreePlannerComponentPlan,
  draftBlockTree?: BlockNode[],
): boolean {
  if (componentPlan.type !== 'page' || componentPlan.isDetail === true) {
    return false;
  }
  const dataNeeds = toVisualDataNeeds(componentPlan.dataNeeds);
  if (!dataNeeds.includes('posts')) {
    return false;
  }
  const normalizedTemplate = normalizeTemplateIdentifier(
    componentPlan.templateName,
  );
  if (['archive', 'index', 'search'].includes(normalizedTemplate)) {
    return true;
  }

  if (!draftBlockTree?.length) {
    return false;
  }

  const shell = inspectDetailShellFromBlockTree(draftBlockTree);
  if (!shell.hasSidebar) {
    return false;
  }

  const mainNodes = collectBlockNodesInOrder(
    draftBlockTree,
    shell.sidebarColumnSourceNodeId
      ? new Set([shell.sidebarColumnSourceNodeId])
      : undefined,
  );

  return mainNodes.some((node) =>
    ['query', 'latest-posts'].includes(node.kind),
  );
}

function isEligibleBlockTreeTransactionalTemplate(
  componentPlan: BlockTreePlannerComponentPlan,
  draftBlockTree: BlockNode[],
): boolean {
  if (componentPlan.type !== 'page' || componentPlan.isDetail === true) {
    return false;
  }

  if (isEligibleTransactionalTemplateByName(componentPlan)) {
    return true;
  }

  return hasTransactionalCommerceBlocks(draftBlockTree);
}

function isEligibleTransactionalTemplateByName(
  componentPlan: BlockTreePlannerComponentPlan,
): boolean {
  const normalizedTemplate = normalizeTemplateIdentifier(
    componentPlan.templateName,
  );
  return TRANSACTIONAL_TEMPLATE_NAMES.has(normalizedTemplate);
}

// Classic themes and non-WooCommerce-FSE themes don't register cart/checkout as
// named FSE templates — the pages are plain WP pages with shortcodes. Detect by
// componentName so transactional short-circuit still fires regardless of theme.
function isEligibleTransactionalByComponentName(
  componentPlan: BlockTreePlannerComponentPlan,
): boolean {
  if (componentPlan.type !== 'page') return false;
  const normalizedName = componentPlan.componentName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return TRANSACTIONAL_TEMPLATE_NAMES.has(normalizedName);
}

function hasTransactionalCommerceBlocks(nodes: BlockNode[]): boolean {
  const transactionalBlockPattern =
    /^woocommerce\/(cart|checkout|my-account|order-pay|order-received)(?:$|-)/i;
  return collectBlockNodesInOrder(nodes).some((node) =>
    transactionalBlockPattern.test(node.blockName),
  );
}

function buildBlockTreeDrivenTransactionalSections(input: {
  draftBlockTree: BlockNode[];
  draftSections?: SectionPlan[];
}): SectionPlan[] | undefined {
  const preferredDraftSections = (input.draftSections ?? []).filter(
    isUsableTransactionalSection,
  );
  if (preferredDraftSections.length > 0) {
    return preferredDraftSections;
  }

  const fallbackSection = buildTransactionalFallbackProseSection(
    input.draftBlockTree,
  );
  return fallbackSection ? [fallbackSection] : undefined;
}

function isUsableTransactionalSection(section: SectionPlan): boolean {
  switch (section.type) {
    case 'navbar':
    case 'footer':
    case 'page-content':
    case 'post-content':
    case 'post-title':
    case 'post-featured-image':
    case 'post-meta':
    case 'post-terms':
    case 'post-navigation':
    case 'comments':
    case 'sidebar':
      return false;
    case 'prose-block':
      return (
        Array.isArray(section.sourceSegments) &&
        section.sourceSegments.length > 0
      );
    case 'hero':
      return (
        typeof section.heading === 'string' && section.heading.trim().length > 0
      );
    case 'cover':
      return (
        (typeof section.heading === 'string' &&
          section.heading.trim().length > 0) ||
        (typeof section.subheading === 'string' &&
          section.subheading.trim().length > 0) ||
        (typeof section.imageSrc === 'string' &&
          section.imageSrc.trim().length > 0)
      );
    case 'media-text':
      return Boolean(
        (typeof section.heading === 'string' &&
          section.heading.trim().length > 0) ||
        (typeof section.body === 'string' && section.body.trim().length > 0) ||
        (typeof section.imageSrc === 'string' &&
          section.imageSrc.trim().length > 0) ||
        section.listItems?.length,
      );
    case 'cta-strip':
      return Boolean(
        (typeof section.heading === 'string' &&
          section.heading.trim().length > 0) ||
        (typeof section.subheading === 'string' &&
          section.subheading.trim().length > 0) ||
        section.cta ||
        (section.ctas?.length ?? 0) > 0,
      );
    case 'testimonial':
      return Boolean(
        (typeof section.quote === 'string' &&
          section.quote.trim().length > 0) ||
        (typeof section.authorName === 'string' &&
          section.authorName.trim().length > 0),
      );
    case 'card-grid':
      return section.cards.some(
        (card) =>
          (typeof card.heading === 'string' &&
            card.heading.trim().length > 0) ||
          (typeof card.body === 'string' && card.body.trim().length > 0) ||
          (typeof card.imageSrc === 'string' &&
            card.imageSrc.trim().length > 0),
      );
    case 'accordion':
      return section.items.some(
        (item) =>
          (typeof item.heading === 'string' &&
            item.heading.trim().length > 0) ||
          (typeof item.body === 'string' && item.body.trim().length > 0),
      );
    case 'tabs':
      return section.tabs.some(
        (tab) =>
          (typeof tab.label === 'string' && tab.label.trim().length > 0) ||
          (typeof tab.heading === 'string' && tab.heading.trim().length > 0) ||
          (typeof tab.body === 'string' && tab.body.trim().length > 0) ||
          (typeof tab.imageSrc === 'string' && tab.imageSrc.trim().length > 0),
      );
    case 'carousel':
      return section.slides.some(
        (slide) =>
          (typeof slide.heading === 'string' &&
            slide.heading.trim().length > 0) ||
          (typeof slide.subheading === 'string' &&
            slide.subheading.trim().length > 0) ||
          (typeof slide.imageSrc === 'string' &&
            slide.imageSrc.trim().length > 0),
      );
    case 'modal':
      return Boolean(
        (typeof section.triggerText === 'string' &&
          section.triggerText.trim().length > 0) ||
        (typeof section.heading === 'string' &&
          section.heading.trim().length > 0) ||
        (typeof section.body === 'string' && section.body.trim().length > 0) ||
        (typeof section.imageSrc === 'string' &&
          section.imageSrc.trim().length > 0),
      );
    default:
      return true;
  }
}

function buildTransactionalFallbackProseSection(
  draftBlockTree: BlockNode[],
): ProseBlockSection | undefined {
  const segments = collectTransactionalSourceSegments(draftBlockTree);
  const fallbackSegments =
    segments.length > 0
      ? segments
      : buildTransactionalPlaceholderSegments(draftBlockTree);
  if (fallbackSegments.length === 0) return undefined;

  const sourceRef =
    fallbackSegments.find((segment) => segment.sourceRef)?.sourceRef ??
    collectBlockNodesInOrder(draftBlockTree).find((node) => node.sourceRef)
      ?.sourceRef;
  const customClassNames = Array.from(
    new Set(
      collectBlockNodesInOrder(draftBlockTree).flatMap(
        (node) => node.customClassNames ?? [],
      ),
    ),
  );

  return {
    type: 'prose-block',
    shellVariant: 'wide',
    sourceSegments: fallbackSegments,
    ...(sourceRef ? { sourceRef } : {}),
    ...(customClassNames.length > 0 ? { customClassNames } : {}),
    debugKey: 'commerce-flow-0',
    sectionKey: 'commerce-flow-0',
  };
}

function buildTransactionalPlaceholderSegments(
  nodes: BlockNode[],
): SourceSegment[] {
  const transactionalNodes = collectBlockNodesInOrder(nodes).filter((node) =>
    /^woocommerce\/(cart|checkout|my-account|order-pay|order-received)(?:$|-)/i.test(
      node.blockName,
    ),
  );
  if (transactionalNodes.length === 0) return [];

  const labels = Array.from(
    new Set(
      transactionalNodes
        .map((node) => humanizeTransactionalBlockName(node.blockName))
        .filter((label): label is string => Boolean(label)),
    ),
  ).slice(0, 6);
  if (labels.length === 0) return [];

  return labels.map((label, index) => {
    const sourceRef = transactionalNodes[index]?.sourceRef;
    if (index === 0) {
      return {
        type: 'heading',
        text: label,
        level: 2,
        ...(sourceRef ? { sourceRef } : {}),
      } satisfies SourceSegment;
    }
    return {
      type: 'paragraph',
      text: label,
      html: label,
      ...(sourceRef ? { sourceRef } : {}),
    } satisfies SourceSegment;
  });
}

function humanizeTransactionalBlockName(blockName: string): string | null {
  const normalized = String(blockName ?? '')
    .trim()
    .toLowerCase();
  if (!normalized.startsWith('woocommerce/')) return null;
  const slug = normalized.replace(/^woocommerce\//, '');
  const label = slug
    .replace(/-block$/i, '')
    .replace(/-/g, ' ')
    .trim();
  if (!label) return null;
  return label.replace(/\b\w/g, (char) => char.toUpperCase());
}

function collectTransactionalSourceSegments(
  nodes: BlockNode[],
): SourceSegment[] {
  const segments: SourceSegment[] = [];
  const visit = (node: BlockNode) => {
    if (isIgnoredTransactionalNode(node)) {
      return;
    }

    const directSegment = toTransactionalSourceSegment(node);
    if (directSegment) {
      segments.push(directSegment);
      return;
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return segments;
}

function isIgnoredTransactionalNode(node: BlockNode): boolean {
  return [
    'template-part',
    'navigation',
    'site-title',
    'site-tagline',
    'site-logo',
  ].includes(node.kind);
}

function toTransactionalSourceSegment(
  node: BlockNode,
): SourceSegment | undefined {
  const customClassNames = node.customClassNames?.length
    ? [...new Set(node.customClassNames)]
    : undefined;

  if (
    node.kind === 'heading' &&
    typeof node.text === 'string' &&
    node.text.trim()
  ) {
    return {
      type: 'heading',
      text: node.text.trim(),
      ...(typeof node.html === 'string' && node.html.trim()
        ? { html: node.html.trim() }
        : {}),
      ...(typeof node.level === 'number' ? { level: node.level } : {}),
      ...(customClassNames ? { customClassNames } : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  if (
    node.kind === 'image' &&
    typeof node.src === 'string' &&
    node.src.trim()
  ) {
    return {
      type: 'image',
      src: node.src,
      ...(typeof node.alt === 'string' && node.alt.trim()
        ? { alt: node.alt.trim() }
        : {}),
      ...(typeof node.width === 'number' ? { width: node.width } : {}),
      ...(typeof node.height === 'number' ? { height: node.height } : {}),
      ...(customClassNames ? { customClassNames } : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  if (typeof node.text === 'string' && node.text.trim()) {
    return {
      type: 'paragraph',
      text: node.text.trim(),
      html:
        typeof node.html === 'string' && node.html.trim()
          ? node.html.trim()
          : node.text.trim(),
      ...(customClassNames ? { customClassNames } : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  if (
    (!node.children || node.children.length === 0) &&
    typeof node.html === 'string' &&
    node.html.trim()
  ) {
    return {
      type: 'html',
      html: node.html.trim(),
      ...(customClassNames ? { customClassNames } : {}),
      ...(node.sourceRef ? { sourceRef: node.sourceRef } : {}),
    };
  }

  return undefined;
}

function buildBlockTreeDrivenListingSections(input: {
  componentPlan: BlockTreePlannerComponentPlan;
  draftBlockTree: BlockNode[];
  draftSections?: SectionPlan[];
  content: DbContentResult;
  layout: LayoutTokens;
}): { sections: SectionPlan[]; layout?: LayoutTokens } | undefined {
  const { componentPlan, draftBlockTree, draftSections } = input;
  if (!draftBlockTree.length) {
    return undefined;
  }

  const normalizedTemplate = normalizeTemplateIdentifier(
    componentPlan.templateName,
  );
  const shell = inspectDetailShellFromBlockTree(draftBlockTree);
  const orderedNodes = collectBlockNodesInOrder(
    draftBlockTree,
    shell.sidebarColumnSourceNodeId
      ? new Set([shell.sidebarColumnSourceNodeId])
      : undefined,
  );
  const queryNode = orderedNodes.find((node) =>
    ['query', 'latest-posts'].includes(node.kind),
  );
  const searchNode = orderedNodes.find((node) => node.kind === 'search');
  const queryTitleNode = orderedNodes.find(
    (node) => node.kind === 'query-title',
  );
  const hasQueryTitle = queryTitleNode != null;
  const patternNodes = orderedNodes.filter((node) => node.kind === 'pattern');

  const sections: SectionPlan[] = [];
  const leadCoverSections = (draftSections ?? []).filter(
    (section): section is Extract<SectionPlan, { type: 'cover' }> =>
      section.type === 'cover' &&
      !sectionBelongsToSourceSubtree(section, shell.sidebarColumnSourceNodeId),
  );
  sections.push(...leadCoverSections);

  const searchSection = draftSections?.find(
    (section): section is SearchSection => section.type === 'search',
  );
  if (
    normalizedTemplate === 'search' &&
    (searchSection || searchNode || queryTitleNode || patternNodes.length > 0)
  ) {
    sections.push(
      buildBlockTreeDrivenListingSearchSection({
        searchSection,
        searchNode,
        queryTitleNode,
        patternNodes,
        hasQueryTitle,
      }),
    );
  }

  const postListSection = draftSections?.find(
    (section): section is PostListSection => section.type === 'post-list',
  );
  if (postListSection) {
    sections.push({
      ...postListSection,
      ...(queryNode?.sourceRef && !postListSection.sourceRef
        ? { sourceRef: queryNode.sourceRef }
        : {}),
    });
  } else if (
    queryNode ||
    patternNodes.length > 0 ||
    ['archive', 'index', 'search'].includes(normalizedTemplate)
  ) {
    sections.push(
      buildBlockTreeDrivenListingFallbackSection(
        componentPlan,
        queryNode ?? patternNodes[patternNodes.length - 1] ?? queryTitleNode,
      ),
    );
  }

  if (shell.sidebarNodes?.length) {
    sections.push(
      buildSidebarSectionFromBlockTree(shell.sidebarNodes, input.content, {
        paddingStyle: shell.shellPaddingStyle,
        marginStyle: shell.shellMarginStyle,
        gapStyle: shell.shellGapStyle,
        sourceRef: shell.shellSourceRef,
        customClassNames: shell.shellCustomClassNames,
      }),
    );
  }

  if (sections.length === 0) {
    return undefined;
  }

  return {
    sections,
    layout: shell.hasSidebar
      ? {
          ...input.layout,
          contentLayout:
            shell.sidebarPosition === 'left' ? 'sidebar-left' : 'sidebar-right',
          sidebarWidth: shell.sidebarWidth ?? input.layout.sidebarWidth,
          sidebarScope: 'all-content',
        }
      : input.layout,
  };
}

function buildBlockTreeDrivenListingSearchSection(input: {
  searchSection?: SearchSection;
  searchNode?: BlockNode;
  queryTitleNode?: BlockNode;
  patternNodes: BlockNode[];
  hasQueryTitle: boolean;
}): SearchSection {
  const sourceRef =
    input.searchSection?.sourceRef ??
    pickFirstBlockSourceRef(
      input.searchNode,
      input.queryTitleNode,
      ...input.patternNodes,
    );
  return {
    type: 'search',
    ...(input.searchSection ? input.searchSection : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(input.hasQueryTitle ? { title: undefined } : {}),
    ...(input.searchSection?.obligation
      ? { obligation: input.searchSection.obligation }
      : {
          obligation: {
            role: 'search',
            required: ['search-input'],
          },
        }),
    debugKey: input.searchSection?.debugKey ?? 'search-0',
    sectionKey: input.searchSection?.sectionKey ?? 'search-0',
  };
}

function buildBlockTreeDrivenListingFallbackSection(
  componentPlan: BlockTreePlannerComponentPlan,
  queryNode?: BlockNode,
): PostListSection {
  const normalizedTemplate = normalizeTemplateIdentifier(
    componentPlan.templateName,
  );
  return {
    type: 'post-list',
    ...(normalizedTemplate === 'index' ? { title: 'Posts' } : {}),
    layout: 'grid-3',
    showDate: normalizedTemplate === 'index',
    showAuthor: normalizedTemplate === 'index',
    showCategory: normalizedTemplate === 'search',
    showExcerpt: true,
    showFeaturedImage: true,
    itemLayout: 'stacked',
    metaLayout: 'inline',
    metaAlign: 'start',
    metaSeparator: normalizedTemplate === 'search' ? 'dot' : 'dash',
    ...(queryNode?.sourceRef ? { sourceRef: queryNode.sourceRef } : {}),
    debugKey: 'post-list-0',
    sectionKey: 'post-list-0',
    obligation: {
      role: 'post-list',
      required: ['posts'],
      minItems: { posts: 1 },
    },
  };
}

function pickFirstBlockSourceRef(
  ...nodes: Array<BlockNode | undefined>
): BlockNode['sourceRef'] | undefined {
  for (const node of nodes) {
    if (node?.sourceRef) return node.sourceRef;
  }
  return undefined;
}

function sectionBelongsToSourceSubtree(
  section: SectionPlan,
  sourceNodeIdPrefix?: string,
): boolean {
  if (!sourceNodeIdPrefix?.trim()) {
    return false;
  }

  const matchesPrefix = (value: string | undefined): boolean =>
    typeof value === 'string' && value.startsWith(sourceNodeIdPrefix);

  if (
    matchesPrefix(section.sourceRef?.sourceNodeId) ||
    matchesPrefix(section.sourceRef?.parentSourceNodeId)
  ) {
    return true;
  }

  return (
    section.obligation?.sourceEvidence?.sourceNodeIds?.some((value) =>
      matchesPrefix(value),
    ) ?? false
  );
}

function buildBlockTreeDrivenPostDetailSections(input: {
  componentPlan: BlockTreePlannerComponentPlan;
  draftBlockTree: BlockNode[];
  content: DbContentResult;
  layout: LayoutTokens;
}): { sections: SectionPlan[]; layout?: LayoutTokens } | undefined {
  const shell = inspectDetailShellFromBlockTree(input.draftBlockTree);
  const mainNodes = collectBlockNodesInOrder(
    input.draftBlockTree,
    shell.sidebarColumnSourceNodeId
      ? new Set([shell.sidebarColumnSourceNodeId])
      : undefined,
  );
  const stats = collectPostDetailBlockStats(mainNodes);
  if (!stats.postContentNode) return undefined;

  const sections: SectionPlan[] = [];

  if (stats.featuredImageNode) {
    const section: PostFeaturedImageSection = {
      type: 'post-featured-image',
      ...(stats.featuredImageNode.sourceRef
        ? { sourceRef: stats.featuredImageNode.sourceRef }
        : {}),
      ...(stats.featuredImageNode.customClassNames?.length
        ? {
            imageCustomClassNames: [
              ...stats.featuredImageNode.customClassNames,
            ],
          }
        : {}),
      debugKey: 'post-featured-image-0',
      sectionKey: 'post-featured-image-0',
    };
    sections.push(section);
  }

  if (stats.titleNode) {
    const level =
      typeof stats.titleNode.level === 'number' &&
      stats.titleNode.level >= 1 &&
      stats.titleNode.level <= 6
        ? (stats.titleNode.level as 1 | 2 | 3 | 4 | 5 | 6)
        : 1;
    const section: PostTitleSection = {
      type: 'post-title',
      level,
      ...(stats.titleNode.sourceRef
        ? { sourceRef: stats.titleNode.sourceRef }
        : {}),
      ...(stats.titleNode.customClassNames?.length
        ? { titleCustomClassNames: [...stats.titleNode.customClassNames] }
        : {}),
      debugKey: 'post-title-0',
      sectionKey: 'post-title-0',
    };
    sections.push(section);
  }

  if (stats.hasMetaSection) {
    const section: PostMetaSection = {
      type: 'post-meta',
      layout: 'inline',
      showAuthor: stats.hasAuthor,
      showDate: stats.hasDate,
      showCategories: stats.hasCategoryTerms,
      ...(stats.metaNode?.sourceRef
        ? { sourceRef: stats.metaNode.sourceRef }
        : {}),
      ...(stats.metaNode?.customClassNames?.length
        ? { customClassNames: [...stats.metaNode.customClassNames] }
        : {}),
      debugKey: 'post-meta-0',
      sectionKey: 'post-meta-0',
    };
    sections.push(section);
  }

  const postContentSection: PostContentSection = {
    type: 'post-content',
    showTitle: !stats.titleNode,
    showAuthor: !stats.hasMetaSection && stats.hasAuthor,
    showDate: !stats.hasMetaSection && stats.hasDate,
    showCategories: !stats.hasMetaSection && stats.hasCategoryTerms,
    ...(stats.postContentNode.sourceRef
      ? { sourceRef: stats.postContentNode.sourceRef }
      : {}),
    ...(stats.postContentNode.customClassNames?.length
      ? { customClassNames: [...stats.postContentNode.customClassNames] }
      : {}),
    debugKey: 'post-content-0',
    sectionKey: 'post-content-0',
  };
  sections.push(postContentSection);

  if (stats.termsNode && stats.hasTagTerms) {
    const section: PostTermsSection = {
      type: 'post-terms',
      taxonomy: stats.termsTaxonomy ?? 'post_tag',
      separator: stats.termsSeparator,
      layout: 'inline',
      ...(stats.termsNode.sourceRef
        ? { sourceRef: stats.termsNode.sourceRef }
        : {}),
      ...(stats.termsNode.customClassNames?.length
        ? { customClassNames: [...stats.termsNode.customClassNames] }
        : {}),
      debugKey: 'post-terms-0',
      sectionKey: 'post-terms-0',
    };
    sections.push(section);
  }

  if (stats.commentsNode) {
    const section: CommentsSection = {
      type: 'comments',
      showForm: true,
      requireName: true,
      requireEmail: true,
      ...(stats.commentsNode.sourceRef
        ? { sourceRef: stats.commentsNode.sourceRef }
        : {}),
      debugKey: 'comments-0',
      sectionKey: 'comments-0',
    };
    sections.push(section);
  }

  if (stats.postNavigationNode) {
    const section: PostNavigationSection = {
      type: 'post-navigation',
      showPrevious: true,
      showNext: true,
      ...(stats.postNavigationNode.sourceRef
        ? { sourceRef: stats.postNavigationNode.sourceRef }
        : {}),
      debugKey: 'post-navigation-0',
      sectionKey: 'post-navigation-0',
    };
    sections.push(section);
  }

  if (shell.sidebarNodes?.length) {
    sections.push(
      buildSidebarSectionFromBlockTree(shell.sidebarNodes, input.content, {
        paddingStyle: shell.shellPaddingStyle,
        marginStyle: shell.shellMarginStyle,
        gapStyle: shell.shellGapStyle,
        sourceRef: shell.shellSourceRef,
        customClassNames: shell.shellCustomClassNames,
      }),
    );
  }

  return {
    sections,
    layout: shell.hasSidebar
      ? {
          ...input.layout,
          contentLayout:
            shell.sidebarPosition === 'left' ? 'sidebar-left' : 'sidebar-right',
          sidebarWidth: shell.sidebarWidth ?? input.layout.sidebarWidth,
          sidebarScope: 'all-content',
        }
      : input.layout,
  };
}

function buildBlockTreeDrivenBoundPageDetailSections(input: {
  componentPlan: BlockTreePlannerComponentPlan;
  draftBlockTree: BlockNode[];
  content: DbContentResult;
  tokens: ThemeTokens | undefined;
  deriveComponentLayout: (
    tokens: ThemeTokens | undefined,
    componentName: string,
    isDetailPage?: boolean,
  ) => LayoutTokens;
  buildRichBoundPageDetailSections: (
    componentPlan: BlockTreePlannerComponentPlan,
    content: DbContentResult,
    tokens: ThemeTokens | undefined,
  ) => SectionPlan[] | undefined;
  buildBoundPageContentFallbackSection: (
    componentPlan: BlockTreePlannerComponentPlan,
    content: DbContentResult,
    showTitle: boolean,
  ) => PageContentSection;
}): { sections: SectionPlan[]; layout?: LayoutTokens } | undefined {
  const shell = inspectDetailShellFromBlockTree(input.draftBlockTree);
  const showTitle = !/no.?title/i.test(input.componentPlan.componentName);
  const richSections = input
    .buildRichBoundPageDetailSections(
      input.componentPlan,
      input.content,
      input.tokens,
    )
    ?.filter(
      (section) => section.type !== 'sidebar' && section.type !== 'search',
    );

  const sections: SectionPlan[] = richSections?.length
    ? [...richSections]
    : [
        input.buildBoundPageContentFallbackSection(
          input.componentPlan,
          input.content,
          showTitle,
        ),
      ];

  if (shell.sidebarNodes?.length) {
    sections.push(
      buildSidebarSectionFromBlockTree(shell.sidebarNodes, input.content, {
        paddingStyle: shell.shellPaddingStyle,
        marginStyle: shell.shellMarginStyle,
        gapStyle: shell.shellGapStyle,
        sourceRef: shell.shellSourceRef,
        customClassNames: shell.shellCustomClassNames,
      }),
    );
  }

  const layout = input.deriveComponentLayout(
    input.tokens,
    input.componentPlan.componentName,
    true,
  );
  return {
    sections,
    layout: shell.hasSidebar
      ? {
          ...layout,
          contentLayout:
            shell.sidebarPosition === 'left' ? 'sidebar-left' : 'sidebar-right',
          sidebarWidth: shell.sidebarWidth ?? layout.sidebarWidth,
          sidebarScope: 'all-content',
        }
      : layout,
  };
}

function inspectDetailShellFromBlockTree(nodes: BlockNode[]): DetailShellInfo {
  for (const node of nodes) {
    const nested = inspectDetailShellNode(node, []);
    if (nested.hasSidebar) return nested;
  }
  return { hasSidebar: false };
}

function inspectDetailShellNode(
  node: BlockNode,
  ancestors: BlockNode[],
): DetailShellInfo {
  if (node.kind === 'columns' && node.children?.length) {
    const columns = node.children.filter((child) => child.kind === 'column');
    const sidebarIndex = columns.findIndex((column) =>
      blockTreeContainsSidebarTemplate(column),
    );
    if (sidebarIndex >= 0) {
      const sidebarColumn = columns[sidebarIndex];
      const outerShellNode = [...ancestors]
        .reverse()
        .find(
          (candidate) =>
            blockNodeHasBoxSpacing(candidate) ||
            candidate.kind === 'group' ||
            candidate.tagName === 'main',
        );
      const mergedPadding = mergeBlockNodeSpacing(
        outerShellNode?.padding,
        node.padding,
      );
      const mergedMargin = mergeBlockNodeSpacing(
        outerShellNode?.margin,
        node.margin,
      );
      const shellCustomClassNames = Array.from(
        new Set([
          ...(outerShellNode?.customClassNames ?? []),
          ...(node.customClassNames ?? []),
        ]),
      );
      return {
        hasSidebar: true,
        sidebarNodes: sidebarColumn.children ?? [],
        sidebarWidth:
          sidebarColumn.columnWidth ?? readWidthFromBlockAttrs(sidebarColumn),
        sidebarPosition: sidebarIndex === 0 ? 'left' : 'right',
        sidebarColumnSourceNodeId: sidebarColumn.sourceRef?.sourceNodeId,
        shellPaddingStyle: blockSpacingToCssShorthand(mergedPadding),
        shellMarginStyle: blockSpacingToCssShorthand(mergedMargin),
        shellGapStyle: node.gap ?? outerShellNode?.gap,
        shellSourceRef: outerShellNode?.sourceRef ?? node.sourceRef,
        shellCustomClassNames:
          shellCustomClassNames.length > 0 ? shellCustomClassNames : undefined,
      };
    }
  }

  for (const child of node.children ?? []) {
    const nested = inspectDetailShellNode(child, [...ancestors, node]);
    if (nested.hasSidebar) return nested;
  }
  return { hasSidebar: false };
}

function blockTreeContainsSidebarTemplate(node: BlockNode): boolean {
  if (
    node.kind === 'template-part' &&
    typeof node.templatePartSlug === 'string' &&
    /sidebar/i.test(node.templatePartSlug)
  ) {
    return true;
  }
  if (node.tagName === 'aside') return true;
  return (node.children ?? []).some((child) =>
    blockTreeContainsSidebarTemplate(child),
  );
}

function collectBlockNodesInOrder(
  nodes: BlockNode[],
  skipSourceNodeIds?: Set<string>,
): BlockNode[] {
  const collected: BlockNode[] = [];
  const visit = (node: BlockNode) => {
    const sourceNodeId = node.sourceRef?.sourceNodeId;
    if (sourceNodeId && skipSourceNodeIds?.has(sourceNodeId)) {
      return;
    }
    collected.push(node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }
  return collected;
}

function collectPostDetailBlockStats(nodes: BlockNode[]): {
  hasMetaSection: boolean;
  hasAuthor: boolean;
  hasDate: boolean;
  hasCategoryTerms: boolean;
  hasTagTerms: boolean;
  titleNode?: BlockNode;
  featuredImageNode?: BlockNode;
  metaNode?: BlockNode;
  postContentNode?: BlockNode;
  termsNode?: BlockNode;
  termsTaxonomy?: 'category' | 'post_tag' | 'tag';
  termsSeparator?: string;
  commentsNode?: BlockNode;
  postNavigationNode?: BlockNode;
} {
  let titleNode: BlockNode | undefined;
  let featuredImageNode: BlockNode | undefined;
  let metaNode: BlockNode | undefined;
  let postContentNode: BlockNode | undefined;
  let termsNode: BlockNode | undefined;
  let commentsNode: BlockNode | undefined;
  let postNavigationNode: BlockNode | undefined;
  let hasAuthor = false;
  let hasDate = false;
  let hasCategoryTerms = false;
  let hasTagTerms = false;
  let hasMetaSection = false;
  let termsTaxonomy: 'category' | 'post_tag' | 'tag' | undefined;
  let termsSeparator: string | undefined;

  for (const node of nodes) {
    switch (node.kind) {
      case 'post-featured-image':
        featuredImageNode ??= node;
        break;
      case 'post-title':
        titleNode ??= node;
        break;
      case 'template-part':
        if (!metaNode && /post-meta/i.test(node.templatePartSlug ?? '')) {
          metaNode = node;
          hasMetaSection = true;
        }
        break;
      case 'post-author-name':
        hasAuthor = true;
        metaNode ??= node;
        hasMetaSection = true;
        break;
      case 'post-date':
        hasDate = true;
        metaNode ??= node;
        hasMetaSection = true;
        break;
      case 'post-content':
        postContentNode ??= node;
        break;
      case 'post-terms': {
        const taxonomy = normalizePostTermsTaxonomy(node);
        if (taxonomy === 'category') {
          hasCategoryTerms = true;
          if (hasMetaSection && !termsNode) {
            termsNode = node;
          }
        } else {
          hasTagTerms = true;
          termsNode ??= node;
          termsTaxonomy = taxonomy;
          termsSeparator ??= readStringBlockAttr(node, 'separator');
        }
        break;
      }
      default:
        break;
    }

    if (!commentsNode && isCommentsBlockTreeNode(node)) {
      commentsNode = node;
    }
    if (!postNavigationNode && isPostNavigationBlockTreeNode(node)) {
      postNavigationNode = node;
    }
  }

  return {
    hasMetaSection,
    hasAuthor,
    hasDate,
    hasCategoryTerms,
    hasTagTerms,
    titleNode,
    featuredImageNode,
    metaNode,
    postContentNode,
    termsNode,
    termsTaxonomy,
    termsSeparator,
    commentsNode,
    postNavigationNode,
  };
}

function buildSidebarSectionFromBlockTree(
  sidebarNodes: BlockNode[],
  content: DbContentResult,
  shell?: SidebarShellPresentation,
): SidebarSection {
  const orderedNodes = collectBlockNodesInOrder(sidebarNodes);
  const headingTexts = orderedNodes
    .filter(
      (node) =>
        node.kind === 'heading' &&
        typeof node.text === 'string' &&
        node.text.trim().length > 0,
    )
    .map((node) => node.text!.trim());
  const hasSearch = orderedNodes.some((node) => node.kind === 'search');
  const hasNavigation = orderedNodes.some((node) => node.kind === 'navigation');
  const hasAuthorBio = orderedNodes.some((node) =>
    ['post-author-biography', 'avatar'].includes(node.kind),
  );
  const hasCategories = orderedNodes.some((node) => node.kind === 'categories');
  const hasRecentPosts = orderedNodes.some((node) =>
    ['query', 'latest-posts'].includes(node.kind),
  );

  const widgets: SidebarSection['widgets'] = [];
  if (hasSearch) {
    widgets.push({
      kind: 'search',
      ...(headingTexts.find((heading) => /search/i.test(heading))
        ? {
            title: headingTexts.find((heading) => /search/i.test(heading)),
          }
        : {}),
    });
  }
  if (hasAuthorBio) {
    widgets.push({
      kind: 'author-bio',
      title:
        headingTexts.find((heading) => /author/i.test(heading)) ??
        'About the author',
      showAvatar: orderedNodes.some((node) => node.kind === 'avatar'),
    });
  }
  if (hasCategories) {
    widgets.push({
      kind: 'categories',
      title:
        headingTexts.find((heading) => /categor/i.test(heading)) ??
        'Popular Categories',
    });
  }
  if (hasNavigation) {
    widgets.push({
      kind: 'navigation',
      title:
        headingTexts.find((heading) =>
          /link|resource|menu|explore/i.test(heading),
        ) ?? 'Useful Links',
      menuSlug: content.menus[0]?.slug ?? 'primary',
    });
  }
  if (hasRecentPosts) {
    widgets.push({
      kind: 'recent-posts',
      title:
        headingTexts.find((heading) => /recent|latest/i.test(heading)) ??
        'Recent Posts',
    });
  }
  if (widgets.length === 0) {
    widgets.push({
      kind: 'pages-list',
      title:
        headingTexts.find((heading) => /page|explore/i.test(heading)) ??
        'Pages',
    });
  }

  const sourceRef =
    shell?.sourceRef ??
    orderedNodes.find((node) => node.sourceRef)?.sourceRef ??
    undefined;
  const customClassNames = Array.from(
    new Set([
      ...(shell?.customClassNames ?? []),
      ...orderedNodes.flatMap((node) => node.customClassNames ?? []),
    ]),
  );

  return {
    type: 'sidebar',
    widgets,
    maxItems: 6,
    ...(sourceRef ? { sourceRef } : {}),
    ...(customClassNames.length > 0 ? { customClassNames } : {}),
    ...(shell?.paddingStyle ? { paddingStyle: shell.paddingStyle } : {}),
    ...(shell?.marginStyle ? { marginStyle: shell.marginStyle } : {}),
    ...(shell?.gapStyle ? { gapStyle: shell.gapStyle } : {}),
    debugKey: 'sidebar-0',
    sectionKey: 'sidebar-0',
  };
}

function isCommentsBlockTreeNode(node: BlockNode): boolean {
  const blockName = node.blockName.toLowerCase();
  const patternSlug = String(node.patternSlug ?? '').toLowerCase();
  return (
    patternSlug.includes('comments') ||
    blockName.includes('comment-template') ||
    blockName.includes('comments')
  );
}

function isPostNavigationBlockTreeNode(node: BlockNode): boolean {
  const blockName = node.blockName.toLowerCase();
  const patternSlug = String(node.patternSlug ?? '').toLowerCase();
  return (
    patternSlug.includes('post-navigation') ||
    blockName.includes('post-navigation')
  );
}

function normalizePostTermsTaxonomy(
  node: BlockNode,
): 'category' | 'post_tag' | 'tag' {
  const taxonomy = readStringBlockAttr(node, 'term');
  if (taxonomy === 'category') return 'category';
  if (taxonomy === 'tag') return 'tag';
  return 'post_tag';
}

function readWidthFromBlockAttrs(node: BlockNode): string | undefined {
  return (
    readStringBlockAttr(node, 'width') ?? readStringBlockAttr(node, 'flexBasis')
  );
}

function readStringBlockAttr(
  node: Pick<BlockNode, 'attrs'>,
  key: string,
): string | undefined {
  const value = node.attrs?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function blockNodeHasBoxSpacing(node: BlockNode | undefined): boolean {
  if (!node) return false;
  return Boolean(
    node.padding?.top ||
    node.padding?.right ||
    node.padding?.bottom ||
    node.padding?.left ||
    node.margin?.top ||
    node.margin?.right ||
    node.margin?.bottom ||
    node.margin?.left ||
    node.gap,
  );
}

function mergeBlockNodeSpacing(
  outer?: BlockNode['padding'],
  inner?: BlockNode['padding'],
): BlockNode['padding'] | undefined {
  const merged = {
    top: inner?.top ?? outer?.top,
    right: inner?.right ?? outer?.right,
    bottom: inner?.bottom ?? outer?.bottom,
    left: inner?.left ?? outer?.left,
  };
  return merged.top || merged.right || merged.bottom || merged.left
    ? merged
    : undefined;
}

function blockSpacingToCssShorthand(
  spacing?: BlockNode['padding'],
): string | undefined {
  if (!spacing) return undefined;
  const top = spacing.top ?? '0px';
  const right = spacing.right ?? top;
  const bottom = spacing.bottom ?? top;
  const left = spacing.left ?? right;
  return [top, right, bottom, left].join(' ');
}

function normalizeTemplateIdentifier(value: string | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/^.*[\\/]/, '');
  return normalized.replace(/\.(php|html)$/i, '').toLowerCase();
}
