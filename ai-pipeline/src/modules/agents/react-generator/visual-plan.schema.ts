import type { SourceRef } from '../../../common/utils/source-node-id.util.js';
import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
export type { BlockNode };

// ── Visual Plan Schema ─────────────────────────────────────────────────────
// Planner builds ComponentVisualPlan and injects it into ComponentPlan.
// Code generator consumes the complete plan to produce deterministic TSX.
// AI only contributes `sections[]` — palette, typography, layout are all
// derived deterministically from theme.tokens by the planner.

export type DataNeed =
  | 'siteInfo'
  | 'footerLinks'
  | 'posts'
  | 'products'
  | 'pages'
  | 'menus'
  | 'postDetail'
  | 'productDetail'
  | 'pageDetail'
  | 'comments';

export type SectionCapability =
  | 'heading'
  | 'body'
  | 'primary-cta'
  | 'secondary-cta'
  | 'image'
  | 'slides'
  | 'cards'
  | 'posts'
  | 'products'
  | 'menus'
  | 'pages'
  | 'site-info'
  | 'search-input'
  | 'comments-list'
  | 'comment-form'
  | 'post-content'
  | 'page-content'
  | 'tabs'
  | 'accordion-items'
  | 'quote'
  | 'author';

export interface SectionSourceEvidence {
  sourceNodeIds?: string[];
  sourceFiles?: string[];
  blockNames?: string[];
  templateNames?: string[];
}

export interface SectionContentRequirements {
  requireTitle?: boolean;
  requireBody?: boolean;
  requireCtaText?: boolean;
  requireImageIfSourceHasImage?: boolean;
}

export interface SectionObligation {
  role: string;
  required: SectionCapability[];
  minItems?: Partial<Record<'slides' | 'cards' | 'posts' | 'products', number>>;
  sourceEvidence?: SectionSourceEvidence;
  contentRequirements?: SectionContentRequirements;
}

export interface ColorPalette {
  background: string; // page/root background e.g. "#f9f9f9"
  surface: string; // card / elevated surfaces e.g. "#ffffff"
  text: string; // primary body text e.g. "#111111"
  textMuted: string; // secondary / caption text e.g. "#636363"
  accent: string; // buttons, links, hover e.g. "#d8613c"
  accentText: string; // text on accent background e.g. "#ffffff"
  dark?: string; // dark section background e.g. "#111111"
  darkText?: string; // text on dark sections e.g. "#f9f9f9"
}

export interface BlockStyleToken {
  color?: { text?: string; background?: string };
  typography?: {
    fontSize?: string;
    fontFamily?: string;
    fontWeight?: string;
    letterSpacing?: string;
    lineHeight?: string;
    textTransform?: string;
  };
  border?: {
    radius?: string;
    width?: string;
    style?: string;
    color?: string;
  };
  spacing?: {
    padding?: string;
    margin?: string;
    gap?: string;
  };
}

export type TypographyStyle = NonNullable<BlockStyleToken['typography']>;

export interface SectionCta {
  text: string;
  link: string;
  customClassNames?: string[];
}

export interface SectionButtonStyle {
  variant?: 'solid' | 'outline' | 'ghost' | 'link';
  background?: string;
  color?: string;
  hoverBackground?: string;
  hoverColor?: string;
  border?: string; // e.g. "1px solid #d8613c"
  borderRadius?: string; // e.g. "8px" | "9999px"
  padding?: string; // CSS shorthand e.g. "0.75rem 1.5rem"
}

export interface SectionCardStyle {
  background?: string;
  padding?: string;
  borderRadius?: string;
  border?: string;
  shadow?: string; // CSS box-shadow value
  titleStyle?: TypographyStyle;
  bodyStyle?: TypographyStyle;
  imageRadius?: string;
  imageAspectRatio?: string; // e.g. "16/9" | "1/1"
}

export interface SectionPresentation {
  container?: 'shell' | 'content';
  contentAlign?: 'left' | 'center' | 'right';
  textAlign?: 'left' | 'center' | 'right';
  itemsAlign?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'between' | 'end';
  contentMaxWidth?: string;
}

