export type ComponentStrategyKind =
  | 'not-found'
  | 'header'
  | 'footer'
  | 'sidebar'
  | 'breadcrumb'
  | 'comments'
  | 'post-meta'
  | 'meta-only';

interface ComponentStrategyRule {
  match: RegExp;
  kind: ComponentStrategyKind;
  deterministicFirst: boolean;
  skipAiVisualPlan: boolean;
  allowFramePath: boolean;
}

const COMPONENT_STRATEGY_RULES: ComponentStrategyRule[] = [
  {
    match: /^(Page404|NotFound)$/i,
    kind: 'not-found',
    // Prefer source-faithful generation from the theme template when available.
    deterministicFirst: false,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^(Header|Navigation|Nav)$/i,
    kind: 'header',
    // Shared chrome should now preserve the real WordPress block/source tree
    // end-to-end. Treat header/navigation as deterministic-first and only fall
    // back to AI when source parsing cannot provide a usable structure.
    deterministicFirst: true,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^Footer$/i,
    kind: 'footer',
    // Same policy as Header: prefer deterministic block-faithful rendering from
    // the resolved footer template/pattern tree for all themes.
    deterministicFirst: true,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^Sidebar$/i,
    kind: 'sidebar',
    // Sidebar widgets are now modeled explicitly in the visual plan, so the
    // deterministic renderer is more stable than free-form AI codegen here.
    deterministicFirst: true,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^Breadcrumb$/i,
    kind: 'breadcrumb',
    deterministicFirst: false,
    skipAiVisualPlan: false,
    allowFramePath: true,
  },
  {
    match: /^PostMeta$/i,
    kind: 'post-meta',
    // PostMeta layout/style often lives in theme patterns/template parts; let
    // AI read that source instead of using the canonical deterministic row.
    deterministicFirst: false,
    skipAiVisualPlan: false,
    allowFramePath: true,
  },
  {
    match: /^(Comments|Comment)$/i,
    kind: 'comments',
    deterministicFirst: false,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^SingleWithSidebar$/i,
    kind: 'meta-only',
    // This template is now contract-heavy and source-backed enough that the
    // deterministic renderer is more reliable than full-file AI generation.
    deterministicFirst: true,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^(Widget|Pagination|Loop|ContentNone|NoResults)$/i,
    kind: 'meta-only',
    deterministicFirst: false,
    skipAiVisualPlan: false,
    allowFramePath: true,
  },
];

export function getComponentStrategy(componentName: string): {
  kind?: ComponentStrategyKind;
  deterministicFirst: boolean;
  skipAiVisualPlan: boolean;
  allowFramePath: boolean;
} {
  const match = COMPONENT_STRATEGY_RULES.find((rule) =>
    rule.match.test(componentName),
  );
  if (!match) {
    return {
      deterministicFirst: false,
      skipAiVisualPlan: false,
      allowFramePath: false,
    };
  }
  return {
    kind: match.kind,
    deterministicFirst: match.deterministicFirst,
    skipAiVisualPlan: match.skipAiVisualPlan,
    allowFramePath: match.allowFramePath,
  };
}

export function isSharedChromePartialComponent(componentName: string): boolean {
  return /^(Header|Footer|Navigation|Nav)$/i.test(componentName);
}
