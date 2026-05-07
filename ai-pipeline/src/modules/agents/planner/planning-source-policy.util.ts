import { basename } from 'path';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type {
  RepoEntrySourceChain,
  RepoThemeManifest,
} from '../repo-analyzer/repo-analyzer.service.js';
import { wpBlocksToJson } from '../../../common/utils/wp-block-to-json.js';
import { extractStaticImageSources } from '../../../common/utils/theme-asset.util.js';
import {
  detectInteractiveWidgetsFromSource,
  scorePlanningSourceRichness,
} from './planning-source-analysis.util.js';
import type { PlanningSourceCandidate } from './planner-visual-repair.service.js';
import { toHomeTemplateBase } from './route-contract.util.js';

export interface PlanningSourcePolicyComponentPlan {
  templateName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  fixedSlug?: string;
  fixedPageId?: number | string;
}

export interface PlanningSourcePolicyPageLike {
  id: number | string;
  slug?: string | null;
  title: string;
  content: string;
  template?: string | null;
}

export interface PlanningSourcePolicyPostLike {
  id: number | string;
  slug?: string | null;
  content: string;
}

interface PlanningSourceSeed {
  source: string;
  label: string;
  templateName?: string;
  sourceFile?: string;
  priority: number;
}

export interface BuildPlanningSourceCandidatesInput {
  componentPlan: PlanningSourcePolicyComponentPlan;
  templateSource: string;
  sourceMap: Map<string, string>;
  content: DbContentResult;
  repoManifest?: RepoThemeManifest;
  findRepoEntrySourceChain: (
    templateName: string,
    repoManifest?: RepoThemeManifest,
  ) => RepoEntrySourceChain | undefined;
  inferSourceFile: (
    templateName: string,
    componentType: 'page' | 'partial',
  ) => string;
  findRepresentativePagesForTemplate: (
    componentPlan: PlanningSourcePolicyComponentPlan,
    content: DbContentResult,
  ) => PlanningSourcePolicyPageLike[];
  findRepresentativePostsForTemplate: (
    componentPlan: PlanningSourcePolicyComponentPlan,
    content: DbContentResult,
  ) => PlanningSourcePolicyPostLike[];
}

export interface PickInvestigativePlanningSourceInput extends BuildPlanningSourceCandidatesInput {
  currentPlanningSource?: {
    source?: string;
    sourceLabel?: string;
  };
  previousReason: string;
}

function sourceLooksLikePatternShell(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;

  try {
    const nodes = wpBlocksToJson(trimmed);
    if (nodes.length === 0) return false;

    let hasPattern = false;
    for (const node of nodes) {
      const block = String(node.block ?? '').toLowerCase();
      if (block === 'pattern' || block === 'core/pattern') {
        hasPattern = true;
        continue;
      }
      if (block === 'template-part' || block === 'core/template-part') {
        continue;
      }
      return false;
    }

    return hasPattern;
  } catch {
    return (
      /wp:pattern/i.test(trimmed) &&
      !/wp:(?:group|columns|column|cover|image|heading|paragraph|query|details|buttons?)/i.test(
        trimmed,
      )
    );
  }
}

function isProfolioFsePlanningFusionEnabled(content: DbContentResult): boolean {
  return content.themeResolvedContent?.themeSlug === 'profolio-fse';
}

