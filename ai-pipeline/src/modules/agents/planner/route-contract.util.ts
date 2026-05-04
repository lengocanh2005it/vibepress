import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { ComponentRenderContract } from './render-contract.schema.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';

export type RouteContractDataNeed =
  | 'posts'
  | 'pages'
  | 'menus'
  | 'site-info'
  | 'footer-links'
  | 'post-detail'
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
}

export interface RepoRouteHints {
  templatePartArea?: string;
  entryFile?: string;
  routeHint?: string;
  chainFiles: string[];
  blockTypes: string[];
  notes: string[];
}

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
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (HOME_TEMPLATE_PRIORITY_SET.has(templateBase)) {
    evidence.add(`home-template:${templateBase}`);
    return {
      archetype: templateBase === 'index' ? 'posts-index' : 'home',
      type: 'page',
      // Repo route hints for home-like templates are often coarse aliases
      // ("home"), so they are not trustworthy for the final route path here.
      route: input.route ?? '/',
      routeMode: 'soft',
      isDetail: false,
      requiredDataNeeds: [],
      disallowedDetailDataNeeds: [
        'post-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
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
        disallowedDetailDataNeeds: ['post-detail', 'categoryDetail'],
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
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
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
      disallowedDetailDataNeeds: ['post-detail', 'page-detail'],
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
        'page-detail',
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
      disallowedDetailDataNeeds: ['page-detail', 'categoryDetail'],
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
      route: templateBase === 'page' ? '/page/:slug' : `/${routeSlug}/:slug`,
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['page-detail'],
      disallowedDetailDataNeeds: ['post-detail', 'categoryDetail'],
      evidence,
    });
  }

  evidence.add('static-page-fallback');
  return {
    archetype: 'static-page',
    type: 'page',
    route: signals.normalizedRouteHint ?? `/${routeSlug}`,
    routeMode: 'soft',
    isDetail: false,
    requiredDataNeeds: [],
    disallowedDetailDataNeeds: ['post-detail', 'page-detail', 'categoryDetail'],
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
}): HomeHierarchyResolution {
  const uniqueTemplateNames = Array.from(new Set(input.templateNames));
  const homeEntries = uniqueTemplateNames
    .map((templateName) => ({
      templateName,
      base: toHomeTemplateBase(templateName),
    }))
    .filter(
      (entry): entry is { templateName: string; base: HomeTemplateBase } =>
        !!entry.base,
    );

  const presentBases = HOME_TEMPLATE_PRIORITY.filter((base) =>
    homeEntries.some((entry) => entry.base === base),
  );
  const winnerBase = presentBases[0] ?? null;
  const explicitBases = collectExplicitHomeBases(
    input.repoManifest,
    input.explicitTemplateNames,
  );
  const redundantBases = new Set<HomeTemplateBase>();
  const routeByBase: Partial<Record<HomeTemplateBase, string>> = {};

  const hasBase = (base: HomeTemplateBase) => presentBases.includes(base);
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
    if (redundantBases.has('home')) {
      routeByBase['index'] = '/blog';
    } else {
      if (hasBase('home')) routeByBase['home'] = '/blog';
      if (hasBase('index')) {
        routeByBase['index'] = hasExplicitHome ? '/index' : '/blog';
      }
    }
  } else if (winnerBase === 'front-page') {
    routeByBase['front-page'] = '/';
    if (redundantBases.has('home')) {
      routeByBase['index'] = '/blog';
    } else {
      if (hasBase('home')) routeByBase['home'] = '/blog';
      if (hasBase('index')) {
        routeByBase['index'] = hasExplicitHome ? '/index' : '/blog';
      }
    }
  } else if (winnerBase === 'home') {
    if (redundantBases.has('home')) {
      routeByBase['index'] = '/';
    } else {
      routeByBase['home'] = '/';
      if (hasBase('index')) routeByBase['index'] = '/index';
    }
  } else if (winnerBase === 'index') {
    routeByBase['index'] = '/';
  }

  const orderedTemplateNames = [
    ...HOME_TEMPLATE_PRIORITY.flatMap((base) =>
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
        disallowedDetailDataNeeds: ['post-detail', 'categoryDetail'],
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
        disallowedDetailDataNeeds: ['page-detail', 'categoryDetail'],
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
        disallowedDetailDataNeeds: ['post-detail', 'page-detail'],
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
