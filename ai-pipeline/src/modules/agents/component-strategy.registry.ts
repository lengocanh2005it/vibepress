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
    // AI reads the actual WP template — deterministic renderer is too generic
    // and produces layouts that diverge significantly from the original site.
    deterministicFirst: false,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^Footer$/i,
    kind: 'footer',
    // Footer is highly contract-sensitive (`footerLinks`, brandDescription,
    // shared chrome ownership). Prefer the deterministic visual-plan renderer
    // so reruns stay stable instead of drifting on prompt interpretation.
    deterministicFirst: true,
    skipAiVisualPlan: false,
    allowFramePath: false,
  },
  {
    match: /^Sidebar$/i,
    kind: 'sidebar',
    // Sidebar chrome/widgets should come from the actual source template, not
    // from a generic canonical fallback.
    deterministicFirst: false,
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