export type SourceSegment =
  | {
      type: 'heading';
      text: string;
      html?: string;
      level?: number;
      customClassNames?: string[];
      style?: TypographyStyle;
      sourceRef?: SourceRef;
    }
  | {
      type: 'paragraph';
      text?: string;
      html: string;
      customClassNames?: string[];
      style?: TypographyStyle;
      sourceRef?: SourceRef;
    }
  | {
      type: 'image';
      src: string;
      alt?: string;
      caption?: string;
      width?: number;
      height?: number;
      customClassNames?: string[];
      sourceRef?: SourceRef;
    }
  | {
      type: 'list';
      items: string[];
      ordered?: boolean;
      customClassNames?: string[];
      itemCustomClassNames?: string[];
      style?: TypographyStyle;
      sourceRef?: SourceRef;
    }
  | {
      type: 'html';
      html: string;
      customClassNames?: string[];
      sourceRef?: SourceRef;
    };

// ── Section types ──────────────────────────────────────────────────────────

interface BaseSection {
  /** Debug-only identifier. Do not use this as render identity or validation truth. */
  debugKey?: string;
  /** @deprecated Legacy field retained for compatibility with older plan artifacts. */
  sectionKey?: string;
  sourceRef?: SourceRef;
  obligation?: SectionObligation;
  customClassNames?: string[];
  background?: string; // overrides palette for this section
  textColor?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  paddingStyle?: string; // exact CSS shorthand from template, e.g. "2rem 1.5rem"
  marginStyle?: string; // exact CSS shorthand from template
  gapStyle?: string; // exact CSS gap between direct children inside the section
  border?: { radius?: string; color?: string; width?: string };
  shadow?: string;
  // Primary and secondary CTA button visual spec — generator must not invent these
  ctaStyle?: SectionButtonStyle;
  secondaryCtaStyle?: SectionButtonStyle;
  presentation?: SectionPresentation;
  sourceSegments?: SourceSegment[];
  /** Set by planner (PR3+). Controls generator strategy for this section.
   *  'section-assembly' = generate this section independently, retry only this section on failure.
   *  'full-file' = generate entire component file as one unit (default when absent). */
  generationMode?: 'full-file' | 'section-assembly';
}

export interface NavbarSection extends BaseSection {
  type: 'navbar';
  sticky: boolean;
  menuSlug: string; // e.g. "primary"
  orientation?: 'horizontal' | 'vertical';
  overlayMenu?: 'always' | 'mobile' | 'never';
  isResponsive?: boolean;
  showSiteLogo?: boolean;
  showSiteTitle?: boolean;
  logoWidth?: string;
  cta?: SectionCta & { style: 'button' | 'link' };
}

export interface HeroSection extends BaseSection {
  type: 'hero';
  layout: 'centered' | 'left' | 'split';
  heading: string;
  subheading?: string;
  headingCustomClassNames?: string[];
  subheadingCustomClassNames?: string[];
  headingStyle?: TypographyStyle;
  subheadingStyle?: TypographyStyle;
  cta?: SectionCta;
  ctas?: SectionCta[];
  image?: {
    src: string;
    alt: string;
    position: 'right' | 'below';
    radius?: string;
    aspectRatio?: string;
    customClassNames?: string[];
  };
}

export interface CtaStripSection extends BaseSection {
  type: 'cta-strip';
  align?: 'left' | 'center' | 'right';
  heading?: string;
  subheading?: string;
  cta?: SectionCta;
  ctas?: SectionCta[];
}

export interface CoverSection extends BaseSection {
  type: 'cover';
  imageSrc: string;
  dimRatio: number; // 0–100
  minHeight: string; // e.g. "500px"
  heading?: string;
  subheading?: string;
  headingCustomClassNames?: string[];
  subheadingCustomClassNames?: string[];
  headingStyle?: TypographyStyle;
  subheadingStyle?: TypographyStyle;
  cta?: SectionCta;
  ctas?: SectionCta[];
  contentAlign: 'center' | 'left' | 'right';
}

