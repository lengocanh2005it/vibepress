export interface AutomationCompareRegion {
  id?: string;
  kind?: string;
  severity?: 'low' | 'medium' | 'high' | string;
  diffPixels?: number | null;
  diffDensity?: number | null;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cropArtifacts?: {
    imageA?: string;
    imageB?: string;
    diff?: string;
  };
}

export interface AutomationComparePageVisual {
  status?: string | null;
  accuracy?: number | null;
  diffPct?: number | null;
  overlapDiffPct?: number | null;
  extraDiffPct?: number | null;
  overlapDiffPixels?: number | null;
  extraPixels?: number | null;
  artifacts?: {
    imageA?: string;
    imageB?: string;
    diff?: string;
  } | null;
  regions?: AutomationCompareRegion[];
  domComparison?: {
    similarityScore?: number | null;
  } | null;
  wpPath?: string | null;
  reactPath?: string | null;
  error?: string | null;
}

export interface AutomationComparePageContent {
  status?: string | null;
  scores?: {
    title?: number | null;
    content?: number | null;
    overall?: number | null;
  } | null;
  issues?: string[];
  wp?: {
    title?: string;
    contentPreview?: string;
  } | null;
  react?: {
    title?: string;
    contentPreview?: string;
  } | null;
}

export interface AutomationComparePageResult {
  routeKey?: string | null;
  route?: string | null;
  url?: string | null;
  slug?: string | null;
  type?: string | null;
  componentHint?: string | null;
  repairPriority?: string | null;
  visual?: AutomationComparePageVisual | null;
  content?: AutomationComparePageContent | null;
}

export type VisualMismatchRootCause =
  | 'plan-omission'
  | 'missing-section'
  | 'missing-image'
  | 'content-drift'
  | 'layout-drift'
  | 'route-mapping-error'
  | 'data-binding-error'
  | 'shared-layout-mismatch'
  | 'unknown';

export interface VisualMismatchIssue {
  type:
    | 'missing_section'
    | 'section_order'
    | 'layout_mismatch'
    | 'element_position'
    | 'style_mismatch'
    | 'content_missing'
    | 'image_mismatch'
    | 'unknown';
  severity: 'low' | 'medium' | 'high';
  sectionHint?: string;
  location?: string;
  evidence: string;
  suggestedFix: string;
  sourceBacked?: boolean;
}

export interface VisualMismatchDiagnosis {
  componentName: string;
  routeKey?: string | null;
  route?: string | null;
  shouldRepair: boolean;
  confidence: number;
  score: number;
  analysisMode?: 'vision' | 'text' | 'heuristic';
  rootCause: {
    primary: VisualMismatchRootCause;
    secondary: string[];
    reasoning: string;
  };
  evidence: {
    sourceHints: string[];
    missingLabels: string[];
    sectionLikelyMissingFromPlan: boolean;
  };
  issues: VisualMismatchIssue[];
  repairPlan: {
    strategy: string;
    instructions: string[];
    targetAreas: Array<{
      type: string;
      sectionHint?: string;
      headingHint?: string;
    }>;
    guardrails: string[];
  };
}

export interface PostEditVisualValidationIssue {
  type:
    | 'edit_not_applied'
    | 'scope_regression'
    | 'layout_regression'
    | 'style_regression'
    | 'content_regression'
    | 'wp_drift_advisory'
    | 'unknown';
  severity: 'low' | 'medium' | 'high';
  target?: string;
  evidence: string;
  suggestedAction: string;
  inEditScope?: boolean;
}

export interface PostEditVisualValidationResult {
  componentName: string;
  routeKey?: string | null;
  route?: string | null;
  passed: boolean;
  shouldRepair: boolean;
  editIntentSatisfied: boolean;
  outOfScopeRegression: boolean;
  wpParityAdvisoryOnly: boolean;
  confidence: number;
  score: number;
  analysisMode?: 'vision' | 'text' | 'heuristic';
  summary: string;
  issues: PostEditVisualValidationIssue[];
  repairPlan: {
    strategy: string;
    instructions: string[];
    targetAreas: Array<{
      type: string;
      sectionHint?: string;
      headingHint?: string;
    }>;
    guardrails: string[];
  };
}
