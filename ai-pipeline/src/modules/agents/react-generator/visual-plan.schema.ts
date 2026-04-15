import type { SourceRef } from '../../../common/utils/source-node-id.util.js';

// ── Visual Plan Schema ─────────────────────────────────────────────────────
// Planner builds ComponentVisualPlan and injects it into ComponentPlan.
// Code generator consumes the complete plan to produce deterministic TSX.
// AI only contributes `sections[]` — palette, typography, layout are all
// derived deterministically from theme.tokens by the planner.

export type DataNeed =
  | 'siteInfo'
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

export interface SourceLayoutHint {
  type?: string;
  orientation?: string;
  justifyContent?: string;
  flexWrap?: string;
  verticalAlignment?: string;
  columnCount?: number;
  minimumColumnWidth?: string;
  contentSize?: string;
  wideSize?: string;
}

// ── Section types ──────────────────────────────────────────────────────────

interface BaseSection {
  sectionKey?: string;
  sourceRef?: SourceRef;
  customClassNames?: string[];
  sourceLayout?: SourceLayoutHint; // exact layout metadata lifted from WP block attrs
  background?: string; // overrides palette for this section
  textColor?: string;
  textAlign?: 'left' | 'center' | 'right';
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  paddingStyle?: string; // exact CSS shorthand from template, e.g. "2rem 1.5rem"
  marginStyle?: string; // exact CSS shorthand from template
  gapStyle?: string; // exact CSS gap between direct children inside the section
  contentWidth?: string; // exact constrained inner width, e.g. "620px"
}

export interface NavbarSection extends BaseSection {
  type: 'navbar';
  sticky: boolean;
  menuSlug: string; // e.g. "primary"
  cta?: { text: string; link: string; style: 'button' | 'link' };
}

export interface HeroSection extends BaseSection {
  type: 'hero';
  layout: 'centered' | 'left' | 'split';
  heading: string;
  subheading?: string;
  headingStyle?: TypographyStyle;
  subheadingStyle?: TypographyStyle;
  cta?: { text: string; link: string };
  image?: { src: string; alt: string; position: 'right' | 'below' };
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
  cta?: { text: string; link: string };
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
  cards: { heading: string; body: string }[];
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
  cta?: { text: string; link: string };
}

export interface TestimonialSection extends BaseSection {
  type: 'testimonial';
  quote: string;
  authorName: string;
  authorTitle?: string;
  authorAvatar?: string;
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
  copyright?: string;
}

export interface PostContentSection extends BaseSection {
  type: 'post-content';
  showTitle: boolean;
  showAuthor: boolean;
  showDate: boolean;
  showCategories: boolean;
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

export interface TabsSection extends BaseSection {
  type: 'tabs';
  tabs: { label: string; content: string }[];
}

export interface SliderSection extends BaseSection {
  type: 'slider';
  slides: {
    heading?: string;
    description?: string;
    cta?: { text: string; link: string };
  }[];
  autoplay?: boolean;
}

export interface ModalSection extends BaseSection {
  type: 'modal';
  triggerText: string;
  heading?: string;
  description?: string;
  cta?: { text: string; link: string };
}

export type SectionPlan =
  | NavbarSection
  | HeroSection
  | CoverSection
  | PostListSection
  | CardGridSection
  | MediaTextSection
  | TestimonialSection
  | NewsletterSection
  | FooterSection
  | PostContentSection
  | PageContentSection
  | SearchSection
  | BreadcrumbSection
  | CommentsSection
  | SidebarSection
  | TabsSection
  | SliderSection
  | ModalSection;

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