export interface PostListSection extends BaseSection {
  type: 'post-list';
  title?: string;
  titleCustomClassNames?: string[];
  resource?: 'posts' | 'products';
  layout: 'list' | 'grid-2' | 'grid-3';
  showDate: boolean;
  showAuthor: boolean;
  showCategory: boolean;
  showExcerpt: boolean;
  showFeaturedImage: boolean;
  showPrice?: boolean;
  showButton?: boolean;
  itemLayout?: 'title-meta-inline' | 'stacked';
  metaLayout?: 'inline' | 'stacked';
  metaAlign?: 'start' | 'end';
  metaSeparator?: 'none' | 'dot' | 'dash' | 'slash' | 'pipe';
  itemGap?: string;
  metaGap?: string;
  showDividers?: boolean;
  dividerColor?: string;
  titleColumnWidth?: string;
  metaColumnWidth?: string;
  splitCategoryLine?: boolean;
  categoryPrefix?: string;
}

export interface CardGridSection extends BaseSection {
  type: 'card-grid';
  title?: string;
  subtitle?: string;
  cta?: SectionCta;
  ctas?: SectionCta[];
  ctaStyle?: SectionButtonStyle;
  secondaryCtaStyle?: SectionButtonStyle;
  titleCustomClassNames?: string[];
  subtitleCustomClassNames?: string[];
  titleStyle?: TypographyStyle;
  columns: 2 | 3 | 4;
  columnWidths?: string[];
  cardStyle?: SectionCardStyle;
  cards: {
    heading: string;
    body: string;
    headingCustomClassNames?: string[];
    bodyCustomClassNames?: string[];
    imageSrc?: string;
    imageAlt?: string;
    customClassNames?: string[];
    imageCustomClassNames?: string[];
  }[];
}

export interface MediaTextSection extends BaseSection {
  type: 'media-text';
  imageSrc: string;
  imageAlt: string;
  imagePosition: 'left' | 'right';
  imageRadius?: string;
  imageAspectRatio?: string; // e.g. "16/9" | "1/1"
  imageCustomClassNames?: string[];
  columnWidths?: string[];
  subtitle?: string;
  heading?: string;
  body?: string;
  subtitleCustomClassNames?: string[];
  headingCustomClassNames?: string[];
  bodyCustomClassNames?: string[];
  subtitleStyle?: TypographyStyle;
  headingStyle?: TypographyStyle;
  bodyStyle?: TypographyStyle;
  listItems?: string[];
  cta?: SectionCta;
  ctas?: SectionCta[];
}

export interface TestimonialSection extends BaseSection {
  type: 'testimonial';
  quote: string;
  authorName: string;
  authorTitle?: string;
  authorAvatar?: string;
  authorAvatarCustomClassNames?: string[];
  quoteCustomClassNames?: string[];
  authorCustomClassNames?: string[];
  contentAlign?: 'center' | 'left' | 'right';
  quoteStyle?: TypographyStyle;
  authorStyle?: TypographyStyle;
  cardStyle?: SectionCardStyle;
}

export interface NewsletterSection extends BaseSection {
  type: 'newsletter';
  heading: string;
  subheading?: string;
  headingCustomClassNames?: string[];
  subheadingCustomClassNames?: string[];
  headingStyle?: TypographyStyle;
  buttonText: string;
  layout: 'centered' | 'card';
  inputStyle?: { background?: string; borderRadius?: string; border?: string };
  cardStyle?: SectionCardStyle;
}

export interface FooterSection extends BaseSection {
  type: 'footer';
  brandDescription?: string; // uses siteInfo.blogDescription if omitted
  menuColumns: { title: string; menuSlug: string }[];
  columnWidths?: string[];
  scrollTopTriggerClassNames?: string[];
  supplementalImages?: Array<{
    src: string;
    alt?: string;
    customClassNames?: string[];
  }>;
  showSiteLogo?: boolean;
  showSiteTitle?: boolean;
  showTagline?: boolean;
  logoWidth?: string;
  copyright?: string;
}

export interface PostContentSection extends BaseSection {
  type: 'post-content';
  showTitle: boolean;
  showAuthor: boolean;
  showDate: boolean;
  showCategories: boolean;
}

export interface PostTitleSection extends BaseSection {
  type: 'post-title';
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  titleCustomClassNames?: string[];
  titleStyle?: TypographyStyle;
}

export interface PostFeaturedImageSection extends BaseSection {
  type: 'post-featured-image';
  imageRadius?: string;
  imageAspectRatio?: string;
  imageCustomClassNames?: string[];
}