function normalizePlanningThemeSlug(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function getProfolioFseBoundPageArchetypeTemplates(): string[] {
  return [
    'page',
    'template-about',
    'template-contact',
    'template-services',
    'blank',
    'full-width',
  ];
}

function getDbTemplateCanonicalSlug(
  template: DbContentResult['dbTemplates'][number],
): string {
  return normalizePlanningTemplateIdentifier(
    template.canonicalSlug || template.slug,
  );
}

function isTrustedProfolioFseDbTemplate(
  template: DbContentResult['dbTemplates'][number],
): boolean {
  const themeSlug = normalizePlanningThemeSlug(template.themeSlug);
  if (themeSlug === 'profolio-fse') return true;
  if (themeSlug) return false;

  const sourceEntityKey = String(template.sourceEntityKey ?? '')
    .trim()
    .toLowerCase();
  if (sourceEntityKey.startsWith('profolio-fse//')) return true;

  const content = String(template.content ?? '');
  return (
    /profolio-fse\//i.test(content) ||
    /"theme"\s*:\s*"profolio-fse"/i.test(content)
  );
}

export function getTrustedPlanningDbTemplates(
  content: DbContentResult,
): DbContentResult['dbTemplates'] {
  if (!isProfolioFsePlanningFusionEnabled(content)) {
    return content.dbTemplates;
  }

  return content.dbTemplates.filter((template) => {
    const canonicalSlug = getDbTemplateCanonicalSlug(template);
    if (!canonicalSlug) return false;
    return isTrustedProfolioFseDbTemplate(template);
  });
}

export function getTrustedPlanningDbTemplateSlugs(
  content: DbContentResult,
): string[] {
  return getTrustedPlanningDbTemplates(content)
    .map((template) => getDbTemplateCanonicalSlug(template))
    .filter(Boolean);
}

function shouldForcePostsHomeRoot(
  content: DbContentResult,
  trustedDbTemplates: DbContentResult['dbTemplates'],
): boolean {
  if (content.readingSettings?.showOnFront !== 'posts') return false;
  if (Number(content.readingSettings?.pageOnFrontId ?? 0) > 0) return false;
  const hasTrustedDbFrontPage = trustedDbTemplates.some((template) =>
    ['front-page', 'frontend-page'].includes(
      getDbTemplateCanonicalSlug(template),
    ),
  );
  return !hasTrustedDbFrontPage;
}

export function isAuthoritativeDbPlanningSource(
  componentPlan: PlanningSourcePolicyComponentPlan,
  label: string | undefined,
): boolean {
  const normalized = String(label ?? '')
    .trim()
    .toLowerCase();
  if (!normalized.startsWith('db:')) return false;

  if (componentPlan.route === '/') {
    return (
      /^db:page-on-front(?::|$)/.test(normalized) ||
      /^db:[^:]+:front-page$/.test(normalized)
    );
  }

  if (componentPlan.fixedSlug) {
    return /^db:bound-page:(.+)$/.test(normalized);
  }

  return false;
}

export function shouldDisableSupplementalPlanningSources(
  componentPlan: PlanningSourcePolicyComponentPlan,
  preferredSource: PlanningSourceCandidate,
): boolean {
  return isAuthoritativeDbPlanningSource(componentPlan, preferredSource.label);
}

function isRepoArchetypeLabel(label: string): boolean {
  return /^repo-archetype:/i.test(label.trim());
}

function isRepoChainLabel(label: string): boolean {
  return /^repo-chain:/i.test(label.trim());
}

function isDbPageContentLabel(label: string): boolean {
  return /^(db:bound-page:|db:page:|db:page-on-front(?::|$)|db:page-for-posts(?::|$))/i.test(
    label.trim(),
  );
}

function isRepoLikePlanningSourceOrigin(origin: string): boolean {
  return (
    origin === 'repo' || origin === 'repo-chain' || origin === 'repo-archetype'
  );
}

function shouldPreferDbPageContentPrimary(
  componentPlan: PlanningSourcePolicyComponentPlan,
  candidate: PlanningSourceSeed,
  content: DbContentResult,
): boolean {
  if (!isProfolioFsePlanningFusionEnabled(content)) return false;
  if (componentPlan.type !== 'page') return false;
  if (!candidate.source.trim()) return false;
  if (!isDbPageContentLabel(candidate.label)) return false;

  const templateName = normalizePlanningTemplateIdentifier(
    componentPlan.templateName,
  );
  if (/^(search|archive|404|single|single-with-sidebar)$/i.test(templateName)) {
    return false;
  }

  if (componentPlan.route === '/') {
    return /^(db:page-on-front(?::|$)|db:page-for-posts(?::|$))/i.test(
      candidate.label.trim(),
    );
  }

  return true;
}

function findProfolioFseRouteSourceSummary(
  templateName: string,
  repoManifest?: RepoThemeManifest,
) {
  if (repoManifest?.themeDeepAnalysis?.themeSlug !== 'profolio-fse') {
    return undefined;
  }

  const normalizedTemplate = normalizePlanningTemplateIdentifier(templateName);
  if (!normalizedTemplate) return undefined;

  const familyAliases = new Set<string>([normalizedTemplate]);
  if (normalizedTemplate === 'header') familyAliases.add('shared-header');
  if (normalizedTemplate === 'footer') familyAliases.add('shared-footer');

  return repoManifest.themeDeepAnalysis.routeSources.find((routeSource) => {
    const entryTemplate = normalizePlanningTemplateIdentifier(
      routeSource.entryFile,
    );
    return (
      familyAliases.has(routeSource.routeFamily) ||
      familyAliases.has(entryTemplate)
    );
  });
}

function findProfolioFseArchetypeEntryChain(
  templateName: string,
  repoManifest?: RepoThemeManifest,
): RepoEntrySourceChain | undefined {
  const routeSource = findProfolioFseRouteSourceSummary(
    templateName,
    repoManifest,
  );
  if (!routeSource) return undefined;

  return repoManifest?.structureHints.entrySourceChains.find(
    (chain) => chain.entryFile === routeSource.entryFile,
  );
}

function buildProfolioFseArchetypeSeed(input: {
  templateName: string;
  priority: number;
  repoManifest?: RepoThemeManifest;
}): PlanningSourceSeed | null {
  const routeSource = findProfolioFseRouteSourceSummary(
    input.templateName,
    input.repoManifest,
  );
  const chain = findProfolioFseArchetypeEntryChain(
    input.templateName,
    input.repoManifest,
  );
  if (!routeSource || !chain?.composedSource?.trim()) {
    return null;
  }

  return {
    source: chain.composedSource,
    label: `repo-archetype:${routeSource.routeFamily}`,
    templateName: normalizePlanningTemplateIdentifier(routeSource.entryFile),
    sourceFile: routeSource.entryFile,
    priority: input.priority,
  };
}

export function extractPlanningSourceOrigin(label: string): string {
  const [origin] = label.split(':', 1);
  return origin?.trim().toLowerCase() || 'unknown';
}

export function isCompatibleSupplementalPlanningSource(
  componentPlan: PlanningSourcePolicyComponentPlan,
  preferredSource: PlanningSourceCandidate,
  candidate: PlanningSourceCandidate,
): boolean {
  const normalize = (value: string | undefined): string =>
    String(value ?? '')
      .trim()
      .toLowerCase();

  const preferredTemplate = normalize(preferredSource.templateName);
  const candidateTemplate = normalize(candidate.templateName);
  if (!preferredTemplate || !candidateTemplate) return false;

  const preferredLabel = preferredSource.label.trim();
  const candidateLabel = candidate.label.trim();
  const candidateOrigin = extractPlanningSourceOrigin(candidateLabel);
  const candidateIsRepoArchetype = isRepoArchetypeLabel(candidateLabel);
  const candidateIsRepoChain = isRepoChainLabel(candidateLabel);
  const candidateIsRepoLike = isRepoLikePlanningSourceOrigin(candidateOrigin);
  const sameTemplateFamily =
    preferredTemplate === candidateTemplate ||
    (componentPlan.route === '/' &&
      !!toHomeTemplateBase(preferredTemplate) &&
      !!toHomeTemplateBase(candidateTemplate));

  if (preferredLabel.startsWith('db:') && candidateIsRepoLike) {
    if (
      isDbPageContentLabel(preferredLabel) &&
      (candidateIsRepoArchetype || candidateIsRepoChain) &&
      sameTemplateFamily
    ) {
      return true;
    }
    return false;
  }

  if (
    componentPlan.dataNeeds?.includes('post-detail') &&
    !componentPlan.fixedSlug &&
    candidate.label.startsWith('db:posts/')
  ) {
    return false;
  }

  if (preferredTemplate === candidateTemplate) return true;

  if (componentPlan.route === '/') {
    if (
      toHomeTemplateBase(preferredTemplate) &&
      toHomeTemplateBase(candidateTemplate)
    ) {
      return true;
    }
  }

  return false;
}

export function buildPlanningSourceCandidates(
  input: BuildPlanningSourceCandidatesInput,
): PlanningSourceCandidate[] {
  const {
    componentPlan,
    templateSource,
    sourceMap,
    content,
    repoManifest,
    findRepoEntrySourceChain,
    inferSourceFile,
    findRepresentativePagesForTemplate,
    findRepresentativePostsForTemplate,
  } = input;
  const profolioFusionEnabled = isProfolioFsePlanningFusionEnabled(content);
  const repoEntryChain = findRepoEntrySourceChain(
    componentPlan.templateName,
    repoManifest,
  );
  const preferRepoChainForPatternShell =
    componentPlan.type === 'page' &&
    !!repoEntryChain?.composedSource &&
    sourceLooksLikePatternShell(templateSource);
  const profolioArchetypeSeed = buildProfolioFseArchetypeSeed({
    templateName: componentPlan.templateName,
    priority: preferRepoChainForPatternShell
      ? componentPlan.route === '/'
        ? 110
        : componentPlan.fixedSlug
          ? 95
          : 80
      : componentPlan.route === '/'
        ? 92
        : componentPlan.fixedSlug
          ? 78
          : 62,
    repoManifest,
  });
  const trustedDbTemplates = getTrustedPlanningDbTemplates(content);
  const forcePostsHomeRoot = shouldForcePostsHomeRoot(
    content,
    trustedDbTemplates,
  );
  const candidates: PlanningSourceSeed[] = [];
  const seen = new Set<string>();

  const pushCandidate = (candidate: {
    source?: string;
    label: string;
    templateName?: string;
    sourceFile?: string;
    priority: number;
  }) => {
    const normalized = String(candidate.source ?? '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({
      source: normalized,
      label: candidate.label,
      templateName: candidate.templateName,
      sourceFile: candidate.sourceFile,
      priority: candidate.priority,
    });
  };

  if (componentPlan.fixedSlug) {
    const boundPage = content.pages.find(
      (page) =>
        String(page.id) === String(componentPlan.fixedPageId ?? '') ||
        page.slug === componentPlan.fixedSlug,
    );
    pushCandidate({
      source: boundPage?.content,
      label: boundPage
        ? `db:bound-page:${boundPage.slug || boundPage.id}`
        : `db:bound-page:${componentPlan.fixedSlug}`,
      templateName: componentPlan.templateName,
      sourceFile: boundPage
        ? `db:pages/${boundPage.slug || boundPage.id}`
        : `db:pages/${componentPlan.fixedSlug}`,
      priority: 120,
    });
  }

  if (!(profolioArchetypeSeed && sourceLooksLikePatternShell(templateSource))) {
    pushCandidate({
      source: templateSource,
      label: `repo:${componentPlan.templateName}`,
      templateName: componentPlan.templateName,
      sourceFile: inferSourceFile(
        componentPlan.templateName,
        componentPlan.type,
      ),
      priority: preferRepoChainForPatternShell ? 8 : repoEntryChain ? 35 : 15,
    });
  }

  if (profolioArchetypeSeed) {
    pushCandidate(profolioArchetypeSeed);
  }

  pushCandidate({
    source: repoEntryChain?.composedSource,
    label: repoEntryChain
      ? `repo-chain:${repoEntryChain.entryFile}`
      : `repo-chain:${componentPlan.templateName}`,
    templateName: componentPlan.templateName,
    sourceFile: repoEntryChain?.entryFile,
    priority: preferRepoChainForPatternShell
      ? componentPlan.route === '/'
        ? 105
        : componentPlan.fixedSlug
          ? 90
          : 75
      : componentPlan.route === '/'
        ? 85
        : componentPlan.fixedSlug
          ? 70
          : 55,
  });

  if (componentPlan.route === '/') {
    for (const templateName of ['front-page', 'home', 'index']) {
      if (forcePostsHomeRoot && templateName === 'front-page') {
        continue;
      }
      const candidateChain = findRepoEntrySourceChain(
        templateName,
        repoManifest,
      );
      const archetypeSeed = buildProfolioFseArchetypeSeed({
        templateName,
        priority:
          templateName === 'front-page'
            ? 100
            : templateName === 'home'
              ? 78
              : 63,
        repoManifest,
      });
      if (archetypeSeed) {
        pushCandidate(archetypeSeed);
      }
      pushCandidate({
        source: candidateChain?.composedSource ?? sourceMap.get(templateName),
        label: `repo:${templateName}`,
        templateName,
        sourceFile:
          candidateChain?.entryFile ??
          inferSourceFile(templateName, componentPlan.type),
        priority:
          templateName === 'front-page'
            ? candidateChain
              ? 95
              : 30
            : templateName === 'home'
              ? candidateChain
                ? 75
                : 20
              : candidateChain
                ? 60
                : 10,
      });
    }

    const frontPage = content.readingSettings?.pageOnFrontId
      ? content.pages.find(
          (page) => page.id === content.readingSettings.pageOnFrontId,
        )
      : undefined;
    pushCandidate({
      source: frontPage?.content,
      label: frontPage
        ? `db:page-on-front:${frontPage.slug || frontPage.id}`
        : 'db:page-on-front',
      templateName: componentPlan.templateName,
      sourceFile: frontPage
        ? `db:pages/${frontPage.slug || frontPage.id}`
        : 'db:pages/front-page',
      priority: content.readingSettings?.showOnFront === 'page' ? 60 : 25,
    });

    const postsPage = content.readingSettings?.pageForPostsId
      ? content.pages.find(
          (page) => page.id === content.readingSettings.pageForPostsId,
        )
      : undefined;
    pushCandidate({
      source: postsPage?.content,
      label: postsPage
        ? `db:page-for-posts:${postsPage.slug || postsPage.id}`
        : 'db:page-for-posts',
      templateName: componentPlan.templateName,
      sourceFile: postsPage
        ? `db:pages/${postsPage.slug || postsPage.id}`
        : 'db:pages/posts-page',
      priority: 45,
    });

    for (const dbTemplate of trustedDbTemplates.filter((entry) =>
      ['front-page', 'home', 'index'].includes(
        getDbTemplateCanonicalSlug(entry),
      ),
    )) {
      const canonicalSlug = getDbTemplateCanonicalSlug(dbTemplate);
      pushCandidate({
        source: dbTemplate.content,
        label: `db:${dbTemplate.postType}:${canonicalSlug}`,
        templateName: canonicalSlug,
        sourceFile: `db:${dbTemplate.postType}/${canonicalSlug}`,
        priority:
          canonicalSlug === 'front-page'
            ? 55
            : canonicalSlug === 'home'
              ? 50
              : 40,
      });
    }
  }

  if (componentPlan.fixedSlug && componentPlan.route !== '/') {
    const boundPage = content.pages.find(
      (page) =>
        String(page.id) === String(componentPlan.fixedPageId ?? '') ||
        page.slug === componentPlan.fixedSlug,
    );
    const assignedTemplate = normalizePlanningTemplateIdentifier(
      boundPage?.template,
    );
    const resolvedRoute = content.themeResolvedContent?.routes.find(
      (route) =>
        String(route.pageId) === String(componentPlan.fixedPageId ?? '') ||
        route.slug === componentPlan.fixedSlug,
    );
    const resolvedTemplateNames = resolvedRoute
      ? [
          ...resolvedRoute.templateCandidates,
          ...resolvedRoute.matchedDbTemplateSlugs,
        ]
          .map((entry) => normalizePlanningTemplateIdentifier(entry))
          .filter(Boolean)
      : [];
    const pageTemplateNames = [
      assignedTemplate || null,
      ...resolvedTemplateNames,
      `page-${componentPlan.fixedSlug}`,
      componentPlan.fixedPageId ? `page-${componentPlan.fixedPageId}` : null,
      'page',
      'singular',
    ]
      .filter(
        (templateName): templateName is string =>
          Boolean(templateName) && templateName !== componentPlan.templateName,
      )
      .filter(
        (templateName, index, all) => all.indexOf(templateName) === index,
      );

    if (
      profolioFusionEnabled &&
      (assignedTemplate === '' ||
        assignedTemplate === 'default' ||
        pageTemplateNames.length <= 2)
    ) {
      for (const templateName of getProfolioFseBoundPageArchetypeTemplates()) {
        if (!pageTemplateNames.includes(templateName)) {
          pageTemplateNames.push(templateName);
        }
      }
    }

    for (const templateName of pageTemplateNames) {
      const archetypeSeed = buildProfolioFseArchetypeSeed({
        templateName,
        priority:
          assignedTemplate && templateName === assignedTemplate
            ? 88
            : templateName.startsWith('page-')
              ? 72
              : 52,
        repoManifest,
      });
      if (archetypeSeed) {
        pushCandidate(archetypeSeed);
      }
      const chain = findRepoEntrySourceChain(templateName, repoManifest);
      pushCandidate({
        source: chain?.composedSource ?? sourceMap.get(templateName),
        label: `repo:${templateName}`,
        templateName,
        sourceFile:
          chain?.entryFile ?? inferSourceFile(templateName, componentPlan.type),
        priority:
          assignedTemplate && templateName === assignedTemplate
            ? chain
              ? 85
              : 30
            : templateName.startsWith('page-')
              ? chain
                ? 70
                : 20
              : chain
                ? 50
                : 10,
      });
    }

    for (const templateName of pageTemplateNames) {
      const chain = findRepoEntrySourceChain(templateName, repoManifest);
      if (!chain?.composedSource) continue;
      pushCandidate({
        source: chain.composedSource,
        label: `repo-chain:${chain.entryFile ?? templateName}`,
        templateName,
        sourceFile: chain.entryFile,
        priority:
          assignedTemplate && templateName === assignedTemplate
            ? 80
            : templateName.startsWith('page-')
              ? 65
              : 45,
      });
    }

    const pageTemplateSlugs = new Set(
      [
        componentPlan.fixedSlug,
        assignedTemplate,
        ...resolvedTemplateNames,
        `page-${componentPlan.fixedSlug}`,
      ].filter(Boolean),
    );
    for (const dbTemplate of trustedDbTemplates.filter((entry) =>
      pageTemplateSlugs.has(getDbTemplateCanonicalSlug(entry)),
    )) {
      const canonicalSlug = getDbTemplateCanonicalSlug(dbTemplate);
      pushCandidate({
        source: dbTemplate.content,
        label: `db:${dbTemplate.postType}:${canonicalSlug}`,
        templateName: canonicalSlug,
        sourceFile: `db:${dbTemplate.postType}/${canonicalSlug}`,
        priority: canonicalSlug === componentPlan.fixedSlug ? 55 : 40,
      });
    }
  }

  for (const page of findRepresentativePagesForTemplate(
    componentPlan,
    content,
  )) {
    pushCandidate({
      source: page.content,
      label: `db:page:${page.slug || page.id}`,
      templateName: componentPlan.templateName,
      sourceFile: `db:pages/${page.slug || page.id}`,
      priority: 35,
    });
  }

  for (const post of findRepresentativePostsForTemplate(
    componentPlan,
    content,
  )) {
    pushCandidate({
      source: post.content,
      label: `db:post:${post.slug || post.id}`,
      templateName: componentPlan.templateName,
      sourceFile: `db:posts/${post.slug || post.id}`,
      priority: 5,
    });
  }

  const preferRepoFrontPageForRoot =
    componentPlan.route === '/' &&
    !forcePostsHomeRoot &&
    candidates.some((candidate) => {
      const normalizedLabel = candidate.label.trim().toLowerCase();
      return (
        /^repo(?:-|:)/.test(normalizedLabel) &&
        String(candidate.templateName ?? '')
          .trim()
          .toLowerCase() === 'front-page'
      );
    }) &&
    !candidates.some((candidate) => {
      const normalizedLabel = candidate.label.trim().toLowerCase();
      return (
        /^db:page-on-front(?::|$)/.test(normalizedLabel) ||
        /^db:[^:]+:front-page$/.test(normalizedLabel)
      );
    });

  const filteredRootCandidates = preferRepoFrontPageForRoot
    ? candidates.filter((candidate) => {
        const normalizedLabel = candidate.label.trim().toLowerCase();
        return !/^db:[^:]+:home$/.test(normalizedLabel);
      })
    : candidates;

  const hasRichDbCandidate = filteredRootCandidates.some(
    (candidate) =>
      candidate.label.startsWith('db:') && candidate.source.trim().length > 0,
  );
  const hasAuthoritativeDbCandidate = filteredRootCandidates.some(
    (candidate) =>
      candidate.source.trim().length > 0 &&
      isAuthoritativeDbPlanningSource(componentPlan, candidate.label),
  );

  const filteredCandidates =
    profolioFusionEnabled && (hasAuthoritativeDbCandidate || hasRichDbCandidate)
      ? filteredRootCandidates.filter((candidate) => {
          const label = candidate.label.trim().toLowerCase();
          if (label.startsWith('db:')) return true;
          if (/^repo-chain:/.test(label) || /^repo-archetype:/.test(label)) {
            return true;
          }
          if (
            componentPlan.fixedSlug &&
            /^repo:/.test(label) &&
            getProfolioFseBoundPageArchetypeTemplates().includes(
              normalizePlanningTemplateIdentifier(candidate.templateName),
            )
          ) {
            return true;
          }
          return !hasRichDbCandidate && !hasAuthoritativeDbCandidate;
        })
      : hasAuthoritativeDbCandidate
        ? filteredRootCandidates.filter((candidate) =>
            candidate.label.startsWith('db:'),
          )
        : hasRichDbCandidate
          ? filteredRootCandidates.filter(
              (candidate) => !/^repo:/.test(candidate.label),
            )
          : filteredRootCandidates;

  return filteredCandidates
    .map((candidate) => ({
      ...candidate,
      richness:
        scorePlanningSourceRichness(candidate.source) +
        (isAuthoritativeDbPlanningSource(componentPlan, candidate.label)
          ? 50000
          : 0) +
        (shouldPreferDbPageContentPrimary(componentPlan, candidate, content)
          ? 20000
          : 0) +
        (componentPlan.fixedSlug && candidate.label.startsWith('db:bound-page:')
          ? 10000
          : 0),
    }))
    .map((candidate) => ({
      ...candidate,
      selectionScore:
        candidate.richness +
        candidate.priority * 20 -
        (!componentPlan.fixedSlug &&
        componentPlan.dataNeeds.includes('post-detail') &&
        /^db:post:/i.test(candidate.label)
          ? 10000
          : 0),
    }))
    .sort((a, b) => {
      if (
        (b.selectionScore ?? Number.NEGATIVE_INFINITY) !==
        (a.selectionScore ?? Number.NEGATIVE_INFINITY)
      ) {
        return (
          (b.selectionScore ?? Number.NEGATIVE_INFINITY) -
          (a.selectionScore ?? Number.NEGATIVE_INFINITY)
        );
      }
      if (b.richness !== a.richness) return b.richness - a.richness;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.source.length - a.source.length;
    })
    .map((candidate, index) => ({
      ...candidate,
      reason:
        index === 0
          ? `highest combined source selected (selectionScore=${candidate.selectionScore ?? candidate.richness}, richness=${candidate.richness}, priority=${candidate.priority})`
          : `alternate candidate (selectionScore=${candidate.selectionScore ?? candidate.richness}, richness=${candidate.richness}, priority=${candidate.priority})`,
    }));
}

