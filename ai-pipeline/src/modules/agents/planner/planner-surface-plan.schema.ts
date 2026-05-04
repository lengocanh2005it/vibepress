import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import type {
  ColorPalette,
  DataNeed,
  SectionPlan,
  TypographyTokens,
} from '../react-generator/visual-plan.schema.js';

export type PlannerPlanKind = 'standard-page' | 'home-page' | 'post-detail';

export type PlannerAuthorityLevel = 'strict' | 'guided' | 'free';

export type PlannerPageIntentKind =
  | 'landing'
  | 'editorial'
  | 'service'
  | 'directory'
  | 'product-like'
  | 'minimal-prose'
  | 'homepage-brand'
  | 'homepage-content'
  | 'homepage-hybrid'
  | 'article';

export type PlannerClusterKind =
  | 'opening'
  | 'hero-like'
  | 'feature-list'
  | 'split-content'
  | 'gallery'
  | 'posts-feed'
  | 'cta'
  | 'prose'
  | 'form'
  | 'testimonials'
  | 'logo-cloud'
  | 'stats'
  | 'faq'
  | 'article-body'
  | 'article-meta'
  | 'author-box'
  | 'comments'
  | 'post-navigation'
  | 'related-posts';

export type PlannerWrapperKind =
  | 'stack'
  | 'contained-group'
  | 'full-bleed'
  | 'two-column'
  | 'three-column'
  | 'sidebar'
  | 'overlap'
  | 'asymmetric-grid'
  | 'article-shell';

export type PlannerWidgetKind =
  | 'query'
  | 'search'
  | 'comments'
  | 'gallery'
  | 'tabs'
  | 'accordion'
  | 'modal'
  | 'slider'
  | 'navigation'
  | 'newsletter';

export interface PlannerSourceRef {
  sourceNodeId?: string;
  sourceFile?: string;
  templateName?: string;
  blockName?: string;
}

export interface PlannerRouteContract {
  route: string | null;
  dataNeeds: DataNeed[];
  isDetail: boolean;
  componentType: 'page' | 'partial';
  sharedChromeOwnership: 'layout' | 'self';
}

export interface PlannerAuthorityPolicy {
  level: PlannerAuthorityLevel;
  reason: string;
  allowSectionTypeSubstitution: boolean;
  allowReorderWithinGroups: boolean;
  allowWrapperRecomposition: boolean;
  preserveExactBlockStructure: boolean;
}

export interface PlannerContentClusterEvidence {
  id: string;
  kind: PlannerClusterKind;
  importance: 'high' | 'medium' | 'low';
  sourceRef?: PlannerSourceRef;
  textEvidence?: string[];
  imageEvidence?: string[];
  ctaEvidence?: string[];
  itemCountHint?: number;
  customClassNames?: string[];
}

export interface PlannerWrapperEvidence {
  id: string;
  kind: PlannerWrapperKind;
  importance: 'high' | 'medium';
  sourceRef?: PlannerSourceRef;
  hints?: string[];
  customClassNames?: string[];
}

export interface PlannerWidgetEvidence {
  kind: PlannerWidgetKind;
  required: boolean;
  sourceRef?: PlannerSourceRef;
  customClassNames?: string[];
}

export interface PlannerSourceFactsSummary {
  hasQuery: boolean;
  hasSidebarTemplatePart: boolean;
  hasSearch: boolean;
  hasPostContent: boolean;
  hasPageList: boolean;
  hasComments: boolean;
  hasNavigation: boolean;
  hasWooCart: boolean;
  hasWooCheckout: boolean;
}

export interface PlannerRepresentativeBinding {
  kind: 'page' | 'post';
  id: number | string;
  slug?: string | null;
  title: string;
  template?: string | null;
}

export interface PlannerDesignEvidence {
  importantClassNames: string[];
  spacingRhythm: {
    density: 'compact' | 'balanced' | 'airy';
    rhythmHints: string[];
  };
  visualToneHints: string[];
  tokens: {
    palette?: ColorPalette;
    typography?: TypographyTokens;
    blockStyles?: ThemeTokens['blockStyles'];
  };
}

export interface PlannerCompositionHints {
  macroOrder: string[];
  preferredGrouping: string[][];
  keepAdjacentClusterPairs: Array<[string, string]>;
  mayCollapseClusters: string[];
  mayExpandClusters: string[];
}