export interface PostMetaSection extends BaseSection {
  type: 'post-meta';
  layout?: 'inline' | 'stacked';
  showAuthor: boolean;
  showDate: boolean;
  showCategories: boolean;
  showSeparator?: boolean;
}

export interface PostTermsSection extends BaseSection {
  type: 'post-terms';
  taxonomy?: 'category' | 'post_tag' | 'tag';
  prefix?: string;
  separator?: string;
  layout?: 'inline' | 'stacked';
}

export interface PostNavigationSection extends BaseSection {
  type: 'post-navigation';
  showPrevious?: boolean;
  showNext?: boolean;
  previousLabel?: string;
  nextLabel?: string;
}

export interface CommentsSection extends BaseSection {
  type: 'comments';
  showForm: boolean; // render "Leave a Reply" form
  requireName: boolean; // show name field in form
  requireEmail: boolean; // show email field in form
}

export interface PageContentSection extends BaseSection {
  type: 'page-content';
  showTitle: boolean;
  /**
   * Fallback presentation mode for bound WordPress pages that are rendered from
   * `page.content` HTML instead of flattened visual sections.
   */
  shellVariant?: 'article' | 'wide';
  bodyPresentation?: 'prose' | 'wordpress-blocks';
  hasColumns?: boolean;
  hasWideBlocks?: boolean;
  hasFullWidthBlocks?: boolean;
  hasInteractiveBlocks?: boolean;
}

export interface ProseBlockSection extends BaseSection {
  type: 'prose-block';
  sourceSegments: SourceSegment[];
  shellVariant?: 'article' | 'wide';
}

export interface SearchSection extends BaseSection {
  type: 'search';
  title?: string;
  cta?: SectionCta;
  ctas?: SectionCta[];
}

export interface SidebarLinkItem {
  label: string;
  url?: string;
}

export type SidebarWidget =
  | {
      kind: 'search';
      title?: string;
      placeholder?: string;
      buttonLabel?: string;
    }
  | {
      kind: 'author-bio';
      title?: string;
      description?: string;
      showAvatar?: boolean;
    }
  | {
      kind: 'categories';
      title?: string;
      showCounts?: boolean;
    }
  | {
      kind: 'navigation';
      title?: string;
      description?: string;
      menuSlug?: string;
      links?: SidebarLinkItem[];
    }
  | {
      kind: 'pages-list';
      title?: string;
    }
  | {
      kind: 'recent-posts';
      title?: string;
    };

export interface BreadcrumbSection extends BaseSection {
  type: 'breadcrumb';
}

export interface SidebarSection extends BaseSection {
  type: 'sidebar';
  title?: string;
  widgets: SidebarWidget[];
  maxItems?: number;
}

export interface ModalSection extends BaseSection {
  type: 'modal';
  triggerText?: string;
  heading?: string;
  body?: string;
  triggerCustomClassNames?: string[];
  headingCustomClassNames?: string[];
  bodyCustomClassNames?: string[];
  imageSrc?: string;
  imageAlt?: string;
  imageCustomClassNames?: string[];
  cta?: SectionCta;
  ctas?: SectionCta[];
  layout?: 'centered' | 'split';
  closeOnOverlay?: boolean;
  closeOnEsc?: boolean;
  overlayColor?: string;
  width?: string;
  height?: string;
  closeIconPosition?: string;
  triggerStyle?: SectionButtonStyle;
  headingStyle?: TypographyStyle;
  bodyStyle?: TypographyStyle;
}

export interface TabsSection extends BaseSection {
  type: 'tabs';
  title?: string;
  titleCustomClassNames?: string[];
  activeTab?: number;
  variant?: string;
  tabAlign?: 'left' | 'center' | 'right';
  tabs: {
    label: string;
    heading?: string;
    body?: string;
    headingCustomClassNames?: string[];
    bodyCustomClassNames?: string[];
    imageSrc?: string;
    imageAlt?: string;
    imageCustomClassNames?: string[];
    cta?: SectionCta;
  }[];
}

export interface AccordionSection extends BaseSection {
  type: 'accordion';
  title?: string;
  titleCustomClassNames?: string[];
  items: {
    heading: string;
    body: string;
    headingCustomClassNames?: string[];
    bodyCustomClassNames?: string[];
  }[];
  allowMultiple?: boolean;
  enableToggle?: boolean;
  defaultOpenItems?: number[];
  variant?: string;
}

