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
  | 'pageDetail';

export interface ColorPalette {
  background: string; // page/root background e.g. "#f9f9f9"
  surface: string;    // card / elevated surfaces e.g. "#ffffff"
  text: string;       // primary body text e.g. "#111111"
  textMuted: string;  // secondary / caption text e.g. "#636363"
  accent: string;     // buttons, links, hover e.g. "#d8613c"
  accentText: string; // text on accent background e.g. "#ffffff"
  dark?: string;      // dark section background e.g. "#111111"
  darkText?: string;  // text on dark sections e.g. "#f9f9f9"
}

// ── Section types ──────────────────────────────────────────────────────────

interface BaseSection {
  background?: string; // overrides palette for this section
  textColor?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
}

export interface NavbarSection extends BaseSection {
  type: 'navbar';
  sticky: boolean;
  menuSlug: string;       // e.g. "primary"
  cta?: { text: string; link: string; style: 'button' | 'link' };
}

export interface HeroSection extends BaseSection {
  type: 'hero';
  layout: 'centered' | 'left' | 'split';
  heading: string;
  subheading?: string;
  cta?: { text: string; link: string };
  image?: { src: string; alt: string; position: 'right' | 'below' };
}

export interface CoverSection extends BaseSection {
  type: 'cover';
  imageSrc: string;
  dimRatio: number;    // 0–100
  minHeight: string;   // e.g. "500px"
  heading?: string;
  subheading?: string;
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
  cards: { heading: string; body: string }[];
}

export interface MediaTextSection extends BaseSection {
  type: 'media-text';
  imageSrc: string;
  imageAlt: string;
  imagePosition: 'left' | 'right';
  heading?: string;
  body?: string;
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
  showMeta: boolean; // date, author, categories
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

/** Fallback: AI provides the JSX directly for complex/unknown sections */
export interface CustomSection extends BaseSection {
  type: 'custom';
  description: string;
  jsx: string; // raw JSX string, inserted verbatim into component
  imports?: string[]; // extra import lines needed
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
  | CustomSection;

/**
 * Typography tokens derived from theme.json / style.css.
 * Injected by PlannerService — never set by AI.
 */
export interface TypographyTokens {
  headingFamily: string; // CSS font-family for headings, e.g. "Inter, sans-serif"
  bodyFamily: string;    // CSS font-family for body text
  h1: string;            // Tailwind class, e.g. "text-[2.5rem] leading-tight"
  h2: string;            // e.g. "text-[2rem] leading-snug"
  h3: string;            // e.g. "text-[1.5rem] leading-snug"
  body: string;          // e.g. "text-[1rem]"
  small: string;         // e.g. "text-sm"
  buttonRadius: string;  // e.g. "rounded" | "rounded-full" | "rounded-none"
}

/**
 * Layout tokens derived from theme.json / style.css.
 * Injected by PlannerService — never set by AI.
 */
export interface LayoutTokens {
  containerClass: string; // e.g. "max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8"
  blockGap: string;       // Tailwind gap class between sections, e.g. "gap-16"
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
  /** Section layout — the only thing AI contributes */
  sections: SectionPlan[];
}