export interface PlannerAcceptanceRules {
  mustKeep: string[];
  mustNotInvent: string[];
  mayRecompose: string[];
}

export interface PlannerSourceEvidenceModel {
  planningSourceLabel?: string;
  planningSourceFile?: string;
  blockTree?: BlockNode[];
  sourceFacts?: PlannerSourceFactsSummary;
  primaryHeadings: string[];
  primaryImages: string[];
  paragraphSnippets?: string[];
  navigationLabels?: string[];
  customClassNames: string[];
  contentClusters: PlannerContentClusterEvidence[];
  wrapperFacts: PlannerWrapperEvidence[];
  widgets: PlannerWidgetEvidence[];
  representativeBindings?: PlannerRepresentativeBinding[];
  evidenceNotes?: string[];
}

export interface PlannerDebugArtifacts {
  legacyDraftSections?: SectionPlan[];
}

export interface BasePlannerPlan {
  kind: PlannerPlanKind;
  componentName: string;
  templateName: string;
  contract: PlannerRouteContract;
  authority: PlannerAuthorityPolicy;
  pageIntent: {
    kind: PlannerPageIntentKind;
    confidence: number;
  };
  sourceEvidence: PlannerSourceEvidenceModel;
  designEvidence: PlannerDesignEvidence;
  compositionHints: PlannerCompositionHints;
  acceptance: PlannerAcceptanceRules;
  debug?: PlannerDebugArtifacts;
}

export interface StandardPagePlan extends BasePlannerPlan {
  kind: 'standard-page';
}

export interface HomeHeroEvidence {
  headingPresent: boolean;
  primaryCtaPresent: boolean;
  mediaPresent: boolean;
  backgroundMediaPresent: boolean;
  sourceRef?: PlannerSourceRef;
}

export interface HomeFeedEvidence {
  kind: 'posts' | 'pages' | 'mixed' | 'none';
  required: boolean;
  sourceRef?: PlannerSourceRef;
}

export interface HomeBrandEvidence {
  siteTitleProminence: 'high' | 'medium' | 'low';
  logoProminence: 'high' | 'medium' | 'low';
  taglineProminence: 'high' | 'medium' | 'low';
  trustSignalsPresent: boolean;
  sourceRef?: PlannerSourceRef;
}

export interface HomePagePlan extends BasePlannerPlan {
  kind: 'home-page';
  homeMode: 'front-page' | 'posts-index' | 'hybrid-home';
  heroEvidence: HomeHeroEvidence;
  feedEvidence: HomeFeedEvidence;
  brandEvidence: HomeBrandEvidence;
  homepageRules: {
    preserveOpeningImpact: boolean;
    preserveBrandFirstRead: boolean;
    preserveEditorialFlow: boolean;
    allowHeroToRecompose: boolean;
    allowFeedSectionToMove: boolean;
  };
}

export interface PostMetaEvidence {
  titleRequired: boolean;
  featuredImageRequired: boolean;
  publishDatePresent: boolean;
  authorPresent: boolean;
  categoryOrTagPresent: boolean;
  commentsPresent: boolean;
  postNavigationPresent: boolean;
}

export interface PostBodyEvidence {
  proseDensity: 'light' | 'medium' | 'heavy';
  bodyHasImages: boolean;
  bodyHasGallery: boolean;
  bodyHasLists: boolean;
  bodyHasQuotes: boolean;
  bodyHasTables: boolean;
}

export interface PostLayoutEvidence {
  shell: 'full-width' | 'with-sidebar' | 'narrow-article';
  metaPlacement:
    | 'above-title'
    | 'below-title'
    | 'below-featured-image'
    | 'mixed';
  featuredImagePlacement:
    | 'before-title'
    | 'after-title'
    | 'inside-body'
    | 'none';
  authorBoxPlacement: 'after-body' | 'after-comments' | 'none';
}

export interface PostDetailPlan extends BasePlannerPlan {
  kind: 'post-detail';
  postMeta: PostMetaEvidence;
  postBody: PostBodyEvidence;
  postLayout: PostLayoutEvidence;
  articleRules: {
    preserveReadingFlow: boolean;
    preserveSemanticMeta: boolean;
    preserveCommentsCapability: boolean;
    forbidLandingPageRecomposition: boolean;
  };
}

export type PlannerSurfacePlan =
  | StandardPagePlan
  | HomePagePlan
  | PostDetailPlan;