export interface CarouselSection extends BaseSection {
  type: 'carousel';
  slides: {
    heading?: string;
    subheading?: string;
    headingCustomClassNames?: string[];
    subheadingCustomClassNames?: string[];
    imageSrc?: string;
    imageAlt?: string;
    imageCustomClassNames?: string[];
    cta?: SectionCta;
  }[];
  autoplay?: boolean;
  autoplaySpeed?: number;
  loop?: boolean;
  effect?: 'slide' | 'fade' | 'flip' | 'coverflow';
  showDots?: boolean;
  showArrows?: boolean;
  vertical?: boolean;
  transitionSpeed?: number;
  pauseOn?: 'hover' | 'click';
  contentAlign?: 'center' | 'left' | 'right';
  slideHeight?: string; // e.g. "500px"
  dotsColor?: string;
  arrowColor?: string;
  arrowBackground?: string;
  headingStyle?: TypographyStyle;
  subheadingStyle?: TypographyStyle;
}

export type SectionPlan =
  | NavbarSection
  | HeroSection
  | CtaStripSection
  | CoverSection
  | PostListSection
  | CardGridSection
  | MediaTextSection
  | TestimonialSection
  | NewsletterSection
  | FooterSection
  | PostContentSection
  | PostTitleSection
  | PostFeaturedImageSection
  | PostMetaSection
  | PostTermsSection
  | PostNavigationSection
  | PageContentSection
  | ProseBlockSection
  | SearchSection
  | BreadcrumbSection
  | CommentsSection
  | SidebarSection
  | ModalSection
  | TabsSection
  | AccordionSection
  | CarouselSection;

/**
 * Optional chunk-level metadata attached to sections after the chunk-labeling
 * stage (PR2+). Planner sets these fields; generator reads them to decide
 * per-section generation mode and retry scope.
 */
export interface SectionChunkMeta {
  /** Which ChunkPlan(s) this section was composed from. */
  chunkIds?: string[];
  /** Semantic label assigned by AI chunk-labeling (e.g. "hero", "projects", "services"). */
  semanticKind?: string;
  /** AI confidence score for the semantic label (0–1). */
  confidence?: number;
  /** Generation strategy: full-file = one-shot page TSX; section-assembly = per-section codegen. */
  generationMode?: 'full-file' | 'section-assembly';
}

/**
 * Typography tokens derived from theme.json / style.css.
 * Injected by PlannerService — never set by AI.
 */
export interface TypographyTokens {
  headingFamily: string; // CSS font-family for headings, e.g. "Inter, sans-serif"
  bodyFamily: string; // CSS font-family for body text
  h1: string; // Tailwind class, e.g. "text-[2.5rem] leading-tight"
  h2: string; // e.g. "text-[2rem] leading-snug"
  h3: string; // e.g. "text-[1.5rem] leading-snug"
  body: string; // e.g. "text-[1rem]"
  small: string; // e.g. "text-sm"
  buttonRadius: string; // exact class, e.g. "rounded-[8px]" | "rounded-full"
}

/**
 * Layout tokens derived from theme.json / style.css.
 * Injected by PlannerService — never set by AI.
 */
export interface LayoutTokens {
  containerClass: string; // e.g. "max-w-[1280px] mx-auto w-full" for full-width sections/chrome
  contentContainerClass?: string; // e.g. "max-w-[800px] mx-auto w-full" for long-form article/page content
  blockGap: string; // Tailwind gap class between sections, e.g. "gap-16"
  contentLayout?: 'single-column' | 'sidebar-right' | 'sidebar-left';
  sidebarWidth?: string; // exact CSS width for sidebar column, e.g. "320px"
  sidebarScope?: 'main-only' | 'all-content';
  buttonPadding?: string; // exact CSS padding shorthand from theme defaults
  imageRadius?: string; // exact border radius for image-like blocks
  cardRadius?: string; // exact border radius for cards/groups
  cardPadding?: string; // exact CSS padding shorthand for group/card-like surfaces
  /** Partial component names this page should import, e.g. ["Header", "Footer"] */
  includes: string[];
}

export type VisualPlanRenderMode =
  | 'section-centric'
  | 'hybrid'
  | 'block-centric';

