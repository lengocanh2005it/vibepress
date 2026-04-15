export type ComponentStrategyKind =
  | 'not-found'
  | 'header'
  | 'footer'
  | 'sidebar'
  | 'breadcrumb'
  | 'comments'
  | 'meta-only';

interface ComponentStrategyRule {
  match: RegExp;
  kind: ComponentStrategyKind;
  deterministicFirst: boolean;
  skipAiVisualPlan: boolean;
}

const COMPONENT_STRATEGY_RULES: ComponentStrategyRule[] = [
  {
    match: /^(Page404|NotFound)$/i,
    kind: 'not-found',
    deterministicFirst: true,
    skipAiVisualPlan: false,
  },
  {
    match: /^(Header|Navigation|Nav)$/i,
    kind: 'header',
    // AI reads the actual WP template — deterministic renderer is too generic
    // and produces layouts that diverge significantly from the original site.
    deterministicFirst: false,
    skipAiVisualPlan: false,
  },
  {
    match: /^Footer$/i,
    kind: 'footer',
    // Same reason as header — allow AI to faithfully recreate the WP footer.
    deterministicFirst: false,
    skipAiVisualPlan: false,
  },
  {
    match: /^Sidebar$/i,
    kind: 'sidebar',
    deterministicFirst: true,
    skipAiVisualPlan: false,
  },
  {
    match: /^Breadcrumb$/i,
    kind: 'breadcrumb',
    deterministicFirst: true,
    skipAiVisualPlan: false,
  },
  {
    match: /^(Comments|Comment)$/i,
    kind: 'comments',
    deterministicFirst: true,
    skipAiVisualPlan: false,
  },
  {
    match: /^(PostMeta|Widget|Pagination|Loop|ContentNone|NoResults)$/i,
    kind: 'meta-only',
    deterministicFirst: false,
    skipAiVisualPlan: true,
  },
];

export function getComponentStrategy(componentName: string): {
  kind?: ComponentStrategyKind;
  deterministicFirst: boolean;
  skipAiVisualPlan: boolean;
} {
  const match = COMPONENT_STRATEGY_RULES.find((rule) =>
    rule.match.test(componentName),
  );
  if (!match) {
    return {
      deterministicFirst: false,
      skipAiVisualPlan: false,
    };
  }
  return {
    kind: match.kind,
    deterministicFirst: match.deterministicFirst,
    skipAiVisualPlan: match.skipAiVisualPlan,
  };
}

export function isSharedChromePartialComponent(componentName: string): boolean {
  return /^(Header|Footer|Navigation|Nav)$/i.test(componentName);
}
