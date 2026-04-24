import type { SourceRef } from '../../../common/utils/source-node-id.util.js';

// ── Visual Plan Schema ─────────────────────────────────────────────────────
// Planner builds ComponentVisualPlan and injects it into ComponentPlan.
// Code generator consumes the complete plan to produce deterministic TSX.
// AI only contributes `sections[]` — palette, typography, layout are all
// derived deterministically from theme.tokens by the planner.

export type DataNeed =
  | 'siteInfo'
  | 'footerLinks'
  | 'posts'
  | 'pages'
  | 'menus'
  | 'postDetail'
  | 'pageDetail'
  | 'comments';

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

// ── Section types ──────────────────────────────────────────────────────────

interface BaseSection {
  sectionKey?: string;
  sourceRef?: SourceRef;
  customClassNames?: string[];
  background?: string; // overrides palette for this section
  textColor?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  paddingStyle?: string; // exact CSS shorthand from template, e.g. "2rem 1.5rem"
  marginStyle?: string; // exact CSS shorthand from template
  gapStyle?: string; // exact CSS gap between direct children inside the section
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
  headingStyle?: TypographyStyle;
  subheadingStyle?: TypographyStyle;
  cta?: SectionCta;
  ctas?: SectionCta[];
  image?: { src: string; alt: string; position: 'right' | 'below' };
}

export interface CtaStripSection extends BaseSection {
  type: 'cta-strip';
  align?: 'left' | 'center' | 'right';
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
  headingStyle?: TypographyStyle;
  subheadingStyle?: TypographyStyle;
  cta?: SectionCta;
  ctas?: SectionCta[];
  contentAlign: 'center' | 'left' | 'right';
}

export interface PostListSection extends BaseSection {
  type: 'post-list';
  title?: string;
  layout: 'list' | 'grid-2' | 'grid-3';
  showDate: boolean;
  showAuthor: boolean;
  showCategory: boolean;
  showExcerpt: boolean;
  showFeaturedImage: boolean;
}

export interface CardGridSection extends BaseSection {
  type: 'card-grid';
  title?: string;
  subtitle?: string;
  columns: 2 | 3 | 4;
  columnWidths?: string[];
  cards: { heading: string; body: string; imageSrc?: string; imageAlt?: string }[];
}

export interface MediaTextSection extends BaseSection {
  type: 'media-text';
  imageSrc: string;
  imageAlt: string;
  imagePosition: 'left' | 'right';
  columnWidths?: string[];
  heading?: string;
  body?: string;
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
  contentAlign?: 'center' | 'left' | 'right';
}

export interface NewsletterSection extends BaseSection {
  type: 'newsletter';
  heading: string;
  subheading?: string;
  buttonText: string;
  layout: 'centered' | 'card';
}

export interface FooterSection extends BaseSection {
  type: 'footer';
  brandDescription?: string; // uses siteInfo.blogDescription if omitted
  menuColumns: { title: string; menuSlug: string }[];
  columnWidths?: string[];
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

export interface PostMetaSection extends BaseSection {
  type: 'post-meta';
  layout?: 'inline' | 'stacked';
  showAuthor: boolean;
  showDate: boolean;
  showCategories: boolean;
  showSeparator?: boolean;
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
}

export interface SearchSection extends BaseSection {
  type: 'search';
  title?: string;
}

export interface BreadcrumbSection extends BaseSection {
  type: 'breadcrumb';
}

export interface SidebarSection extends BaseSection {
  type: 'sidebar';
  title?: string;
  menuSlug?: string;
  showSiteInfo: boolean;
  showPages: boolean;
  showPosts: boolean;
  maxItems?: number;
}

export interface ModalSection extends BaseSection {
  type: 'modal';
  triggerText?: string;
  heading?: string;
  body?: string;
  imageSrc?: string;
  imageAlt?: string;
  cta?: SectionCta;
  ctas?: SectionCta[];
  layout?: 'centered' | 'split';
  closeOnOverlay?: boolean;
  closeOnEsc?: boolean;
  overlayColor?: string;
  width?: string;
  height?: string;
  closeIconPosition?: string;
}

export interface TabsSection extends BaseSection {
  type: 'tabs';
  title?: string;
  activeTab?: number;
  variant?: string;
  tabAlign?: 'left' | 'center' | 'right';
  tabs: {
    label: string;
    heading?: string;
    body?: string;
    imageSrc?: string;
    imageAlt?: string;
    cta?: SectionCta;
  }[];
}

export interface AccordionSection extends BaseSection {
  type: 'accordion';
  title?: string;
  items: {
    heading: string;
    body: string;
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
    imageSrc?: string;
    imageAlt?: string;
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
  | PostMetaSection
  | PageContentSection
  | SearchSection
  | BreadcrumbSection
  | CommentsSection
  | SidebarSection
  | ModalSection
  | TabsSection
  | AccordionSection
  | CarouselSection;

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
  buttonPadding?: string; // exact CSS padding shorthand from theme defaults
  imageRadius?: string; // exact border radius for image-like blocks
  cardRadius?: string; // exact border radius for cards/groups
  cardPadding?: string; // exact CSS padding shorthand for group/card-like surfaces
  /** Partial component names this page should import, e.g. ["Header", "Footer"] */
  includes: string[];
}

export interface ComponentVisualPlan {
  componentName: string;
  dataNeeds: DataNeed[];
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
  /** Section layout — the only thing AI contributes */
  sections: SectionPlan[];
}