export type VisualPlanRenderAuthority =
  | 'ai'
  | 'deterministic-structure'
  | 'deterministic-pixel';

export interface VisualPlanLockPolicy {
  /** When true, downstream must not hand this component back to AI codegen. */
  bypassAiGeneration?: boolean;
  /** When true, reviewer/fixer must not allow AI structural rewrites. */
  bypassAiReviewRewrite?: boolean;
  /** Narrow exception list for AI repair modes that are still allowed. */
  allowAiFixModes?: Array<'syntax-only' | 'import-only'>;
  /** Human-readable explanation for logs/artifacts. */
  reason?: string;
}

export interface ComponentVisualPlan {
  componentName: string;
  dataNeeds: DataNeed[];
  runtimeRenderer?: 'runtime-page';
  /** When this component is bound to one exact WordPress page, fetch by this slug instead of URL params. */
  pageBinding?: {
    id?: number | string;
    slug: string;
    title?: string;
    route?: string;
  };
  /** Colors — derived from theme.tokens by planner, forced on all components */
  palette: ColorPalette;
  /** Typography — derived from theme.tokens by planner, forced on all components */
  typography: TypographyTokens;
  /** Layout — derived from theme.tokens + plan structure by planner */
  layout: LayoutTokens;
  /** Block-level style presets derived from theme tokens/style.css */
  blockStyles?: Record<string, BlockStyleToken>;
  /**
   * Render authority for this plan:
   * - section-centric: sections own both structure and behavior
   * - hybrid: blockTree owns structure, sections own behavior/data contracts
   * - block-centric: blockTree is authoritative for both structure and rendering
   */
  renderMode?: VisualPlanRenderMode;
  /** When true, downstream generation/repair must stay on the deterministic path
   *  and must not hand structural rendering back to AI. */
  deterministicAuthority?: boolean;
  /** Granular render authority level for deterministic contracts. */
  renderAuthority?: VisualPlanRenderAuthority;
  /** Downstream lock policy derived by planner for deterministic-safe components. */
  lockPolicy?: VisualPlanLockPolicy;
  /** Section layout — the only thing AI contributes */
  sections: SectionPlan[];
  /** Preserved WordPress block tree for block-centric rendering. When present,
   *  codegen uses this as the primary render source instead of sections[]. */
  blockTree?: BlockNode[];
}

export function normalizeVisualPlanArchitecture(
  visualPlan: ComponentVisualPlan,
): ComponentVisualPlan {
  return {
    ...visualPlan,
    sections: visualPlan.sections.map((section, index) => {
      const debugKey =
        section.debugKey?.trim() ||
        section.sectionKey?.trim() ||
        `${section.type}-${index + 1}`;
      return {
        ...section,
        debugKey,
        obligation: section.obligation ?? deriveSectionObligation(section),
      };
    }),
  };
}

export function getVisualPlanRenderAuthority(
  visualPlan:
    | Pick<
        ComponentVisualPlan,
        'renderAuthority' | 'deterministicAuthority' | 'renderMode'
      >
    | undefined,
): VisualPlanRenderAuthority {
  if (visualPlan?.renderAuthority) return visualPlan.renderAuthority;
  if (
    visualPlan?.deterministicAuthority === true &&
    visualPlan.renderMode === 'block-centric'
  ) {
    return 'deterministic-structure';
  }
  return 'ai';
}

export function isDeterministicVisualPlan(
  visualPlan:
    | Pick<
        ComponentVisualPlan,
        'renderAuthority' | 'deterministicAuthority' | 'renderMode'
      >
    | undefined,
): boolean {
  return getVisualPlanRenderAuthority(visualPlan) !== 'ai';
}

export function shouldBypassAiGenerationForVisualPlan(
  visualPlan:
    | Pick<
        ComponentVisualPlan,
        | 'renderAuthority'
        | 'deterministicAuthority'
        | 'renderMode'
        | 'lockPolicy'
      >
    | undefined,
): boolean {
  if (visualPlan?.lockPolicy?.bypassAiGeneration === true) return true;
  return getVisualPlanRenderAuthority(visualPlan) === 'deterministic-pixel';
}

