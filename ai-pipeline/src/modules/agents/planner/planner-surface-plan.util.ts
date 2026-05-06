import type {
  ComponentVisualPlan,
  SectionPlan,
} from '../react-generator/visual-plan.schema.js';
import type { PlannerSurfacePlan } from './planner-surface-plan.schema.js';

export interface SurfacePlanRegressionSnapshot {
  kind: PlannerSurfacePlan['kind'];
  authority: PlannerSurfacePlan['authority']['level'];
  pageIntent: PlannerSurfacePlan['pageIntent']['kind'];
  mustKeep: string[];
  mustNotInvent: string[];
  mayRecompose: string[];
  clusterKinds: string[];
  widgetKinds: string[];
  headingCount: number;
  navigationLabelCount: number;
  debugSectionKeys: string[];
  representativeBindings: string[];
  planningSourceLabel?: string;
}

export function resolveSurfacePlanLegacySections(
  surfacePlan?: PlannerSurfacePlan | null,
): SectionPlan[] {
  const sections = surfacePlan?.debug?.legacyDraftSections;
  return Array.isArray(sections) ? sections : [];
}

export function resolvePlannerSectionBlueprint(input: {
  visualPlan?: Pick<ComponentVisualPlan, 'sections'> | null;
  surfacePlan?: PlannerSurfacePlan | null;
}): SectionPlan[] {
  const visualSections = input.visualPlan?.sections;
  if (Array.isArray(visualSections) && visualSections.length > 0) {
    return visualSections;
  }
  return resolveSurfacePlanLegacySections(input.surfacePlan);
}

export function collectSurfacePlanRequiredLiterals(
  surfacePlan: PlannerSurfacePlan,
): string[] {
  const values: string[] = [];
  const authority = surfacePlan.authority.level;
  const ownsSharedChrome =
    surfacePlan.contract.sharedChromeOwnership === 'self';
  const isTransactionalCommerceSurface =
    surfacePlan.sourceEvidence.sourceFacts?.hasWooCart === true ||
    surfacePlan.sourceEvidence.sourceFacts?.hasWooCheckout === true;

  values.push(...surfacePlan.sourceEvidence.primaryHeadings.slice(0, 4));

  if (ownsSharedChrome) {
    values.push(
      ...(surfacePlan.sourceEvidence.navigationLabels ?? []).slice(0, 6),
    );
  }

  for (const cluster of surfacePlan.sourceEvidence.contentClusters) {
    if (cluster.importance === 'low') continue;
    values.push(...(cluster.ctaEvidence ?? []).slice(0, 2));
    if (authority !== 'free') {
      values.push(...(cluster.textEvidence ?? []).slice(0, 2));
    }
    if (values.length >= 18) break;
  }

  return [
    ...new Set(
      values
        .map(normalizeLiteral)
        .filter((value): value is string => Boolean(value))
        .filter((value) => value.length >= 4)
        .filter((value) => !/[{}]/.test(value))
        .filter((value) => !value.startsWith('/'))
        .filter((value) => !value.startsWith('#'))
        .filter((value) => !/^https?:\/\//i.test(value))
        .filter((value) => ownsSharedChrome || !isSharedChromeLiteral(value))
        .filter(
          (value) =>
            !isTransactionalCommerceSurface ||
            !isTransactionalCommerceLiteral(value),
        ),
    ),
  ].slice(0, authority === 'strict' ? 12 : authority === 'guided' ? 9 : 6);
}

export function buildSurfacePlanRegressionSnapshot(
  surfacePlan?: PlannerSurfacePlan | null,
): SurfacePlanRegressionSnapshot | null {
  if (!surfacePlan) return null;

  return {
    kind: surfacePlan.kind,
    authority: surfacePlan.authority.level,
    pageIntent: surfacePlan.pageIntent.kind,
    mustKeep: surfacePlan.acceptance.mustKeep.slice(0, 6),
    mustNotInvent: surfacePlan.acceptance.mustNotInvent.slice(0, 6),
    mayRecompose: surfacePlan.acceptance.mayRecompose.slice(0, 6),
    clusterKinds: surfacePlan.sourceEvidence.contentClusters
      .map((cluster) => `${cluster.kind}:${cluster.importance}`)
      .slice(0, 10),
    widgetKinds: surfacePlan.sourceEvidence.widgets
      .map((widget) =>
        widget.required ? `${widget.kind}:required` : widget.kind,
      )
      .slice(0, 10),
    headingCount: surfacePlan.sourceEvidence.primaryHeadings.length,
    navigationLabelCount:
      surfacePlan.sourceEvidence.navigationLabels?.length ?? 0,
    debugSectionKeys: resolveSurfacePlanLegacySections(surfacePlan)
      .map(
        (section, index) =>
          section.debugKey?.trim() ||
          section.sectionKey?.trim() ||
          `${section.type}-${index + 1}`,
      )
      .slice(0, 12),
    representativeBindings:
      surfacePlan.sourceEvidence.representativeBindings?.map(
        (binding) => `${binding.kind}:${binding.slug ?? binding.id}`,
      ) ?? [],
    planningSourceLabel: surfacePlan.sourceEvidence.planningSourceLabel,
  };
}

function normalizeLiteral(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function isSharedChromeLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (
    /©|copyright|all rights reserved|&copy;|developed by|powered by/i.test(
      value,
    )
  ) {
    return true;
  }
  return /^[a-z0-9-]+\.(com|net|org|io|co)(\.[a-z]{2})?$/i.test(normalized);
}

function isTransactionalCommerceLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return new Set([
    'checkout fields',
    'order summary',
    'billing details',
    'shipping address',
    'shipping methods',
    'payment',
    'additional information',
    'order note',
    'terms',
  ]).has(normalized);
}
