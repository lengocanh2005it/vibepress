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

const HOME_TEMPLATE_PRIORITY_SET = new Set(['frontend-page', 'home', 'index']);

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

  if (templateBase === 'search') {
    evidence.add('template:search');
    return {
      archetype: 'search',
      type: 'page',
      route: '/search',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (templateBase === 'archive') {
    evidence.add('template:archive');
    return {
      archetype: 'archive',
      type: 'page',
      route: '/archive',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (templateBase === 'blog') {
    evidence.add('template:blog');
    return {
      archetype: 'posts-index',
      type: 'page',
      route: '/blog',
      routeMode: 'hard',
      isDetail: false,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (
    /^category(?:-.+)?$/.test(templateBase) ||
    normalizedNeeds.has('categoryDetail')
  ) {
    evidence.add('category-archive-signal');
    return {
      archetype: 'category-archive',
      type: 'page',
      route: '/category/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['categoryDetail', 'posts'],
      disallowedDetailDataNeeds: ['post-detail', 'page-detail'],
      evidence: [...evidence],
    };
  }

  if (/^tag(?:-.+)?$/.test(templateBase)) {
    evidence.add('template:tag');
    return {
      archetype: 'tag-archive',
      type: 'page',
      route: '/tag/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (/^author(?:-.+)?$/.test(templateBase)) {
    evidence.add('template:author');
    return {
      archetype: 'author-archive',
      type: 'page',
      route: '/author/:slug',
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['posts'],
      disallowedDetailDataNeeds: [
        'post-detail',
        'page-detail',
        'categoryDetail',
      ],
      evidence: [...evidence],
    };
  }

  if (
    /^single(?:-.+)?$/.test(templateBase) ||
    (normalizedNeeds.has('post-detail') &&
      !normalizedNeeds.has('page-detail')) ||
    signals.hasPostDetailStructure
  ) {
    evidence.add(
      signals.hasPostDetailStructure
        ? 'structure:post-detail'
        : /^single(?:-.+)?$/.test(templateBase)
          ? `template:${templateBase}`
          : 'dataNeed:post-detail',
    );
    return {
      archetype: 'single-post',
      type: 'page',
      route:
        templateBase === 'single' || templateBase === 'single-post'
          ? '/post/:slug'
          : `/${routeSlug}/:slug`,
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['post-detail'],
      disallowedDetailDataNeeds: ['page-detail', 'categoryDetail'],
      evidence: [...evidence],
    };
  }

  if (
    templateBase === 'page' ||
    /^page-.+$/.test(templateBase) ||
    signals.hasConcretePageBindings ||
    signals.hasPageDetailStructure ||
    (normalizedNeeds.has('page-detail') &&
      !normalizedNeeds.has('post-detail') &&
      isLikelyPageTemplate(templateBase))
  ) {
    evidence.add(
      signals.hasConcretePageBindings
        ? 'db:page-binding'
        : signals.hasPageDetailStructure
          ? 'structure:page-detail'
          : templateBase === 'page' || /^page-.+$/.test(templateBase)
            ? `template:${templateBase}`
            : 'dataNeed:page-detail',
    );
    return {
      archetype: 'single-page',
      type: 'page',
      route: templateBase === 'page' ? '/page/:slug' : `/${routeSlug}/:slug`,
      routeMode: 'hard',
      isDetail: true,
      requiredDataNeeds: ['page-detail'],
      disallowedDetailDataNeeds: ['post-detail', 'categoryDetail'],
      evidence: [...evidence],
    };
  }

  evidence.add('static-page-fallback');
  return {
    archetype: 'static-page',
    type: 'page',
    route: `/${routeSlug}`,
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

function collectArchetypeSignals(
  input: RouteContractInput,
  normalizedNeeds: Set<RouteContractDataNeed>,
): {
  structuralKinds: Set<string>;
  isTemplatePartSource: boolean;
  hasConcretePageBindings: boolean;
  hasPageDetailStructure: boolean;
  hasPostDetailStructure: boolean;
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

  return {
    structuralKinds,
    isTemplatePartSource,
    hasConcretePageBindings,
    hasPageDetailStructure,
    hasPostDetailStructure,
    evidence,
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

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function findMatchingEntrySourceChain(
  templateName: string,
  repoManifest: RepoThemeManifest,
):
  | RepoThemeManifest['structureHints']['entrySourceChains'][number]
  | undefined {
  const normalizedTemplate = toTemplateBase(templateName);

  return repoManifest.structureHints.entrySourceChains.find((chain) => {
    const entryName = toTemplateBase(
      chain.entryFile.split('/').pop() ?? chain.entryFile,
    );
    if (entryName === normalizedTemplate) return true;

    if (
      normalizedTemplate === 'front-page' &&
      ['front-page', 'home'].includes(entryName)
    ) {
      return true;
    }
    if (
      normalizedTemplate === 'home' &&
      ['front-page', 'home', 'index'].includes(entryName)
    ) {
      return true;
    }

    return false;
  });
}
