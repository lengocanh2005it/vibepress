import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { ComponentRenderContract } from './render-contract.schema.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';

// Generic page-layout templates whose URL in WordPress comes from the assigned
// page slug (via _wp_page_template meta), not from the template name. These
// should stay on the canonical page route family so concrete-page expansion can
// materialize them into real routes (or fold them into RuntimePage if unused).
const FSE_GENERIC_PAGE_LAYOUT_BASES = new Set([
  'blank',
  'full-width',
  'page-no-title',
  'page-with-sidebar',
  'page-wide',
]);

export type RouteContractDataNeed =
  | 'posts'
  | 'products'
  | 'pages'
  | 'menus'
  | 'site-info'
  | 'footer-links'
  | 'post-detail'
  | 'product-detail'
  | 'page-detail'
  | 'comments'
  | 'categoryDetail';

export interface RouteContractInput {
  templateName: string;
  componentName?: string;
  type?: 'page' | 'partial';
  route?: string | null;
  dataNeeds?: string[];
  isDetail?: boolean;
  fixedSlug?: string;
  fixedPageId?: number | string;
  draftBlockTree?: BlockNode[];
  renderContract?: ComponentRenderContract;
  planningSourceFile?: string;
  planningSourceLabel?: string;
  planningSourceSummary?: string;
  hasConcretePageBindings?: boolean;
  repoRouteHints?: RepoRouteHints;
  readingSettings?: RouteContractReadingSettings;
  homeMode?: DeterministicHomeMode;
}

export interface RepoRouteHints {
  templatePartArea?: string;
  entryFile?: string;
  routeHint?: string;
  chainFiles: string[];
  blockTypes: string[];
  notes: string[];
}

export interface RouteContractReadingSettings {
  showOnFront?: 'page' | 'posts' | null;
  pageOnFrontId?: number | null;
  pageForPostsId?: number | null;
}

export type DeterministicHomeMode =
  | 'front-page'
  | 'posts-index'
  | 'hybrid-home';

export interface DeterministicRouteContract {
  archetype:
    | 'partial'
    | 'home'
    | 'posts-index'
    | 'not-found'
    | 'search'
    | 'archive'
    | 'category-archive'
    | 'tag-archive'
    | 'author-archive'
    | 'single-post'
    | 'single-page'
    | 'exact-post-binding'
    | 'exact-page-binding'
    | 'static-page';
  type: 'page' | 'partial';
  route: string | null;
  routeMode: 'hard' | 'soft';
  isDetail: boolean;
  requiredDataNeeds: RouteContractDataNeed[];
  disallowedDetailDataNeeds: RouteContractDataNeed[];
  evidence: string[];
  homeTemplateBase?: HomeTemplateBase | null;
  homeMode?: DeterministicHomeMode | null;
}

export const HOME_TEMPLATE_PRIORITY = [
  'frontend-page',
  'front-page',
  'home',
  'index',
] as const;
const HOME_TEMPLATE_PRIORITY_SET = new Set<string>(HOME_TEMPLATE_PRIORITY);

export type HomeTemplateBase = (typeof HOME_TEMPLATE_PRIORITY)[number];

export interface HomeHierarchyResolution {
  winnerBase: HomeTemplateBase | null;
  orderedTemplateNames: string[];
  routeByBase: Partial<Record<HomeTemplateBase, string>>;
  redundantBases: HomeTemplateBase[];
  explicitBases: HomeTemplateBase[];
}

function assignNonRootHomeAliases(input: {
  routeByBase: Partial<Record<HomeTemplateBase, string>>;
  hasBase: (base: HomeTemplateBase) => boolean;
  redundantBases: Set<HomeTemplateBase>;
  readingSettings?: RouteContractReadingSettings;
  preferPostsIndexAlias?: boolean;
}): void {
  const {
    routeByBase,
    hasBase,
    redundantBases,
    readingSettings,
    preferPostsIndexAlias,
  } = input;
  const postsIndexAlias = resolvePostsIndexAliasRoute({
    readingSettings,
    preferPostsIndexAlias,
  });

  if (redundantBases.has('home')) {
    if (hasBase('index')) routeByBase['index'] = postsIndexAlias;
    return;
  }

  if (hasBase('home')) routeByBase['home'] = '/home';
  if (hasBase('index')) routeByBase['index'] = postsIndexAlias;
}