export function pickInvestigativePlanningSource(
  input: PickInvestigativePlanningSourceInput,
): PlanningSourceCandidate | null {
  const { currentPlanningSource, previousReason } = input;
  const focusWidgets = new Set<string>();
  if (/carousel|slider/i.test(previousReason)) focusWidgets.add('carousel');
  if (/modal/i.test(previousReason)) focusWidgets.add('modal');
  if (/accordion/i.test(previousReason)) focusWidgets.add('accordion');
  if (/tabs/i.test(previousReason)) focusWidgets.add('tabs');
  const imageSensitive = /imagesrc|image/i.test(previousReason);

  const candidates = buildPlanningSourceCandidates(input);
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((candidate) => {
      const widgets = new Set(
        detectInteractiveWidgetsFromSource(candidate.source),
      );
      let score = candidate.richness + candidate.priority;
      for (const widget of focusWidgets) {
        if (widgets.has(widget)) score += 140;
      }
      if (imageSensitive) {
        score += extractStaticImageSources(candidate.source).length * 20;
      }
      if (candidate.label === currentPlanningSource?.sourceLabel) score -= 40;
      if (candidate.source === currentPlanningSource?.source) score -= 40;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.candidate ?? null;
}

export function normalizePlanningTemplateIdentifier(
  value: string | undefined,
): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  return basename(trimmed)
    .replace(/\.(php|html)$/i, '')
    .toLowerCase();
}