export function shouldProtectDeterministicStructureFromAi(
  visualPlan:
    | Pick<
        ComponentVisualPlan,
        | 'renderAuthority'
        | 'deterministicAuthority'
        | 'renderMode'
        | 'lockPolicy'
      >
    | undefined,
): boolean {
  if (visualPlan?.lockPolicy?.bypassAiReviewRewrite === true) return true;
  return isDeterministicVisualPlan(visualPlan);
}

function deriveSectionObligation(section: SectionPlan): SectionObligation {
  const sourceEvidence: SectionSourceEvidence | undefined = section.sourceRef
    ? {
        sourceNodeIds: section.sourceRef.sourceNodeId
          ? [section.sourceRef.sourceNodeId]
          : undefined,
        sourceFiles: section.sourceRef.sourceFile
          ? [section.sourceRef.sourceFile]
          : undefined,
        blockNames: section.sourceRef.blockName
          ? [section.sourceRef.blockName]
          : undefined,
        templateNames: section.sourceRef.templateName
          ? [section.sourceRef.templateName]
          : undefined,
      }
    : undefined;

  switch (section.type) {
    case 'hero':
      return {
        role: 'hero',
        required: [
          ...(section.heading ? (['heading'] as SectionCapability[]) : []),
          ...(section.subheading ? (['body'] as SectionCapability[]) : []),
          ...(section.image?.src ? (['image'] as SectionCapability[]) : []),
          ...(section.ctas?.some((cta) => cta?.text) || section.cta?.text
            ? (['primary-cta'] as SectionCapability[])
            : []),
        ],
        sourceEvidence,
        contentRequirements: {
          requireTitle: !!section.heading,
          requireBody: !!section.subheading,
          requireCtaText:
            !!section.cta?.text || !!section.ctas?.some((cta) => cta?.text),
          requireImageIfSourceHasImage: !!section.image?.src,
        },
      };
    case 'cta-strip':
      return {
        role: 'cta-strip',
        required: section.cta?.text ? ['primary-cta'] : [],
        sourceEvidence,
        contentRequirements: {
          requireCtaText: !!section.cta?.text,
        },
      };
    case 'cover':
      return {
        role: 'cover',
        required: [
          ...(section.heading ? (['heading'] as SectionCapability[]) : []),
          ...(section.subheading ? (['body'] as SectionCapability[]) : []),
          ...(section.imageSrc ? (['image'] as SectionCapability[]) : []),
          ...(section.cta?.text
            ? (['primary-cta'] as SectionCapability[])
            : []),
        ],
        sourceEvidence,
        contentRequirements: {
          requireTitle: !!section.heading,
          requireBody: !!section.subheading,
          requireCtaText: !!section.cta?.text,
          requireImageIfSourceHasImage: !!section.imageSrc,
        },
      };
    case 'post-list': {
      const collectionCapability: SectionCapability =
        section.resource === 'products' ? 'products' : 'posts';
      const minItemsKey =
        section.resource === 'products' ? 'products' : 'posts';
      return {
        role: 'post-list',
        required: [
          ...(section.title ? (['heading'] as SectionCapability[]) : []),
          collectionCapability,
        ],
        minItems: { [minItemsKey]: 1 },
        sourceEvidence,
        contentRequirements: {
          requireTitle: !!section.title,
        },
      };
    }
    case 'card-grid':
      return {
        role: 'card-grid',
        required: [
          ...(section.title ? (['heading'] as SectionCapability[]) : []),
          ...(section.subtitle ? (['body'] as SectionCapability[]) : []),
          'cards',
        ],
        minItems: { cards: Math.max(1, section.cards?.length ?? 0) },
        sourceEvidence,
        contentRequirements: {
          requireTitle: !!section.title,
          requireBody: !!section.subtitle,
        },
      };
    case 'media-text':
      return {
        role: 'media-text',
        required: [
          ...(section.heading ? (['heading'] as SectionCapability[]) : []),
          ...(section.body ? (['body'] as SectionCapability[]) : []),
          ...(section.imageSrc ? (['image'] as SectionCapability[]) : []),
          ...(section.cta?.text
            ? (['primary-cta'] as SectionCapability[])
            : []),
        ],
        sourceEvidence,
        contentRequirements: {
          requireTitle: !!section.heading,
          requireBody: !!section.body,
          requireCtaText: !!section.cta?.text,
          requireImageIfSourceHasImage: !!section.imageSrc,
        },
      };
    case 'testimonial':
      return {
        role: 'testimonial',
        required: [
          ...(section.quote ? (['quote'] as SectionCapability[]) : []),
          ...(section.authorName ? (['author'] as SectionCapability[]) : []),
          ...(section.authorAvatar ? (['image'] as SectionCapability[]) : []),
        ],
        sourceEvidence,
      };
    case 'newsletter':
      return {
        role: 'newsletter',
        required: [
          ...(section.heading ? (['heading'] as SectionCapability[]) : []),
          ...(section.subheading ? (['body'] as SectionCapability[]) : []),
          'primary-cta',
        ],
        sourceEvidence,
      };
    case 'post-content':
      return {
        role: 'post-content',
        required: ['post-content'],
        sourceEvidence,
      };
    case 'post-title':
      return {
        role: 'post-title',
        required: ['heading'],
        sourceEvidence,
      };
    case 'post-featured-image':
      return {
        role: 'post-featured-image',
        required: ['image'],
        sourceEvidence,
      };
    case 'page-content':
      return {
        role: 'page-content',
        required: ['page-content'],
        sourceEvidence,
      };
    case 'prose-block':
      return {
        role: 'prose-block',
        required: [
          ...(section.sourceSegments.some(
            (segment) => segment.type === 'heading',
          )
            ? (['heading'] as SectionCapability[])
            : []),
          ...(section.sourceSegments.some(
            (segment) =>
              segment.type === 'paragraph' ||
              segment.type === 'list' ||
              segment.type === 'html',
          )
            ? (['body'] as SectionCapability[])
            : []),
          ...(section.sourceSegments.some((segment) => segment.type === 'image')
            ? (['image'] as SectionCapability[])
            : []),
        ],
        sourceEvidence,
      };
    case 'search':
      return {
        role: 'search',
        required: ['search-input'],
        sourceEvidence,
      };
    case 'comments':
      return {
        role: 'comments',
        required: [
          'comments-list',
          ...(section.showForm === false
            ? []
            : (['comment-form'] as SectionCapability[])),
        ],
        sourceEvidence,
      };
    case 'post-terms':
      return {
        role: 'post-terms',
        required: [],
        sourceEvidence,
      };
    case 'post-navigation':
      return {
        role: 'post-navigation',
        required: ['posts'],
        sourceEvidence,
      };
    case 'sidebar':
      const sidebarRequired = new Set<SectionCapability>();
      for (const widget of section.widgets) {
        if (widget.kind === 'search') sidebarRequired.add('search-input');
        if (widget.kind === 'author-bio') {
          sidebarRequired.add('posts');
          sidebarRequired.add('site-info');
        }
        if (widget.kind === 'categories') sidebarRequired.add('posts');
        if (widget.kind === 'navigation') sidebarRequired.add('menus');
        if (widget.kind === 'pages-list') sidebarRequired.add('pages');
        if (widget.kind === 'recent-posts') sidebarRequired.add('posts');
      }
      return {
        role: 'sidebar',
        required: Array.from(sidebarRequired),
        sourceEvidence,
      };
    case 'modal':
      return {
        role: 'modal',
        required: [
          ...(section.triggerText
            ? (['primary-cta'] as SectionCapability[])
            : []),
          ...(section.heading ? (['heading'] as SectionCapability[]) : []),
          ...(section.body ? (['body'] as SectionCapability[]) : []),
          ...(section.imageSrc ? (['image'] as SectionCapability[]) : []),
          ...(section.cta?.text
            ? (['secondary-cta'] as SectionCapability[])
            : []),
        ],
        sourceEvidence,
      };
    case 'tabs':
      return {
        role: 'tabs',
        required: ['tabs'],
        sourceEvidence,
      };
    case 'accordion':
      return {
        role: 'accordion',
        required: ['accordion-items'],
        sourceEvidence,
      };
    case 'carousel':
      return {
        role: 'carousel',
        required: ['slides'],
        minItems: { slides: Math.max(1, section.slides?.length ?? 0) },
        sourceEvidence,
      };
    case 'navbar':
      return {
        role: 'navbar',
        required: ['menus'],
        sourceEvidence,
      };
    default:
      return {
        role: section.type,
        required: [],
        sourceEvidence,
      };
  }
}