export function inferDeterministicRouteContract(
  input: RouteContractInput,
): DeterministicRouteContract {
  const templateBase = toTemplateBase(input.templateName);
  const routeSlug = toKebabCase(templateBase);
  const normalizedNeeds = new Set(
    (input.dataNeeds ?? []).map((need) => need.trim() as RouteContractDataNeed),
  );
  const signals = collectArchetypeSignals(input, normalizedNeeds);
  const evidence = new Set<string>(signals.evidence);

  const partialCandidate =
    input.type === 'partial' ||
    isPartialComponentName(input.componentName ?? '') ||
    isPartialComponentName(templateBase) ||
    signals.isTemplatePartSource;
  if (partialCandidate) {
    if (
      input.type === 'partial' ||
      isPartialComponentName(input.componentName ?? '') ||
      isPartialComponentName(templateBase)
    ) {
      evidence.add('partial-name-or-type');
    }
    if (signals.isTemplatePartSource) {
      evidence.add('template-part-source');
    }
    return {
      archetype: 'partial',
      type: 'partial',
      route: null,
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: [],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (HOME_TEMPLATE_PRIORITY_SET.has(templateBase)) {
    evidence.add(`home-template:${templateBase}`);
    const homeTemplateBase = templateBase as HomeTemplateBase;
    const homeMode = resolveDeterministicHomeMode({
      templateBase: homeTemplateBase,
      readingSettings: input.readingSettings,
      declaredHomeMode: input.homeMode,
      hasPostsSignal:
        normalizedNeeds.has('posts') || signals.hasPostsIndexStructure,
    });
    evidence.add(`home-mode:${homeMode}`);
    return {
      archetype: templateBase === 'index' ? 'posts-index' : 'home',
      type: 'page',
      // Repo route hints for home-like templates are often coarse aliases
      // ("home"), so they are not trustworthy for the final route path here.
      route: input.route ?? '/',
      routeMode: 'soft',
      isDetail: false,
      requiredDataNeeds:
        normalizedNeeds.has('posts') || signals.hasPostsIndexStructure
          ? ['posts']
          : [],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
      homeTemplateBase,
      homeMode,
    };
  }

  if (input.fixedSlug) {
    if (normalizedNeeds.has('page-detail')) {
      evidence.add('fixed-page-binding');
      return {
        archetype: 'exact-page-binding',
        type: 'page',
        route: `/page/${input.fixedSlug}`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['page-detail'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'categoryDetail',
        ],
        evidence: [...evidence],
      };
    }
    if (normalizedNeeds.has('post-detail')) {
      evidence.add('fixed-post-binding');
      return {
        archetype: 'exact-post-binding',
        type: 'page',
        route: `/post/${input.fixedSlug}`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['post-detail'],
        disallowedDetailDataNeeds: ['page-detail', 'categoryDetail'],
        evidence: [...evidence],
      };
    }
    if (normalizedNeeds.has('product-detail')) {
      evidence.add('fixed-product-binding');
      return {
        archetype: 'exact-post-binding',
        type: 'page',
        route: `/product/${input.fixedSlug}`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['product-detail'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: [...evidence],
      };
    }
  }

  if (templateBase === '404') {
    evidence.add('template:404');
    return {
      archetype: 'not-found',
      type: 'page',
      route: '*',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: [],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (
    signals.hasConcretePageBindings &&
    (templateBase === 'page' ||
      /^page-.+$/.test(templateBase) ||
      normalizedNeeds.has('page-detail'))
  ) {
    evidence.add('concrete-page-bindings');
    return buildFixedArchetypeContract({
      archetype: 'single-page',
      route: templateBase === 'page' ? '/page/:slug' : `/${routeSlug}/:slug`,
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['page-detail'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  const structureFirst = inferStructureFirstArchetype({
    input,
    templateBase,
    routeSlug,
    normalizedNeeds,
    signals,
    evidence,
  });
  if (structureFirst) {
    return structureFirst;
  }

  if (templateBase === 'search') {
    evidence.add('template:search');
    return buildFixedArchetypeContract({
      archetype: 'search',
      route: '/search',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (templateBase === 'archive-product') {
    evidence.add('template:archive-product');
    return buildFixedArchetypeContract({
      archetype: 'archive',
      route: '/products',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['products'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (templateBase === 'archive') {
    evidence.add('template:archive');
    return buildFixedArchetypeContract({
      archetype: 'archive',
      route: '/archive',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (templateBase === 'blog') {
    evidence.add('template:blog');
    return buildFixedArchetypeContract({
      archetype: 'posts-index',
      route: '/blog',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (
    /^category(?:-.+)?$/.test(templateBase) ||
    normalizedNeeds.has('categoryDetail')
  ) {
    evidence.add('category-archive-signal');
    return buildFixedArchetypeContract({
      archetype: 'category-archive',
      route: '/category/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['categoryDetail', 'posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
      ],
      evidence,
    });
  }

  if (/^tag(?:-.+)?$/.test(templateBase)) {
    evidence.add('template:tag');
    return buildFixedArchetypeContract({
      archetype: 'tag-archive',
      route: '/tag/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (/^author(?:-.+)?$/.test(templateBase)) {
    evidence.add('template:author');
    return buildFixedArchetypeContract({
      archetype: 'author-archive',
      route: '/author/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (
    templateBase === 'single-product' ||
    (normalizedNeeds.has('product-detail') &&
      !normalizedNeeds.has('page-detail'))
  ) {
    evidence.add(
      templateBase === 'single-product'
        ? 'template:single-product'
        : 'dataNeed:product-detail',
    );
    return buildFixedArchetypeContract({
      archetype: 'single-post',
      route: '/product/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['product-detail'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  // Generic layout-only templates should stay on the canonical page route
  // family. Named semantic templates such as template-about/contact/services
  // keep their own route family unless they are expanded into exact page
  // bindings later.
  if (FSE_GENERIC_PAGE_LAYOUT_BASES.has(templateBase)) {
    evidence.add('fse:page-layout-template');
    return buildFixedArchetypeContract({
      archetype: 'single-page',
      route: '/page/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['page-detail'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (
    /^template-.+$/.test(templateBase) &&
    (normalizedNeeds.has('page-detail') || input.isDetail === true)
  ) {
    evidence.add('named-page-template-detail');
    return buildFixedArchetypeContract({
      archetype: 'single-page',
      route: `/${routeSlug}/:slug`,
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['page-detail'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (
    /^single(?:-.+)?$/.test(templateBase) ||
    (normalizedNeeds.has('post-detail') && !normalizedNeeds.has('page-detail'))
  ) {
    evidence.add(
      /^single(?:-.+)?$/.test(templateBase)
        ? `template:${templateBase}`
        : 'dataNeed:post-detail',
    );
    return buildFixedArchetypeContract({
      archetype: 'single-post',
      route:
        templateBase === 'single' || templateBase === 'single-post'
          ? '/post/:slug'
          : `/${routeSlug}/:slug`,
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['post-detail'],
      disallowedDetailDataNeeds: [
        'product-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  if (
    templateBase === 'page' ||
    /^page-.+$/.test(templateBase) ||
    (normalizedNeeds.has('page-detail') &&
      !normalizedNeeds.has('post-detail') &&
      isLikelyPageTemplate(templateBase))
  ) {
    evidence.add(
      templateBase === 'page' || /^page-.+$/.test(templateBase)
        ? `template:${templateBase}`
        : 'dataNeed:page-detail',
    );
    return buildFixedArchetypeContract({
      archetype: 'single-page',
      route: '/page/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['page-detail'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'product-detail',
        'categoryDetail',
      ],
      evidence,
    });
  }

  evidence.add('static-page-fallback');
  return {
    archetype: 'static-page',
    type: 'page',
    route: resolveStaticPageFallbackRoute({
      templateBase,
      routeSlug,
      routeHint: signals.normalizedRouteHint,
      inputRoute: input.route,
    }),
    routeMode: 'soft',
    isDetail: false,
    requiredDataNeeds: [],
    disallowedDetailDataNeeds: [
      'post-detail',
      'product-detail',
      'page-detail',
      'categoryDetail',
    ],
    evidence: [...evidence],
  };
}

export function buildRepoRouteHints(
  templateName: string,
  repoManifest?: RepoThemeManifest,
): RepoRouteHints | undefined {
  if (!repoManifest) return undefined;

  const templateBase = toTemplateBase(templateName);
  const templatePartArea = repoManifest.themeJsonSummary.templatePartAreas.find(
    (part) => toTemplateBase(part.name) === templateBase,
  )?.area;
  const entryChain = findMatchingEntrySourceChain(templateName, repoManifest);

  if (!templatePartArea && !entryChain) {
    return undefined;
  }

  return {
    ...(templatePartArea ? { templatePartArea } : {}),
    ...(entryChain?.entryFile ? { entryFile: entryChain.entryFile } : {}),
    ...(entryChain?.routeHint ? { routeHint: entryChain.routeHint } : {}),
    chainFiles: entryChain?.chainFiles ?? [],
    blockTypes: entryChain?.blockTypes ?? [],
    notes: entryChain?.notes ?? [],
  };
}

export function toHomeTemplateBase(
  templateName: string,
): HomeTemplateBase | null {
  const base = toTemplateBase(templateName);
  return HOME_TEMPLATE_PRIORITY_SET.has(base)
    ? (base as HomeTemplateBase)
    : null;
}

export function matchesRepoEntrySourceTemplate(
  templateName: string,
  entryFile: string,
): boolean {
  const normalizedTemplate = toTemplateBase(templateName);
  const entryName = toTemplateBase(entryFile.split('/').pop() ?? entryFile);
  if (entryName === normalizedTemplate) return true;

  if (
    normalizedTemplate === 'front-page' &&
    ['front-page', 'home'].includes(entryName)
  ) {
    return true;
  }
  if (normalizedTemplate === 'home' && ['home', 'index'].includes(entryName)) {
    return true;
  }

  return false;
}

export function resolveHomeHierarchy(input: {
  templateNames: string[];
  repoManifest?: RepoThemeManifest;
  explicitTemplateNames?: string[];
  readingSettings?: RouteContractReadingSettings;
  preferPostsIndexAlias?: boolean;
}): HomeHierarchyResolution {
  const uniqueTemplateNames = Array.from(new Set(input.templateNames));
  const showOnFront = input.readingSettings?.showOnFront ?? null;
  const hasDbFrontPageEvidence =
    Number(input.readingSettings?.pageOnFrontId ?? 0) > 0 ||
    (input.explicitTemplateNames ?? []).some((templateName) =>
      ['front-page', 'frontend-page'].includes(toTemplateBase(templateName)),
    );
  const preferPostsRootFamily =
    showOnFront === 'posts' && !hasDbFrontPageEvidence;
  const homeEntries = uniqueTemplateNames
    .map((templateName) => ({
      templateName,
      base: toHomeTemplateBase(templateName),
    }))
    .filter(
      (entry): entry is { templateName: string; base: HomeTemplateBase } =>
        !!entry.base,
    );
  const effectiveHomeEntries =
    preferPostsRootFamily &&
    homeEntries.some((entry) => ['home', 'index'].includes(entry.base))
      ? homeEntries.filter(
          (entry) =>
            entry.base === 'home' ||
            entry.base === 'index' ||
            !['frontend-page', 'front-page'].includes(entry.base),
        )
      : homeEntries;

  const orderingPriority = preferPostsRootFamily
    ? (['home', 'index', 'frontend-page', 'front-page'] as const)
    : HOME_TEMPLATE_PRIORITY;
  const presentBases = orderingPriority.filter((base) =>
    effectiveHomeEntries.some((entry) => entry.base === base),
  );
  const winnerBase = presentBases[0] ?? null;
  const explicitBases = collectExplicitHomeBases(
    input.repoManifest,
    input.explicitTemplateNames,
  );
  const redundantBases = new Set<HomeTemplateBase>();
  const routeByBase: Partial<Record<HomeTemplateBase, string>> = {};

  const hasBase = (base: HomeTemplateBase) =>
    homeEntries.some((entry) => entry.base === base);
  const hasExplicitHome = explicitBases.has('home');
  const canCollapseHomeIntoIndex =
    hasBase('home') &&
    hasBase('index') &&
    !hasExplicitHome &&
    (winnerBase === 'frontend-page' ||
      winnerBase === 'front-page' ||
      winnerBase === 'home');

  if (canCollapseHomeIntoIndex) {
    redundantBases.add('home');
  }

  if (winnerBase === 'frontend-page') {
    routeByBase['frontend-page'] = '/';
    if (hasBase('front-page')) {
      routeByBase['front-page'] = '/front-page';
    }
    assignNonRootHomeAliases({
      routeByBase,
      hasBase,
      redundantBases,
      readingSettings: input.readingSettings,
      preferPostsIndexAlias: input.preferPostsIndexAlias,
    });
  } else if (winnerBase === 'front-page') {
    routeByBase['front-page'] = '/';
    assignNonRootHomeAliases({
      routeByBase,
      hasBase,
      redundantBases,
      readingSettings: input.readingSettings,
      preferPostsIndexAlias: input.preferPostsIndexAlias,
    });
  } else if (winnerBase === 'home') {
    if (redundantBases.has('home')) {
      routeByBase['index'] = '/';
    } else {
      routeByBase['home'] = '/';
      if (hasBase('index')) {
        routeByBase['index'] = resolvePostsIndexAliasRoute({
          readingSettings: input.readingSettings,
          preferPostsIndexAlias: input.preferPostsIndexAlias,
        });
      }
    }
    if (preferPostsRootFamily) {
      if (hasBase('frontend-page'))
        routeByBase['frontend-page'] = '/front-page';
      if (hasBase('front-page')) routeByBase['front-page'] = '/front-page';
    }
  } else if (winnerBase === 'index') {
    routeByBase['index'] = '/';
    if (preferPostsRootFamily) {
      if (hasBase('frontend-page'))
        routeByBase['frontend-page'] = '/front-page';
      if (hasBase('front-page')) routeByBase['front-page'] = '/front-page';
      if (hasBase('home')) routeByBase['home'] = '/blog';
    }
  }

  const orderedTemplateNames = [
    ...orderingPriority.flatMap((base) =>
      homeEntries
        .filter(
          (entry) => entry.base === base && !redundantBases.has(entry.base),
        )
        .map((entry) => entry.templateName),
    ),
    ...uniqueTemplateNames.filter(
      (templateName) => !toHomeTemplateBase(templateName),
    ),
  ];

  return {
    winnerBase,
    orderedTemplateNames,
    routeByBase,
    redundantBases: [...redundantBases],
    explicitBases: [...explicitBases],
  };
}

function resolvePostsIndexAliasRoute(input: {
  readingSettings?: RouteContractReadingSettings;
  preferPostsIndexAlias?: boolean;
}): string {
  return input.preferPostsIndexAlias ||
    input.readingSettings?.showOnFront === 'posts'
    ? '/blog'
    : '/index';
}

function collectArchetypeSignals(
  input: RouteContractInput,
  normalizedNeeds: Set<RouteContractDataNeed>,
): {
  structuralKinds: Set<string>;
  isTemplatePartSource: boolean;
  hasConcretePageBindings: boolean;
  hasPageDetailStructure: boolean;
  hasPostDetailStructure: boolean;
  hasSearchStructure: boolean;
  hasQueryStructure: boolean;
  hasArchiveStructure: boolean;
  hasPostsIndexStructure: boolean;
  hasCategoryArchiveHint: boolean;
  hasTagArchiveHint: boolean;
  hasAuthorArchiveHint: boolean;
  hasArchiveRouteHint: boolean;
  hasBlogRouteHint: boolean;
  normalizedRouteHint: string | null;
  evidence: string[];
} {
  const structuralKinds = collectStructuralKinds(input);
  const planningSourceFile = String(
    input.planningSourceFile ?? '',
  ).toLowerCase();
  const planningSourceLabel = String(
    input.planningSourceLabel ?? '',
  ).toLowerCase();
  const planningSourceSummary = String(
    input.planningSourceSummary ?? '',
  ).toLowerCase();
  const repoHintArea = String(
    input.repoRouteHints?.templatePartArea ?? '',
  ).toLowerCase();
  const repoHintEntryFile = String(
    input.repoRouteHints?.entryFile ?? '',
  ).toLowerCase();
  const repoHintRoute = String(
    input.repoRouteHints?.routeHint ?? '',
  ).toLowerCase();
  const repoHintNotes =
    input.repoRouteHints?.notes.map((note) => note.toLowerCase()) ?? [];
  const repoHintBlockTypes = new Set(
    (input.repoRouteHints?.blockTypes ?? []).map((blockType) =>
      normalizeBlockKind(blockType),
    ),
  );
  const evidence: string[] = [];
  const normalizedRouteHint = normalizeRouteHint(
    input.repoRouteHints?.routeHint ?? input.route,
  );

  const isTemplatePartSource =
    ['header', 'footer', 'sidebar'].includes(repoHintArea) ||
    planningSourceFile.startsWith('parts/') ||
    planningSourceFile.includes('/parts/') ||
    repoHintEntryFile.startsWith('parts/') ||
    repoHintEntryFile.includes('/parts/') ||
    planningSourceSummary.includes('template part') ||
    planningSourceLabel.startsWith('part:') ||
    repoHintNotes.some((note) => note.includes('template part'));
  if (isTemplatePartSource) {
    evidence.push('source:template-part');
  }

  const hasConcretePageBindings =
    input.hasConcretePageBindings === true ||
    planningSourceFile.startsWith('db:pages/') ||
    planningSourceSummary.includes('exact bound page') ||
    planningSourceSummary.includes('representative db page');
  if (hasConcretePageBindings) {
    evidence.push('source:db-page-binding');
  }

  const hasPageDetailStructure =
    structuralKinds.has('page-content') ||
    repoHintBlockTypes.has('page-content') ||
    repoHintNotes.some(
      (note) => note.includes('page content') || note.includes('page-detail'),
    ) ||
    (structuralKinds.has('post-content') === false &&
      repoHintBlockTypes.has('post-content') === false &&
      structuralKinds.has('query') === false &&
      normalizedNeeds.has('page-detail') &&
      (planningSourceFile.startsWith('db:pages/') ||
        repoHintRoute.includes('page') ||
        planningSourceSummary.includes('page content') ||
        planningSourceSummary.includes('page-detail')));
  if (hasPageDetailStructure) {
    evidence.push('block:page-content');
  }

  const hasPostDetailStructure =
    (!hasPageDetailStructure && structuralKinds.has('post-content')) ||
    (!hasPageDetailStructure && repoHintBlockTypes.has('post-content')) ||
    (structuralKinds.has('comments') &&
      (structuralKinds.has('post-title') ||
        structuralKinds.has('post-featured-image') ||
        structuralKinds.has('post-navigation') ||
        structuralKinds.has('post-date') ||
        structuralKinds.has('post-author-name') ||
        structuralKinds.has('post-terms'))) ||
    (repoHintBlockTypes.has('comments') &&
      (repoHintBlockTypes.has('post-title') ||
        repoHintBlockTypes.has('post-featured-image') ||
        repoHintBlockTypes.has('post-navigation') ||
        repoHintBlockTypes.has('post-date') ||
        repoHintBlockTypes.has('post-author-name') ||
        repoHintBlockTypes.has('post-terms'))) ||
    (normalizedNeeds.has('post-detail') &&
      !normalizedNeeds.has('page-detail') &&
      (planningSourceSummary.includes('post content') ||
        planningSourceSummary.includes('single post') ||
        repoHintRoute.includes('single')));
  if (hasPostDetailStructure) {
    evidence.push('block:post-content');
  }

  const hasSearchStructure =
    structuralKinds.has('search') ||
    repoHintBlockTypes.has('search') ||
    planningSourceSummary.includes('search results') ||
    planningSourceSummary.includes('search form');
  if (hasSearchStructure) {
    evidence.push('block:search');
  }

  const hasQueryStructure =
    structuralKinds.has('query') ||
    structuralKinds.has('latest-posts') ||
    repoHintBlockTypes.has('query') ||
    repoHintBlockTypes.has('latest-posts');
  if (hasQueryStructure) {
    evidence.push('block:query');
  }

  const hasCategoryArchiveHint =
    normalizedNeeds.has('categoryDetail') ||
    /^category(?:\/|$)/.test((normalizedRouteHint ?? '').replace(/^\/+/, '')) ||
    repoHintNotes.some(
      (note) => note.includes('category archive') || note.includes('category'),
    );
  const hasTagArchiveHint =
    /^tag(?:\/|$)/.test((normalizedRouteHint ?? '').replace(/^\/+/, '')) ||
    repoHintNotes.some((note) => note.includes('tag archive'));
  const hasAuthorArchiveHint =
    /^author(?:\/|$)/.test((normalizedRouteHint ?? '').replace(/^\/+/, '')) ||
    repoHintNotes.some((note) => note.includes('author archive'));
  const hasArchiveRouteHint = /^archive(?:\/|$)/.test(
    (normalizedRouteHint ?? '').replace(/^\/+/, ''),
  );
  const hasBlogRouteHint = /^(blog|posts)(?:\/|$)/.test(
    (normalizedRouteHint ?? '').replace(/^\/+/, ''),
  );

  const hasArchiveStructure =
    hasQueryStructure &&
    !hasPageDetailStructure &&
    !hasPostDetailStructure &&
    !hasSearchStructure;
  const hasPostsIndexStructure =
    hasArchiveStructure &&
    !hasCategoryArchiveHint &&
    !hasTagArchiveHint &&
    !hasAuthorArchiveHint;

  return {
    structuralKinds,
    isTemplatePartSource,
    hasConcretePageBindings,
    hasPageDetailStructure,
    hasPostDetailStructure,
    hasSearchStructure,
    hasQueryStructure,
    hasArchiveStructure,
    hasPostsIndexStructure,
    hasCategoryArchiveHint,
    hasTagArchiveHint,
    hasAuthorArchiveHint,
    hasArchiveRouteHint,
    hasBlogRouteHint,
    normalizedRouteHint,
    evidence,
  };
}

function resolveDeterministicHomeMode(input: {
  templateBase: HomeTemplateBase;
  readingSettings?: RouteContractReadingSettings;
  declaredHomeMode?: DeterministicHomeMode;
  hasPostsSignal: boolean;
}): DeterministicHomeMode {
  if (input.declaredHomeMode) {
    return input.declaredHomeMode;
  }

  const showOnFront = input.readingSettings?.showOnFront ?? null;
  const hasPostsPage = Number(input.readingSettings?.pageForPostsId ?? 0) > 0;

  if (showOnFront === 'posts') {
    return input.hasPostsSignal ? 'hybrid-home' : 'posts-index';
  }

  if (
    input.templateBase === 'front-page' ||
    input.templateBase === 'frontend-page'
  ) {
    return input.hasPostsSignal || hasPostsPage ? 'hybrid-home' : 'front-page';
  }

  if (input.templateBase === 'home' || input.templateBase === 'index') {
    return 'posts-index';
  }

  return input.hasPostsSignal ? 'hybrid-home' : 'front-page';
}

function inferStructureFirstArchetype(input: {
  input: RouteContractInput;
  templateBase: string;
  routeSlug: string;
  normalizedNeeds: Set<RouteContractDataNeed>;
  signals: ReturnType<typeof collectArchetypeSignals>;
  evidence: Set<string>;
}): DeterministicRouteContract | undefined {
  const { templateBase, routeSlug, normalizedNeeds, signals, evidence } = input;

  const candidates: Array<
    DeterministicRouteContract & { score: number; priority: number }
  > = [];

  if (signals.hasPageDetailStructure || signals.hasConcretePageBindings) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'single-page',
        route: templateBase === 'page' ? '/page/:slug' : `/${routeSlug}/:slug`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['page-detail'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'categoryDetail',
        ],
        evidence: new Set([
          ...evidence,
          signals.hasConcretePageBindings
            ? 'db:page-binding'
            : 'structure:page-detail',
        ]),
      }),
      score:
        (signals.hasPageDetailStructure ? 12 : 0) +
        (signals.hasConcretePageBindings ? 4 : 0) +
        (normalizedNeeds.has('page-detail') ? 2 : 0),
      priority: 100,
    });
  }

  if (signals.hasPostDetailStructure) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'single-post',
        route:
          templateBase === 'single' || templateBase === 'single-post'
            ? '/post/:slug'
            : `/${routeSlug}/:slug`,
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['post-detail'],
        disallowedDetailDataNeeds: [
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: new Set([...evidence, 'structure:post-detail']),
      }),
      score:
        12 +
        (normalizedNeeds.has('post-detail') ? 2 : 0) +
        (signals.structuralKinds.has('comments') ? 1 : 0),
      priority: 95,
    });
  }

  if (
    signals.hasSearchStructure &&
    (templateBase === 'search' ||
      signals.normalizedRouteHint === '/search' ||
      signals.normalizedRouteHint?.startsWith('/search/') === true)
  ) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'search',
        route: '/search',
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: ['posts'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: new Set([...evidence, 'structure:search']),
      }),
      score: 9,
      priority: 80,
    });
  }

  if (signals.hasCategoryArchiveHint && signals.hasArchiveStructure) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'category-archive',
        route: '/category/:slug',
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['categoryDetail', 'posts'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
        ],
        evidence: new Set([...evidence, 'structure:category-archive']),
      }),
      score: 9,
      priority: 90,
    });
  }

  if (signals.hasTagArchiveHint && signals.hasArchiveStructure) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'tag-archive',
        route: '/tag/:slug',
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['posts'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: new Set([...evidence, 'structure:tag-archive']),
      }),
      score: 8,
      priority: 85,
    });
  }

  if (signals.hasAuthorArchiveHint && signals.hasArchiveStructure) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'author-archive',
        route: '/author/:slug',
        routeMode: 'hard',
        isDetail: true,
        requiredDataNeeds: ['posts'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: new Set([...evidence, 'structure:author-archive']),
      }),
      score: 8,
      priority: 84,
    });
  }

  if (
    signals.hasPostsIndexStructure &&
    (templateBase === 'blog' ||
      templateBase === 'index' ||
      templateBase === 'home' ||
      templateBase === 'front-page' ||
      signals.hasBlogRouteHint)
  ) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: templateBase === 'front-page' ? 'home' : 'posts-index',
        route:
          signals.normalizedRouteHint ??
          (templateBase === 'index' || templateBase === 'front-page'
            ? '/'
            : '/blog'),
        routeMode: 'soft',
        isDetail: false,
        requiredDataNeeds: ['posts'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: new Set([
          ...evidence,
          templateBase === 'front-page'
            ? 'structure:front-page-home'
            : 'structure:posts-index',
        ]),
      }),
      score: 7,
      priority: 70,
    });
  }

  if (
    signals.hasArchiveStructure &&
    (templateBase === 'archive' || signals.hasArchiveRouteHint)
  ) {
    candidates.push({
      ...buildFixedArchetypeContract({
        archetype: 'archive',
        route: signals.normalizedRouteHint ?? '/archive',
        routeMode: 'hard',
        isDetail: false,
        requiredDataNeeds: ['posts'],
        disallowedDetailDataNeeds: [
          'post-detail',
          'product-detail',
          'page-detail',
          'categoryDetail',
        ],
        evidence: new Set([...evidence, 'structure:archive']),
      }),
      score: 6,
      priority: 60,
    });
  }

  const winner = candidates
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.priority - left.priority;
    })
    .at(0);

  return winner && winner.score >= 6
    ? {
        archetype: winner.archetype,
        type: winner.type,
        route: winner.route,
        routeMode: winner.routeMode,
        isDetail: winner.isDetail,
        requiredDataNeeds: winner.requiredDataNeeds,
        disallowedDetailDataNeeds: winner.disallowedDetailDataNeeds,
        evidence: winner.evidence,
      }
    : undefined;
}

function buildFixedArchetypeContract(input: {
  archetype: DeterministicRouteContract['archetype'];
  route: string | null;
  routeMode: 'hard' | 'soft';
  isDetail: boolean;
  requiredDataNeeds: RouteContractDataNeed[];
  disallowedDetailDataNeeds: RouteContractDataNeed[];
  evidence: Set<string>;
}): DeterministicRouteContract {
  return {
    archetype: input.archetype,
    type: input.archetype === 'partial' ? 'partial' : 'page',
    route: input.route,
    routeMode: input.routeMode,
    isDetail: input.isDetail,
    requiredDataNeeds: input.requiredDataNeeds,
    disallowedDetailDataNeeds: input.disallowedDetailDataNeeds,
    evidence: [...input.evidence],
  };
}

function collectStructuralKinds(input: RouteContractInput): Set<string> {
  const kinds = new Set<string>();
  const visit = (node: BlockNode) => {
    const normalizedKind = normalizeBlockKind(node.kind || node.blockName);
    if (normalizedKind) {
      kinds.add(normalizedKind);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of input.draftBlockTree ?? []) {
    visit(node);
  }
  for (const node of input.renderContract?.sourceModel.blockTree ?? []) {
    visit(node);
  }
  return kinds;
}

function normalizeBlockKind(value: string | undefined): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function isLikelyPageTemplate(templateBase: string): boolean {
  return (
    templateBase === 'frontend-page' ||
    templateBase === 'page' ||
    /^page-.+$/.test(templateBase)
  );
}

export function toTemplateBase(templateName: string): string {
  return templateName.replace(/\.(php|html)$/i, '').toLowerCase();
}

function collectExplicitHomeBases(
  repoManifest?: RepoThemeManifest,
  explicitTemplateNames: string[] = [],
): Set<HomeTemplateBase> {
  const explicitBases = new Set<HomeTemplateBase>();
  for (const templateName of explicitTemplateNames) {
    const base = toHomeTemplateBase(templateName);
    if (base) explicitBases.add(base);
  }

  if (!repoManifest) return explicitBases;

  const markIfHomeBase = (value: string | undefined) => {
    const base = toHomeTemplateBase(value ?? '');
    if (base) explicitBases.add(base);
  };

  for (const chain of repoManifest.structureHints.entrySourceChains) {
    markIfHomeBase(chain.entryFile.split('/').pop() ?? chain.entryFile);
  }
  for (const file of repoManifest.structureHints.fileAnalyses) {
    if (!['template', 'pattern', 'php-template'].includes(file.kind)) continue;
    markIfHomeBase(file.file.split('/').pop() ?? file.file);
  }

  return explicitBases;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function normalizeRouteHint(value?: string | null): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/, '') || '/';
}

function resolveStaticPageFallbackRoute(input: {
  templateBase: string;
  routeSlug: string;
  routeHint: string | null;
  inputRoute?: string | null;
}): string {
  const canonicalRoute = `/${input.routeSlug}`;
  const normalizedInputRoute = normalizeRouteHint(input.inputRoute);
  if (
    normalizedInputRoute &&
    normalizedInputRoute !== '/' &&
    normalizedInputRoute !== '*' &&
    !normalizedInputRoute.includes(':slug')
  ) {
    return normalizedInputRoute;
  }

  const routeHint = input.routeHint;
  if (!routeHint || routeHint === '/' || routeHint === '*') {
    return canonicalRoute;
  }

  const hintSlug =
    routeHint.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
  const templateSlug = input.routeSlug.toLowerCase();
  const genericFamilyHints = new Set([
    'blog',
    'home',
    'index',
    'archive',
    'search',
    'single',
    'page',
    'front-page',
  ]);

  if (
    hintSlug &&
    hintSlug !== templateSlug &&
    genericFamilyHints.has(hintSlug)
  ) {
    return canonicalRoute;
  }

  return routeHint;
}

function findMatchingEntrySourceChain(
  templateName: string,
  repoManifest: RepoThemeManifest,
):
  | RepoThemeManifest['structureHints']['entrySourceChains'][number]
  | undefined {
  return repoManifest.structureHints.entrySourceChains.find((chain) =>
    matchesRepoEntrySourceTemplate(templateName, chain.entryFile),
  );
}
